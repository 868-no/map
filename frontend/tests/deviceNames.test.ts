import { describe, expect, it } from 'vitest'
import { hardwareName, presetName, roleLabel } from '../src/lib/deviceNames'

describe('hardware model names', () => {
  it('names common boards as sold', () => {
    expect(hardwareName('T_ECHO')).toBe('LilyGO T-Echo')
    expect(hardwareName('TRACKER_T1000_E')).toBe('Seeed SenseCAP T1000-E')
    expect(hardwareName('XIAO_NRF52_KIT')).toBe('Seeed XIAO nRF52840 kit')
  })

  it('makes any other enum name readable: brands spelt their way, model codes kept', () => {
    expect(hardwareName('HELTEC_V3')).toBe('Heltec V3')
    expect(hardwareName('RAK4631')).toBe('RAK4631')
    expect(hardwareName('HELTEC_MESH_NODE_T114')).toBe('Heltec Mesh Node T114')
    expect(hardwareName('SEEED_WIO_TRACKER_L1')).toBe('Seeed Wio Tracker L1')
    expect(hardwareName('LILYGO_T_LORA_PAGER')).toBe('LilyGO T LoRa Pager')
    expect(hardwareName('M5STACK_C6L')).toBe('M5Stack C6L')
    expect(hardwareName('FUTURE_BOARD__X')).toBe('Future Board X')
  })

  it('names roles and presets in plain words', () => {
    expect(roleLabel('CLIENT_BASE')).toBe('Client base')
    expect(roleLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW')
    expect(presetName('NARROW_FAST')).toBe('Narrow Fast')
  })
})
