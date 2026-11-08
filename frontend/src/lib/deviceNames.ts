// Meshtastic's enum names (hardware models, roles, modem presets) in plain
// words for the UI. The engine passes the protobuf names through untouched.

/** Device roles (the raw enum name is the fallback). */
const ROLE_LABEL: Record<string, string> = {
  CLIENT: 'Client', CLIENT_MUTE: 'Client (mute)', CLIENT_HIDDEN: 'Client (hidden)', CLIENT_BASE: 'Client base',
  ROUTER: 'Router', ROUTER_LATE: 'Router (late)', ROUTER_CLIENT: 'Router/client', REPEATER: 'Repeater',
  TRACKER: 'Tracker', SENSOR: 'Sensor', TAK: 'TAK', TAK_TRACKER: 'TAK tracker', LOST_AND_FOUND: 'Lost and found',
}
export const roleLabel = (r: string) => ROLE_LABEL[r] ?? r

/** "NARROW_FAST" -> "Narrow Fast" */
export const presetName = (p: string) => p.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

/** Common boards by their product names, where the enum name is far from it. */
const HARDWARE: Record<string, string> = {
  T_ECHO: 'LilyGO T-Echo',
  T_DECK: 'LilyGO T-Deck',
  TBEAM: 'LilyGO T-Beam',
  LILYGO_TBEAM_S3_CORE: 'LilyGO T-Beam Supreme',
  TLORA_T3_S3: 'LilyGO T3-S3',
  TLORA_V2_1_1P6: 'LilyGO T-LoRa V2.1-1.6',
  TLORA_V2_1_1P8: 'LilyGO T-LoRa V2.1-1.8',
  HELTEC_MESH_POCKET: 'Heltec MeshPocket',
  HELTEC_WSL_V3: 'Heltec Wireless Stick Lite V3',
  SEEED_XIAO_S3: 'Seeed XIAO ESP32-S3',
  XIAO_NRF52_KIT: 'Seeed XIAO nRF52840 kit',
  SEEED_SOLAR_NODE: 'Seeed SenseCAP Solar Node',
  TRACKER_T1000_E: 'Seeed SenseCAP T1000-E',
  SENSECAP_INDICATOR: 'Seeed SenseCAP Indicator',
  WISMESH_TAG: 'RAK WisMesh Tag',
  THINKNODE_M1: 'Elecrow ThinkNode M1',
  THINKNODE_M2: 'Elecrow ThinkNode M2',
  STATION_G2: 'Station G2',
  NANO_G2_ULTRA: 'Nano G2 Ultra',
  PORTDUINO: 'Linux (Portduino)',
  PRIVATE_HW: 'Private hardware',
}

/** Words of enum names spelt their own way; others are capitalised, and words with digits kept. */
const WORDS: Record<string, string> = { HELTEC: 'Heltec', LILYGO: 'LilyGO', SEEED: 'Seeed', TLORA: 'T-LoRa', TBEAM: 'T-Beam', LORA: 'LoRa', ESP32: 'ESP32', NRF52: 'nRF52', RAK: 'RAK', M5STACK: 'M5Stack', DIY: 'DIY', HW: 'HW', TAK: 'TAK', USB: 'USB', RP2040: 'RP2040' }

/** A hardware model's enum name for people: "HELTEC_V3" -> "Heltec V3", "RAK4631" -> "RAK4631". */
export function hardwareName(model: string): string {
  if (HARDWARE[model]) return HARDWARE[model]
  return model
    .split('_')
    .filter(Boolean)
    .map((w) => WORDS[w] ?? (/\d/.test(w) ? w : w[0] + w.slice(1).toLowerCase()))
    .join(' ')
}
