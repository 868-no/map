// Basemap layer groups (ids match web/styles/dark.json). Kept free of
// map-library imports so the store and tests can use it.
/**
 * Basemap layer groups the viewer can switch on and off. Most start hidden
 * to keep the map calm; water and the background are always shown.
 */
export const BASEMAP_GROUPS = [
  { id: 'borders', label: 'Borders', on: true, layers: ['boundary-county', 'boundary-country'],
    info: 'National borders and county (fylke) boundaries from OpenStreetMap.' },
  { id: 'majorRoads', label: 'Major roads', on: false, layers: ['road-primary', 'road-trunk', 'road-motorway'],
    info: 'Motorways, trunk roads and primary roads from OpenStreetMap.' },
  { id: 'landcover', label: 'Land cover and parks', on: true, layers: ['landcover-ice', 'landcover-wood', 'landcover-grass', 'landuse-residential', 'park'],
    info: 'Glaciers, forest, grassland and farmland, built-up areas and parks, as subtle shading. Helps read terrain that affects radio range.' },
  { id: 'minorRoads', label: 'Minor roads and rail', on: false, layers: ['road-minor', 'road-tertiary', 'road-secondary', 'rail'],
    info: 'Secondary, tertiary and local roads, tracks, railways and transit lines from OpenStreetMap.' },
  { id: 'waterways', label: 'Rivers and streams', on: false, layers: ['waterway'],
    info: 'Rivers, streams and canals. Lakes and the sea are always shown.' },
  { id: 'buildings', label: 'Buildings', on: false, layers: ['building'],
    info: 'Building footprints from OpenStreetMap; visible when zoomed far in.' },
  { id: 'places', label: 'Place names', on: false, layers: ['place-village', 'place-town', 'place-city', 'place-country'],
    info: 'Names of countries, cities, towns, villages and neighbourhoods.' },
  { id: 'peaks', label: 'Peaks', on: false, layers: ['mountain-peak'],
    info: 'Mountain peaks with name and elevation. Useful for spotting likely high sites for routers.' },
  { id: 'roadNames', label: 'Road names and numbers', on: false, layers: ['road-name', 'road-shield'],
    info: 'Street names and route numbers (E6, Rv. 3 …) along roads.' },
  { id: 'waterNames', label: 'Water names', on: false, layers: ['water-name'],
    info: 'Names of seas, fjords and lakes.' },
] as const

export type BasemapGroup = (typeof BASEMAP_GROUPS)[number]['id']

export const defaultBasemap = Object.fromEntries(BASEMAP_GROUPS.map((g) => [g.id, g.on])) as Record<BasemapGroup, boolean>
