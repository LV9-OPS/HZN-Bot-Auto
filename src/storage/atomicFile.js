import fs from "node:fs";
import path from "node:path";

/**
 * Atomic write: write to a temp file, fsync, then rename over the target.
 * On Windows rename-over-existing can fail transiently (AV scanners, indexers),
 * so we retry a few times before giving up.
 */
export function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) break;
      const until = Date.now() + 25 * (i + 1);
      while (Date.now() < until) {
        /* short synchronous back-off */
      }
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  throw lastErr;
}

/** Append one line and fsync (journal durability). */
export function appendLineDurable(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, line.endsWith("\n") ? line : line + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
