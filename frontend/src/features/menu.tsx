// The Settings panel (tool rail, D-066): display settings, installing the
// app, and what the site is: source code, license and privacy policy.
import { useEffect, useState } from 'react'
import { DEFAULT_MAX_NODES, MAX_NODES_RANGE, useStore } from '../state/store'
import type { ThemeChoice } from '../theme'
import { LICENSE_HREF, PRIVACY_URL, REVISION_HREF, SOURCE_HREF, SOURCE_REVISION } from '../links'
import { resetEverything } from '../reset'

const THEMES: [ThemeChoice, string][] = [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]

/**
 * How many nodes the map keeps, the most active first (D-182). Applied when
 * the field is left or Enter pressed: every change rebuilds every view.
 */
function MaxNodes() {
  const value = useStore((s) => s.toggles.maxNodes)
  const setT = useStore((s) => s.setToggles)
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const n = Math.round(Number(draft))
    if (!Number.isFinite(n) || draft.trim() === '') return setDraft(String(value))
    const v = Math.min(Math.max(n, MAX_NODES_RANGE[0]), MAX_NODES_RANGE[1])
    setDraft(String(v))
    if (v !== value) setT({ maxNodes: v })
  }
  return (
    <>
      <h3 id="settings-max-nodes">Nodes on the map</h3>
      <p className="muted small">
        At most this many nodes are shown, the most active first ({DEFAULT_MAX_NODES.toLocaleString('en')} by default). More costs memory and makes every
        update slower; links, estimates and counts always use every node.
      </p>
      <input
        type="number" aria-labelledby="settings-max-nodes" min={MAX_NODES_RANGE[0]} max={MAX_NODES_RANGE[1]} step={500}
        value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
      {value !== DEFAULT_MAX_NODES && (
        <>
          {' '}
          <button className="linkish" onClick={() => setT({ maxNodes: DEFAULT_MAX_NODES })}>Reset to {DEFAULT_MAX_NODES.toLocaleString('en')}</button>
        </>
      )}
    </>
  )
}

export function SettingsPanel({ canInstall, install }: { canInstall: boolean; install: () => void }) {
  const theme = useStore((s) => s.toggles.theme)
  const setT = useStore((s) => s.setToggles)
  const id = 'settings'
  return (
    <div className="panel settings">
      <h3 id={`${id}-theme`}>Theme</h3>
      <div className="segmented" role="radiogroup" aria-labelledby={`${id}-theme`}>
        {THEMES.map(([v, label]) => (
          <label key={v} title={v === 'system' ? 'Follow your browser\'s light or dark setting' : undefined}>
            <input type="radio" name={`${id}-theme`} value={v} checked={theme === v} onChange={() => setT({ theme: v })} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <MaxNodes />
      {canInstall && (
        <>
          <h3>App</h3>
          <button className="menu-item" onClick={install}>Install 868.no Map on this device</button>
        </>
      )}
      <h3>About</h3>
      <nav aria-label="About this site">
        <a className="menu-item" href={SOURCE_HREF} target="_blank" rel="noreferrer">Source code on GitHub ↗</a>
        <a className="menu-item" href={LICENSE_HREF} target="_blank" rel="noreferrer">License: GNU GPL v3 ↗</a>
        <a className="menu-item" href={PRIVACY_URL} target="_blank" rel="noreferrer">Privacy policy ↗</a>
      </nav>
      <p className="muted small version">
        Version{' '}
        {SOURCE_REVISION ? (
          <a href={REVISION_HREF} target="_blank" rel="noreferrer" title={`Built from commit ${SOURCE_REVISION}`}><code>{SOURCE_REVISION.slice(0, 7)}</code></a>
        ) : (
          <span title="Built without a source revision (set SOURCE_REVISION when building the web image)">development build</span>
        )}
      </p>
      <h3>Reset</h3>
      <p className="muted">Forget everything this site stored in your browser: layer choices, theme, the saved copy of the mesh data and the offline cache. The page then reloads and fetches the data again.</p>
      <button className="danger" onClick={() => window.confirm('Clear all stored data and settings, and reload?') && void resetEverything()}>
        Reset and reload
      </button>
    </div>
  )
}
