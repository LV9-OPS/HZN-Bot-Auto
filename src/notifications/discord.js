// Discord notifications: queued, rate-limited, deduplicated, secret-redacted.
// Messages are in French (as in the previous bot). Every trade message says
// whether an order was only SUBMITTED or actually FILLED.
import { redact } from "../monitoring/redact.js";
import { fmt } from "../util/num.js";
import { planLevels } from "../strategy/profitPlan.js";

const MODE_TAG = { paper: "🧪 PAPER", live: "🔴 LIVE" };

export class DiscordNotifier {
  constructor({ webhookUrl, mode, cfg, logger, fetchImpl = globalThis.fetch, priceOf = () => null, clock = { now: () => Date.now() } }) {
    this.url = webhookUrl || "";
    this.mode = mode;
    this.cfg = cfg;
    this.log = logger;
    this.fetch = fetchImpl;
    this.priceOf = priceOf;
    this.clock = clock;
    this.queue = [];
    this.sending = false;
    this.lastByKey = new Map();
    this.sent = [];
    this.pausedUntil = 0;
  }

  get enabled() {
    return Boolean(this.url);
  }

  tag() {
    return MODE_TAG[this.mode] || this.mode;
  }

  /**
   * @param {string} text
   * @param {{key?: string, cooldownMs?: number, critical?: boolean}} opts
   */
  send(text, { key = null, cooldownMs = 0, critical = false } = {}) {
    const body = redact(`**HZN Bot Auto | ${this.tag()}**\n${text}`).slice(0, 1900);
    const k = key || body;
    const now = this.clock.now();
    const last = this.lastByKey.get(k);
    const cd = cooldownMs || (critical ? 5 * 60000 : 0);
    if (last && cd && now - last < cd) return false; // dedupe
    this.lastByKey.set(k, now);
    this.sent.push({ at: now, text: body });
    if (this.sent.length > 100) this.sent.shift();
    if (!this.enabled) return true;
    this.queue.push(body);
    if (this.queue.length > 50) this.queue.splice(0, this.queue.length - 50);
    this.#drain();
    return true;
  }

