// Fills the privacy policy with this deployment's settings from
// /api/v1/capabilities: operator, contact, retention, position estimates and
// where map tiles come from. Without it (no script, API down) the page
// keeps its generic wording.
;(function () {
  function fill(name, value) {
    document.querySelectorAll('[data-fill="' + name + '"]').forEach(function (el) {
      el.textContent = ''
      el.appendChild(typeof value === 'string' ? document.createTextNode(value) : value)
    })
  }
  function show(name, on) {
    document.querySelectorAll('[data-show="' + name + '"]').forEach(function (el) {
      el.hidden = !on
    })
  }
  // An e-mail address or a web address becomes a link; anything else stays text.
  function contactNode(c) {
    var href = /^https?:\/\//i.test(c) ? c : /^[^\s@]+@[^\s@]+$/.test(c) ? 'mailto:' + c : null
    if (!href) return document.createTextNode(c)
    var a = document.createElement('a')
    a.href = href
    a.rel = 'noreferrer'
    a.textContent = c.replace(/^mailto:/i, '')
    return a
  }
  fetch('/api/v1/capabilities', { headers: { Accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) throw new Error(String(r.status))
      return r.json()
    })
    .then(function (caps) {
      var op = caps.operator || {}
      if (op.name) fill('operator', op.name)
      show('operator', !!op.name)
      show('no-operator', !op.name)
      if (op.contact) {
        document.querySelectorAll('[data-fill="contact"]').forEach(function (el) {
          el.textContent = ''
          el.appendChild(contactNode(op.contact))
        })
      }
      show('contact', !!op.contact)
      show('no-contact', !op.contact)
      var m = caps.retention_months
      if (m > 0) {
        var period = m === 1 ? 'one month' : m + ' months'
        fill('retention', period)
        fill('retention-short', period)
      }
      show('geolocation', !!(caps.features && caps.features.geolocation))
      show('weather', !!(caps.features && caps.features.weather))
      show('terrain', !!(caps.features && caps.features.terrain))
      var src = (caps.map && caps.map.tile_source) || ''
      var remote = /^https?:\/\//i.test(src)
      show('tiles-local', !remote)
      show('tiles-remote', remote)
      if (remote) {
        try {
          fill('tile-host', new URL(src).host)
        } catch {
          fill('tile-host', src)
        }
      }
    })
    .catch(function () {
      /* keep the generic wording */
    })
})()
