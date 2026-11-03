import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Tests are independent: workers and CI shards split them one by one, not by file.
  fullyParallel: true,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.MESHMAP_URL ?? 'http://localhost:8080',
    viewport: { width: 1440, height: 900 },
    timezoneId: 'Europe/Oslo',
    colorScheme: 'dark', // the app follows the browser: dark keeps screenshots consistent; theme tests emulate light
    // Request interception (page.route) does not see service-worker fetches;
    // the offline test opts back in.
    serviceWorkers: 'block',
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  outputDir: './e2e/.results',
})
