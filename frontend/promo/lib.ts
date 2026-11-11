// The promo recorder's toolkit (promo/README.md). A take drives the real app,
// built with the test hook and served against production (promo/vite.config.ts),
// and saves one screenshot per video frame. The page's clock is fake and
// paused: each frame advances it by exactly 1/fps, so camera moves, pings and
// captions are smooth however long a frame takes to draw. Live traffic still
// arrives on the wall clock, which runs about 12 times slower than video time,
// so pings come out denser than they really are.
//
// On top of the app, in the page itself: captions, a pointer (a mouse arrow,
// or a touch marker) that goes to what it clicks, and a "lens", the part of
// the page a frame shows. The page draws at twice its size, so a frame can
// zoom in up to 2× and stay sharp; frames vary in size and are scaled to the
// video's when encoded. The app is the page itself, or (openStage) an iframe
// in a page of the take's own, such as a phone.
import type { Frame, Locator, Page } from '@playwright/test'
import { mkdirSync, rmSync } from 'node:fs'

type LngLat = [number, number]
type Camera = { center: LngLat; zoom: number; bearing?: number; pitch?: number }
type XY = { x: number; y: number }
type Rect = { x: number; y: number; width: number; height: number }
type M = {
  jumpTo: (o: object) => void
  easeTo: (o: object) => void
  stop: () => void
  getZoom: () => number
  getCenter: () => { lng: number; lat: number }
  fire: (e: string) => void
  areTilesLoaded: () => boolean
  project: (p: LngLat) => XY
}
type Hook = { __meshmap: { map: M; pick: (x: number, y: number) => unknown; layers: () => { id: string; data: unknown[] }[] } }

/** The video's size (16:9: Discord, desktop and the Facebook feed). */
const W = 1920
const H = 1080
/** The page's device pixel ratio: how far the lens can zoom in and stay sharp. */
const SCALE = 2

/** The address on the end card: the site's final one, set when recording (PROMO_ADDRESS). */
export const ADDRESS = process.env.PROMO_ADDRESS ?? 'map.868.no'

/** A count as a caption says it: rounded down to a round number ("over 200"). */
export function roundDown(n: number): number {
  const step = n >= 1000 ? 100 : n >= 100 ? 10 : 5
  return Math.floor(n / step) * step
}

/** Ease in and out. */
const smooth = (t: number) => t * t * t * (t * (6 * t - 15) + 10)
export const mix = (a: number, b: number, t: number) => a + (b - a) * t

type Place = 'bottom' | 'side' | 'end'
type Caption = { title: string; sub?: string; from: number; to: number; place: Place }
type Lens = { x: number; y: number; w: number }

/** Pings fade out over these zooms: drawn at their real range, up close one ring covers the screen. */
const PING_FADE = [6.5, 8.5]

/** The overlay: captions (laid out in frame coordinates, mapped into the lens) and the pointer. */
const OVERLAY_CSS = `
#promo-frame { position: fixed; left: 0; top: 0; width: ${W}px; height: ${H}px; z-index: 9999; pointer-events: none; transform-origin: 0 0; }
#promo-caption { position: absolute; left: 0; right: 0; bottom: 9%; display: flex; justify-content: center; opacity: 0; }
#promo-caption > div { max-width: 82%; padding: 18px 30px 20px; border-radius: 14px; text-align: center;
  background: rgba(10, 14, 20, 0.8); box-shadow: 0 10px 40px rgba(0,0,0,.45);
  font-family: Inter, system-ui, sans-serif; color: #f2f5f8; }
#promo-caption .t { font-size: 44px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.15; }
#promo-caption .s { font-size: 24px; margin-top: 8px; color: #b9c4d0; line-height: 1.3; }
#promo-caption .s:empty { display: none; }
#promo-caption.side, #promo-caption.end { top: 0; bottom: 0; left: 48%; align-items: center; }
#promo-caption.end > div { padding: 30px 60px 36px; }
#promo-caption.end .t { font-size: 75px; }
#promo-pointer { position: fixed; left: 0; top: 0; z-index: 10000; pointer-events: none; opacity: 0; transform-origin: 0 0; }
#promo-pointer svg { display: block; filter: drop-shadow(0 2px 4px rgba(0,0,0,.6)); }
#promo-pointer .touch { display: none; position: absolute; left: -19px; top: -19px; width: 38px; height: 38px; border-radius: 50%;
  background: rgba(255, 255, 255, .38); border: 2px solid rgba(255, 255, 255, .9); box-shadow: 0 2px 10px rgba(0,0,0,.4); }
#promo-pointer.touch svg { display: none; }
#promo-pointer.touch .touch { display: block; }
#promo-ripple { position: absolute; left: -22px; top: -22px; width: 44px; height: 44px; border-radius: 50%;
  border: 3px solid #ffd166; background: rgba(255, 209, 102, .25); opacity: 0; }
`
const POINTER_HTML = `<div id="promo-ripple"></div><div class="touch"></div><svg width="30" height="38" viewBox="0 0 30 38"><path d="M2 2 L2 31 L9.5 24 L14.5 35.5 L20 33 L15 21.5 L25 21.5 Z" fill="#fff" stroke="#111" stroke-width="2.2" stroke-linejoin="round"/></svg>`

