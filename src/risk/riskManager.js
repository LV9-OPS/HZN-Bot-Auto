// Capital allocation and risk limits. These checks are independent of the
// strategy: no signal, however strong, can bypass them.
import { dayKey } from "../util/time.js";
import { HARD_MAX_BUDGET } from "../config/index.js";

const ACTIVE = new Set(["opening", "open", "closing", "needs_reconciliation", "error_locked"]);

/** Explicit position state machine names (spec) <-> internal statuses. */
export const STATE_NAMES = { opening: "ENTRY_PENDING", open: "OPEN", closing: "EXIT_PENDING", needs_reconciliation: "RECONCILIATION_REQUIRED", error_locked: "ERROR_LOCKED", closed: "CLOSED", failed: "CLOSED" };

export class RiskManager {
  constructor({ cfg, clock = { now: () => Date.now() } }) {
    this.cfg = cfg;
    this.clock = clock;
  }

  activePositions(state) {
    return Object.values(state.positions).filter((p) => ACTIVE.has(p.status));
  }

  /** Capital committed by the bot: cost basis of held positions, reserved allocation for in-flight entries. */
  deployedQuote(state) {
    return this.activePositions(state).reduce((sum, p) => {
      const committed = p.status === "opening" ? p.allocationQuote : Math.max(p.costBasisQuote || 0, p.status === "needs_reconciliation" ? p.allocationQuote : 0);
      return sum + committed;
    }, 0);
  }

  budget() {
    return Math.min(this.cfg.MAX_TRADING_BUDGET_QUOTE, HARD_MAX_BUDGET);
  }

  remainingBudget(state) {
    return Math.max(0, this.budget() - this.deployedQuote(state));
  }

  freeSlot(state) {
    const used = new Set(this.activePositions(state).map((p) => p.slot));
    for (let s = 1; s <= this.cfg.MAX_OPEN_POSITIONS; s++) if (!used.has(s)) return s;
    return null;
  }

  rollDay(state) {
    const today = dayKey(this.clock.now(), this.cfg.RISK_DAY_TIMEZONE);
    const month = today.slice(0, 7);
    if (!state.monthly || state.monthly.month !== month) {
      state.monthly = { month, startEquity: this.budget(), realizedNetPnl: 0, trades: 0 };
    }
    if (state.daily.day !== today) {
      state.daily = { day: today, realizedNetPnl: 0, entries: 0, exits: 0, fees: 0 };
      return true;
    }
    return false;
  }

  /** Realized drawdown (% of budget-based equity) from the peak since the last manual risk reset. */
  drawdownPct(state) {
    const realized = state.stats.realizedNetPnl || 0;
    const peak = Math.max(state.riskPeakRealized ?? 0, realized);
    const peakEq = this.budget() + peak;
    return peakEq > 0 ? ((peak - realized) / peakEq) * 100 : 0;
  }

  /** Consecutive losing closed trades at the end of the history. */
  lossStreak(state) {
    let n = 0, lastAt = 0;
    for (let i = state.history.length - 1; i >= 0; i--) {
      const p = state.history[i];
      if (p.status !== "closed" || p.exitReason === "EXTERNAL_CLOSE_CONFIRMED_BY_USER") continue;
      if ((p.realizedNetPnl || 0) < 0) { n++; lastAt = Math.max(lastAt, Date.parse(p.closedAt) || 0); } else break;
    }
    return { n, lastAt };
  }

  criticalDiscrepancies(state) {
    return state.discrepancies.filter((d) => !d.resolved && d.severity === "critical");
  }

