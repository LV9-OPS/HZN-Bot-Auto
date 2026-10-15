// npm run check : syntax-check every .js file (node --check) without running it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const roots = ["src", "tools", "tests"];
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
};
for (const r of roots) if (fs.existsSync(r)) walk(r);
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    bad++;
    console.error(`SYNTAX ERROR ${f}\n${e.stderr?.toString()}`);
  }
}
console.log(`${files.length - bad}/${files.length} files OK`);
process.exit(bad ? 1 : 0);
