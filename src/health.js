import "dotenv/config";
import http from "node:http";
import { RevolutX } from "./revolut.js";
const port = Number(process.env.PORT || 3000);
const api = new RevolutX();
const server = http.createServer((req, res) => {
  if (req.url !== "/health") { res.writeHead(404); res.end("Not found"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, mode: process.env.BOT_MODE || "paper", configured: api.configured, time: new Date().toISOString() }));
});
server.listen(port, "0.0.0.0", () => console.log("HZN Bot health listening on port " + port));
