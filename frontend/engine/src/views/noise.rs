//! The noise floor nodes measure (local statistics telemetry, D-199): one
//! reading per packet, per node, for the Telemetry tab's chart, the link
//! panel's RSSI chart and a router's link quality chart.

use super::first_per_packet;
use crate::row::{ty, Interner, Row};
use crate::util::{map, FxMap};

/// Every node's noise floor readings in the window: [Unix ms, dBm], one per
/// logical packet (its first copy), in time order. Built on first use: most
/// builds show no panel that needs it.
#[derive(Default)]
pub struct NoiseFloors(FxMap<u32, Vec<(i64, i32)>>);

impl NoiseFloors {
    pub fn new(rows: &[&Row], i: &Interner) -> Self {
        let Some(local) = i.get("local") else { return NoiseFloors::default() };
        let first = first_per_packet(rows.iter().copied(), |r| r.ty == ty::TELEMETRY && r.telemetry().is_some_and(|t| t.kind == local && t.noise_floor.is_some()));
        let mut by: FxMap<u32, Vec<(i64, u64, i32)>> = map();
        for r in first {
            by.entry(r.src).or_default().push((r.t, r.lp, r.telemetry().unwrap().noise_floor.unwrap()));
        }
        NoiseFloors(
            by.into_iter()
                .map(|(n, mut v)| {
                    v.sort_unstable_by_key(|x| (x.0, x.1));
                    (n, v.into_iter().map(|(t, _, f)| (t, f)).collect())
                })
                .collect(),
        )
    }

    /// `num`'s readings, oldest first; empty when it sent none.
    pub fn of(&self, num: u32) -> &[(i64, i32)] {
        self.0.get(&num).map_or(&[], Vec::as_slice)
    }

    /// `num`'s newest `max` readings, oldest first.
    pub fn newest(&self, num: u32, max: usize) -> Vec<(i64, i32)> {
        let v = self.of(num);
        v[v.len().saturating_sub(max)..].to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::JRow;

    #[test]
    fn one_reading_per_packet_from_local_stats_only() {
        let mut i = Interner::default();
        // Node 5: a packet heard by two gateways (the earlier copy counts),
        // local stats without a floor, device telemetry; node 6 one reading.
        let text = r#"[
          {"i":1,"t":2000,"b":"x","g":7,"s":5,"y":"telemetry","l":"01","o":"01","sg":"unsigned","te":{"kind":"local","noise_floor":-104}},
          {"i":2,"t":1000,"b":"x","g":8,"s":5,"y":"telemetry","l":"02","o":"02","sg":"unsigned","te":{"kind":"local","noise_floor":-110}},
          {"i":3,"t":1500,"b":"x","g":9,"s":5,"y":"telemetry","l":"02","o":"03","sg":"unsigned","te":{"kind":"local","noise_floor":-90}},
          {"i":4,"t":3000,"b":"x","g":7,"s":5,"y":"telemetry","l":"04","o":"04","sg":"unsigned","te":{"kind":"local"}},
          {"i":5,"t":4000,"b":"x","g":7,"s":5,"y":"telemetry","l":"05","o":"05","sg":"unsigned","te":{"kind":"device","battery":80}},
          {"i":6,"t":5000,"b":"x","g":7,"s":6,"y":"telemetry","l":"06","o":"06","sg":"unsigned","te":{"kind":"local","noise_floor":-99}}
        ]"#;
        let rows: Vec<Row> = serde_json::from_str::<Vec<JRow>>(text).unwrap().into_iter().map(|r| r.into_row(&mut i)).collect();
        let refs: Vec<&Row> = rows.iter().collect();
        let f = NoiseFloors::new(&refs, &i);
        assert_eq!(f.of(5), [(1000, -110), (2000, -104)]);
        assert_eq!(f.of(6), [(5000, -99)]);
        assert!(f.of(7).is_empty());
        assert_eq!(f.newest(5, 1), vec![(2000, -104)]);
    }

    #[test]
    fn no_local_stats_no_readings() {
        let i = Interner::default();
        assert!(NoiseFloors::new(&[], &i).of(5).is_empty());
    }
}
