// Regions (D-194): the mesh per landsdel, for the people who look after it
// there. The list compares the five; a region's page gathers its nodes,
// problems, channel use and growth, and can be shared as a link. Both show
// what the nodes run: hardware, firmware, roles and presets (D-196).
import { memo, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getJSON } from '../api/client'
import type { components } from '../api/schema'
import type { Issue, RegionSummary, SnapshotView } from '../derive/views'
import { useHealth, useRegionsView } from '../state/data'
import { toQuery, useStore } from '../state/store'
import { namesOf } from '../map/model'
import { PALETTES } from '../map/palette'
import { REGION_LABELS } from '../map/regionData'
import { useTheme } from '../theme'
import { BarChart } from '../components/BarChart'
import { useFlash } from '../lib/useFlash'
import { IssueLine, KIND } from './health'
import { FleetSection } from './fleet'

type Trends = components['schemas']['TrendsBody']
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const NO_ISSUES: Issue[] = []

function useRegionTrends(region: string) {
  return useQuery({
    queryKey: ['trends', 'week', TZ, region],
    queryFn: ({ signal }) => getJSON<Trends>('/api/v1/trends', new URLSearchParams({ bucket: 'week', tz: TZ, region }), signal),
    staleTime: 15 * 60_000,
  })
}

/** Problems and warnings (and notices) among a region's nodes. */
function issuesOf(issues: Issue[], members: Set<string>) {
  const mine = issues.filter((i) => members.has(i.node))
  return { mine, problems: mine.filter((i) => i.severity === 'problem').length, warnings: mine.filter((i) => i.severity === 'warning').length }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function RegionsPanel({ snapshot }: { snapshot: SnapshotView | undefined }) {
  const region = useStore((s) => s.region)
  const setRegion = useStore((s) => s.setRegion)
  const v = useRegionsView()
  const issues = useHealth().data?.issues ?? NO_ISSUES
  const palette = PALETTES[useTheme()]
  // One style object per region and theme, so the memoised page is not re-rendered for a new one.
  const swatches = useMemo(() => new Map(REGION_LABELS.map((l) => [l.name, { background: `rgb(${palette.regions[l.id].join(',')})` }])), [palette])
  const swatch = (name: string) => swatches.get(name)
  if (!v.data) return <div className="panel muted">Summing up the regions…</div>
  if (!v.data.loaded) return <div className="panel muted">Loading the region outlines…</div>
  const r = v.data.regions.find((x) => x.name === region)
  if (r) return <RegionPage r={r} issues={issues} snapshot={snapshot} swatch={swatch(r.name)} />
  return (
    <div className="panel regions-panel">
      <p className="muted small">Norway's five regions in the selected period: nodes by where they are (reported or estimated), problems and warnings from Health. Open one for its page.</p>
      <ul className="region-list">
        {v.data.regions.map((x) => {
          const { problems, warnings } = issuesOf(issues, new Set(x.members))
          return (
            <li key={x.name}>
              <button className="region-row" onClick={() => setRegion(x.name)}>
                <span className="region-swatch" style={swatch(x.name)} aria-hidden />
                <span className="region-name">{x.name}</span>
                <span className="region-facts">
                  {plural(x.nodes, 'node')} · {plural(x.gateways, 'gateway')} · {plural(x.routers, 'router')}
                  {x.ch_util !== undefined && <> · channel {Math.round(x.ch_util)} %</>}
                </span>
                {(problems > 0 || warnings > 0) && (
                  <span className={`region-issues${problems ? ' bad' : ''}`}>{[problems && plural(problems, 'problem'), warnings && plural(warnings, 'warning')].filter(Boolean).join(', ')}</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {v.data.outside > 0 && <p className="muted small">{plural(v.data.outside, 'node')} placed outside every region (abroad or at sea).</p>}
      <FleetSection fleet={v.data.mesh} />
    </div>
  )
}

/** A link to this region's page, with the period and filters in view. */
function ShareRegion({ name }: { name: string }) {
  const [state, flash] = useFlash<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    try {
      // The page's own address: the region, period and filters, never the selected node (which would open Details instead).
      const { win, filters } = useStore.getState()
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?${toQuery({ win, filters, region: name }).toString()}`)
      flash('copied')
    } catch {
      flash('failed')
    }
  }
  return (
    <button className="linkish share-link" onClick={() => void copy()} title={`Copy a link to ${name}'s page, for the period and filters shown`}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Share'}
    </button>
  )
}

const RegionPage = memo(function RegionPage({ r, issues, snapshot, swatch }: { r: RegionSummary; issues: Issue[]; snapshot: SnapshotView | undefined; swatch?: React.CSSProperties }) {
  const select = useStore((s) => s.select)
  const setRegion = useStore((s) => s.setRegion)
  const setToggles = useStore((s) => s.setToggles)
  const goToPlace = useStore((s) => s.goToPlace)
  const names = namesOf(snapshot?.nodes)
  const name = (id: string) => names.get(id) ?? id
  const [notices, setNotices] = useState(false)
  const { mine, problems, warnings } = useMemo(() => issuesOf(issues, new Set(r.members)), [issues, r.members])
  const groups = useMemo(() => {
    const g = new Map<string, Issue[]>()
    for (const i of mine) if (notices || i.severity !== 'notice') g.set(i.kind, [...(g.get(i.kind) ?? []), i])
    return [...g]
  }, [mine, notices])
  const noticeCount = mine.length - problems - warnings
  const t = useRegionTrends(r.name)
  const charts = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: TZ })
    const b = t.data?.buckets ?? []
    return {
      nodes: b.map((x) => ({ label: `week of ${fmt.format(new Date(x.start))}`, value: x.nodes, part: x.new_nodes })),
      gateways: b.map((x) => ({ label: `week of ${fmt.format(new Date(x.start))}`, value: x.gateways })),
    }
  }, [t.data])
  const show = () => {
    const at = REGION_LABELS.find((x) => x.name === r.name)
    setToggles({ regions: true })
    if (at) goToPlace({ lon: at.pos[0], lat: at.pos[1], zoom: at.zoom, name: r.name, ring: false })
  }
  return (
    <div className="panel region-page">
      <button className="linkish region-back" onClick={() => setRegion(null)}>‹ All regions</button>
      <div className="node-title">
        <h3 className="region-title"><span className="region-swatch" style={swatch} aria-hidden />{r.name}</h3>
        <ShareRegion name={r.name} />
      </div>
      <dl className="region-stats">
        <dt>Nodes here</dt><dd title="Nodes whose reported position or estimate lies in the region">{r.nodes}</dd>
        <dt>Routers</dt><dd>{r.routers}</dd>
        <dt>Home stations</dt><dd>{r.bases}</dd>
        <dt>Gateways</dt><dd>{r.gateways}</dd>
        <dt>Through its topic</dt><dd title={`Nodes and gateways in rows uplinked under a topic root naming ${r.name} (msh/…/${r.name}/…), wherever they are`}>{plural(r.topic_nodes, 'node')}, {plural(r.topic_gateways, 'gateway')}</dd>
        <dt>Channel use</dt>
        <dd title="The median of the channel utilisation its nodes reported (each node's own median over the period)">
          {r.ch_util === undefined ? 'no reports' : <>{Math.round(r.ch_util)} % median of {plural(r.ch_util_nodes, 'node')}{r.busiest && <>; busiest <button className="linkish" onClick={() => select({ kind: 'node', id: r.busiest![0] })}>{name(r.busiest[0])}</button> {Math.round(r.busiest[1])} %</>}</>}
        </dd>
      </dl>
      <p><button className="linkish" onClick={show}>Show on the map</button></p>
      <h3>Problems and warnings ({problems + warnings})</h3>
      {groups.length === 0 && <p className="muted">None among its nodes in the selected period.</p>}
      {groups.map(([kind, list]) => (
        <section key={kind}>
          <h4>{KIND[kind] ?? kind} ({list.length})</h4>
          <ul className="issues">{list.map((i) => <IssueLine key={i.kind + i.node} i={i} name={name} />)}</ul>
        </section>
      ))}
      {noticeCount > 0 && <p><button className="linkish" onClick={() => setNotices(!notices)}>{notices ? 'Hide' : 'Show'} {plural(noticeCount, 'notice')}</button></p>}
      <FleetSection fleet={r.fleet} where={`whose position or estimate lies in ${r.name}`} />
      <h3>Growth, week by week</h3>
      <p className="muted small">Over everything the server keeps, counted from rows uplinked under a topic root naming {r.name}: gateways set to another region's topic count there, and nodes heard only by those are missed. Not affected by the period or filters.</p>
      {t.isLoading && <p className="muted">Counting…</p>}
      {t.error && <p className="muted">Trends are unavailable right now.</p>}
      {charts.nodes.length > 0 && (
        <div className="tcharts">
          <BarChart title="Nodes heard" partLabel="new" note="Distinct nodes heard through its topic root; new: first heard that week" bars={charts.nodes} />
          <BarChart title="Gateways" note="Distinct gateways uplinking under its topic root" bars={charts.gateways} />
        </div>
      )}
    </div>
  )
})
