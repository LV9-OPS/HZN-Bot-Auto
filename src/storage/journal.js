// Append-only, fsync'd journals. The order registry is independent from the
// state file: even if state.json were lost, every client_order_id the bot ever
// submitted is still known, so its holdings can be re-identified on the exchange.
import fs from "node:fs";
import path from "node:path";
import { appendLineDurable } from "./atomicFile.js";
import { redact } from "../monitoring/redact.js";

export class Journal {
  constructor({ dataDir, mode }) {
    this.ordersFile = path.join(dataDir, `orders.${mode}.jsonl`);
    this.eventsFile = path.join(dataDir, `events.${mode}.jsonl`);
  }

  /** Must be called BEFORE an order is sent. */
  recordOrderIntent(intent) {
    appendLineDurable(this.ordersFile, JSON.stringify({ ...intent, ts: new Date().toISOString(), record: "intent" }));
  }

  recordOrderUpdate(update) {
    appendLineDurable(this.ordersFile, JSON.stringify({ ...update, ts: new Date().toISOString(), record: "update" }));
  }

  event(kind, data) {
    try {
      appendLineDurable(this.eventsFile, redact(JSON.stringify({ ts: new Date().toISOString(), kind, ...data })));
    } catch {
      /* events are best-effort */
    }
  }

  /** Map clientOrderId -> latest merged record. */
  loadOrders() {
    const out = new Map();
    if (!fs.existsSync(this.ordersFile)) return out;
    const lines = fs.readFileSync(this.ordersFile, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (!r.clientOrderId) continue;
        out.set(r.clientOrderId, { ...(out.get(r.clientOrderId) || {}), ...r });
      } catch {
        // A torn last line after a crash is expected; skip it.
      }
    }
    return out;
  }
}
