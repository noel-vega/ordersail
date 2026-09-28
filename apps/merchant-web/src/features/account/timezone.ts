// this browser's canonical spelling of a zone, or null when it isn't a named
// zone it knows. The API canonicalises with Node's ICU, which can pick a
// different (legacy) name for the same zone — "Asia/Calcutta" where the
// browser says "Asia/Kolkata" — so a stored value is passed through here
// before being matched against the browser's own zone list. Offsets
// ("+05:00") are refused, same as the API (OS-667)
export function canonicalTimeZone(zone: string): string | null {
  try {
    const canonical = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
    }).resolvedOptions().timeZone
    return /^[+-]/.test(canonical) ? null : canonical
  } catch {
    return null
  }
}

// the zone to start a new account's reporting timezone on, or undefined to
// let the API default to UTC. A browser that can't detect its host zone
// reports "Etc/Unknown", which the API would 400 — failing the whole signup
export function detectTimeZone(): string | undefined {
  return (
    canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ??
    undefined
  )
}
