//! Norway's regions (landsdeler) for health rules (D-161): which region a
//! point lies in, from the same outlines as the map's Regions layer
//! (`frontend/src/assets/regions.geojson`, built by `scripts/regions.sh`),
//! and which region an MQTT topic root names. The outlines are not built
//! in: the worker fetches the map layer's file and hands it over
//! (`Engine::set_regions`), and until it has, regions are not judged.

/// How far outside every outline a point may lie and still count for the
/// nearest region: the outlines are simplified and drop islets under 2 km²,
/// so a coastal or island site can fall just outside them.
pub const NEAREST_KM: f64 = 15.0;

struct Region {
    name: &'static str,
    /// Every ring of every polygon, as (lon, lat): even-odd over all rings
    /// handles holes.
    rings: Vec<Ring>,
    /// The box around all its rings.
    bbox: Bbox,
}

struct Ring {
    pts: Vec<(f64, f64)>,
    bbox: Bbox,
}

/// A bounding box in degrees: (lon, lat) corners.
#[derive(Clone, Copy)]
struct Bbox {
    min: (f64, f64),
    max: (f64, f64),
}

impl Bbox {
    const EMPTY: Bbox = Bbox { min: (f64::INFINITY, f64::INFINITY), max: (f64::NEG_INFINITY, f64::NEG_INFINITY) };

    fn of(pts: &[(f64, f64)]) -> Bbox {
        pts.iter().fold(Bbox::EMPTY, |b, &(x, y)| Bbox { min: (b.min.0.min(x), b.min.1.min(y)), max: (b.max.0.max(x), b.max.1.max(y)) })
    }

    fn union(self, o: Bbox) -> Bbox {
        Bbox { min: (self.min.0.min(o.min.0), self.min.1.min(o.min.1)), max: (self.max.0.max(o.max.0), self.max.1.max(o.max.1)) }
    }

    fn contains(&self, lon: f64, lat: f64) -> bool {
        (self.min.0..=self.max.0).contains(&lon) && (self.min.1..=self.max.1).contains(&lat)
    }

    /// Distance in km from a point to the box, in distance_km's flat
    /// projection (kx, ky: km per degree): no point of a ring inside it is nearer.
    fn distance_km(&self, lon: f64, lat: f64, kx: f64, ky: f64) -> f64 {
        let dx = (self.min.0 - lon).max(lon - self.max.0).max(0.0) * kx;
        let dy = (self.min.1 - lat).max(lat - self.max.1).max(0.0) * ky;
        dx.hypot(dy)
    }
}

/// The regions' outlines.
#[derive(Default)]
pub struct Regions(Vec<Region>);

impl Regions {
    /// From the Regions layer's GeoJSON: features with a `region` property
    /// that is one of NAMES; others are ignored.
    pub fn parse(geojson: &str) -> Result<Regions, serde_json::Error> {
        let v: serde_json::Value = serde_json::from_str(geojson)?;
        let mut out = Vec::new();
        for f in v["features"].as_array().into_iter().flatten() {
            let Some(name) = f["properties"]["region"].as_str().and_then(|n| NAMES.iter().copied().find(|&k| k == n)) else { continue };
            let polys = match f["geometry"]["type"].as_str() {
                Some("Polygon") => vec![f["geometry"]["coordinates"].clone()],
                Some("MultiPolygon") => f["geometry"]["coordinates"].as_array().cloned().unwrap_or_default(),
                _ => continue,
            };
            let mut rings = Vec::new();
            for p in &polys {
                for ring in p.as_array().into_iter().flatten() {
                    let pts: Vec<(f64, f64)> = ring.as_array().into_iter().flatten().filter_map(|c| Some((c[0].as_f64()?, c[1].as_f64()?))).collect();
                    if pts.len() >= 3 {
                        rings.push(Ring { bbox: Bbox::of(&pts), pts });
                    }
                }
            }
            let bbox = rings.iter().fold(Bbox::EMPTY, |b, r| b.union(r.bbox));
            out.push(Region { name, rings, bbox });
        }
        Ok(Regions(out))
    }

