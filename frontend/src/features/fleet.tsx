// What a set of nodes runs (D-196): roles, hardware, presets and firmware,
// as the regions view counts them, for the Regions panel's list (the whole
// mesh) and each region's page.
import { useState } from 'react'
import type { FirmwareCount, Fleet, FleetCount } from '../derive/views'
import { hardwareName, presetName, roleLabel } from '../lib/deviceNames'

/** Entries shown before the rest fold into "n others". */
const TOP = 6

interface Bar {
  key: string
  label: string
  title?: string
  nodes: number
  /** Shown below it on request (a firmware line's exact versions). */
  detail?: FleetCount[]
}

const UNKNOWN = 'unknown'

/** Inferred firmware generations: never a version, so labelled as such. */
export const GENERATION: Record<string, [string, string]> = {
  key: ['2.8 or later (inferred)', 'No map report states its version, but its node id is derived from its public key, as firmware 2.8 and later do'],
  hardware: ['2.7 or earlier (inferred)', 'No map report states its version, but it announces a public key while its node id comes from its hardware, as on firmware 2.7 and earlier'],
  no_hop_start: ['before 2.3 (inferred)', 'No map report states its version, and its packets carry no hop start, which firmware has sent since 2.3'],
  unknown: ['unknown', 'No map report states its version, and its packets in the period say nothing about it'],
}

function firmwareBar(c: FirmwareCount): Bar {
  if (c.basis === 'reported') {
    const v = c.version ?? ''
    return { key: `v${v}`, label: v, title: `${v}.x, as the nodes' own map reports state it`, nodes: c.nodes, detail: c.versions }
  }
  const [label, title] = GENERATION[c.basis] ?? [c.basis, '']
  return { key: c.basis, label, title, nodes: c.nodes }
}

const plainBars = (list: FleetCount[], name: (s: string) => string): Bar[] =>
  list.map((c) => (c.name === UNKNOWN ? { key: UNKNOWN, label: 'unknown', title: 'Not reported in the selected period', nodes: c.nodes } : { key: c.name, label: name(c.name), title: c.name, nodes: c.nodes }))

function BarRow({ b, total }: { b: Bar; total: number }) {
  const [open, setOpen] = useState(false)
  const width = { width: `${total ? (100 * b.nodes) / total : 0}%` }
  return (
    <li>
      <span className="fleet-label" title={b.title}>
        {b.detail?.length ? (
          <button className="linkish" aria-expanded={open} onClick={() => setOpen(!open)} title={`${b.title}: ${open ? 'hide' : 'show'} exact versions`}>{b.label} {open ? '▾' : '▸'}</button>
        ) : b.label}
      </span>
      <span className="fleet-bar" aria-hidden><span style={width} /></span>
      <span className="fleet-count">{b.nodes}</span>
      {open && b.detail && (
        <ul className="fleet-versions">
          {b.detail.map((v) => <li key={v.name}><span>{v.name}</span><span className="fleet-count">{v.nodes}</span></li>)}
        </ul>
      )}
    </li>
  )
}

/** Bars in the engine's order, unknown last; with `fold`, past the top few the rest become "n others" (expandable). */
function Bars({ title, bars, total, fold = true }: { title: string; bars: Bar[]; total: number; fold?: boolean }) {
  const [all, setAll] = useState(false)
  const unknown = bars.filter((b) => b.key === UNKNOWN)
  const known = bars.filter((b) => b.key !== UNKNOWN)
  const shown = all || !fold || known.length <= TOP + 1 ? known : known.slice(0, TOP)
  const rest = known.slice(shown.length)
  return (
    <section className="fleet-group">
      <h4>{title}</h4>
      {bars.length === 0 ? <p className="muted small">None.</p> : (
        <ul className="fleet-bars">
          {shown.map((b) => <BarRow key={b.key} b={b} total={total} />)}
          {rest.length > 0 && (
            <li>
              <span className="fleet-label"><button className="linkish" onClick={() => setAll(true)}>{rest.length} others</button></span>
              <span className="fleet-bar" aria-hidden><span style={{ width: `${total ? (100 * rest.reduce((s, b) => s + b.nodes, 0)) / total : 0}%` }} /></span>
              <span className="fleet-count">{rest.reduce((s, b) => s + b.nodes, 0)}</span>
            </li>
          )}
          {unknown.map((b) => <BarRow key={b.key} b={b} total={total} />)}
        </ul>
      )}
    </section>
  )
}

/** The breakdown, with what it counts in words. `where`: "in the region" or empty for the whole mesh. */
export function FleetSection({ fleet, where }: { fleet: Fleet; where?: string }) {
  const n = fleet.nodes
  return (
    <section className="fleet" aria-label="Hardware and firmware">
      <h3>Hardware and firmware</h3>
      <p className="muted small">
        {n === 1 ? '1 node' : `${n} nodes`} heard in the selected period{where ? ` ${where}` : ', placed on the map or not'}.
        Firmware is exact only where a node's own map report states it; for the rest the generation is inferred from its packets.
        Presets are as each node's Radio tab infers them.
      </p>
      {n > 0 && (
        <div className="fleet-groups">
          <Bars title="Firmware" bars={fleet.firmware.map(firmwareBar)} total={n} fold={false} />
          <Bars title="Hardware" bars={plainBars(fleet.hardware, hardwareName)} total={n} />
          <Bars title="Role" bars={plainBars(fleet.roles, roleLabel)} total={n} />
          <Bars title="Preset" bars={plainBars(fleet.presets, presetName)} total={n} />
        </div>
      )}
    </section>
  )
}
