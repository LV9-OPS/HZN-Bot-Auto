// Structured logger: human-readable console + JSON lines in rotating files.
// Every line passes through redact() so secrets cannot reach disk or console.
import fs from "node:fs";
import path from "node:path";
import { redact, safeStringify } from "./redact.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor({ dir = null, level = "info", console: useConsole = true, maxBytes = 20 * 1024 * 1024, keepDays = 14, timeZone = "Europe/Paris" } = {}) {
    this.dir = dir;
    this.level = LEVELS[level] ?? 20;
    this.useConsole = useConsole;
    this.maxBytes = maxBytes;
    this.keepDays = keepDays;
    this.timeZone = timeZone;
    this.currentFile = null;
    this.currentDay = null;
    this.bytes = 0;
    this.memory = []; // last lines for the status page
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.#cleanup();
    }
  }

  child(component) {
    const parent = this;
    return {
      debug: (msg, data) => parent.log("debug", component, msg, data),
      info: (msg, data) => parent.log("info", component, msg, data),
      warn: (msg, data) => parent.log("warn", component, msg, data),
      error: (msg, data) => parent.log("error", component, msg, data)
    };
  }

  log(level, component, msg, data) {
    if ((LEVELS[level] ?? 20) < this.level) return;
    const ts = new Date().toISOString();
    const entry = { ts, level, component, msg };
    if (data !== undefined) entry.data = data;
    const line = redact(safeStringify(entry));
    this.memory.push(line);
    if (this.memory.length > 200) this.memory.shift();
    if (this.useConsole) {
      const local = new Date().toLocaleTimeString("fr-FR", { timeZone: this.timeZone });
      const tail = data === undefined ? "" : " " + redact(safeStringify(data));
      const out = `[${local}] ${level.toUpperCase().padEnd(5)} ${component.padEnd(10)} ${redact(msg)}${tail}`;
      (level === "error" || level === "warn" ? console.error : console.log)(out);
    }
    if (this.dir) this.#write(line + "\n");
  }

  #write(text) {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.currentDay || this.bytes > this.maxBytes) {
      let idx = 0;
      let file;
      do {
        file = path.join(this.dir, `hzn-${day}${idx ? "." + idx : ""}.log`);
        idx++;
      } while (fs.existsSync(file) && fs.statSync(file).size > this.maxBytes);
      this.currentFile = file;
      this.currentDay = day;
      this.bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    }
    try {
      fs.appendFileSync(this.currentFile, text, "utf8");
      this.bytes += Buffer.byteLength(text);
    } catch {
      // Logging must never crash the bot.
    }
  }

  #cleanup() {
    try {
      const cutoff = Date.now() - this.keepDays * 86400000;
      for (const f of fs.readdirSync(this.dir)) {
        if (!/^hzn-\d{4}-\d{2}-\d{2}/.test(f)) continue;
        const p = path.join(this.dir, f);
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      }
    } catch {
      /* ignore */
    }
  }
}

/** Silent logger for tests. */
export function nullLogger() {
  const noop = () => {};
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l, memory: [] };
  return l;
}
