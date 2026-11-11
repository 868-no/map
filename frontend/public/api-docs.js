// Renders the API page from the server's own OpenAPI description
// (/api/openapi.json), so it always matches the running server. Text only:
// nothing from the description is inserted as HTML.
;(function () {
  var spec
  var TAG_TITLES = { mesh: 'Mesh data', live: 'Live updates', meta: 'Site and helpers' }

  function el(tag, attrs, children) {
    var e = document.createElement(tag)
    for (var k in attrs || {}) {
      if (k === 'text') e.textContent = attrs[k]
      else e.setAttribute(k, attrs[k])
    }
    ;(children || []).forEach(function (c) {
      if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return e
  }

  // Descriptions use `code` spans; everything else stays plain text.
  function prose(text, tag) {
    var p = el(tag || 'p')
    String(text).split(/(`[^`]+`)/).forEach(function (part) {
      if (/^`[^`]+`$/.test(part)) p.appendChild(el('code', { text: part.slice(1, -1) }))
      else if (part) p.appendChild(document.createTextNode(part))
    })
    return p
  }

  function refName(ref) {
    return ref.split('/').pop()
  }

  function resolve(s) {
    var seen = 0
    while (s && s.$ref && seen++ < 20) s = spec.components.schemas[refName(s.$ref)]
    return s || {}
  }

  // A schema's type in a few words: "string (date-time)", "array of Row", "integer or null".
  function typeOf(s) {
    if (!s) return ''
    // Inline objects get generated names (CapabilitiesBodyMapStruct): just "object".
    if (s.$ref) return /Struct$/.test(refName(s.$ref)) ? 'object' : refName(s.$ref)
    var t = Array.isArray(s.type) ? s.type : s.type ? [s.type] : []
    var words = t.map(function (x) {
      if (x === 'array') return 'array of ' + (typeOf(s.items) || 'values')
      if (x === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object') return 'map of ' + typeOf(s.additionalProperties)
      return x
    })
    if (!words.length && s.oneOf) words = s.oneOf.map(typeOf)
    var out = words.join(' or ')
    if (s.format) out += ' (' + s.format + ')'
    return out
  }

  function hasFields(s) {
    s = resolve(s)
    if (s.properties) return true
    if (s.items) return hasFields(s.items)
    if (s.additionalProperties && typeof s.additionalProperties === 'object') return hasFields(s.additionalProperties)
    return false
  }

  // The fields of an object schema, nested ones folded; `chain` stops
  // recursive types from unfolding forever.
  function fields(schema, chain) {
    var s = resolve(schema)
    if (s.items) return fields(s.items, chain)
    if (s.additionalProperties && typeof s.additionalProperties === 'object' && !s.properties) return fields(s.additionalProperties, chain)
    var list = el('ul', { class: 'fields' })
    var props = s.properties || {}
    var required = s.required || []
    Object.keys(props).sort().forEach(function (name) {
      if (name === '$schema') return
      var p = props[name]
      var r = resolve(p)
      var li = el('li', {}, [
        el('code', { class: 'name', text: name }),
        ' ',
        el('span', { class: 'type', text: typeOf(p) }),
        required.indexOf(name) >= 0 ? el('span', { class: 'req', text: ' always present' }) : null,
      ])
      var d = p.description || r.description
      if (d) li.appendChild(prose(d, 'span')).className = 'desc'
      var en = p.enum || r.enum || (p.items && resolve(p.items).enum)
      if (en) li.appendChild(el('span', { class: 'desc muted' }, ['One of: ', en.map(function (v) { return v === null ? 'null' : String(v) }).join(', ')]))
      var ref = p.$ref || (p.items && p.items.$ref)
      if (hasFields(p) && (!ref || chain.indexOf(ref) < 0)) {
        var det = el('details', {}, [el('summary', { text: 'Fields' })])
        det.appendChild(fields(p, ref ? chain.concat(ref) : chain))
        li.appendChild(det)
      }
      list.appendChild(li)
    })
    return list
  }

  function params(op) {
    var ps = op.parameters || []
    if (!ps.length) return null
    var box = el('div', {}, [el('h4', { text: 'Parameters' })])
    var list = el('ul', { class: 'fields' })
    ps.forEach(function (p) {
      var s = p.schema || {}
      var li = el('li', {}, [
        el('code', { class: 'name', text: p.name }),
        ' ',
        el('span', { class: 'type', text: (p.in === 'path' ? 'in the path, ' : p.in === 'query' ? 'query, ' : p.in + ', ') + typeOf(s) }),
        p.required ? el('span', { class: 'req', text: ' required' }) : null,
      ])
      if (p.description) li.appendChild(prose(p.description, 'span')).className = 'desc'
      var extra = []
      if (s.enum) extra.push('One of: ' + s.enum.join(', '))
      if (s.default !== undefined) extra.push('Default: ' + s.default)
      if (s.minimum !== undefined || s.maximum !== undefined) extra.push('Range: ' + (s.minimum !== undefined ? s.minimum : '…') + ' to ' + (s.maximum !== undefined ? s.maximum : '…'))
      if (s.examples && s.examples.length) extra.push('Example: ' + s.examples[0])
      if (extra.length) li.appendChild(el('span', { class: 'desc muted', text: extra.join(' · ') }))
      list.appendChild(li)
    })
    box.appendChild(list)
    return box
  }

  function body(op) {
    var c = op.requestBody && op.requestBody.content
    var json = c && c['application/json']
    if (!json) return null
    return el('div', {}, [el('h4', { text: 'Request body (JSON)' }), fields(json.schema, [])])
  }

  // Server-sent events: one entry per event name and its data.
  function events(schema) {
    var list = el('ul', { class: 'fields' })
    ;((schema.items && schema.items.oneOf) || []).forEach(function (o) {
      var ev = o.properties && o.properties.event
      var data = o.properties && o.properties.data
      var li = el('li', {}, [el('code', { class: 'name', text: (ev && ev.const) || 'message' }), ' ', el('span', { class: 'type', text: typeOf(data) })])
      var d = data && (data.description || resolve(data).description)
      if (d) li.appendChild(prose(d, 'span')).className = 'desc'
      if (data && hasFields(data)) {
        var det = el('details', {}, [el('summary', { text: 'Fields' })])
        det.appendChild(fields(data, data.$ref ? [data.$ref] : []))
        li.appendChild(det)
      }
      list.appendChild(li)
    })
    return list
  }

  function responses(op) {
    var box = el('div')
    Object.keys(op.responses || {}).forEach(function (code) {
      if (code === 'default') return // problem details, described above
      var r = op.responses[code]
      var content = r.content || {}
      var types = Object.keys(content)
      box.appendChild(el('h4', { text: 'Response ' + code + (types.length ? ' (' + types.join(', ') + ')' : '') }))
      if (r.description && r.description !== 'OK') box.appendChild(prose(r.description))
      types.forEach(function (t) {
        var s = content[t].schema
        if (!s || t === 'application/problem+json') return // problem details, described above
        // Several forms of one answer (JSON or GeoJSON): say which each is.
        if (types.length > 1) box.appendChild(el('p', { class: 'muted' }, [el('code', { text: t }), ':']))
        if (t === 'text/event-stream') box.appendChild(events(s))
        else if (hasFields(s)) box.appendChild(fields(s, s.$ref ? [s.$ref] : []))
        else box.appendChild(el('p', { class: 'muted', text: typeOf(s) }))
      })
      var h = r.headers || {}
      Object.keys(h).forEach(function (name) {
        box.appendChild(el('p', { class: 'muted' }, [el('code', { text: name }), h[name].description ? ': ' + h[name].description : '']))
      })
    })
    return box
  }

  function render() {
    var base = (spec.servers && spec.servers[0] && spec.servers[0].url) || ''
    document.querySelectorAll('[data-fill="base"]').forEach(function (e) {
      e.textContent = base + '/api/v1'
    })
    if (spec.info && spec.info.description) document.getElementById('intro').replaceWith(prose(spec.info.description))
    // Endpoints by tag, in the order tags first appear; paths sorted.
    var groups = {}
    var order = []
    Object.keys(spec.paths).sort().forEach(function (path) {
      var item = spec.paths[path]
      ;['get', 'post', 'put', 'delete'].forEach(function (m) {
        var op = item[m]
        if (!op) return
        var tag = (op.tags && op.tags[0]) || 'other'
        if (!groups[tag]) {
          groups[tag] = []
          order.push(tag)
        }
        groups[tag].push({ path: path, method: m, op: op })
      })
    })
    order.sort(function (a, b) {
      var k = Object.keys(TAG_TITLES)
      return (k.indexOf(a) + 1 || 99) - (k.indexOf(b) + 1 || 99)
    })
    var toc = document.querySelector('#toc ul')
    var ops = document.getElementById('ops')
    order.forEach(function (tag) {
      ops.appendChild(el('h2', { text: TAG_TITLES[tag] || tag }))
      groups[tag].forEach(function (g) {
        var id = g.op.operationId || g.method + g.path
        toc.appendChild(el('li', {}, [el('a', { href: '#' + id }, [el('span', { class: 'method ' + g.method, text: g.method.toUpperCase() }), el('code', { text: g.path })])]))
        var sec = el('section', { class: 'op', id: id }, [
          el('h3', {}, [el('span', { class: 'method ' + g.method, text: g.method.toUpperCase() }), el('code', { text: g.path })]),
          g.op.summary ? prose(g.op.summary) : null,
          g.op.description ? prose(g.op.description) : null,
          params(g.op),
          body(g.op),
          responses(g.op),
        ])
        ops.appendChild(sec)
      })
    })
    document.getElementById('status').hidden = true
    document.getElementById('toc').hidden = false
    // Opened at an endpoint's link: it exists only now.
    if (location.hash) {
      var target = document.getElementById(decodeURIComponent(location.hash.slice(1)))
      if (target) target.scrollIntoView()
    }
  }

  fetch('/api/openapi.json', { headers: { Accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
    .then(function (s) {
      spec = s
      render()
    })
    .catch(function (e) {
      var st = document.getElementById('status')
      st.textContent = 'The API description could not be loaded (' + e.message + '). '
      st.appendChild(el('a', { href: '/api/openapi.yaml', text: 'Open it as YAML' }))
    })
})()
