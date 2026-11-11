// The promo recorder's server: the app built with the test hook
// (promo/.dist), its data, tiles, fonts and styles from production.
import { defineConfig } from 'vite'

const target = process.env.PROMO_SITE ?? 'https://map.868.no'
const proxy = Object.fromEntries(['/api', '/health', '/tiles', '/fonts', '/styles'].map((p) => [p, { target, changeOrigin: true, secure: true }]))

export default defineConfig({
  build: { outDir: 'promo/.dist' },
  preview: { port: 4173, strictPort: true, host: '127.0.0.1', proxy },
})
