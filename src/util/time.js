export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Injectable clock so tests and replay can control time. */
export const systemClock = { now: () => Date.now() };

/** Day key in a given IANA time zone (default UTC). */
export function dayKey(ts = Date.now(), timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isoNow(clock = systemClock) {
  return new Date(clock.now()).toISOString();
}
