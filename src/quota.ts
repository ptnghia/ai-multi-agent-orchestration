/**
 * Recognises "out of quota / rate limited" failures in agent error output.
 * Only applied to error text (stderr, error fields, failure events), never to
 * the agent's normal output, which may legitimately mention "429" or "quota".
 */
const QUOTA_PATTERNS = [
  /usage limit/i,
  /rate[ _-]?limit/i,
  /\bquota\b/i,
  /RESOURCE_EXHAUSTED/,
  /\b429\b/,
  /too many requests/i,
  /insufficient (credits|balance|funds)/i,
  /out of credits/i,
  /credit balance is too low/i,
  /exceeded your (current )?(plan|quota|usage)/i,
];

export function isQuotaError(text: string): boolean {
  return QUOTA_PATTERNS.some((re) => re.test(text));
}

const UNIT_MINUTES: Record<string, number> = { s: 1 / 60, sec: 1 / 60, second: 1 / 60, m: 1, min: 1, minute: 1, h: 60, hr: 60, hour: 60, d: 1440, day: 1440 };

/**
 * Parses "try again in 2 days 5 hours", "retry after 120s", "resets in 45 minutes"
 * into minutes. Returns undefined when no duration is stated.
 */
export function parseRetryAfterMinutes(text: string): number | undefined {
  const m = /(?:try again|retry|resets?|available again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (!m) return undefined;
  let total = 0;
  for (const [, n, unit] of m[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    // Drop a plural "s" ("hours"), but not the bare seconds unit ("90s").
    const lower = unit.toLowerCase();
    const key = lower.length > 1 ? lower.replace(/s$/, '') : lower;
    const factor = UNIT_MINUTES[key] ?? UNIT_MINUTES[key.slice(0, 1)];
    if (factor !== undefined) total += Number(n) * factor;
  }
  return total > 0 ? Math.ceil(total) : undefined;
}
