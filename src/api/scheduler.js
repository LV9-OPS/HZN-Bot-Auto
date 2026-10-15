// Centralized request scheduler. EVERY exchange request goes through here:
// scanner, position monitor, reconciliation and order placement share the same
// token buckets, so no component can exhaust the API budget on its own.

export const PRIORITY = { ORDER: 0, POSITION: 1, RECONCILE: 2, RADAR: 3, DEEP: 4, BACKGROUND: 5 };

class Bucket {
  /** capacity tokens, refilled at ratePerMs */
  constructor(capacity, ratePerMs, now) {
    this.capacity = capacity;
    this.ratePerMs = ratePerMs;
    this.tokens = capacity;
    this.updatedAt = now;
  }
  refill(now) {
    const dt = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.ratePerMs);
    this.updatedAt = now;
  }
  msUntil(cost, now) {
    this.refill(now);
    if (this.tokens >= cost) return 0;
    if (cost > this.capacity) return Infinity;
    return Math.ceil((cost - this.tokens) / this.ratePerMs);
  }
  take(cost) {
    this.tokens -= cost;
  }
}

export class RequestScheduler {
  /**
   * @param {object} groups name -> [{capacity, perMs}] (all buckets must allow the request)
   */
  constructor({ groups, clock = { now: () => Date.now() }, maxInFlight = 4, logger = null }) {
    this.clock = clock;
    this.logger = logger;
    this.maxInFlight = maxInFlight;
    this.groups = {};
    const now = clock.now();
    for (const [name, limits] of Object.entries(groups)) {
      this.groups[name] = {
        buckets: limits.map((l) => new Bucket(l.capacity, l.capacity / l.perMs, now)),
        pausedUntil: 0,
        sent: 0,
        rateLimited: 0,
        recent: [] // timestamps for per-minute stats
      };
    }
    this.queue = [];
    this.inFlight = 0;
    this.timer = null;
    this.seq = 0;
    this.closed = false;
  }

  static fromConfig(cfg, opts = {}) {
    const SEC = 1000;
    const MIN = 60 * SEC;
    const DAY = 24 * 60 * MIN;
    return new RequestScheduler({
      ...opts,
      groups: {
        public: [{ capacity: 1, perMs: SEC / cfg.API_PUBLIC_PER_SEC }],
        auth: [{ capacity: 20, perMs: SEC }, { capacity: cfg.API_AUTH_PER_MIN, perMs: MIN }],
        // candles cost max(5000, count) tokens of 5,000,000/min => at most 1000 requests/min; we keep 150/min.
        candles: [{ capacity: 10, perMs: SEC }, { capacity: 150, perMs: MIN }],
        orders: [{ capacity: 5, perMs: SEC }, { capacity: cfg.API_ORDERS_PER_DAY, perMs: DAY }]
      }
    });
  }

  /** Schedule fn() under a group budget. Resolves/rejects with fn's result. */
  schedule(group, fn, { priority = PRIORITY.BACKGROUND, cost = 1, label = "" } = {}) {
    if (!this.groups[group]) return Promise.reject(new Error("Unknown scheduler group " + group));
    if (this.closed) return Promise.reject(new Error("Scheduler closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ group, fn, priority, cost, label, resolve, reject, seq: this.seq++, enqueuedAt: this.clock.now() });
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.#pump();
    });
  }

  /** Called by the HTTP layer after a 429: pause the whole group. */
  pauseGroup(group, ms, reason = "rate limit") {
    const g = this.groups[group];
    if (!g) return;
    g.pausedUntil = Math.max(g.pausedUntil, this.clock.now() + ms);
    g.rateLimited++;
    this.logger?.warn(`API group ${group} paused ${ms}ms (${reason})`);
  }

  queueDepth(group, maxPriority = 99) {
    return this.queue.filter((t) => (!group || t.group === group) && t.priority <= maxPriority).length;
  }

  stats() {
    const now = this.clock.now();
    const out = {};
    for (const [name, g] of Object.entries(this.groups)) {
      g.recent = g.recent.filter((t) => now - t < 60000);
      out[name] = { lastMinute: g.recent.length, total: g.sent, rateLimited: g.rateLimited, paused: g.pausedUntil > now, queued: this.queueDepth(name) };
    }
    return out;
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const t of this.queue) t.reject(new Error("Scheduler closed"));
    this.queue = [];
  }

  #pump() {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = this.clock.now();
    let soonest = Infinity;
    for (let i = 0; i < this.queue.length && this.inFlight < this.maxInFlight; ) {
      const task = this.queue[i];
      const g = this.groups[task.group];
      let wait = Math.max(0, g.pausedUntil - now);
      if (wait === 0) for (const b of g.buckets) wait = Math.max(wait, b.msUntil(task.cost, now));
      if (wait === Infinity) {
        // Cost can never be satisfied: fail fast instead of hanging.
        this.queue.splice(i, 1);
        task.reject(new Error(`Request cost ${task.cost} exceeds ${task.group} capacity`));
        continue;
      }
      if (wait > 0) {
        soonest = Math.min(soonest, wait);
        i++;
        continue; // a lower-priority task in another group may still run
      }
      for (const b of g.buckets) b.take(task.cost);
      g.sent++;
      g.recent.push(now);
      this.queue.splice(i, 1);
      this.inFlight++;
      Promise.resolve()
        .then(() => task.fn())
        .then(task.resolve, task.reject)
        .finally(() => {
          this.inFlight--;
          this.#pump();
        });
    }
    if (this.queue.length && soonest < Infinity) {
      this.timer = setTimeout(() => this.#pump(), Math.max(5, soonest));
    }
  }
}
