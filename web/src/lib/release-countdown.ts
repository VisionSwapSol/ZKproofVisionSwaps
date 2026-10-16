// Noon PST is UTC-8. Use an explicit offset so every visitor sees the same deadline.
export const RELEASE_DATE = "2026-10-15T12:00:00-08:00";
export const RELEASE_AT = Date.parse(RELEASE_DATE);

export function getReleaseCountdown(now = Date.now()) {
  const remaining = Math.max(0, Math.ceil((RELEASE_AT - now) / 1000));
  return {
    hours: Math.floor(remaining / 3600),
    minutes: Math.floor((remaining % 3600) / 60),
    seconds: remaining % 60,
    complete: remaining === 0,
  };
}
