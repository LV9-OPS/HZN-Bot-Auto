// The three-position profit plan, implemented exactly as specified:
//   slot 1: reach 2x entry -> arm floor at 1x entry -> exit if bid <= 1x
//   slot 2: reach 3x entry -> arm floor at 2x entry -> exit if bid <= 2x
//   slot 3: reach 3x entry -> arm floor at 2x entry -> exit if bid <= 2x
// "X2" means 2 TIMES the entry price (+100%), not +2%.
// Before the target is reached, the initial stop-loss (default -3%) applies.
// All comparisons use the current BID (the price we could actually sell at).

export function planLevels(position, stopLossPct) {
  const e = position.entryPrice;
  return {
    stopPrice: e * (1 - stopLossPct / 100),
    targetPrice: e * position.plan.targetMultiple,
    floorPrice: e * position.plan.floorMultiple
  };
}

/**
 * Pure decision function.
 * @param {object} position { entryPrice, plan:{targetMultiple, floorMultiple}, targetReached, peakBid }
 * @param {object} price { bid, reliable }
 * @returns {{ action: 'hold'|'exit', reason: string|null, updates: object, events: string[], levels: object }}
 */
export function evaluateExit(position, price, { stopLossPct }) {
  const levels = planLevels(position, stopLossPct);
  const updates = {};
  const events = [];
  if (!price || !price.reliable || !(price.bid > 0)) {
    return { action: "hold", reason: null, updates, events: ["no_reliable_price"], levels };
  }
  const bid = price.bid;
  updates.peakBid = Math.max(position.peakBid || 0, bid);
  let targetReached = position.targetReached === true;
  if (!targetReached && bid >= levels.targetPrice) {
    targetReached = true;
    updates.targetReached = true;
    updates.targetReachedAt = new Date().toISOString();
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
