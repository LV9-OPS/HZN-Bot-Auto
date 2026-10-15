// Single-instance guard. Two bots on the same state would double-trade.
import fs from "node:fs";
import path from "node:path";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours
  }
}

export function acquireLock(dataDir, mode) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, `bot.${mode}.lock`);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      const release = () => {
        try {
          const cur = JSON.parse(fs.readFileSync(file, "utf8"));
          if (cur.pid === process.pid) fs.unlinkSync(file);
        } catch { /* ignore */ }
      };
      return { file, release };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let info = {};
      try { info = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* corrupt lock */ }
      if (info.pid && alive(info.pid)) {
        throw new Error(`Another HZN bot instance (${mode}) is running with PID ${info.pid} (lock ${file}). Stop it first.`);
      }
      // stale lock from a crashed process
      fs.unlinkSync(file);
    }
  }
  throw new Error("Could not acquire instance lock");
}
