import fs from "node:fs/promises";
import path from "node:path";
const DATA_DIR = path.resolve("data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const DEFAULT_STATE = { day: "", realizedPnl: 0, trades: [], position: null };
export async function loadState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { return { ...DEFAULT_STATE, ...JSON.parse(await fs.readFile(STATE_FILE, "utf8")) }; }
  catch { return { ...DEFAULT_STATE }; }
}
export async function saveState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}