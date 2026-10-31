import { expect, test } from '@playwright/test'

// Spec §11/§17 test 32 (client side): reference density of 2 000 nodes and
// 20 000 edges served as a snapshot; measure JS heap and frame rate while
// panning. Results are printed for docs/benchmarks.md.
for (const [N, E] of [[0, 0], [2000, 20000]] as const) test(`rendering ${N} nodes / ${E} edges: heap and frame rate`, async ({ page }) => {
  test.setTimeout(180_000)
  const nodes = Array.from({ length: N }, (_, i) => {
    const id = '!' + (0x10000000 + i).toString(16)
    const positioned = i % 4 !== 0
    const lat = 58.5 + ((i * 7919) % 1000) / 1000 * 5.5, lon = 5.5 + ((i * 104729) % 1000) / 1000 * 6.5
    return {
      id, num: 0x10000000 + i, status: 'observed', packets: 10, receptions: 20, gateway_receptions: i % 12 === 0 ? 50 : 0, is_gateway: i % 12 === 0,
      signatures: { verified: 5, unsigned: 5, unverifiable: 0, not_applicable: 0 }, last_seen: new Date().toISOString(), first_seen: new Date(Date.now() - 3600e3).toISOString(),
      identity: { long_name: `Node ${i}`, short_name: `N${i % 1000}`, has_public_key: true, signature: 'verified', observed_at: new Date().toISOString() },
      ...(positioned ? { position: { lat, lon, precision_bits: 32, precision_known: true, signature: 'verified', observed_at: new Date().toISOString() } }
        : i % 8 === 0 ? { estimate: { lat, lon, uncertainty_radius_m: 3000, method: 'weighted_centroid', quality: 'very_low', anchor_count: 3, sample_count: 9, anchors: [], evidence_from: '', evidence_to: '', reasons: [] } } : {}),
    }
  })
  const edges = Array.from({ length: E }, (_, k) => {
    const a = k % N, b = (a + 1 + (k % 17)) % N
    return { src: nodes[a].id, dst: nodes[b].id, src_num: nodes[a].num, dst_num: nodes[b].num, samples: 1 + (k % 9), confidence: ['high', 'medium', 'low'][k % 3], inferred: k % 3 === 2,
      reason: '', evidence: { neighbor: k % 3 === 0 ? 1 : 0, traceroute: 0, direct_rf: k % 3 === 1 ? 1 : 0, relay_hint: k % 3 === 2 ? 1 : 0 },
      snr: { n: 1, median: 5 }, rssi: { n: 0 }, first_at: new Date().toISOString(), last_at: new Date().toISOString() }
  })
  await page.route('**/api/v1/snapshot*', async (route) => {
    const now = new Date()
    const body = { meta: { window: { start: new Date(now.getTime() - 72 * 3600e3).toISOString(), end: now.toISOString(), rolling: true }, revision: 'perf', filters: {}, generated_at: now.toISOString() },
      nodes, edges, edges_truncated: false, diagnostics: { relay_ambiguous: 0, relay_unmatched: 0 },
      counts: { packets: 1, receptions: 1, nodes: N, referenced: 0, positioned: N, estimated: 0, edges: E, by_type: {}, nodes_truncated: false } }
    await route.fulfill({ json: body })
  })
  await page.goto('/?derive=server') // a synthetic snapshot: measures rendering, not derivation
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap)
  await expect(page.locator('.counters')).toContainText(`${E} links`)
  if (N > 0) {
    await page.getByRole('button', { name: 'Nodes & details' }).click() // the side panel starts hidden
    await expect(page.locator('.node-row').first()).toBeVisible()
  }
  await page.waitForTimeout(3000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  const heap = (await page.evaluate(() => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize)) / 2 ** 20
  // Pan continuously for 5 s and count frames.
  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const m = (window as unknown as { __meshmap: { map: { panBy: (o: [number, number], a: object) => void } } }).__meshmap.map
        let frames = 0
        const t0 = performance.now()
        const tick = () => {
          frames++
          if (performance.now() - t0 < 5000) {
            m.panBy([6, 2], { animate: false })
            requestAnimationFrame(tick)
          } else resolve(frames / ((performance.now() - t0) / 1000))
        }
        requestAnimationFrame(tick)
      }),
  )
  console.log(`PERF ${N} nodes / ${E} edges: JS heap ${heap.toFixed(0)} MiB after GC; panning ${fps.toFixed(1)} fps (headless Chromium, software GL)`)
  expect(heap).toBeLessThan(250)
})
