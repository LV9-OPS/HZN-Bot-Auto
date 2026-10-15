// Durable state store: atomic writes, schema validation, rotating backups,
// recovery from interrupted writes, and FAIL-CLOSED loading (a corrupt state
// is never replaced by an empty one, which is how the old bot lost XRP).
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";
import { emptyState, validateState, SCHEMA_VERSION } from "./schema.js";

export class StateCorruptError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "StateCorruptError";
    this.details = details;
  }
}

export class StateStore {
  constructor({ dataDir, mode, logger, keepBackups = 30 }) {
    this.dataDir = dataDir;
    this.mode = mode;
    this.file = path.join(dataDir, `state.${mode}.json`);
    this.backupDir = path.join(dataDir, "backups");
    this.legacyFile = path.join(dataDir, "state.json");
    this.log = logger;
    this.keepBackups = keepBackups;
    this.state = null;
    this.lastBackupAt = 0;
  }

  #readJson(file) {
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    return JSON.parse(text);
  }

  #listBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs
      .readdirSync(this.backupDir)
      .filter((f) => f.startsWith(`state.${this.mode}.`) && f.endsWith(".json"))
      .sort()
      .reverse()
      .map((f) => path.join(this.backupDir, f));
  }

  /**
   * Load state. Order: main file -> newest valid backup -> legacy migration -> fresh.
   * Fresh state is only created when NOTHING exists (true first run).
   */
  load({ allowFresh = true } = {}) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    // Leftover temp files mean a write was interrupted; the main file is still the previous complete version.
    for (const f of fs.readdirSync(this.dataDir)) {
      if (f.startsWith(`state.${this.mode}.json.tmp-`)) {
        this.log?.warn("Found interrupted state write; discarding temp file", { file: f });
        try { fs.unlinkSync(path.join(this.dataDir, f)); } catch { /* ignore */ }
      }
    }
    const problems = [];
    if (fs.existsSync(this.file)) {
      try {
        const s = this.#readJson(this.file);
        const errs = validateState(s);
        if (!errs.length && s.mode === this.mode) {
          this.state = s;
          return { state: s, source: "main" };
        }
        problems.push({ file: this.file, errors: errs.length ? errs : ["mode mismatch"] });
      } catch (e) {
        problems.push({ file: this.file, errors: [e.message] });
      }
      const quarantine = `${this.file}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.file, quarantine); } catch { /* ignore */ }
      this.log?.error("State file invalid; quarantined copy kept", { quarantine, problems });
    }
    for (const b of this.#listBackups()) {
      try {
        const s = this.#readJson(b);
        if (!validateState(s).length && s.mode === this.mode) {
          this.state = s;
          this.log?.error("State recovered from backup - reconciliation required", { backup: path.basename(b) });
          this.save({ backup: false });
          return { state: s, source: "backup", recoveredFrom: b, problems };
        }
      } catch (e) {
        problems.push({ file: b, errors: [e.message] });
      }
    }
    if (problems.length) throw new StateCorruptError("State file and all backups are invalid. Refusing to start with an empty state.", problems);

    if (this.mode === "live" && fs.existsSync(this.legacyFile)) {
      const legacy = this.#readJson(this.legacyFile);
      this.state = migrateLegacy(legacy, this.mode);
      this.log?.warn("Migrated legacy state.json", { positions: Object.keys(this.state.positions).length });
      this.save({ backup: true });
      return { state: this.state, source: "legacy" };
    }
    if (!allowFresh) throw new StateCorruptError("No state found and fresh state not allowed", []);
    this.state = emptyState(this.mode);
    this.save({ backup: false });
    return { state: this.state, source: "fresh" };
  }

  save({ backup = false } = {}) {
    if (!this.state) throw new Error("No state loaded");
    this.state.updatedAt = new Date().toISOString();
    const errs = validateState(this.state);
    if (errs.length) {
      // Never persist a broken state over a good one.
      this.log?.error("Refusing to save invalid state", { errs });
      throw new StateCorruptError("Refusing to save invalid state", errs);
    }
    const text = JSON.stringify(this.state, null, 2);
    writeFileAtomic(this.file, text);
    if (backup || Date.now() - this.lastBackupAt > 3600000) this.#backup(text);
  }

  #backup(text) {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileAtomic(path.join(this.backupDir, `state.${this.mode}.${stamp}.json`), text);
    this.lastBackupAt = Date.now();
    const all = this.#listBackups();
    for (const old of all.slice(this.keepBackups)) {
      try { fs.unlinkSync(old); } catch { /* ignore */ }
    }
  }
}

/**
 * Migrate the v0.2 state.json. Legacy positions are imported as
 * needs_reconciliation: their entry facts must be confirmed on the exchange
 * (by order id) before the bot manages them again. Nothing is invented.
 */
export function migrateLegacy(legacy, mode) {
  const s = emptyState(mode);
  const list = Array.isArray(legacy?.positions) ? [...legacy.positions] : [];
  if (legacy?.position) list.push(legacy.position);
  const plans = { 1: { targetMultiple: 2, floorMultiple: 1, name: "X2->X1" }, 2: { targetMultiple: 3, floorMultiple: 2, name: "X3->X2" }, 3: { targetMultiple: 3, floorMultiple: 2, name: "X3->X2" } };
  const usedSlots = new Set();
  for (const p of list) {
    if (!p?.symbol) continue;
    let slot = Number(p.profitPlan || p.slot || 1);
    if (!(slot >= 1 && slot <= 3) || usedSlots.has(slot)) slot = [1, 2, 3].find((x) => !usedSlots.has(x)) || 3;
    usedSlots.add(slot);
    const id = `legacy-${String(p.orderId || p.symbol).replace(/[^A-Za-z0-9-]/g, "")}`;
    s.positions[id] = {
      id,
      symbol: String(p.symbol).toUpperCase().replace("/", "-"),
      slot,
      plan: plans[slot],
      origin: "legacy",
      status: "needs_reconciliation",
      allocationQuote: Number(p.quoteSize) > 0 ? Number(p.quoteSize) : 10,
      qty: Number(p.baseSize) || 0,
      entryPrice: Number(p.entryPrice) || 0,
      costBasisQuote: Number(p.quoteSize) || 0,
      entryFeeQuote: 0,
      targetReached: Boolean(p.targetReached),
      targetReachedAt: null,
      peakBid: Number(p.highWatermark) || null,
      openedAt: p.openedAt || null,
      entry: { clientOrderId: null, venueOrderId: p.orderId || null, status: "unknown" },
      exits: [],
      pendingExit: null,
      exitReason: null,
      realizedNetPnl: 0,
      protection: { type: "software", nativeOrderIds: [] },
      notes: ["Imported from legacy state.json; entry must be verified on the exchange"],
      lastBid: null,
      lastPriceAt: null
    };
  }
  s.legacyImportedAt = new Date().toISOString();
  return s;
}

export { SCHEMA_VERSION };
