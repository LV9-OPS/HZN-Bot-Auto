import test from "node:test";
import assert from "node:assert/strict";
import { DiscordNotifier } from "../../src/notifications/discord.js";
import { makeCfg, ManualClock, nullLogger } from "../helpers.js";

const HOOK = "https://discord.com/api/webhooks/123456/SECRET_TOKEN_abc";

function notifier() {
  const posts = [];
  const clock = new ManualClock();
  const n = new DiscordNotifier({ webhookUrl: HOOK, mode: "paper", cfg: makeCfg(), logger: nullLogger(), clock, fetchImpl: async (url, init) => { posts.push(JSON.parse(init.body).content); return { ok: true, status: 204 }; }, priceOf: () => ({ bid: 101 }) });
  return { n, posts, clock };
}

const pos = { id: "p", symbol: "SOL-USDC", qty: 0.05, initialQty: 0.05, entryPrice: 100, costBasisQuote: 5.0045, entryFeeQuote: 0.0045, plan: { targetMultiple: 2, floorMultiple: 1, name: "X2->X1" }, targetReached: false, protection: { nativeOrderIds: [] }, signal: { explanation: "score 70 [...]" } };

test("submitted vs filled are clearly distinguished and include price, qty, PnL, reason and protection", async () => {
  const { n, posts } = notifier();
  n.orderSubmitted({ position: pos, side: "buy", order: { type: "limit", timeInForce: "ioc", baseSize: "0.05", price: "100.1" } });
  n.entryFilled({ position: pos });
  await n.flush();
  assert.match(posts[0], /SOUMIS\*\* \(pas encore exécuté\)/);
  assert.match(posts[1], /EXÉCUTÉ/);
  assert.match(posts[1], /Entrée moyenne : 100/);
  assert.match(posts[1], /Quantité : 0\.05/);
  assert.match(posts[1], /PnL net estimé/);
  assert.match(posts[1], /Pourquoi/);
  assert.match(posts[1], /Stop-loss -3%/);
  assert.match(posts[1], /LOGICIELLE/);
});

test("repeated errors are deduplicated with a cooldown; webhook URL never leaks", async () => {
  const { n, posts, clock } = notifier();
  n.error(new Error("boom " + HOOK), "radar");
  n.error(new Error("boom " + HOOK), "radar");
  await n.flush();
  assert.equal(posts.length, 1);
  assert.ok(!posts[0].includes("SECRET_TOKEN_abc"));
  clock.advance(16 * 60000);
  n.error(new Error("boom " + HOOK), "radar");
  await n.flush();
  assert.equal(posts.length, 2);
});
