// County number -> region (landsdel), for scripts/regions.sh.
const REGIONS = {
  'Nord-Norge': ['18', '55', '56'],
  Trøndelag: ['50'],
  Vestlandet: ['11', '15', '46'],
  Østlandet: ['03', '31', '32', '33', '34', '39', '40'],
  Sørlandet: ['42'],
}
const IDS = { 'Nord-Norge': 'nord', Trøndelag: 'trondelag', Vestlandet: 'vest', Østlandet: 'ost', Sørlandet: 'sor' }

module.exports = {
  region: (county) => Object.keys(REGIONS).find((r) => REGIONS[r].includes(String(county).padStart(2, '0'))) ?? null,
  id: (region) => IDS[region],
}