  async #drain() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const wait = this.pausedUntil - this.clock.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const content = this.queue[0];
        try {
          const res = await this.fetch(this.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
          if (res.status === 429) {
            let retry = 2000;
            try { retry = Math.ceil(Number((await res.json()).retry_after || 2) * 1000); } catch { /* ignore */ }
            this.pausedUntil = this.clock.now() + retry;
            continue;
          }
          if (!res.ok) this.log?.warn("Discord webhook error", { status: res.status });
        } catch (e) {
          this.log?.warn("Discord unreachable", { err: e.message });
          this.pausedUntil = this.clock.now() + 10000;
          if (this.queue.length > 20) this.queue.shift();
          continue;
        }
        this.queue.shift();
        await new Promise((r) => setTimeout(r, 400)); // stay well under Discord's webhook limit
      }
    } finally {
      this.sending = false;
    }
  }

  // ---------------------------------------------------------------- formatting helpers
  #pnl(p) {
    const tk = this.priceOf(p.symbol);
    if (!tk || !(tk.bid > 0) || !(p.qty > 0)) return { line: "Prix actuel : indisponible", bid: null };
    const value = p.qty * tk.bid * (1 - this.cfg.TAKER_FEE_PCT / 100);
    const net = value - p.costBasisQuote * (p.initialQty > 0 ? p.qty / p.initialQty : 1);
    return { line: `Prix actuel (bid) : ${fmt(tk.bid, 6)} | PnL net estimé : ${net >= 0 ? "+" : ""}${fmt(net, 4)} ${this.q} (${fmt((net / p.costBasisQuote) * 100, 2)}%)`, bid: tk.bid };
  }

  #protection(p) {
    if (!(p.entryPrice > 0)) return "Protection : en attente du remplissage";
    const lv = planLevels(p, this.cfg.STOP_LOSS_PCT);
    if (p.plan.mode === "scalp") {
      const parts = [`Stop-loss -${this.cfg.STOP_LOSS_PCT}% à ${fmt(lv.stopPrice, 6)}`];
      if (Number.isFinite(lv.targetPrice)) parts.push(`take-profit +${p.plan.takeProfitPct}% à ${fmt(lv.targetPrice, 6)}`);
      if (p.plan.trailActivationPct > 0) parts.push(`trailing ${p.plan.trailDistancePct}% dès +${p.plan.trailActivationPct}%${p.targetReached ? " (ARMÉ)" : ""}`);
      if (p.plan.maxHoldMin > 0) parts.push(`sortie après ${p.plan.maxHoldMin} min`);
      return `Protection : ${parts.join(" | ")} — surveillance LOGICIELLE (aucun stop natif Revolut X via API; inactive si le bot est arrêté)`;
    }
    const native = p.protection?.nativeOrderIds?.length ? ` + ordre natif détecté (${p.protection.nativeOrderIds.length})` : "";
    const base = p.targetReached
      ? `Plancher ARMÉ à X${p.plan.floorMultiple} = ${fmt(lv.floorPrice, 6)} (objectif X${p.plan.targetMultiple} atteint)`
      : `Stop-loss -${this.cfg.STOP_LOSS_PCT}% à ${fmt(lv.stopPrice, 6)} | objectif X${p.plan.targetMultiple} à ${fmt(lv.targetPrice, 6)}`;
    return `Protection : ${base} — surveillance LOGICIELLE (aucun stop natif Revolut X via API; inactive si le bot est arrêté)${native}`;
  }

  // ---------------------------------------------------------------- events
  get q() {
    return this.cfg?.QUOTE_CURRENCY || "USDC";
  }

  startup({ mode, config, auth, reconcile, positions }) {
    this.send(`Démarrage. Mode **${mode.toUpperCase()}**. Auth Revolut X : ${auth}. Réconciliation : ${reconcile}. Positions gérées : ${positions}.\nBudget max ${config.MAX_TRADING_BUDGET_QUOTE} ${config.QUOTE_CURRENCY} | slots ${config.SLOT_ALLOCATIONS.join("/")} | stop -${config.STOP_LOSS_PCT}% | plans ${config.plans.map((p) => p.name).join(", ")}`, { key: "startup", cooldownMs: 60000 });
  }

  authResult(ok, detail = "") {
    this.send(ok ? "Authentification Revolut X : OK" : `⚠️ Authentification Revolut X : ÉCHEC ${detail}`, { key: "auth-" + ok, cooldownMs: 30 * 60000, critical: !ok });
  }

  candidate(c) {
    this.send(`👀 Candidat : **${c.exec}** (signal sur ${c.ref}) — score ${c.score.toFixed(1)}\n${c.explanation}`, { key: "cand-" + c.exec, cooldownMs: this.cfg.DISCORD_CANDIDATE_COOLDOWN_MIN * 60000 });
  }

  entryDecision({ candidate, slot, plan, allocation, order, costs }) {
    this.send(`🟢 Décision d'ACHAT ${candidate.exec} — slot ${slot} (${allocation} ${this.q}, plan ${plan.name})\nPourquoi : ${candidate.explanation}\nOrdre prévu : limite IOC ${order.baseSize} @ ${order.price} | coût aller-retour estimé ${fmt(costs.roundTripCostPct, 2)}%`);
  }

  orderSubmitted({ position, side, order, reason, bid }) {
    const what = side === "buy" ? "ACHAT" : "VENTE";
    this.send(`📨 Ordre ${what} **SOUMIS** (pas encore exécuté) : ${position.symbol} ${order.type}${order.timeInForce ? " " + order.timeInForce.toUpperCase() : ""} qty ${order.baseSize}${order.price ? " @ " + order.price : ""}${reason ? `\nRaison : ${reason}` : ""}${bid ? ` | bid ${fmt(bid, 6)}` : ""}`);
  }

  orderFailed({ position, side, error }) {
    this.send(`❌ Ordre ${side === "buy" ? "d'achat" : "de vente"} REJETÉ/ÉCHOUÉ : ${position.symbol} — ${error?.message || error}`, { key: `fail-${position.symbol}-${side}-${error?.status}`, cooldownMs: 10 * 60000 });
  }

  entryNotFilled({ position, order }) {
    this.send(`↩️ Achat ${position.symbol} NON exécuté (${order.status}${order.rejectReason ? ": " + order.rejectReason : ""}). Aucune position ouverte.`);
  }

  entryFilled({ position: p }) {
    this.send(`✅ ACHAT **EXÉCUTÉ** : **${p.symbol}**${p.partialEntry ? " (partiel)" : ""}\nEntrée moyenne : ${fmt(p.entryPrice, 6)} | Quantité : ${fmt(p.qty, 8)} | Coût : ${fmt(p.costBasisQuote, 4)} ${this.q} (frais ${fmt(p.entryFeeQuote, 4)})\nPourquoi : ${p.signal?.explanation || "n/a"}\n${this.#pnl(p).line}\n${this.#protection(p)}`);
  }

  targetReached(p) {
    this.send(`🎯 Objectif X${p.plan.targetMultiple} ATTEINT sur ${p.symbol} (entrée ${fmt(p.entryPrice, 6)}). Plancher de sortie armé à X${p.plan.floorMultiple}.\n${this.#pnl(p).line}`, { key: "target-" + p.id, cooldownMs: 24 * 3600000 });
  }

  exitTriggered(p, reason, bid) {
    const label = reason === "STOP_LOSS" ? `🛑 STOP-LOSS déclenché (-${this.cfg.STOP_LOSS_PCT}%)` : reason === "TAKE_PROFIT" ? `✅ Take-profit atteint` : reason === "TRAILING_STOP" ? `📉 Trailing stop` : reason === "TIME_EXIT" ? `⏱️ Durée max atteinte` : reason.startsWith("X") ? `📉 Retour au plancher (${reason})` : `⚠️ Sortie (${reason})`;
    this.send(`${label} sur **${p.symbol}** — bid ${fmt(bid, 6)} | entrée ${fmt(p.entryPrice, 6)}\n${this.#pnl(p).line}\nEnvoi d'un ordre de vente…`, { key: `exit-${p.id}-${reason}`, cooldownMs: 10 * 60000 });
  }

  exitFilled({ position: p, exit, partial }) {
    this.send(`💰 VENTE **EXÉCUTÉE**${partial ? " (PARTIELLE)" : ""} : **${p.symbol}** — ${fmt(exit.filledQty, 8)} @ ${fmt(exit.avgPrice, 6)} (frais ${fmt(exit.feeQuote, 4)})\nRaison : ${exit.reason} | PnL net de cette vente : ${exit.realizedNetPnl >= 0 ? "+" : ""}${fmt(exit.realizedNetPnl, 4)} ${this.q}${partial ? `\nReste à vendre : ${fmt(p.qty, 8)}` : ""}`);
  }

  positionClosed({ position: p }) {
    this.send(`📕 Position clôturée ${p.symbol} (${p.exitReason}). PnL net réalisé : ${p.realizedNetPnl >= 0 ? "+" : ""}${fmt(p.realizedNetPnl, 4)} ${this.q} (frais inclus)${p.dustQty ? ` | résidu non vendable : ${fmt(p.dustQty, 8)}` : ""}`);
  }

  reconciliation({ discrepancy: d, position }) {
    this.send(`🧩 Écart de réconciliation [${d.severity}] ${d.kind} ${d.symbol || ""}\n${JSON.stringify(d.details).slice(0, 600)}${position ? `\nPosition passée en "needs_reconciliation" : nouvelles entrées bloquées.` : ""}`, { key: `rec-${d.kind}-${d.symbol}-${d.severity}`, cooldownMs: 30 * 60000, critical: d.severity === "critical" });
  }

  rateLimited(group, ms) {
    this.send(`⏳ Limite d'API Revolut X (${group}) : pause ${Math.round(ms / 1000)}s. Cadence réduite automatiquement.`, { key: "rl-" + group, cooldownMs: 30 * 60000 });
  }

  dailySummary(s) {
    this.send(`📊 Résumé du ${s.day}\nPnL net réalisé : ${fmt(s.realizedNetPnl, 4)} ${this.q} | frais : ${fmt(s.fees, 4)} | entrées : ${s.entries} | sorties : ${s.exits}\nCumul : ${fmt(s.totalNet, 4)} ${this.q} | trades ${s.trades} | taux de gain ${s.winRate} | gain moyen ${fmt(s.avgWin, 4)} | perte moyenne ${fmt(s.avgLoss, 4)} | drawdown max ${fmt(s.maxDrawdown, 4)}\nPositions ouvertes : ${s.open} | exposition ${fmt(s.exposure, 4)} ${this.q} | non-réalisé ${fmt(s.unrealized, 4)} ${this.q}\nSignaux rejetés (top) : ${s.topRejections}`, { key: "daily-" + s.day, cooldownMs: 3600000 });
  }

  emergency(text) {
    this.send(`🚨 ARRÊT D'URGENCE / INCIDENT : ${text}`, { key: "emerg-" + text.slice(0, 60), cooldownMs: 10 * 60000, critical: true });
  }

  critical(text, key) {
    this.send(`🚨 ${text}`, { key: key || text.slice(0, 80), cooldownMs: 30 * 60000, critical: true });
  }

  warning(text, key) {
    this.send(`⚠️ ${text}`, { key: key || text.slice(0, 80), cooldownMs: 60 * 60000 });
  }

  info(text, key) {
    this.send(`ℹ️ ${text}`, { key: key || text.slice(0, 80), cooldownMs: 10 * 60000 });
  }

  error(err, context = "") {
    const msg = String(err?.message || err).slice(0, 600);
    this.send(`❗ Erreur ${context}: \`${msg}\``, { key: "err-" + context + msg.slice(0, 80), cooldownMs: 15 * 60000 });
  }

  /** Wait until queued messages are flushed (used on shutdown). */
  async flush(timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    while ((this.queue.length || this.sending) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  }
}
