import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, getJSON } from '../../api/client'
import type { NodeContact } from '../../api/types'
import { useFlash } from '../../lib/useFlash'
import { formatLocal } from '../../lib/time'
import { SigBadge } from './shared'

/**
 * Adds the node to a Meshtastic app's contacts (D-213): the app's own
 * shared-contact link, as a QR code to scan and as a link to open or copy.
 * Only for a node that announced a public key: the apps refuse a keyless
 * contact.
 */
export function ImportNode({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="linkish import-link" aria-haspopup="dialog" onClick={() => setOpen(true)}
        title="Add this node to the Meshtastic app on your phone, with its public key, from a QR code or a link">
        Import
      </button>
      {open && <ContactDialog id={id} name={name} onClose={() => setOpen(false)} />}
    </>
  )
}

function ContactDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  const q = useQuery({
    queryKey: ['contact', id],
    queryFn: ({ signal }) =>
      getJSON<NodeContact>(`/api/v1/nodes/${encodeURIComponent(id)}/contact`, undefined, signal).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return 'none' as const
        throw e
      }),
    staleTime: 10 * 60_000,
    retry: false,
  })
  const c = q.isError ? 'error' : (q.data ?? null)
  return (
    // A click on the backdrop lands on the dialog itself, outside its content.
    <dialog ref={ref} className="contact-dialog" aria-labelledby="contact-title" onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) ref.current?.close() }}>
      <div className="contact-body">
        <h2 id="contact-title">Import {name}</h2>
        {c === null && <p className="muted">Loading…</p>}
        {c === 'error' && <p className="muted">The contact could not be made right now. Try again in a moment.</p>}
        {c === 'none' && <p className="muted">No NodeInfo with a name and a public key is retained for this node, so there is nothing an app could import.</p>}
        {typeof c === 'object' && c !== null && <ContactLink c={c} />}
        <button className="contact-close" onClick={() => ref.current?.close()}>Close</button>
      </div>
    </dialog>
  )
}

/**
 * The contact link as the app on this device opens it from inside a
 * browser, or null without one (D-213). Both apps claim the https link, but
 * only when the system handles the tap: embedded browsers and installed web
 * apps load meshtastic.org/v/ themselves, a blank page. So Android gets an
 * intent: URL naming the app (Android splits it at the last #, so the
 * link's own fragment survives) and iOS the app's meshtastic: scheme, whose
 * parser takes meshtastic:///v#payload.
 */
export function appLink(url: string, ua: string): string | null {
  const i = url.indexOf('#')
  if (i < 0) return null
  const payload = url.slice(i + 1)
  if (/Android/i.test(ua)) return `intent://meshtastic.org/v/#${payload}#Intent;scheme=https;package=com.geeksville.mesh;end`
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return `meshtastic:///v#${payload}`
  return null
}

function ContactLink({ c }: { c: NodeContact }) {
  const open = appLink(c.url, navigator.userAgent)
  const [copied, flash] = useFlash<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(c.url)
      flash('copied')
    } catch {
      flash('failed')
    }
  }
  return (
    <>
      <p className="small">Scan the code with the Meshtastic app (Android or iPhone){open ? ', or open it in the app on this device' : ''}. The app adds the node to your radio&apos;s contacts with its public key, so you can send it direct messages.</p>
      <QrCode text={c.url} label={`QR code: ${c.long_name} as a Meshtastic contact`} />
      <p className="contact-actions">
        {open && <a className="contact-open" href={open}>Open in Meshtastic</a>}
        <button className="linkish" onClick={() => void copy()}>{copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Could not copy' : 'Copy link'}</button>
      </p>
      <p className="muted small">
        From its NodeInfo of {formatLocal(c.observed_at)} <SigBadge s={c.signature} />.{' '}
        {c.signature === 'unsigned' && 'Unsigned, so this service cannot confirm the key is the node’s own. '}
        Compare the key with the node&apos;s owner before you rely on it.
      </p>
    </>
  )
}

/** A QR code as one SVG path; the encoder loads with the first one. */
function QrCode({ text, label }: { text: string; label: string }) {
  const [qr, setQr] = useState<{ text: string; size: number; path: string } | null>(null)
  useEffect(() => {
    let live = true
    void import('uqr').then(({ encode }) => {
      // Medium error correction: still a small code for a ~150-character link.
      const { data, size } = encode(text, { ecc: 'M', border: 2 })
      let path = ''
      data.forEach((row, y) => row.forEach((on, x) => { if (on) path += `M${x} ${y}h1v1h-1z` }))
      if (live) setQr({ text, size, path })
    })
    return () => { live = false }
  }, [text])
  if (qr?.text !== text) return <div className="contact-qr" aria-busy="true" />
  return (
    <svg className="contact-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#000" />
    </svg>
  )
}
