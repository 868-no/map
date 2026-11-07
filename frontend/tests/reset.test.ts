// @vitest-environment node
// Settings → Reset (D-076), with the browser's storage stood in for: the
// worker stops first, then everything stored goes, and the page reloads
// without its query string.
import { afterEach, describe, expect, it, vi } from 'vitest'

const order: string[] = []
vi.mock('../src/derive/client', () => ({ stopDerive: () => void order.push('stop') }))
const { resetEverything } = await import('../src/reset')

afterEach(() => vi.unstubAllGlobals())

describe('reset', () => {
  it('stops the worker before deleting its database, clears every store and reloads bare', async () => {
    const store = (name: string) => ({ clear: () => void order.push(`${name} cleared`) })
    const replace = vi.fn()
    vi.stubGlobal('localStorage', store('localStorage'))
    vi.stubGlobal('sessionStorage', store('sessionStorage'))
    vi.stubGlobal('indexedDB', {
      databases: async () => [{ name: 'meshmap-cache' }, { name: 'meshmap-derive' }],
      deleteDatabase: (name: string) => {
        order.push(`deleted ${name}`)
        const req = { onsuccess: null as (() => void) | null, onerror: null, onblocked: null }
        setTimeout(() => req.onsuccess?.())
        return req
      },
    })
    vi.stubGlobal('caches', { keys: async () => ['app-v1'], delete: async (k: string) => void order.push(`cache ${k} deleted`) })
    vi.stubGlobal('navigator', { serviceWorker: { getRegistrations: async () => [{ unregister: async () => void order.push('unregistered') }] } })
    vi.stubGlobal('location', { pathname: '/map', replace })
    await resetEverything()
    expect(order).toEqual(['stop', 'localStorage cleared', 'sessionStorage cleared', 'deleted meshmap-cache', 'deleted meshmap-derive', 'cache app-v1 deleted', 'unregistered'])
    expect(replace).toHaveBeenCalledWith('/map')
  })

  it('goes on when a store is not there to clear', async () => {
    order.length = 0
    const replace = vi.fn()
    vi.stubGlobal('localStorage', { clear: () => { throw new Error('denied') } })
    vi.stubGlobal('sessionStorage', undefined)
    vi.stubGlobal('indexedDB', undefined)
    vi.stubGlobal('caches', undefined)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('location', { pathname: '/', replace })
    await resetEverything()
    expect(order).toEqual(['stop'])
    expect(replace).toHaveBeenCalledWith('/')
  })
})
