import { useEffect, useState } from 'react'
import { ApiError, getJSON } from '../../api/client'
import type { NodeKey } from '../../api/types'
import type { MeshNode, NodeView } from '../../derive/views'
import { formatLocal, relativeAge } from '../../lib/time'
import { precisionErrorM } from '../../map/model'
import { useStore } from '../../state/store'
import { NR, SigBadge, dist } from './shared'

const METHOD: Record<string, string> = { weighted_centroid: 'weighted centre of the nodes that hear it', ranged_centroid: 'weighted centre of the nodes that hear it, moved by distances from signal strength (they are all to one side)', log_distance_wls: 'distances from signal strength' }
const QUALITY: Record<string, string> = { very_low: 'very rough', low: 'rough' }

/** The Overview tab: identity, position and activity. */
export function OverviewTab({ d, snapNode, now, names }: { d: NodeView; snapNode: MeshNode | undefined; now: number; names: Map<string, string> }) {
  const select = useStore((s) => s.select)
  const est = snapNode?.estimate
  const pos = d.position // a stale one is never shown as its position (D-094)
  return (
    <>
      <dl>
        <dt>Short name</dt><dd>{d.identity?.short_name || NR}</dd>
        <dt>Hardware</dt><dd>{d.identity?.hw_model || NR}</dd>
        <dt>Role</dt><dd>{d.identity?.role || NR}</dd>
        {(d.node_status ?? []).length > 0 && (
          <>
            <dt title="The status text the node broadcasts about itself (node status app, firmware 2.7.20 and later)">Status</dt>
            <dd>
              <q className="node-status">{d.node_status![0].status}</q> <small className="muted">· {formatLocal(d.node_status![0].at)}</small>
              {d.node_status!.length > 1 && (
                <ul className="status-history">
                  {d.node_status!.slice(1).map((s) => <li key={s.at}><span className="muted">earlier:</span> {s.status} <small className="muted">· {formatLocal(s.at)}</small></li>)}
                </ul>
              )}
            </dd>
          </>
        )}
        <dt>Identity</dt>
        <dd>
          {!d.identity ? NR : d.identity.source === 'mapreport' ? (
            <span title="No NodeInfo from this node in the selected period: name, hardware and role come from the map report it sends to the MQTT broker itself">
              from its own map report · {formatLocal(d.identity.observed_at)}
            </span>
          ) : (
            <><SigBadge s={d.identity.signature} /> {d.identity.has_public_key ? 'announces a public key' : 'no public key'} · {formatLocal(d.identity.observed_at)}</>
          )}
        </dd>
        {d.identity?.node_id_from && (
          <>
            <dt>Node id</dt>
            <dd>
              {d.identity.node_id_from === 'key' ? (
                <span title="Firmware 2.8 and later derive the node id from the public key (CRC-32 of the key); this node's id matches its key">derived from its key: firmware 2.8 or newer</span>
              ) : (
                <span title="Firmware 2.7 and earlier take the node id from the hardware. Upgrading to 2.8 with the key kept gives the id derived from the key; a reset without restoring the key gives a new key and an unrelated id">
                  from its hardware: firmware 2.7 or older
                  {d.identity.key_id && (names.has(d.identity.key_id) ? (
                    // Its key's id is heard in the window too: upgraded (or a copy, see Health).
                    <> · now also heard as <button className="linkish" onClick={() => select({ kind: 'node', id: d.identity!.key_id! })}>{names.get(d.identity.key_id)}</button>, the id its key derives</>
                  ) : (
                    <> · becomes {d.identity.key_id} on 2.8 if its key is kept</>
                  ))}
                </span>
              )}
            </dd>
          </>
        )}
        <dt>Public key</dt>
        <dd><PublicKey key={d.id} id={d.id} optOut={d.mqtt_opt_out} /></dd>
        <dt>Position</dt>
        <dd>
          {d.stale_position && (
            <div className="stale-note" title="A reported position more than a day older than the newest data in the selected period (a week for routers, base stations and nodes that have stayed in one place) may no longer be where the node is (D-094, D-138)">
              Last reported position is stale: {formatLocal(d.stale_position.observed_at)}.{' '}
              {est ? 'Estimated instead:' : 'No estimate could be made, so it is not on the map.'}
            </div>
          )}
          {pos ? (
            <>
              {pos.lat.toFixed(5)}, {pos.lon.toFixed(5)}
              {pos.alt !== undefined && pos.alt !== null && <> · {pos.alt} m above sea level</>}
              <br />
              <small>
                {pos.source === 'mapreport' ? 'from map report · ' : ''}
                {pos.precision_known
                  ? pos.precision_bits >= 32
                    ? 'full precision'
                    : <span title={`Shared with ${pos.precision_bits} precision bits: firmware reports the centre of a cell this size, so it is somewhere within this distance`}>± {dist(precisionErrorM(pos.precision_bits, pos.lat))}</span>
                  : 'precision unknown'} · <SigBadge s={pos.signature} /> · {formatLocal(pos.observed_at)}
              </small>
              {d.refined && (
                <div className="refined" title="Its reports jump around one place: combined, they narrow down where it is. The map places it here (D-077).">
                  Narrowed to {d.refined.lat.toFixed(5)}, {d.refined.lon.toFixed(5)} ± {d.refined.radius_m < 1000 ? `${Math.round(d.refined.radius_m)} m` : `${(d.refined.radius_m / 1000).toFixed(1)} km`}
                  <br />
                  <small>
                    from {d.refined.agree} of {d.refined.reports} reports{d.refined.agree < d.refined.reports ? `; ${d.refined.reports - d.refined.agree} outlying ones set aside as noise` : ''}
                  </small>
                </div>
              )}
            </>
          ) : est ? (
            <span className="est-note">
              Estimated location{d.stale_position ? '' : ' (not reported)'}: {est.lat.toFixed(3)}, {est.lon.toFixed(3)} ± {dist(est.uncertainty_radius_m)}
              <br />
              <small title="Anchors: nodes with a precise reported position that heard it directly. Samples: those receptions.">
                {QUALITY[est.quality] ?? est.quality} estimate from the {METHOD[est.method] ?? est.method}: {est.anchor_count} anchors, {est.sample_count} receptions. {(est.reasons ?? []).join(' ')}
              </small>
            </span>
          ) : (
            <>
              {!d.stale_position && NR}
              {snapNode?.estimate_note && <>{!d.stale_position && <br />}<small>No estimate: {snapNode.estimate_note}</small></>}
            </>
          )}
        </dd>
        {d.moved_at && (
          <>
            <dt title="It moved more than 300 m (2 km for routers and base stations) beyond what its position precision explains (D-073, D-139)">Moving</dt>
            <dd>
              last moved {formatLocal(d.moved_at)} · {d.track?.length ?? 0}{(d.track?.length ?? 0) >= 100 ? '+' : ''} reported places in the window{d.airborne && <> · <span className="tag">✈ airborne</span></>}
              <br /><small className="muted">Its links count only evidence from after that move.</small>
            </dd>
          </>
        )}
        <dt title="First and last time anything from it, or uplinked by it as a gateway, reached the broker">Seen in window</dt>
        <dd>
          {d.first_seen ? `${formatLocal(d.first_seen)} → ${formatLocal(d.last_seen)} (${relativeAge(d.last_seen, now)})`
            : d.last_referenced ? <span title="Never heard itself: only named in others' NeighborInfo or traceroutes">named by others, last {formatLocal(d.last_referenced)} ({relativeAge(d.last_referenced, now)})</span> : NR}
        </dd>
        <dt>Traffic</dt>
        <dd>
          <span title="Distinct packets it sent that reached the broker">{d.packets} unique packets</span> ·{' '}
          <span title="Receptions of its packets by other gateways, over the air (one per gateway and copy)">{d.receptions - (d.own_uplinks ?? 0)} receptions by other gateways</span>
          {(d.own_uplinks ?? 0) > 0 && <span title="Its own packets it uplinked itself as a gateway, its map reports among them: not radio receptions"> · {d.own_uplinks} uplinked itself</span>}
          {d.is_gateway && <span title="Other nodes' packets it uplinked as a gateway"> · uplinked {d.gateway_receptions - (d.own_uplinks ?? 0)} of others'</span>}
        </dd>
      </dl>
    </>
  )
}

/** The node's public key from the whole retained log (keys identify a node, not a window). */
function PublicKey({ id, optOut }: { id: string; optOut?: boolean }) {
  const [k, setK] = useState<NodeKey | 'none' | 'error' | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const ctl = new AbortController()
    getJSON<NodeKey>(`/api/v1/nodes/${encodeURIComponent(id)}/public-key`, undefined, ctl.signal)
      .then(setK)
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setK(e instanceof ApiError && e.status === 404 ? 'none' : 'error')
      })
    return () => ctl.abort()
  }, [id])
  if (k === null) return <span className="muted">…</span>
  if (k === 'none')
    return optOut ? (
      <span className="muted" title="This node does not allow MQTT uplink, so its NodeInfo (which carries the key) is not stored when another gateway uplinks it">none retained (NodeInfo not stored)</span>
    ) : (
      <span className="muted" title="No NodeInfo carrying a public key from this node is retained">none retained</span>
    )
  if (k === 'error') return <span className="muted">unavailable</span>
  const key = k.public_key || k.trusted_key || ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(key)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      /* clipboard refused */
    }
  }
  const differs = !!k.trusted_key && !!k.public_key && k.trusted_key !== k.public_key
  return (
    <>
      <code className="pubkey">{key}</code>{' '}
      <button className="linkish" onClick={() => void copy()} title="Copy the key (base64)">{copied ? 'Copied' : 'Copy'}</button>
      <br />
      <small>
        {k.announced_at && <>announced {formatLocal(k.announced_at)}</>}
        {k.trusted_key && !differs && k.trusted_since && <span title="The first verified NodeInfo with this key: signatures from this node are checked against it (trust on first use)"> · trusted since {formatLocal(k.trusted_since)}</span>}
        {!k.trusted_key && <span title="No signed NodeInfo verified under this key is retained, so signatures from this node cannot be checked"> · not verified</span>}
      </small>
      {differs && (
        <p className="opt-out-note" title="Signatures are checked against the trusted key, so packets signed with the new one are not verified until the trusted key's NodeInfo ages out of retention">
          Differs from the key trusted since {formatLocal(k.trusted_since!)}: <code className="pubkey">{k.trusted_key}</code>
        </p>
      )}
    </>
  )
}
