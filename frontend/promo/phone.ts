// The phone segment's stage (takes/phone.spec.ts): a generic phone, deliberately
// no particular brand's, on a blurred still of the map take's last frame. Its
// screen holds the app in an iframe under a generic browser bar, an install
// dialog, a home screen and a launch splash. Every moving part is a CSS
// variable on :root that the take sets frame by frame (no CSS animation: the
// frames are taken on a fake clock).

const ICON = '/icons/maskable-512.png'

/** Simple white glyphs for the stand-in apps on the home screen. */
const GLYPHS = [
  '<path d="M9 5h6l2 5-3 2a11 11 0 0 0 6 6l2-3 5 2v6a2 2 0 0 1-2 2A21 21 0 0 1 7 7a2 2 0 0 1 2-2z"/>', // handset
  '<path d="M6 8h20v13H14l-6 5v-5H6z"/>', // speech bubble
  '<rect x="5" y="10" width="22" height="15" rx="3"/><circle cx="16" cy="17.5" r="4.5" fill="#000" fill-opacity=".35"/><rect x="11" y="6" width="10" height="5" rx="1.5"/>', // camera
  '<rect x="6" y="7" width="20" height="18" rx="3"/><path d="M8 23l6-7 4 4 3-3 4 6z" fill="#000" fill-opacity=".35"/>', // picture
  '<circle cx="16" cy="16" r="10"/><path d="M16 10v6l4 3" stroke="#000" stroke-opacity=".4" stroke-width="2.4" fill="none" stroke-linecap="round"/>', // clock
  '<rect x="6" y="8" width="20" height="18" rx="3"/><rect x="6" y="8" width="20" height="5" fill="#000" fill-opacity=".3"/>', // calendar
  '<circle cx="13" cy="13" r="5"/><path d="M10 25a6 6 0 0 1 0-12h11a5 5 0 0 1 0 12z"/>', // weather
  '<rect x="8" y="5" width="16" height="22" rx="2"/><path d="M11 11h10M11 15h10M11 19h6" stroke="#000" stroke-opacity=".35" stroke-width="2"/>', // notes
  '<circle cx="16" cy="16" r="4"/><path d="M16 5v4M16 23v4M5 16h4M23 16h4M8 8l3 3M21 21l3 3M24 8l-3 3M11 21l-3 3" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>', // settings
]
const APPS: [string, string, number][] = [
  // label, colour, glyph
  ['Telefon', '#2e9d5b', 0], ['Meldinger', '#2f7de1', 1], ['Kamera', '#5b6270', 2], ['Galleri', '#d0603a', 3],
  ['Klokke', '#3a4152', 4], ['Kalender', '#c9493f', 5], ['Vær', '#3a8fd0', 6], ['Notater', '#d6a93a', 7],
  ['Innstillinger', '#59606e', 8],
]
const DOCK = [0, 1, 3, 2]

const glyph = (i: number, colour: string) =>
  `<div class="ic" style="background:${colour}"><svg viewBox="0 0 32 32" fill="#fff">${GLYPHS[i]}</svg></div>`

const STATUS = (light: boolean) => `
  <div class="status${light ? ' light' : ''}"><span>12:00</span><span class="sys">
    <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="4.5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="9" y="3" width="3" height="9" rx=".8"/><rect x="13.5" y="0" width="3" height="12" rx=".8"/></svg>
    <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 12l2.6-3.2a4 4 0 0 0-5.2 0zM8 5.4a7.4 7.4 0 0 1 4.8 1.7l1.5-1.8A10 10 0 0 0 8 3a10 10 0 0 0-6.3 2.3l1.5 1.8A7.4 7.4 0 0 1 8 5.4z"/></svg>
    <svg width="25" height="12" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21" height="11" rx="3" fill="none" stroke="currentColor" stroke-opacity=".6"/><rect x="2.5" y="2.5" width="14" height="7" rx="1.5" fill="currentColor"/><rect x="22.5" y="4" width="2" height="4" rx="1" fill="currentColor" fill-opacity=".6"/></svg>
  </span></div>`