  /** Account-level gate: may the bot open ANY new position right now? */
  entryGate(state, { apiHealthy = true } = {}) {
    const reasons = [];
    this.rollDay(state);
    if (this.cfg.EMERGENCY_STOP || state.emergencyStop) reasons.push({ code: "emergency_stop", detail: "emergency stop active" });
    if (!state.reconciliation.ok) reasons.push({ code: "not_reconciled", detail: "exchange reconciliation has not succeeded" });
    const crit = this.criticalDiscrepancies(state);
    if (crit.length) reasons.push({ code: "critical_discrepancy", detail: crit.map((d) => d.kind + ":" + (d.symbol || "")).join(", ") });
    if (this.activePositions(state).some((p) => p.status === "needs_reconciliation")) reasons.push({ code: "position_needs_reconciliation", detail: "a position needs manual reconciliation" });
    const monthLimit = (this.cfg.MONTHLY_LOSS_PCT / 100) * (state.monthly?.startEquity || this.budget());
    if ((state.monthly?.realizedNetPnl || 0) <= -monthLimit) reasons.push({ code: "monthly_loss_limit", detail: `month ${state.monthly.realizedNetPnl.toFixed(4)} <= -${monthLimit.toFixed(4)} (${this.cfg.MONTHLY_LOSS_PCT}%)` });
    const dd = this.drawdownPct(state);
    if (dd >= this.cfg.MAX_DRAWDOWN_PCT) reasons.push({ code: "max_drawdown_halt", detail: `realized drawdown ${dd.toFixed(2)}% >= ${this.cfg.MAX_DRAWDOWN_PCT}% since peak - review, then npm run risk-reset` });
    if (state.monthly?.flattened) reasons.push({ code: "monthly_loss_limit", detail: `monthly policy triggered on ${state.monthly.flattened}` });
    if (this.cfg.LOSS_STREAK_PAUSE > 0) {
      const ls = this.lossStreak(state);
      if (ls.n >= this.cfg.LOSS_STREAK_PAUSE && this.clock.now() - ls.lastAt < this.cfg.LOSS_STREAK_PAUSE_HOURS * 3600000) reasons.push({ code: "loss_streak_pause", detail: `${ls.n} consecutive losses, paused until ${new Date(ls.lastAt + this.cfg.LOSS_STREAK_PAUSE_HOURS * 3600000).toISOString()}` });
    }
    if (this.activePositions(state).some((p) => p.status === "error_locked")) reasons.push({ code: "position_error_locked", detail: "a position is ERROR_LOCKED (manual action needed)" });
    if (state.daily.realizedNetPnl <= -this.cfg.MAX_DAILY_LOSS_QUOTE) reasons.push({ code: "daily_loss_limit", detail: `day PnL ${state.daily.realizedNetPnl.toFixed(4)} <= -${this.cfg.MAX_DAILY_LOSS_QUOTE}` });
    if (state.daily.entries >= this.cfg.MAX_TRADES_PER_DAY) reasons.push({ code: "daily_trade_limit", detail: `${state.daily.entries} entries today` });
    if (this.activePositions(state).length >= this.cfg.MAX_OPEN_POSITIONS) reasons.push({ code: "max_positions", detail: "all slots used" });
    if (this.freeSlot(state) === null) reasons.push({ code: "no_free_slot", detail: "no free slot" });
    if (this.remainingBudget(state) < this.cfg.MIN_POSITION_QUOTE) reasons.push({ code: "budget_exhausted", detail: `remaining ${this.remainingBudget(state).toFixed(4)} USDC` });
    if (!apiHealthy) reasons.push({ code: "api_degraded", detail: "API errors / rate limiting" });
    return { ok: reasons.length === 0, reasons };
  }

  /** Symbol-level gate. */
  symbolGate(state, symbol) {
    const reasons = [];
    if (this.activePositions(state).some((p) => p.symbol === symbol)) reasons.push({ code: "already_held", detail: symbol });
    const until = state.cooldowns[symbol];
    if (until && until > this.clock.now()) reasons.push({ code: "cooldown", detail: `until ${new Date(until).toISOString()}` });
    return { ok: reasons.length === 0, reasons };
  }

  /**
   * Allocation for the next entry. Uses the slot's target (5/3/2) but never more
   * than the remaining budget or the free quote balance.
   */
  allocation(state, slot, availableQuote) {
    const target = this.cfg.SLOT_ALLOCATIONS[slot - 1];
    const amount = Math.min(target, this.remainingBudget(state), Number.isFinite(availableQuote) ? availableQuote * 0.995 : 0);
    const floored = Math.floor(amount * 100) / 100;
    if (floored < this.cfg.MIN_POSITION_QUOTE) return { ok: false, amount: floored, reason: { code: "insufficient_balance", detail: `can allocate ${floored} < ${this.cfg.MIN_POSITION_QUOTE} USDC (available ${availableQuote})` } };
    return { ok: true, amount: floored, target };
  }

  recordEntry(state) {
    this.rollDay(state);
    state.daily.entries++;
  }

  /** Book a fully closed position's realized result. */
  recordClose(state, { netPnl, fees, symbol }) {
    this.rollDay(state);
    state.daily.realizedNetPnl += netPnl;
    if (state.monthly) { state.monthly.realizedNetPnl += netPnl; state.monthly.trades++; }
    state.daily.exits++;
    state.daily.fees += fees;
    const s = state.stats;
    s.trades++;
    s.totalFees += fees;
    s.realizedNetPnl += netPnl;
    if (netPnl >= 0) { s.wins++; s.sumWin += netPnl; } else { s.losses++; s.sumLoss += netPnl; }
    s.equityPeak = Math.max(s.equityPeak, s.realizedNetPnl);
    state.riskPeakRealized = Math.max(state.riskPeakRealized ?? 0, s.realizedNetPnl);
    s.maxDrawdown = Math.max(s.maxDrawdown, s.equityPeak - s.realizedNetPnl);
    if (this.cfg.SYMBOL_COOLDOWN_MIN > 0) state.cooldowns[symbol] = this.clock.now() + this.cfg.SYMBOL_COOLDOWN_MIN * 60000;
  }
}
