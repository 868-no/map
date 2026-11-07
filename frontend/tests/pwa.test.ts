import { describe, expect, it, vi } from 'vitest'
import { setupPwa, usePwa } from '../src/pwa'

describe('offline and installation', () => {
  it("follows the browser's connection and offers its install prompt once", async () => {
    setupPwa()
    window.dispatchEvent(new Event('offline'))
    expect(usePwa.getState().online).toBe(false)
    window.dispatchEvent(new Event('online'))
    expect(usePwa.getState().online).toBe(true)

    const prompt = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: vi.fn(async () => {}), userChoice: Promise.resolve({ outcome: 'accepted' }) })
    window.dispatchEvent(prompt)
    expect(prompt.defaultPrevented).toBe(true) // our own button instead of the browser's bar
    expect(usePwa.getState().canInstall).toBe(true)
    await usePwa.getState().install()
    expect(prompt.prompt).toHaveBeenCalledTimes(1)
    expect(usePwa.getState().canInstall).toBe(false)
    await usePwa.getState().install() // the prompt is used up
    expect(prompt.prompt).toHaveBeenCalledTimes(1)
  })
})
