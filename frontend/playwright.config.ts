import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.MESHMAP_URL ?? 'http://localhost:8080',
    viewport: { width: 1440, height: 900 },
    timezoneId: 'Europe/Oslo',
    colorScheme: 'light', // the app must stay dark even when the OS prefers light
    // Request interception (page.route) does not see service-worker fetches;
    // the offline test opts back in.
    serviceWorkers: 'block',
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  outputDir: './e2e/.results',
})
