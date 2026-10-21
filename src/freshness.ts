/** A duration is deliberately explicit: bare numbers and ambiguous units are rejected. */
export function parseDuration(value?: string): number {
  if (value === undefined) return 0;
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value);
  if (!match)
    throw new Error("Expected a duration such as 30s, 1m, 30m or 4h.");
  const scale: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const ms = Number(match[1]) * scale[match[2]!]!;
  if (!Number.isSafeInteger(ms) || ms <= 0)
    throw new Error(
      "Duration must be positive and represent whole milliseconds.",
    );
  return ms;
}
export function isFresh(
  checkedAt: string | undefined,
  windowMs: number,
  now = Date.now(),
): boolean {
  if (!checkedAt || !windowMs) return false;
  const age = now - Date.parse(checkedAt);
  return Number.isFinite(age) && age >= 0 && age < windowMs;
}
