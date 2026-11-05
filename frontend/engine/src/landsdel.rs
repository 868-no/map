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
    rings: Vec<Vec<(f64, f64)>>,
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
                        rings.push(pts);
                    }
                }
            }
            out.push(Region { name, rings });
        }
        Ok(Regions(out))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The region a point lies in, or the nearest one within NEAREST_KM;
    /// None elsewhere (abroad, or far out at sea).
    pub fn region_at(&self, lat: f64, lon: f64) -> Option<&'static str> {
        if let Some(r) = self.0.iter().find(|r| inside(&r.rings, lon, lat)) {
            return Some(r.name);
        }
        self.0
            .iter()
            .map(|r| (r.name, distance_km(&r.rings, lon, lat)))
            .filter(|&(_, d)| d <= NEAREST_KM)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(n, _)| n)
    }
}

fn inside(rings: &[Vec<(f64, f64)>], lon: f64, lat: f64) -> bool {
    let mut odd = false;
    for ring in rings {
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
/// around the point: fine at these distances).
fn distance_km(rings: &[Vec<(f64, f64)>], lon: f64, lat: f64) -> f64 {
    let kx = 111.32 * lat.to_radians().cos();
    let ky = 110.57;
    let mut best = f64::INFINITY;
    for ring in rings {
        for w in ring.windows(2) {
            let (ax, ay) = ((w[0].0 - lon) * kx, (w[0].1 - lat) * ky);
            let (bx, by) = ((w[1].0 - lon) * kx, (w[1].1 - lat) * ky);
            let (dx, dy) = (bx - ax, by - ay);
            let len2 = dx * dx + dy * dy;
            let t = if len2 > 0.0 { (-(ax * dx + ay * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
            best = best.min((ax + t * dx).hypot(ay + t * dy));
        }
    }
    best
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