/** The phone on the stage, in page pixels: its body, and the screen inside it. */
const PHONE = { x: 400, y: 90, width: 430, height: 900 }

export function stageHtml(): string {
  const grid = APPS.map(([name, c, g]) => `<div class="app">${glyph(g, c)}<span>${name}</span></div>`).join('')
  const dock = DOCK.map((i) => glyph(APPS[i][2], APPS[i][1])).join('')
  return `<!doctype html><html lang="nb"><head><meta charset="utf-8"><style>
:root { --bg-blur: 0; --bg-dim: 1; --phone-y: 1100; --toolbar: 1; --sheet: 0; --home: 0; --icon: 0; --label: 0;
  --splash: 0; --splash-op: 0; --sx: 50%; --sy: 50%; --app-scale: 1; --app-op: 1; }
html, body { margin: 0; height: 100%; overflow: hidden; background: #0e1116; font-family: system-ui, sans-serif; }
#bg { position: fixed; inset: calc(var(--bg-blur) * -3px); background: url(/promo-bg.png) center / cover;
  filter: blur(calc(var(--bg-blur) * 1px)) brightness(var(--bg-dim)); }
#phone { position: absolute; left: ${PHONE.x}px; top: ${PHONE.y}px; width: ${PHONE.width}px; height: ${PHONE.height}px;
  transform: translateY(calc(var(--phone-y) * 1px)); }
#phone .body { position: absolute; inset: 0; border-radius: 58px; background: linear-gradient(150deg, #34383f, #14161a 45%, #22252b);
  box-shadow: 0 50px 90px rgba(0,0,0,.65), inset 0 0 0 2px #454a52, inset 0 0 0 6px #111316; }
#phone .key { position: absolute; right: -4px; width: 5px; border-radius: 3px; background: #2c3036; }
#screen { position: absolute; left: 15px; top: 15px; width: 400px; height: 870px; border-radius: 44px; overflow: hidden; background: #0e1116; }
#cam { position: absolute; top: 9px; left: 50%; width: 13px; height: 13px; margin-left: -6.5px; border-radius: 50%; background: #050608;
  box-shadow: 0 0 0 2px #15171b; z-index: 30; }
.status { height: 34px; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 24px 0 28px;
  color: #e8ecf1; font-weight: 600; font-size: 14px; background: #0e1116; position: relative; z-index: 2; }
.status.light { background: transparent; color: #fff; }
.status .sys { display: flex; gap: 6px; align-items: center; }
#browser { position: absolute; inset: 0; display: flex; flex-direction: column; transform: scale(var(--app-scale)); opacity: var(--app-op); }
#toolbar { height: calc(var(--toolbar) * 58px); flex: none; overflow: hidden; background: #171a20; display: flex; align-items: center; gap: 10px; padding: 0 12px; }
#toolbar .url { flex: 1; height: 40px; border-radius: 20px; background: #262a33; display: flex; align-items: center; gap: 9px; padding: 0 16px;
  color: #e8ecf1; font-size: 16px; }
#toolbar .dots { width: 4px; display: flex; flex-direction: column; gap: 3.5px; padding: 0 6px; }
#toolbar .dots i { width: 4px; height: 4px; border-radius: 2px; background: #c8ced6; }
#promo-app { flex: 1; width: 400px; border: 0; display: block; background: #0e1116; }
#scrim, #sheet, #home, #splash { pointer-events: none; } /* invisible until shown: taps must reach the app */
#scrim { position: absolute; inset: 0; z-index: 10; background: #000; opacity: calc(var(--sheet) * .5); }
#sheet { position: absolute; left: 0; right: 0; bottom: 0; z-index: 11; padding: 14px 26px 34px; border-radius: 28px 28px 0 0;
  background: #23272e; color: #e8ecf1; transform: translateY(calc((1 - var(--sheet)) * 105%)); box-shadow: 0 -10px 40px rgba(0,0,0,.4); }
#sheet .grab { width: 36px; height: 4px; border-radius: 2px; background: #5a606b; margin: 0 auto 22px; }
#sheet h2 { margin: 0 0 20px; font-size: 22px; font-weight: 600; }
#sheet .row { display: flex; gap: 16px; align-items: center; }
#sheet .row img { width: 54px; height: 54px; border-radius: 50%; }
#sheet .row b { display: block; font-size: 17px; font-weight: 600; }
#sheet .row span { font-size: 14px; color: #a9b2bf; }
#sheet .btns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 30px; font-size: 15px; font-weight: 600; }
#sheet .btns span { padding: 11px 22px; border-radius: 22px; }
#cancel { color: #8fc1ff; }
#install { background: #8fc1ff; color: #0b2340; }
#home { position: absolute; inset: 0; z-index: 12; opacity: var(--home); color: #fff;
  background: radial-gradient(120% 70% at 15% 0%, #2c5585 0%, transparent 62%), radial-gradient(110% 70% at 100% 100%, #5d2f70 0%, transparent 60%), #0c1323; }
#home .clock { margin: 64px 0 0 30px; font-size: 64px; font-weight: 300; letter-spacing: -1px; }
#home .date { margin: 2px 0 0 32px; font-size: 16px; opacity: .85; }
#home .grid { position: absolute; left: 14px; right: 14px; top: 330px; display: grid; grid-template-columns: repeat(4, 1fr); row-gap: 22px; }
.app { display: flex; flex-direction: column; align-items: center; gap: 7px; font-size: 12.5px; text-shadow: 0 1px 3px rgba(0,0,0,.5); }
.ic { width: 58px; height: 58px; border-radius: 50%; display: grid; place-items: center; box-shadow: 0 3px 8px rgba(0,0,0,.3); }
.ic svg { width: 30px; height: 30px; }
#newapp img { width: 58px; height: 58px; border-radius: 50%; display: block; transform: scale(var(--icon)); box-shadow: 0 3px 8px rgba(0,0,0,.3); }
#newapp span { opacity: var(--label); }
#home .dock { position: absolute; left: 22px; right: 22px; bottom: 34px; display: flex; justify-content: space-around; padding: 12px 0;
  border-radius: 34px; background: rgba(255,255,255,.12); }
#splash { position: absolute; inset: 0; z-index: 13; background: #0e1116; opacity: var(--splash-op);
  clip-path: circle(calc(var(--splash) * 120%) at var(--sx) var(--sy)); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px; color: #e8ecf1; }
#splash img { width: 124px; height: 124px; border-radius: 50%; }
#splash span { font-size: 21px; font-weight: 600; }
</style></head><body>
<div id="bg"></div>
<div id="phone">
  <div class="body"></div><div class="key" style="top:180px;height:64px"></div><div class="key" style="top:270px;height:110px"></div>
  <div id="screen">
    <div id="cam"></div>
    <div id="browser">
      ${STATUS(false)}
      <div id="toolbar"><div class="url"><svg width="13" height="15" viewBox="0 0 13 15" fill="#c8ced6"><rect x="1" y="6" width="11" height="9" rx="2"/><path d="M3.5 6V4.5a3 3 0 0 1 6 0V6" fill="none" stroke="#c8ced6" stroke-width="1.8"/></svg>map.868.no</div><div class="dots"><i></i><i></i><i></i></div></div>
      <iframe id="promo-app" src="/"></iframe>
    </div>
    <div id="scrim"></div>
    <div id="sheet"><div class="grab"></div><h2>Installer app</h2>
      <div class="row"><img src="${ICON}" alt=""><div><b>868.no Map</b><span>map.868.no</span></div></div>
      <div class="btns"><span id="cancel">Avbryt</span><span id="install">Installer</span></div></div>
    <div id="home">
      ${STATUS(true)}
      <div class="clock">12:00</div><div class="date">onsdag 11. november</div>
      <div class="grid">${grid}<div class="app" id="newapp"><img src="${ICON}" alt=""><span>868.no Map</span></div></div>
      <div class="dock">${dock}</div>
    </div>
    <div id="splash"><img src="${ICON}" alt=""><span>868.no Map</span></div>
  </div>
</div>
</body></html>`
}
