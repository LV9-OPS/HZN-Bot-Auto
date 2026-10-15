// Secret redaction applied to every log line and every Discord message.

const PATTERNS = [
  [/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'`)]+/gi, "<discord-webhook>"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<private-key>"],
  [/(x-revx-(?:api-key|signature)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1<redacted>"],
  [/((?:api[_-]?key|secret|token|signature|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, "$1<redacted>"]
];

const exactSecrets = new Set();

/** Register concrete secret values (API key, webhook) so they are removed wherever they appear. */
export function registerSecret(value) {
  if (value && String(value).length >= 8) exactSecrets.add(String(value));
}

export function redact(input) {
  let s = typeof input === "string" ? input : safeStringify(input);
  for (const secret of exactSecrets) s = s.split(secret).join("<redacted>");
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

export function safeStringify(obj) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, (k, v) => {
      if (v instanceof Error) return { name: v.name, message: v.message, code: v.code, status: v.status };
      if (typeof v === "bigint") return v.toString();
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return String(obj);
  }
}
