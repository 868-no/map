//! Small shared helpers: node ids, timestamps, rounding, a fast hasher.

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

/// FxHash (rustc's hasher): much faster than SipHash for integer keys, and
/// these maps never hold attacker-chosen keys that need DoS resistance.
#[derive(Default, Clone, Copy)]
pub struct Fx(u64);

impl Hasher for Fx {
    fn finish(&self) -> u64 {
        // The product's low bits depend only on the key's low bits, and
        // the table indexes by low bits: rotating brings the well-mixed
        // high bits down (as rustc-hash 2 does), so keys sharing low zero
        // bits (hour starts, coarse coordinates) do not share buckets.
        self.0.rotate_left(26)
    }
    // Out of line: inlined into every map keyed by a string, the word loop
    // grew the WebAssembly by about 10 KB.
    #[inline(never)]
    fn write(&mut self, bytes: &[u8]) {
        // Eight bytes at a time, as rustc's FxHasher: strings (interned on
        // every row added) hash in an eighth of the steps.
        let (words, rest) = bytes.as_chunks::<8>();
        for w in words {
            self.add(u64::from_le_bytes(*w));
        }
        for &b in rest {
            self.add(b as u64);
        }
    }
    fn write_u8(&mut self, i: u8) {
        self.add(i as u64)
    }
    fn write_u16(&mut self, i: u16) {
        self.add(i as u64)
    }
    fn write_u32(&mut self, i: u32) {
        self.add(i as u64)
    }
    fn write_u64(&mut self, i: u64) {
        self.add(i)
    }
    fn write_i64(&mut self, i: i64) {
        self.add(i as u64)
    }
    fn write_usize(&mut self, i: usize) {
        self.add(i as u64)
    }
}

impl Fx {
    #[inline]
    fn add(&mut self, i: u64) {
        self.0 = (self.0.rotate_left(5) ^ i).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

pub type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;
pub type FxSet<K> = HashSet<K, BuildHasherDefault<Fx>>;

pub fn map<K, V>() -> FxMap<K, V> {
    FxMap::default()
}
pub fn set<K>() -> FxSet<K> {
    FxSet::default()
}

pub const BROADCAST: u32 = 0xffff_ffff;

/// "!xxxxxxxx", as the server writes node ids.
pub fn node_id(n: u32) -> String {
    format!("!{n:08x}")
}

/// Parses "!xxxxxxxx" or a decimal number.
pub fn parse_node(s: &str) -> Option<u32> {
    if let Some(h) = s.strip_prefix('!') {
        if h.len() == 8 { u32::from_str_radix(h, 16).ok() } else { None }
    } else if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok()
    } else {
        None
    }
}

/// A packet or reception key as sent by the API (16 hex digits) to a u64.
/// Anything else (hand-written test keys) is hashed (FNV-1a) consistently.
pub fn key64(s: &str) -> u64 {
    if s.len() == 16
        && let Ok(v) = u64::from_str_radix(s, 16)
    {
        return v;
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100_0000_01b3);
    }
    h
}

pub fn key_hex(k: u64) -> String {
    format!("{k:016x}")
}

pub fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Unix milliseconds to "YYYY-MM-DDTHH:MM:SS.mmmZ" (JavaScript's toISOString).
pub fn iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil(days);
    let (h, mi, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// A time in a sentence, as a mark the page writes in the viewer's time
/// zone ("{{t:1793...}}", Unix milliseconds): the engine knows no zone.
/// frontend/src/lib/time.ts `localizeTimes` reads the same form.
pub fn time_mark(ms: i64) -> String {
    format!("{{{{t:{ms}}}}}")
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian
/// (Howard Hinnant's civil_from_days).
fn civil(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_javascript() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_793_414_269_260), "2026-10-31T02:37:49.260Z"); // checked against Node's toISOString
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn node_ids_round_trip() {
        assert_eq!(node_id(0x0a00000a), "!0a00000a");
        assert_eq!(parse_node("!0a00000a"), Some(0x0a00000a));
        assert_eq!(parse_node("42"), Some(42));
        assert_eq!(parse_node("!zz"), None);
        assert_eq!(key64("6d09cc29ab957b72"), 0x6d09cc29ab957b72);
        assert_eq!(key_hex(key64("6d09cc29ab957b72")), "6d09cc29ab957b72");
    }

    #[test]
    fn rounding_is_away_from_zero() {
        assert_eq!(round2(-0.125), -0.13);
    }
}