export class Take {
  private n = 0
  private captions: Caption[] = []
  private lens: Lens = { x: 0, y: 0, w: W }
  private pointer = { x: W * 0.62, y: H * 0.7, shown: 0, clickAt: -1 }
  private pingsShown = -1
  /** Where the app runs: the page, or a frame in it (openStage). */
  app: Page | Frame
  /** Pings: shown by zoom (fading out up close), or kept off once they have faded. */
  pings: 'zoom' | 'off' = 'zoom'
  /** How clicks are shown: a mouse arrow that travels, or a touch marker. */
  touch = false
  readonly fps: number
  readonly dir: string

  constructor(readonly page: Page, name: string, fps = Number(process.env.PROMO_FPS ?? 60)) {
    this.app = page
    this.fps = fps
    this.dir = `promo/.frames/${name}`
    rmSync(this.dir, { recursive: true, force: true })
    mkdirSync(this.dir, { recursive: true })
  }

  /** Open the app at `query` as the page, wait for its data, and stop the clock. */
  async open(query = '', camera?: Camera): Promise<void> {
    await this.page.setViewportSize({ width: W, height: H })
    await this.page.clock.install()
    await this.page.goto('/' + query)
    await this.ready(camera)
  }

  /**
   * Open a page of the take's own (`html`, served at /promo-stage.html beside
   * the app, with `files` at their paths) holding the app in an iframe
   * `#promo-app`; wait for the app's data and stop the clock.
   */
  async openStage(html: string, files: Record<string, string> = {}, camera?: Camera): Promise<void> {
    const { page } = this
    await page.setViewportSize({ width: W, height: H })
    await page.route('**/promo-stage.html', (r) => r.fulfill({ contentType: 'text/html', body: html }))
    for (const [path, file] of Object.entries(files)) await page.route('**' + path, (r) => r.fulfill({ path: file }))
    await page.clock.install()
    await page.goto('/promo-stage.html')
    const el = await page.waitForSelector('#promo-app')
    this.app = (await el.contentFrame())!
    await this.ready(camera)
  }

  private async ready(camera?: Camera): Promise<void> {
    const { page, app } = this
    await app.waitForFunction(() => ((window as unknown as Partial<Hook>).__meshmap?.layers() ?? []).some((l) => l.id === 'nodes' && l.data.length > 0), null, { timeout: 60_000 })
    await page.addStyleTag({ content: OVERLAY_CSS })
    await page.evaluate((html) => {
      const f = document.createElement('div')
      f.id = 'promo-frame'
      f.innerHTML = '<div id="promo-caption"><div><div class="t"></div><div class="s"></div></div></div>'
      const p = document.createElement('div')
      p.id = 'promo-pointer'
      p.innerHTML = html
      document.body.append(f, p)
    }, POINTER_HTML)
    await app.evaluate(() => {
      // The pings' canvas: the map container's child between the map's canvas and its controls.
      const kids = [...document.querySelector('.maplibregl-map')!.children]
      const ping = kids[kids.findIndex((k) => k.classList.contains('maplibregl-control-container')) - 1]
      if (ping && !ping.classList.contains('maplibregl-canvas-container')) ping.id = 'promo-pings'
    })
    await page.waitForTimeout(3000) // the first layout (and the app's fit to its data) settles on the wall clock
    if (camera) await this.map((m, c) => { m.stop(); m.jumpTo(c) }, camera)
    await page.clock.pauseAt(Date.now() + 1000)
    await this.settle()
  }

