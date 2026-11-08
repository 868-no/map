// What the nodes run over everything the server keeps (D-198): the
// /api/v1/trends/fleet answer laid out as stacked bars, one series per value
// of the chosen dimension, labelled and coloured for the chart.
import type { components } from '../api/schema'
import { hardwareName, presetName, roleLabel } from '../lib/deviceNames'
import { GENERATION } from './fleet'

type FleetTrends = components['schemas']['FleetTrendsBody']
type FleetValue = components['schemas']['FleetValue']

export type Dimension = 'firmware' | 'hardware' | 'role' | 'preset'

export const DIMENSION_NAME: Record<Dimension, string> = { firmware: 'Firmware', hardware: 'Hardware', role: 'Role', preset: 'Preset' }

export interface Series {
  key: string
  label: string
  title: string
  color: string // a CSS colour: var(--series-n) and the greys
}

export interface Stack {
  start: string
  total: number // nodes heard; the counts sum to it
  counts: number[] // per series
}

/** Firmware keeps fixed colours for its inferred generations, after the five reported lines (the server's fold). */
const GENERATION_SLOT: Record<string, number> = { key: 6, hardware: 7, no_hop_start: 8 }

const UNKNOWN_TITLE: Record<Dimension, string> = {
  firmware: GENERATION.unknown[1].replace('in the period', 'then'),
  hardware: 'No NodeInfo or map report of its own says',
  role: 'No NodeInfo or map report of its own says',
  preset: 'Neither a map report of its own proves it, nor was it heard on a preset\'s default channel name',
}

function label(dim: Dimension, v: FleetValue): [string, string] {
  if (v.kind === 'others') return [`${v.folded ?? 0} others`, `${v.folded ?? 0} less common values, summed`]
  if (v.kind === 'unknown') return ['unknown', UNKNOWN_TITLE[dim]]
  switch (dim) {
    case 'firmware':
      if (v.basis === 'reported') return [v.name, `${v.name}.x, as the nodes' own map reports state it`]
      return GENERATION[v.name] ?? [v.name, '']
    case 'hardware':
      return [hardwareName(v.name), v.name]
    case 'role':
      return [roleLabel(v.name), v.name]
    case 'preset':
      return [presetName(v.name), v.name]
  }
}

/** The chosen dimension's series (in the server's order) and each bucket's counts in that order. */
export function fleetStacks(data: FleetTrends | undefined, dim: Dimension): { series: Series[]; stacks: Stack[] } {
  if (!data) return { series: [], stacks: [] }
  let slot = 0
  const series = (data[dim].values ?? []).map((v): Series => {
    const [l, title] = label(dim, v)
    let color: string
    if (v.kind === 'others') color = 'var(--series-others)'
    else if (v.kind === 'unknown') color = 'var(--series-unknown)'
    else if (dim === 'firmware' && v.basis !== 'reported') color = `var(--series-${GENERATION_SLOT[v.name] ?? 8})`
    else color = `var(--series-${Math.min(++slot, 8)})`
    return { key: `${v.kind}:${v.name}`, label: l, title, color }
  })
  const stacks = (data.buckets ?? []).map((b) => {
    const counts = b[dim] ?? []
    return { start: b.start, total: b.nodes, counts: series.map((_, i) => counts[i] ?? 0) }
  })
  return { series, stacks }
}
