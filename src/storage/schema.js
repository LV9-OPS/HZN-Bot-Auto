// State schema (version 3). Validation is strict: a state that fails
// validation is never silently replaced by an empty one.

export const SCHEMA_VERSION = 3;

export const POSITION_STATUS = [
  "opening", // entry order intent persisted, outcome not yet known
  "open", // holding base, managed
  "closing", // exit order in flight
  "closed", // fully exited (moved to history)
  "failed", // entry never filled
  "needs_reconciliation" // facts could not be established: entries blocked
];

export function emptyState(mode) {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    positions: {},
    history: [],
    daily: { day: "", realizedNetPnl: 0, entries: 0, exits: 0, fees: 0 },
    stats: { trades: 0, wins: 0, losses: 0, sumWin: 0, sumLoss: 0, totalFees: 0, realizedNetPnl: 0, equityPeak: 0, maxDrawdown: 0 },
    discrepancies: [],
    unmanagedHoldings: [],
    cooldowns: {},
    rejections: {},
    reconciliation: { lastRunAt: null, lastOkAt: null, lastHistorySyncAt: null, ok: false },
    paper: null
  };
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

/** Returns a list of problems; empty list means valid. */
export function validateState(s) {
  const errs = [];
  if (!isObj(s)) return ["state is not an object"];
  if (s.schemaVersion !== SCHEMA_VERSION) errs.push(`schemaVersion ${s.schemaVersion} != ${SCHEMA_VERSION}`);
  if (!["paper", "live"].includes(s.mode)) errs.push("mode invalid");
  if (!isObj(s.positions)) errs.push("positions must be an object");
  else {
    for (const [id, p] of Object.entries(s.positions)) {
      if (!isObj(p)) { errs.push(`position ${id} not an object`); continue; }
      if (p.id !== id) errs.push(`position ${id} id mismatch`);
      if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(p.symbol || "")) errs.push(`position ${id} symbol invalid`);
      if (!POSITION_STATUS.includes(p.status)) errs.push(`position ${id} status invalid`);
      if (!Number.isInteger(p.slot) || p.slot < 1 || p.slot > 3) errs.push(`position ${id} slot invalid`);
      const planOk = isObj(p.plan) && (p.plan.mode === "scalp" ? p.plan.takeProfitPct >= 0 : p.plan.targetMultiple > 1 && p.plan.floorMultiple >= 1);
      if (!planOk) errs.push(`position ${id} plan invalid`);
      if (typeof p.allocationQuote !== "number" || !(p.allocationQuote > 0)) errs.push(`position ${id} allocationQuote invalid`);
      if (p.status === "open" || p.status === "closing") {
        if (!(p.qty > 0)) errs.push(`position ${id} qty invalid`);
        if (!(p.entryPrice > 0)) errs.push(`position ${id} entryPrice invalid`);
      }
      if (typeof p.targetReached !== "boolean") errs.push(`position ${id} targetReached must be boolean`);
    }
  }
  if (!Array.isArray(s.history)) errs.push("history must be an array");
  if (!isObj(s.daily)) errs.push("daily invalid");
  if (!isObj(s.stats)) errs.push("stats invalid");
  if (!Array.isArray(s.discrepancies)) errs.push("discrepancies must be an array");
  if (!isObj(s.cooldowns)) errs.push("cooldowns invalid");
  return errs;
}
