/**
 * Pulls the client's first-hop IP from the request headers. Vercel sets
 * x-forwarded-for with the chain (client first, edge last) so we trust the
 * leftmost entry. Falls back to x-real-ip and finally null when neither is
 * present (e.g. local non-proxied dev). Used by the rate-limit middleware
 * and the signup route's IP-capture step.
 */
export function getClientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip');
}

/** Vercel returns the IANA name (e.g. "America/Los_Angeles") in this header. */
export function getClientTimezoneName(req: Request): string | null {
  return req.headers.get('x-vercel-ip-timezone');
}

/**
 * Best-effort conversion of an IANA timezone name to a UTC offset in
 * minutes (e.g. "America/Los_Angeles" → -480 in PST, -420 in PDT).
 * Returns null on any parse failure — the caller treats null as "unknown,
 * skip the timezone-mismatch signal."
 */
export function tzNameToOffsetMinutes(tzName: string | null): number | null {
  if (!tzName) return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzName,
      timeZoneName: 'longOffset',
    });
    const parts = fmt.formatToParts(new Date());
    const offsetStr = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (!offsetStr) return null;
    const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(offsetStr);
    if (!m) return offsetStr === 'GMT' ? 0 : null;
    const sign = m[1] === '+' ? 1 : -1;
    const hours = Number(m[2] ?? 0);
    const minutes = Number(m[3] ?? 0);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return sign * (hours * 60 + minutes);
  } catch {
    return null;
  }
}
