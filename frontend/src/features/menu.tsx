// The Settings panel (tool rail, D-066): display settings, installing the
// app, and what the site is: source code, license and privacy policy.
import { useStore } from '../state/store'
import type { ThemeChoice } from '../theme'
import { LICENSE_HREF, PRIVACY_URL, SOURCE_HREF, SOURCE_REVISION } from '../links'
import { resetEverything } from '../reset'

const THEMES: [ThemeChoice, string][] = [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]

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
      <h3>Reset</h3>
      <p className="muted">Forget everything this site stored in your browser: layer choices, theme, filters, the saved copy of the mesh data and the offline cache. The page then reloads and fetches the data again.</p>
      <button className="danger" onClick={() => window.confirm('Clear all stored data and settings, and reload?') && void resetEverything()}>
        Reset and reload
      </button>
      {SOURCE_REVISION && <p className="muted menu-foot">Version {SOURCE_REVISION.slice(0, 7)}</p>}
    </div>
  )
}
