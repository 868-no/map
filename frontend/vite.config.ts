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
      const precache = [...urls, '/styles/dark.json']
      const src = readFileSync('sw/sw.js', 'utf8')
        .replace("'__VERSION__'", JSON.stringify(hash.digest('hex').slice(0, 12)))
        .replace('const PRECACHE = __PRECACHE__', `const PRECACHE = ${JSON.stringify(precache)}`)
      writeFileSync(join(outDir, 'sw.js'), src)
    },
  }
}

// Dev server proxies the API and map assets to a running stack
// (backend on :8000; tiles/fonts/styles from the web service on :8080).
export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    proxy: {
      '/api': 'http://host.docker.internal:8000',
      '/health': 'http://host.docker.internal:8000',
      '/tiles': 'http://host.docker.internal:8080',
      '/fonts': 'http://host.docker.internal:8080',
      '/styles': 'http://host.docker.internal:8080',
    },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 2500 },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'] },
})
