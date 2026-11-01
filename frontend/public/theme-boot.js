// Sets the colour theme on <html> before the first paint, so neither the app
// nor the privacy page flashes the wrong colours. Same rule as src/theme.ts:
// the viewer's saved choice (src/state/store.ts, TOGGLES_KEY), or the
// browser's preference when it is "system" or nothing is saved.
;(function () {
  var choice = 'system'
  try {
    var saved = JSON.parse(localStorage.getItem('meshmap:toggles:v5') || 'null')
    if (saved && (saved.theme === 'light' || saved.theme === 'dark')) choice = saved.theme
  } catch {
    /* storage unavailable: follow the browser */
  }
  var light = choice === 'light' || (choice === 'system' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
  var theme = light ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme)
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', light ? '#f6f7f9' : '#0e1116')
})()
