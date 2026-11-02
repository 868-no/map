// The tool rail on the right edge: every control panel in one place (D-066).
// One panel at a time opens beside the rail, over the map; pressing the open
// panel's button again, its close button or Escape closes it.
import type { ReactNode } from 'react'

export type PanelId = 'nodes' | 'details' | 'health' | 'period' | 'filters' | 'layers' | 'legend' | 'settings'

const ICON_PROPS = { viewBox: '0 0 20 20', width: 20, height: 20, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const ICONS: Record<PanelId, ReactNode> = {
  nodes: (
    <svg {...ICON_PROPS}><circle cx="4.5" cy="5.5" r="1.3" /><circle cx="4.5" cy="10" r="1.3" /><circle cx="4.5" cy="14.5" r="1.3" /><path d="M8.5 5.5h8M8.5 10h8M8.5 14.5h8" /></svg>
  ),
  details: (
    <svg {...ICON_PROPS}><circle cx="10" cy="10" r="7.2" /><path d="M10 9v5" /><circle cx="10" cy="6.4" r="0.6" fill="currentColor" /></svg>
  ),
  health: (
    <svg {...ICON_PROPS}><path d="M2.5 10.5h3.2l1.8-4 3 8 2-5.5 1.3 1.5h3.7" /></svg>
  ),
  period: (
    <svg {...ICON_PROPS}><circle cx="10" cy="10" r="7.2" /><path d="M10 5.8V10l2.8 1.8" /></svg>
  ),
  filters: <svg {...ICON_PROPS}><path d="M3 4h14l-5.5 6.5v5L8.5 17v-6.5L3 4Z" /></svg>,
  layers: (
    <svg {...ICON_PROPS}><path d="M10 3 2.5 7 10 11l7.5-4L10 3Z" /><path d="m2.5 10.5 7.5 4 7.5-4" /><path d="m2.5 14 7.5 4 7.5-4" /></svg>
  ),
  legend: (
    <svg {...ICON_PROPS}><rect x="3" y="3.5" width="4.5" height="4.5" rx="1" /><circle cx="5.25" cy="13.75" r="2.25" /><path d="M10.5 5.75h6.5M10.5 13.75h6.5" /></svg>
  ),
  settings: (
    <svg {...ICON_PROPS}><path d="M3 6h14M3 14h14" /><circle cx="7.5" cy="6" r="2" fill="var(--panel)" /><circle cx="12.5" cy="14" r="2" fill="var(--panel)" /></svg>
  ),
}

export const PANELS: { id: PanelId; label: string; hint: string }[] = [
  { id: 'nodes', label: 'Nodes', hint: 'Find a node by name or ID' },
  { id: 'details', label: 'Details', hint: 'The selected node or link (closing it clears the selection)' },
  { id: 'health', label: 'Health', hint: 'Known problems in the mesh, and who uses the airtime' },
  { id: 'period', label: 'Period', hint: 'The time window: its length, start and end' },
  { id: 'filters', label: 'Filters', hint: 'Which observations and links count' },
  { id: 'layers', label: 'Layers', hint: 'What the map shows' },
  { id: 'legend', label: 'Legend', hint: 'What the colours, sizes and lines mean' },
  { id: 'settings', label: 'Settings', hint: 'Theme, install, source code, license and privacy' },
]

export const panelLabel = (id: PanelId) => PANELS.find((p) => p.id === id)!.label

export function Rail({ open, onToggle, badges }: { open: PanelId | null; onToggle: (p: PanelId) => void; badges: Partial<Record<PanelId, number>> }) {
  const button = (p: (typeof PANELS)[number]) => {
    const n = badges[p.id] ?? 0
    return (
      <button key={p.id} className="rail-btn" aria-pressed={open === p.id} aria-controls="dock" aria-label={p.label}
        title={`${p.hint}${n ? ` (${n} ${p.id === 'health' ? 'problems and warnings' : 'active'})` : ''}`} onClick={() => onToggle(p.id)}>
        {ICONS[p.id]}
        <span className="rail-label">{p.label}</span>
        {n > 0 && <span className="rail-badge" aria-hidden>{n}</span>}
      </button>
    )
  }
  return (
    <nav className="rail" aria-label="Controls">
      {PANELS.map(button)}
    </nav>
  )
}

/** The open panel, docked beside the rail over the map. */
export function Dock({ open, onClose, children }: { open: PanelId | null; onClose: () => void; children: ReactNode }) {
  return (
    <aside id="dock" className="dock" aria-label={open ? panelLabel(open) : 'Panel'} hidden={!open}>
      <header className="dock-head">
        <h2>{open && panelLabel(open)}</h2>
        <button className="close" onClick={onClose} aria-label={`Close ${open ? panelLabel(open).toLowerCase() : 'panel'}`} title={open === 'details' ? 'Close and clear the selection (Esc)' : 'Close (Esc)'}>×</button>
      </header>
      <div className="dock-body">{children}</div>
    </aside>
  )
}
