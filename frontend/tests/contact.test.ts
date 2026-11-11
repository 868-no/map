import { describe, expect, it } from 'vitest'
import { appLink } from '../src/features/node/Contact'

// D-213: from inside a browser, each app opens the contact by its own route.
describe('appLink', () => {
  const url = 'https://meshtastic.org/v/#CJL6pf0LElEK_-x'
  it('names the Android app in an intent: URL that keeps the https link', () => {
    const l = appLink(url, 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36')
    expect(l).toBe('intent://meshtastic.org/v/#CJL6pf0LElEK_-x#Intent;scheme=https;package=com.geeksville.mesh;end')
  })
  it("uses the iOS app's own scheme", () => {
    expect(appLink(url, 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')).toBe('meshtastic:///v#CJL6pf0LElEK_-x')
  })
  it('offers nothing on a desktop', () => {
    expect(appLink(url, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36')).toBeNull()
  })
})
