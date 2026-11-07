// Engine benchmark (docs/benchmarks.md): load a window's rows into the
// WebAssembly engine as the worker does (20 000-row pages) and time each
// view. Needs a built engine (scripts/wasm.sh build) and row files:
// scripts/bench.sh saves synthetic ones to .bench/rows-<h>h.json, and
//   node bench/engine.mjs --fetch https://beta-map.868.no 168 .bench/rows-prod-168h.json
// saves a real mesh's last 168 h. Then:
//   node bench/engine.mjs .bench/rows-72h.json .bench/rows-168h.json
import { readFileSync, writeFileSync } from 'node:fs'
import { Engine, initSync } from '../src/engine/pkg/engine.js'

const PAGE = 20_000
const RUNS = 5

if (process.argv[2] === '--fetch') {
  const [, , , base, hours, out] = process.argv
  const end = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000)
  const q = new URLSearchParams({ start: new Date(end.getTime() - Number(hours) * 3_600_000).toISOString(), end: end.toISOString() })
  const rows = []
  for (let page; !page || page.more; ) {
    if (page) q.set('cursor', page.next_cursor)
    const r = await fetch(`${base}/api/v1/observations?${q}`, { headers: { 'user-agent': '868map-engine-bench' } })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    page = await r.json()
    rows.push(...page.rows)
  }
  writeFileSync(out, JSON.stringify(rows))
  console.log(`${out}: ${rows.length} rows, ${hours} h to ${end.toISOString()}`)
  process.exit(0)
}

const wasm = initSync({ module: readFileSync(new URL('../src/engine/pkg/engine_bg.wasm', import.meta.url)) })
// The geolocation settings production sends (GET /api/v1/capabilities).
const geo = { enabled: true, min_precision_bits: 15, exclude: [], min_anchors: 3, min_samples: 5, min_anchor_spacing_m: 200, min_spread_m: 500, min_shape_ratio: 0.2, max_anchor_distance_m: 150000, floor_m: 500, uncalibrated_floor_m: 2000 }
const now = () => performance.now()
const time = (f) => { const t = now(); f(); return now() - t }
const median = (v) => [...v].sort((a, b) => a - b)[v.length >> 1]
const ms = (v) => `${v.toFixed(0)} ms`
const decoder = new TextDecoder()

for (const file of process.argv.slice(2)) {
  const rows = JSON.parse(readFileSync(file, 'utf8')).sort((a, b) => a.t - b.t)
  const pages = []
  for (let k = 0; k < rows.length; k += PAGE) pages.push(JSON.stringify(rows.slice(k, k + PAGE)))
  const start = rows[0].t
  const end = rows[rows.length - 1].t + 1
  const hours = (end - start) / 3_600_000
  const memBefore = wasm.memory.buffer.byteLength

  const e = new Engine()
  e.set_options(JSON.stringify({ geo }))
  const load = time(() => { for (const p of pages) e.add_rows(p, -Infinity) })
  // A view is memoised per window: shift the end by a millisecond per run to build afresh.
  let n = 0
  const fresh = (kind, arg = '', from = start) => median(Array.from({ length: RUNS }, () => { const z = end + ++n; return time(() => e.view_bytes(kind, from, z, '{}', arg)) }))
  const snapshot = fresh('snapshot')
  const snapshot72 = hours > 100 ? fresh('snapshot', '', end - 72 * 3_600_000) : null
  const bytes = e.view_bytes('snapshot', start, end, '{}', '')
  const parse = median(Array.from({ length: RUNS }, () => time(() => JSON.parse(decoder.decode(bytes)))))
  const snap = JSON.parse(decoder.decode(bytes))
  // The node most rows came from, for its panel and packet log.
  const from = new Map()
  for (const r of rows) from.set(r.s, (from.get(r.s) ?? 0) + 1)
  const top = `!${[...from].sort((a, b) => b[1] - a[1])[0][0].toString(16).padStart(8, '0')}`
  // Views on a built snapshot (memoised, as when the page opens a panel).
  const built = (kind, arg = '') => { e.view_bytes('snapshot', start, end, '{}', ''); return median(Array.from({ length: RUNS }, () => time(() => e.view_bytes(kind, start, end, '{}', arg)))) }
  const traffic = built('traffic')
  const node = built('node', top)
  const log = built('packetlog', top)
  const health = built('health')
  // A live batch (20 newer rows) and the rebuild it triggers.
  let id = 9e12
  const live = () => JSON.stringify(rows.slice(-20).map((r, k) => ({ ...r, i: ++id, t: end + 60_000 + n * 1000 + k })))
  const rebuild = median(Array.from({ length: RUNS }, () => { const batch = live(); n++; return time(() => { e.add_rows(batch, -Infinity); e.view_bytes('snapshot', start, end + 60_000 + n * 1000 + 100, '{}', '') }) }))
  const memory = (wasm.memory.buffer.byteLength - memBefore) / 2 ** 20

  console.log(`${file}: ${rows.length} rows over ${hours.toFixed(0)} h, ${snap.nodes.length} nodes, ${snap.edges.length} links, snapshot ${(bytes.length / 2 ** 20).toFixed(1)} MiB
  load ${ms(load)} | snapshot ${ms(snapshot)}${snapshot72 === null ? '' : ` (last 72 h ${ms(snapshot72)})`} | rebuild after a live batch ${ms(rebuild)} | traffic ${ms(traffic)} | node ${ms(node)} | packet log ${ms(log)} | health ${ms(health)} | page JSON.parse ${ms(parse)} | wasm memory grown ${memory.toFixed(0)} MiB`)
  e.free()
}
