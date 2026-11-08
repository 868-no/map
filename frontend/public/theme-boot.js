// Sets the colour theme and the UI scale on <html> before the first paint, so
// neither the app nor the privacy page flashes the wrong colours or size. Same
// rule as src/theme.ts: the viewer's saved choice (src/state/store.ts,
// TOGGLES_KEY), or the browser's preference when it is "system" or nothing is
// saved; the scale only if it is one Settings offers (UI_SCALES).
;(function () {
  var choice = 'system'
  var scale = 1
  try {
    var saved = JSON.parse(localStorage.getItem('meshmap:toggles:v6') || 'null')
    if (saved && (saved.theme === 'light' || saved.theme === 'dark')) choice = saved.theme
    if (saved && [0.85, 1.15, 1.3, 1.5].indexOf(saved.uiScale) >= 0) scale = saved.uiScale
  } catch {
    /* storage unavailable: follow the browser */
  }
  var light = choice === 'light' || (choice === 'system' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
  var theme = light ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme)
  if (scale !== 1) document.documentElement.style.setProperty('--ui-scale', String(scale))
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', light ? '#f6f7f9' : '#0e1116')
})()
