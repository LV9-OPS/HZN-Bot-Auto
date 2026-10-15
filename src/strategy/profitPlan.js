// Exit policies.
//
// 1) "plan" (original request): slot 1 reach 2x -> floor 1x; slots 2/3 reach 3x -> floor 2x.
//    "X2" means 2 TIMES the entry price (+100%). Before the target the initial stop applies.
// 2) "scalp" (small, frequent gains): take profit at +TP%, optional trailing stop once
//    the gain reaches +activation%, initial stop-loss, optional maximum holding time.
//
// All comparisons use the current BID (the price we could actually sell at).

export function planLevels(position, stopLossPct) {
  const e = position.entryPrice;
  const p = position.plan;
  if (p.mode === "scalp") {
    return {
      stopPrice: e * (1 - stopLossPct / 100),
      targetPrice: p.takeProfitPct > 0 ? e * (1 + p.takeProfitPct / 100) : Infinity,
      floorPrice: null,
      trailActivationPrice: p.trailActivationPct > 0 ? e * (1 + p.trailActivationPct / 100) : Infinity
    };
  }
  return {
    stopPrice: e * (1 - stopLossPct / 100),
    targetPrice: e * p.targetMultiple,
    floorPrice: e * p.floorMultiple
  };
}

function openedMs(position) {
  if (typeof position.openedAt === "number") return position.openedAt;
  const t = Date.parse(position.openedAt || "");
  return Number.isFinite(t) ? t : null;
}

/**
 * Pure decision function.
 * @param {object} position { entryPrice, plan, targetReached, peakBid, openedAt }
 * @param {object} price { bid, reliable }
 * @param {object} opts { stopLossPct, now }
 * @returns {{ action: 'hold'|'exit', reason: string|null, updates: object, events: string[], levels: object }}
 */
export function evaluateExit(position, price, { stopLossPct, now = Date.now() }) {
  const levels = planLevels(position, stopLossPct);
  const updates = {};
  const events = [];
  if (!price || !price.reliable || !(price.bid > 0)) {
    return { action: "hold", reason: null, updates, events: ["no_reliable_price"], levels };
  }
  const bid = price.bid;
  const peak = Math.max(position.peakBid || 0, bid);
  updates.peakBid = peak;

  if (position.plan.mode === "scalp") {
    const p = position.plan;
    if (bid >= levels.targetPrice) return { action: "exit", reason: "TAKE_PROFIT", updates, events, levels };
    if (peak >= levels.trailActivationPrice && p.trailDistancePct > 0) {
      const trailStop = peak * (1 - p.trailDistancePct / 100);
      levels.trailStopPrice = trailStop;
      if (!position.targetReached) {
        updates.targetReached = true; // reused flag: trailing armed (persisted)
        updates.targetReachedAt = new Date(now).toISOString();
        events.push("trailing_armed");
      }
      if (bid <= trailStop) return { action: "exit", reason: "TRAILING_STOP", updates, events, levels };
    }
    if (bid <= levels.stopPrice) return { action: "exit", reason: "STOP_LOSS", updates, events, levels };
    const opened = openedMs(position);
    if (p.maxHoldMin > 0 && opened !== null && now - opened >= p.maxHoldMin * 60000) {
      return { action: "exit", reason: "TIME_EXIT", updates, events, levels };
    }
    return { action: "hold", reason: null, updates, events, levels };
  }

  let targetReached = position.targetReached === true;
  if (!targetReached && bid >= levels.targetPrice) {
    targetReached = true;
    updates.targetReached = true;
    updates.targetReachedAt = new Date(now).toISOString();
    events.push("target_reached");
  }
  if (targetReached) {
    if (bid <= levels.floorPrice) {
      return { action: "exit", reason: `X${position.plan.targetMultiple}_RETRACE_TO_X${position.plan.floorMultiple}`, updates, events, levels };
    }
    return { action: "hold", reason: null, updates, events, levels };
  }
  if (bid <= levels.stopPrice) {
    return { action: "exit", reason: "STOP_LOSS", updates, events, levels };
  }
  return { action: "hold", reason: null, updates, events, levels };
}