    /// No outlines: the worker has not handed them over yet.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The region a point lies in, or the nearest one within NEAREST_KM;
    /// None elsewhere (abroad, or far out at sea). Bounding boxes skip the
    /// regions and rings a point cannot lie in or near.
    pub fn region_at(&self, lat: f64, lon: f64) -> Option<&'static str> {
        if let Some(r) = self.0.iter().find(|r| r.bbox.contains(lon, lat) && inside(&r.rings, lon, lat)) {
            return Some(r.name);
        }
        let mut best: Option<(&'static str, f64)> = None;
        for r in &self.0 {
            let limit = best.map_or(NEAREST_KM, |b| b.1);
            if let Some(d) = distance_km(r, lon, lat, limit)
                && best.is_none_or(|b| d < b.1)
            {
                best = Some((r.name, d));
            }
        }
        best.map(|(n, _)| n)
    }
}

fn inside(rings: &[Ring], lon: f64, lat: f64) -> bool {
    let mut odd = false;
    // A ring whose box misses the point crosses the ray from it an even
    // number of times (none, or in and out again): it changes nothing.
    for ring in rings.iter().filter(|r| r.bbox.contains(lon, lat)) {
        let ring = &ring.pts;
        let mut j = ring.len() - 1;
        for i in 0..ring.len() {
            let (xi, yi) = ring[i];
            let (xj, yj) = ring[j];
            if (yi > lat) != (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi {
                odd = !odd;
            }
            j = i;
        }
    }
    odd
}

/// Distance in km from a point to a region's outline (flat projection
/// around the point: fine at these distances), when it is at most `limit`;
/// None when it is farther.
fn distance_km(region: &Region, lon: f64, lat: f64, limit: f64) -> Option<f64> {
    let kx = 111.32 * lat.to_radians().cos();
    let ky = 110.57;
    if region.bbox.distance_km(lon, lat, kx, ky) > limit {
        return None;
    }
    let mut best = f64::INFINITY;
    for ring in &region.rings {
        if ring.bbox.distance_km(lon, lat, kx, ky) > best.min(limit) {
            continue;
        }
        for w in ring.pts.windows(2) {
            let (ax, ay) = ((w[0].0 - lon) * kx, (w[0].1 - lat) * ky);
            let (bx, by) = ((w[1].0 - lon) * kx, (w[1].1 - lat) * ky);
            let (dx, dy) = (bx - ax, by - ay);
            let len2 = dx * dx + dy * dy;
            let t = if len2 > 0.0 { (-(ax * dx + ay * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
            best = best.min((ax + t * dx).hypot(ay + t * dy));
        }
    }
    (best <= limit).then_some(best)
}

/// The only names a topic root may use for a region: exact, case and
/// Norwegian letters included.
pub const NAMES: [&str; 5] = ["Nord-Norge", "Trøndelag", "Vestlandet", "Østlandet", "Sørlandet"];

/// The region an MQTT topic root names: a segment equal to one of NAMES,
/// exactly. None when it names none.
pub fn region_of_topic(topic: &str) -> Option<&'static str> {
    topic.split('/').find_map(|seg| NAMES.iter().copied().find(|&n| n == seg))
}

/// A segment that is meant as a region but is not spelled exactly (other
/// case, ASCII for æ/ø/å, a missing hyphen): the segment and the name it
/// should be. Such a root names no region.
pub fn misspelled_region(topic: &str) -> Option<(&str, &'static str)> {
    let fold = |s: &str| s.to_lowercase().replace('æ', "ae").replace('ø', "o").replace('å', "a").replace("oe", "o").replace("aa", "a").replace(['-', '_', ' '], "");
    topic.split('/').find_map(|seg| {
        if NAMES.contains(&seg) {
            return None;
        }
        let s = fold(seg);
        NAMES.iter().copied().find(|n| fold(n) == s).map(|n| (seg, n))
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The map layer's file, as the worker would hand it over.
    pub(crate) fn fixture() -> Regions {
        Regions::parse(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/assets/regions.geojson")).unwrap()).unwrap()
    }

    #[test]
    fn points_fall_in_their_regions() {
        let rs = fixture();
        let region_at = |lat, lon| rs.region_at(lat, lon);
        assert_eq!(region_at(59.9139, 10.7522), Some("Østlandet"), "Oslo");
        assert_eq!(region_at(63.4305, 10.3951), Some("Trøndelag"), "Trondheim");
        assert_eq!(region_at(60.3913, 5.3221), Some("Vestlandet"), "Bergen");
        assert_eq!(region_at(58.1467, 7.9956), Some("Sørlandet"), "Kristiansand");
        assert_eq!(region_at(69.6496, 18.9560), Some("Nord-Norge"), "Tromsø");
        assert_eq!(region_at(59.3293, 18.0686), None, "Stockholm is in none");
        assert_eq!(region_at(56.0, 3.0), None, "the North Sea is in none");
    }

    #[test]
    fn bounding_boxes_change_no_answer() {
        // The same lookup without boxes: every ring tested, every region measured.
        let rs = fixture();
        let open = Bbox { min: (f64::NEG_INFINITY, f64::NEG_INFINITY), max: (f64::INFINITY, f64::INFINITY) };
        let unboxed: Vec<Region> = rs.0.iter().map(|r| Region { name: r.name, rings: r.rings.iter().map(|g| Ring { pts: g.pts.clone(), bbox: open }).collect(), bbox: open }).collect();
        let naive = |lat: f64, lon: f64| -> Option<&'static str> {
            if let Some(r) = unboxed.iter().find(|r| inside(&r.rings, lon, lat)) {
                return Some(r.name);
            }
            unboxed.iter().filter_map(|r| distance_km(r, lon, lat, NEAREST_KM).map(|d| (r.name, d))).min_by(|a, b| a.1.total_cmp(&b.1)).map(|(n, _)| n)
        };
        let mut n = 0;
        for a in 0..60 {
            for b in 0..50 {
                let (lat, lon) = (57.5 + a as f64 * 0.25, 3.0 + b as f64 * 0.6);
                let got = rs.region_at(lat, lon);
                assert_eq!(got, naive(lat, lon), "{lat}, {lon}");
                n += usize::from(got.is_some());
            }
        }
        assert!(n > 500, "the grid covers the regions: {n} points in one");
    }

    #[test]
    fn topic_roots_name_regions() {
        assert_eq!(region_of_topic("msh/EU_868/NO/Østlandet"), Some("Østlandet"));
        assert_eq!(region_of_topic("msh/EU_868/NO/Nord-Norge"), Some("Nord-Norge"));
        // Exact only: other case or spellings name no region, but are caught as misspelt.
        for (t, seg, name) in [("msh/EU_N_868/NO/ostlandet", "ostlandet", "Østlandet"), ("msh/EU_868/NO/Trondelag", "Trondelag", "Trøndelag"), ("msh/EU_868/NO/NordNorge", "NordNorge", "Nord-Norge"), ("msh/EU_868/NO/Oestlandet", "Oestlandet", "Østlandet"), ("msh/EU_868/NO/VESTLANDET", "VESTLANDET", "Vestlandet")] {
            assert_eq!(region_of_topic(t), None, "{t}");
            assert_eq!(misspelled_region(t), Some((seg, name)), "{t}");
        }
        assert_eq!(misspelled_region("msh/EU_868/NO/Østlandet"), None);
        assert_eq!(misspelled_region("msh/EU_868/NO/Molde"), None);
        assert_eq!(region_of_topic("msh/EU_868/NO"), None);
        assert_eq!(region_of_topic("msh/EU_N_868/Telemark"), None);
    }
}
