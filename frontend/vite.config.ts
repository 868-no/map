import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Emits dist/sw.js from sw/sw.js with the list of built files to precache
// and a version derived from their contents (a new build = a new cache).
function serviceWorker(): Plugin {
  let outDir = 'dist'
  return {
    name: 'meshmap-sw',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir
    },
    closeBundle() {
      const files: string[] = []
      const walk = (dir: string) => {
        for (const f of readdirSync(dir)) {
          const full = join(dir, f)
          if (statSync(full).isDirectory()) walk(full)
          else files.push(full)
        }
      }
      walk(outDir)
      const urls = files
        .map((f) => '/' + relative(outDir, f).split('\\').join('/'))
        .filter((u) => !u.endsWith('.map') && u !== '/sw.js')
        .sort()
      const hash = createHash('sha256')
      for (const u of urls) hash.update(u).update(readFileSync(join(outDir, u)))
      const precache = [...urls, '/styles/dark.json', '/styles/light.json']
      const src = readFileSync('sw/sw.js', 'utf8')
        .replace("'__VERSION__'", JSON.stringify(hash.digest('hex').slice(0, 12)))
        .replace('const PRECACHE = __PRECACHE__', `const PRECACHE = ${JSON.stringify(precache)}`)
      writeFileSync(join(outDir, 'sw.js'), src)
    },
  }
}

// Starts the derivation worker's script and the engine's WebAssembly from
// index.html, so they download beside the main bundles instead of after them;
// their content-hashed names are known only from inside the bundles (D-171).
// Measured forms: the worker (a module worker) as modulepreload, whose
// response the worker's own request takes from the HTTP cache; the engine as
// prefetch, which the worker's fetch() likewise reuses (also while still in
// flight) and, unlike a preload the document never uses itself, draws no
// "preloaded but not used" warning. Chrome has no preload `as` for workers.
function workerPreloads(): Plugin {
  return {
    name: 'meshmap-worker-preloads',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const names = Object.keys(ctx.bundle ?? {})
        const worker = names.find((n) => /(^|\/)worker-[\w-]+\.js$/.test(n))
        const wasm = names.find((n) => /(^|\/)engine_bg-[\w-]+\.wasm$/.test(n))
        if (!worker || !wasm) throw new Error(`worker preloads: worker or engine not emitted (${names.join(', ')})`)
        return [
          { tag: 'link', attrs: { rel: 'modulepreload', href: `/${worker}` }, injectTo: 'head' },
          { tag: 'link', attrs: { rel: 'prefetch', href: `/${wasm}` }, injectTo: 'head' },
        ]
      },
    },
  }
}

// Dev server proxies the API and map assets to a running stack
// (backend on :8000; tiles/fonts/styles from the web service on :8080).
export default defineConfig({
  plugins: [react(), workerPreloads(), serviceWorker()],
  server: {
    proxy: {
      '/api': 'http://host.docker.internal:8000',
      '/health': 'http://host.docker.internal:8000',
      '/tiles': 'http://host.docker.internal:8080',
      '/fonts': 'http://host.docker.internal:8080',
      '/styles': 'http://host.docker.internal:8080',
    },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      output: {
        // Large libraries change rarely: separate chunks stay cached across deploys of app code.
        advancedChunks: {
          groups: [
            { name: 'maplibre', test: /node_modules[\\/](maplibre-gl|pmtiles)/ },
            { name: 'deckgl', test: /node_modules[\\/](@deck\.gl|@luma\.gl|@loaders\.gl|@math\.gl|@probe\.gl)/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|@tanstack|zustand)[\\/]/ },
          ],
        },
      },
    },
  },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'] },
})
