import { Fragment, useMemo } from 'react'
import { useWatch } from '../../state/watch'
import { useFlash } from '../../lib/useFlash'
import { NodeHealth } from '../health'
import { ViewError, type SnapshotView } from '../../derive/views'
import { useNodeDetail } from '../../state/data'
import { nodeLink, useStore, type DetailTab } from '../../state/store'
import { relativeAge } from '../../lib/time'
import { isOnline, namesOf } from '../../map/model'
import { linkNeighbours } from './sort'
import { OverviewTab } from './Overview'
import { TelemetryTab } from './Telemetry'
import { LinksTab } from './Links'
import { RadioTab } from './Radio'
import { PacketsTab } from './Packets'

export function NodePanel({ id, snapshot }: { id: string; snapshot: SnapshotView | undefined }) {
  const { data, isLoading, error } = useNodeDetail(id)
  const tab = useStore((s) => s.detailTab)
  const now = snapshot ? Date.parse(snapshot.meta.window.end) : Date.now()
  const names = namesOf(snapshot?.nodes)
  const neighbours = useMemo(() => linkNeighbours(snapshot?.edges ?? [], id, names), [snapshot, id, names])
  if (isLoading) return <div className="panel">Loading {id}…</div>
  if (error) return <div className="panel">{error instanceof ViewError && error.kind === 'not_found' ? `No data for ${id} in the selected window.` : `Details for ${id} could not be built right now (${error.message}). They will load again with the next update.`}</div>
  if (!data) return null
  const d = data
  return (
    <div className="panel node-panel">
      <div className="node-title">
        <h2>{d.identity?.long_name || d.id}</h2>
        <WatchButton id={d.id} />
        <ShareNode id={d.id} name={d.identity?.long_name || d.id} />
      </div>
      <p className="muted node-id">{d.id} · #{d.num}</p>
      <p className="node-tags">
        {isOnline(d, now)
          ? <span className="tag online" title="Heard within the last 3 hours of the selected period">● online</span>
          : <span className="tag offline" title="Not heard in the last 3 hours of the selected period">offline{d.last_seen ? ` · last heard ${relativeAge(d.last_seen, now)}` : ''}</span>}{' '}
        {d.status === 'referenced' && <span className="tag">referenced only — not directly observed</span>}
        {d.is_gateway &&
          (d.multi_uplink ? (
            <span className="tag gw" title="Uplinks every copy of a packet it hears, each with the last hop it came from, not only the first (a firmware option): its reports show more of the routes packets take">
              ⏫ MQTT gateway, every copy
            </span>
          ) : (
            <span className="tag gw" title="Uplinks the packets it hears to the MQTT broker (the first copy of each)">↑ MQTT gateway</span>
          ))}
        {d.mqtt_downlink && (
          <span className="tag gw" title={`Probably transmits packets it takes from the MQTT broker: ${d.mqtt_downlink.zero_snr} of ${d.mqtt_downlink.traceroutes} traceroutes reached it at exactly 0 dB, the reading a packet from MQTT gets`}>
            ↓ MQTT downlink (probable)
          </span>
        )}
      </p>
      {d.mqtt_opt_out && (
        <p className="opt-out-note">This node did not allow MQTT uplink, but some of its packets reached us through another gateway. Its name and NodeInfo are not stored.</p>
      )}
      <NodeHealth id={d.id} />
      <DetailTabs counts={{ links: neighbours.length, packets: d.packets }} />
      <div role="tabpanel" id="detail-tabpanel" aria-labelledby={`detail-tab-${tab}`}>
        {tab === 'overview' && <OverviewTab d={d} now={now} names={names} />}
        {tab === 'telemetry' && <TelemetryTab d={d} snapshot={snapshot} now={now} />}
        {tab === 'links' && <LinksTab d={d} id={id} snapshot={snapshot} names={names} neighbours={neighbours} />}
        {tab === 'radio' && <RadioTab d={d} names={names} />}
        {tab === 'packets' && <PacketsTab d={d} id={id} snapshot={snapshot} names={names} />}
      </div>
    </div>
  )
}

const TABS: { id: DetailTab; label: string; hint: string }[] = [
  { id: 'overview', label: 'Overview', hint: 'Identity, position and activity' },
  { id: 'links', label: 'Links', hint: 'Radio links, gateways that heard it, reach and relaying' },
  { id: 'radio', label: 'Radio', hint: 'Region, preset, channels, MQTT topics and brokers' },
  { id: 'telemetry', label: 'Telemetry', hint: 'Battery, power, channel use and sensor readings, charted over the selected period' },
  { id: 'packets', label: 'Packets', hint: 'Packet log, delivery reports, airtime and signatures' },
]

/** The node panel's tabs (D-098); the choice is kept when another node is selected. */
function DetailTabs({ counts }: { counts: Partial<Record<DetailTab, number>> }) {
  const tab = useStore((s) => s.detailTab)
  const setTab = useStore((s) => s.setDetailTab)
  const onKey = (e: React.KeyboardEvent) => {
    const k = TABS.findIndex((t) => t.id === tab)
    const next = e.key === 'ArrowRight' ? k + 1 : e.key === 'ArrowLeft' ? k - 1 : -2
    if (next === -2) return
    e.preventDefault()
    const t = TABS[(next + TABS.length) % TABS.length]
    setTab(t.id)
    document.getElementById(`detail-tab-${t.id}`)?.focus()
  }
  return (
    <div className="detail-tabs" role="tablist" aria-label="Node details" onKeyDown={onKey}>
      <span className="tab-edge" aria-hidden />
      {TABS.map((t, k) => (
        <Fragment key={t.id}>
          {k > 0 && <span className="tab-gap" aria-hidden />}
          <button id={`detail-tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls={tab === t.id ? 'detail-tabpanel' : undefined} tabIndex={tab === t.id ? 0 : -1} title={t.hint} onClick={() => setTab(t.id)}>
            {t.label}{counts[t.id] !== undefined && <span className="tab-count">{counts[t.id]}</span>}
          </button>
        </Fragment>
      ))}
      <span className="tab-edge end" aria-hidden />
    </div>
  )
}

/** Keeps the node on the watchlist (D-192), in the Nodes panel. */
function WatchButton({ id }: { id: string }) {
  const on = useWatch((s) => s.ids.includes(id))
  const toggle = useWatch((s) => s.toggle)
  return (
    <button className="linkish watch-toggle" aria-pressed={on} onClick={() => toggle(id)} title={on ? 'Stop watching this node' : 'Watch this node: it is listed at the top of the Nodes panel, with when it was last heard and its battery'}>
      {on ? '★ Watching' : '☆ Watch'}
    </button>
  )
}

/**
 * A permanent link to the node (D-080): the node alone, so it keeps working
 * whatever window or filters the viewer had. The phone's share sheet when
 * there is one, otherwise copied to the clipboard.
 */
function ShareNode({ id, name }: { id: string; name: string }) {
  const [state, flash] = useFlash<'idle' | 'copied' | 'failed'>('idle')
  const share = async () => {
    const url = nodeLink(id)
    try {
      if (navigator.share && window.matchMedia?.('(pointer: coarse)').matches) {
        await navigator.share({ title: `${name} on 868.no Map`, url })
        return
      }
      await navigator.clipboard.writeText(url)
      flash('copied')
    } catch (e) {
      if ((e as Error).name === 'AbortError') return // the share sheet was dismissed
      flash('failed')
    }
  }
  return (
    <button className="linkish share-link" onClick={() => void share()} title={`Copy a permanent link to this node: ${nodeLink(id)}`}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Share'}
    </button>
  )
}