  /** Run `fn(map, arg)` in the app. */
  map<A, R = void>(fn: (m: M, a: A) => R, arg: A): Promise<R> {
    return this.app.evaluate(([src, a]) => {
      const f = new Function('m', 'a', `return (${src})(m, a)`) as (m: M, a: unknown) => R
      return f((window as unknown as Hook).__meshmap.map, a)
    }, [fn.toString(), arg] as const) as Promise<R>
  }

  /** Nodes on the map right now (reported and estimated positions), from the header's counters. */
  async nodesOnMap(): Promise<number> {
    const text = await this.app.locator('.counters').innerText()
    const n = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0)
    return n('positioned') + n('estimated')
  }

  /** Seconds of video so far. */
  get t(): number {
    return this.n / this.fps
  }

  private async settle(): Promise<void> {
    await this.app.waitForFunction(() => (window as unknown as Hook).__meshmap.map.areTilesLoaded(), null, { timeout: 60_000, polling: 30 })
  }

  /** One frame: advance the clock by 1/fps, wait for the map's tiles, draw the overlay, save. */
  private async frame(): Promise<void> {
    // The app reclusters markers when a move ends (D-204), which in a video
    // looks like a pop at the end of every zoom: while the zoom changes, tell
    // it a move ended on every frame, so clusters come apart as they would if
    // it reclustered continuously. Then let React apply that before drawing.
    const zoom = await this.app.evaluate(() => {
      const m = (window as unknown as Hook).__meshmap.map
      const w = window as unknown as { __promoZoom?: number }
      const z = m.getZoom()
      if (w.__promoZoom !== z) {
        w.__promoZoom = z
        m.fire('moveend')
      }
      return new Promise<number>((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(z); c.port2.postMessage(0) })
    })
    const pings = this.pings === 'off' ? 0 : Math.min(1, Math.max(0, (PING_FADE[1] - zoom) / (PING_FADE[1] - PING_FADE[0])))
    if (pings !== this.pingsShown) {
      this.pingsShown = pings
      await this.app.evaluate((a) => { const p = document.getElementById('promo-pings'); if (p) p.style.opacity = String(a) }, pings)
    }
    await this.page.clock.runFor(1000 / this.fps)
    await this.settle()
    await this.drawOverlay()
    const { x, y, w } = this.lens
    await this.page.screenshot({ path: `${this.dir}/${String(this.n++).padStart(5, '0')}.png`, clip: { x, y, width: w, height: (w * H) / W } })
  }

  private async drawOverlay(): Promise<void> {
    const t = this.t
    const c = this.captions.find((c) => t >= c.from && t < c.to)
    const fade = 0.35
    const a = c ? Math.min(1, (t - c.from) / fade, (c.to - t) / fade) : 0
    const p = this.pointer
    const since = t - p.clickAt
    const ripple = p.clickAt >= 0 && since < 0.5 ? since / 0.5 : -1
    await this.page.evaluate(([cap, lens, ptr]) => {
      const [title, sub, a, place] = cap as [string, string, number, string]
      const { x, y, w } = lens as Lens
      const [px, py, shown, ripple, touch] = ptr as readonly number[]
      const k = w / innerWidth
      const f = document.getElementById('promo-frame')!
      f.style.transform = `translate(${x}px, ${y}px) scale(${k})`
      const d = document.getElementById('promo-caption')!
      d.querySelector('.t')!.textContent = title
      d.querySelector('.s')!.textContent = sub
      d.className = place === 'bottom' ? '' : place
      // Centred over the map the open panel leaves free (in frame coordinates).
      const dock = document.getElementById('dock')
      let right = 0
      if (place === 'bottom' && dock && !dock.hidden) {
        const left = (dock.getBoundingClientRect().left - x) / k
        if (left > innerWidth * 0.4 && left < innerWidth) right = innerWidth - left
      }
      d.style.right = `${right}px`
      d.style.opacity = String(a)
      d.style.transform = `translateY(${(1 - a) * 12}px)`
      const p = document.getElementById('promo-pointer')!
      p.className = touch ? 'touch' : ''
      p.style.opacity = String(shown)
      p.style.transform = `translate(${px}px, ${py}px) scale(${k})`
      const r = document.getElementById('promo-ripple')!
      r.style.opacity = ripple < 0 ? '0' : String(1 - ripple)
      r.style.transform = `scale(${0.4 + ripple * 1.4})`
    }, [[c?.title ?? '', c?.sub ?? '', a, c?.place ?? 'bottom'], this.lens, [p.x, p.y, p.shown, ripple, Number(this.touch)]] as const)
  }

  /** Show a caption from now for `seconds` (fading in and out); the frames come from the other steps. */
  caption(title: string, seconds: number, sub?: string, place: Place = 'bottom'): void {
    this.captions.push({ title, sub, from: this.t, to: this.t + seconds, place })
  }

  /** Record `seconds` of whatever the app does by itself. */
  async hold(seconds: number): Promise<void> {
    for (let i = Math.round(seconds * this.fps); i > 0; i--) await this.frame()
  }

  /** Record `seconds`, calling `step` with the eased progress (0 to 1) before each frame. */
  async animate(seconds: number, step: (e: number) => Promise<void> | void, ease: (t: number) => number = smooth): Promise<void> {
    const n = Math.max(1, Math.round(seconds * this.fps))
    for (let i = 1; i <= n; i++) {
      await step(ease(i / n))
      await this.frame()
    }
  }

  /** Ease the camera over `seconds` (MapLibre's own easing; for short moves). */
  async move(to: Camera, seconds: number): Promise<void> {
    await this.map((m, o) => m.easeTo(o), { ...to, duration: seconds * 1000, essential: true })
    await this.hold(seconds)
  }

  /**
   * Zoom between two views keeping `anchor` on a straight line across the
   * screen: from where it is now to where it is in `to`, as the zoom changes
   * evenly. (MapLibre's easing interpolates the centre, which makes a place
   * off the centre swing out sideways on the way.) The app must fill the page.
   */
  async glide(anchor: LngLat, to: Camera, seconds: number): Promise<void> {
    const start = await this.map((m, a) => ({ zoom: m.getZoom(), p: m.project(a) }), anchor)
    const merc = ([lon, lat]: LngLat) => {
      const s = Math.sin((lat * Math.PI) / 180)
      return { x: (lon + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) }
    }
    const a = merc(anchor), c = merc(to.center)
    const world = (z: number) => 512 * 2 ** z
    const end = { x: W / 2 + (a.x - c.x) * world(to.zoom), y: H / 2 + (a.y - c.y) * world(to.zoom) }
    await this.animate(seconds, async (e) => {
      const z = mix(start.zoom, to.zoom, e)
      const p = { x: mix(start.p.x, end.x, e), y: mix(start.p.y, end.y, e) }
      const cx = a.x - (p.x - W / 2) / world(z), cy = a.y - (p.y - H / 2) / world(z)
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * cy))) * 180) / Math.PI
      await this.map((m, v) => {
        m.jumpTo(v)
        ;(window as unknown as { __promoZoom?: number }).__promoZoom = m.getZoom() // jumpTo has ended a move already
      }, { center: [cx * 360 - 180, lat], zoom: z })
    })
  }

  /** Zoom the frame in on `target` (a rectangle in page pixels, with a margin), over `seconds`. */
  async focus(target: Rect, seconds = 0.9, margin = 40): Promise<void> {
    const want = { x: target.x - margin, y: target.y - margin, width: target.width + 2 * margin, height: target.height + 2 * margin }
    const w = Math.min(W, Math.max(W / SCALE, want.width, (want.height * W) / H))
    const h = (w * H) / W
    const x = Math.min(W - w, Math.max(0, want.x + want.width / 2 - w / 2))
    const y = Math.min(H - h, Math.max(0, want.y + want.height / 2 - h / 2))
    await this.lensTo({ x, y, w }, seconds)
  }

  /** Back to the whole page. */
  unfocus(seconds = 0.9): Promise<void> {
    return this.lensTo({ x: 0, y: 0, w: W }, seconds)
  }

  private async lensTo(to: Lens, seconds: number): Promise<void> {
    const from = { ...this.lens }
    await this.animate(seconds, (e) => {
      this.lens = { x: mix(from.x, to.x, e), y: mix(from.y, to.y, e), w: mix(from.w, to.w, e) }
    })
  }

  /** The page rectangle around some elements, `top`/`height` limiting it to part of the first. */
  async region(els: Locator[], opts: { top?: number; height?: number } = {}): Promise<Rect> {
    const boxes = (await Promise.all(els.map((l) => l.boundingBox()))).filter((b): b is Rect => !!b)
    if (!boxes.length) throw new Error('region: nothing on the page')
    const x0 = Math.min(...boxes.map((b) => b.x)), x1 = Math.max(...boxes.map((b) => b.x + b.width))
    let y0 = Math.min(...boxes.map((b) => b.y)), y1 = Math.max(...boxes.map((b) => b.y + b.height))
    if (opts.top !== undefined) y0 = boxes[0].y + opts.top
    if (opts.height !== undefined) y1 = y0 + opts.height
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }

  /** Bring the pointer to `to`: a mouse travels there over `seconds`, a touch marker appears there. */
  async point(to: XY, seconds = 0.7): Promise<void> {
    const p = this.pointer
    if (this.touch) {
      p.x = to.x
      p.y = to.y
      await this.animate(0.15, (e) => void (p.shown = e))
    } else {
      const from = { x: p.x, y: p.y, shown: p.shown }
      await this.animate(seconds, (e) => {
        p.x = mix(from.x, to.x, e)
        p.y = mix(from.y, to.y, e)
        p.shown = Math.max(from.shown, Math.min(1, e * 3))
      })
    }
    await this.page.mouse.move(to.x, to.y)
  }

  /** Hide the pointer over `seconds`. */
  async hidePointer(seconds = 0.3): Promise<void> {
    const from = this.pointer.shown
    await this.animate(seconds, (e) => void (this.pointer.shown = from * (1 - e)))
  }

  /** Where an element's centre is on the page. */
  async centre(el: Locator): Promise<XY> {
    const b = await el.boundingBox()
    if (!b) throw new Error('not on the page')
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }

  /**
   * Point at and click an element (its centre) or a page position, with a
   * ripple. `real: false` shows the tap without clicking (the take does what it does).
   */
  async click(target: Locator | XY, opts: { seconds?: number; park?: boolean; real?: boolean } = {}): Promise<void> {
    const xy = 'boundingBox' in target ? await this.centre(target) : target
    await this.point(xy, opts.seconds)
    if (opts.real !== false) await this.page.mouse.click(xy.x, xy.y)
    this.pointer.clickAt = this.t
    if (opts.park !== false) await this.park()
    await this.hold(0.25)
    if (this.touch) await this.hidePointer(0.25)
  }

  /** Where the app's top-left corner is on the page. */
  private async appOffset(): Promise<XY> {
    if (this.app === this.page) return { x: 0, y: 0 }
    const b = await this.page.locator('#promo-app').boundingBox()
    return { x: b?.x ?? 0, y: b?.y ?? 0 }
  }

  /** Click on the map at a place (a node: selects it, as a viewer would). */
  async clickMap(p: LngLat, opts: { seconds?: number } = {}): Promise<void> {
    const xy = await this.map((m, p) => m.project(p), p)
    const o = await this.appOffset()
    await this.click({ x: xy.x + o.x, y: xy.y + o.y }, opts)
  }

  /** Click on empty map (nothing within the pick radius), without showing it: clears the selection. */
  async clearSelection(): Promise<void> {
    const xy = await this.app.evaluate(() => {
      const pick = (window as unknown as Hook).__meshmap.pick
      const free = (x: number, y: number) => [-16, 0, 16].every((dx) => [-16, 0, 16].every((dy) => !pick(x + dx, y + dy)))
      for (let y = innerHeight * 0.75; y > innerHeight * 0.2; y -= 23)
        for (let x = innerWidth * 0.08; x < innerWidth * 0.45; x += 29) if (free(x, y)) return { x, y }
      throw new Error('no empty spot on the map')
    })
    const o = await this.appOffset()
    await this.page.mouse.click(xy.x + o.x, xy.y + o.y)
    await this.park()
  }

  /** Move the real mouse off the map: no hover tooltip or coordinate readout in the shot. */
  async park(): Promise<void> {
    if (this.app !== this.page) return this.page.mouse.move(2, 2)
    const b = await this.page.locator('#topbar').boundingBox()
    if (b) await this.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  }
}
