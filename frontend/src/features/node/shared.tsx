// Labels and formatting shared by the node panel's tabs.

export const NR = <span className="nr">not reported in selected period</span>

/** Firmware Routing.Error names in plain words (D-092). */
const ROUTING_ERROR: Record<string, string> = {
  NO_ROUTE: 'no route', GOT_NAK: 'refused', TIMEOUT: 'timed out', NO_INTERFACE: 'no interface', MAX_RETRANSMIT: 'gave up after retries',
  NO_CHANNEL: 'no matching channel', TOO_LARGE: 'too large', NO_RESPONSE: 'no response', DUTY_CYCLE_LIMIT: 'duty-cycle limit',
  BAD_REQUEST: 'bad request', NOT_AUTHORIZED: 'not authorised', PKI_FAILED: 'encryption failed', PKI_UNKNOWN_PUBKEY: "doesn't know the sender's key",
  ADMIN_BAD_SESSION_KEY: 'admin session expired', ADMIN_PUBLIC_KEY_UNAUTHORIZED: 'admin key not authorised', RATE_LIMIT_EXCEEDED: 'rate limited',
  PKI_SEND_FAIL_PUBLIC_KEY: "no key for the recipient",
}
export const routingError = (e?: string) => (e ? ROUTING_ERROR[e] ?? e.toLowerCase().replaceAll('_', ' ') : 'error')

export const SIG_LABEL: Record<string, string> = { verified: 'signature verified', unsigned: 'unsigned', unverifiable: 'signed, key unknown', 'not-applicable': 'not signable' }
const SIG_SHORT: Record<string, string> = { verified: '✓', unsigned: '–', unverifiable: '?', 'not-applicable': 'n/a' }

export function SigBadge({ s, compact = false }: { s: string; compact?: boolean }) {
  return <span className={`sig sig-${s}`} title={compact ? SIG_LABEL[s] ?? s : undefined}>{(compact ? SIG_SHORT : SIG_LABEL)[s] ?? s}</span>
}

export function fmt(v: number | undefined | null, unit: string, digits = 1) {
  return v === undefined || v === null ? '—' : `${v.toFixed(digits)} ${unit}`
}

/** A distance for people: metres below 1 km, else km with one decimal. */
export const dist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`)
