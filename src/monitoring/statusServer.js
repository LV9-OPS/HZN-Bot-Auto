// Local status endpoint/dashboard bound to 127.0.0.1 only (never exposed on the LAN).
import http from "node:http";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function startStatusServer({ port, getStatus, logger }) {
  if (!port) return null;
  const server = http.createServer((req, res) => {
    try {
      const status = getStatus();
      if (req.url === "/health") {
        res.writeHead(status.healthy ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ healthy: status.healthy, mode: status.mode, issues: status.issues, at: status.at }));
        return;
      }
      if (req.url === "/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(status, null, 2));
        return;
      }
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderHtml(status));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      res.writeHead(500);
      res.end("error");
    }
  });
  server.on("error", (e) => logger.warn("status server error", { err: e.message }));
  server.listen(port, "127.0.0.1", () => logger.info(`status dashboard on http://127.0.0.1:${port}/`));
  return server;
}

function renderHtml(s) {
  const rows = (arr, cols) => arr.map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof c === "function" ? c(r) : r[c])}</td>`).join("")}</tr>`).join("");
  const perf = s.performance || {};
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>HZN Bot Auto</title>
<style>body{font:14px system-ui;margin:16px;background:#111;color:#ddd}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #333;padding:4px 8px}h2{margin-top:20px}.live{color:#f55;font-weight:bold}.paper{color:#5cf;font-weight:bold}.bad{color:#f88}.ok{color:#8f8}</style></head><body>
<h1>HZN Bot Auto <span class="${esc(s.mode)}">${esc(String(s.mode).toUpperCase())}</span></h1>
<p>Health: <b class="${s.healthy ? "ok" : "bad"}">${s.healthy ? "OK" : "DEGRADED"}</b> ${esc((s.issues || []).join(" | "))}<br>Entries: ${s.entryGate?.ok ? '<b class="ok">allowed</b>' : `<b class="bad">blocked</b> ${esc((s.entryGate?.reasons || []).map((r) => r.code).join(", "))}`}<br>Updated ${esc(s.at)} | uptime ${esc(s.uptimeMin)} min</p>
<h2>Capital</h2><p>Budget ${esc(s.capital?.budget)} USDC | deployed ${esc(s.capital?.deployed?.toFixed?.(4))} | remaining ${esc(s.capital?.remaining?.toFixed?.(4))} | quote balance ${esc(s.capital?.quoteBalance)}</p>
<h2>Positions</h2><table><tr><th>Symbol</th><th>Slot/Plan</th><th>Status</th><th>Qty</th><th>Entry</th><th>Bid</th><th>Stop</th><th>Target</th><th>Floor armed</th><th>Net PnL est.</th><th>Protection</th></tr>
${rows(s.positions || [], ["symbol", (r) => `${r.slot} ${r.plan}`, "status", "qty", "entryPrice", "bid", "stopPrice", "targetPrice", (r) => (r.targetReached ? "YES @" + r.floorPrice : "no"), "netPnl", "protection"])}</table>
<h2>Performance (net of fees)</h2><p>Realized ${esc(perf.realizedNetPnl?.toFixed?.(4))} | Unrealized ${esc(perf.unrealizedNetPnl?.toFixed?.(4))} | Fees ${esc(perf.totalFees?.toFixed?.(4))} | Trades ${esc(perf.trades)} | Win rate ${esc(perf.winRate === null ? "n/a" : (perf.winRate * 100).toFixed(0) + "%")} | Max DD ${esc(perf.maxDrawdown?.toFixed?.(4))} | Today ${esc(perf.dailyRealized?.toFixed?.(4))}</p>
<h2>Scanner leaderboard</h2><table><tr><th>Symbol</th><th>Ref</th><th>Score</th><th>Qualified</th><th>Why</th><th>Age s</th></tr>${rows(s.leaderboard || [], ["symbol", "ref", "score", "qualified", "why", "ageSec"])}</table>
<h2>Discrepancies</h2><table>${rows((s.discrepancies || []).filter((d) => !d.resolved), ["severity", "kind", "symbol", (d) => JSON.stringify(d.details)])}</table>
<h2>Unmanaged holdings</h2><table>${rows(s.unmanagedHoldings || [], ["currency", "total", "valueQuote", "note"])}</table>
<h2>API</h2><pre>${esc(JSON.stringify(s.api, null, 1))}</pre>
<h2>Top rejection reasons</h2><pre>${esc(JSON.stringify(s.rejections, null, 1))}</pre>
</body></html>`;
}
