// The promo recorder (promo/README.md): each take is a "test" that drives the
// app against production and writes its frames under promo/.frames.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './takes',
  timeout: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.PROMO_URL ?? 'http://127.0.0.1:4173',
    timezoneId: 'Europe/Oslo',
    colorScheme: 'dark',
    serviceWorkers: 'block',
    actionTimeout: 30_000, // a missing element fails the take instead of hanging it
    deviceScaleFactor: 2, // lib.ts SCALE: frames can zoom in 2× and stay sharp
    launchOptions: { args: process.env.PROMO_GPU ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  outputDir: './.results',
})
