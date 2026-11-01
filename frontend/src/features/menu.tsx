// The app menu (top bar, ☰): display settings, installing the app, and what
// the site is: source code, license and privacy policy.
import { useStore } from '../state/store'
import type { ThemeChoice } from '../theme'
import { LICENSE_HREF, PRIVACY_URL, SOURCE_HREF, SOURCE_REVISION } from '../links'

const THEMES: [ThemeChoice, string][] = [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]

export function AppMenu({ id, onClose, canInstall, install }: { id: string; onClose: () => void; canInstall: boolean; install: () => void }) {
  const theme = useStore((s) => s.toggles.theme)
  const setT = useStore((s) => s.setToggles)
  return (
    <div id={id} className="popover menu" role="dialog" aria-label="Menu" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <button className="close" onClick={onClose} aria-label="Close menu">×</button>
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
          <button className="menu-item" onClick={() => { install(); onClose() }}>Install Mesh Observatory on this device</button>
        </>
      )}
      <h3>About</h3>
      <nav aria-label="About this site">
        <a className="menu-item" href={SOURCE_HREF} target="_blank" rel="noreferrer">Source code on GitHub ↗</a>
        <a className="menu-item" href={LICENSE_HREF} target="_blank" rel="noreferrer">License: GNU GPL v3 ↗</a>
        <a className="menu-item" href={PRIVACY_URL} target="_blank" rel="noreferrer">Privacy policy ↗</a>
      </nav>
      {SOURCE_REVISION && <p className="muted menu-foot">Version {SOURCE_REVISION.slice(0, 7)}</p>}
    </div>
  )
}
