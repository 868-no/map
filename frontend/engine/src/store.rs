//! The browser's copy of the packet log: rows ordered by (observed_at, id),
//! deduplicated by id. Fetched pages are staged first, so the caller can
//! still decide to start over before they are committed.

use std::cell::Cell;

use serde::{Deserialize, Serialize};

use crate::row::{parse_rows, to_json, Interner, JRow, Row, RowsSeed};
use crate::util::{FxMap, FxSet};

#[derive(Default)]
pub struct Store {
    // Rows are buf[start..]: trimming advances start, and the dropped prefix
    // is compacted away only once it is large, so a sync that trims a few
    // minutes of rows does not move every row kept (Store::rows).
    buf: Vec<Row>,
    start: usize,
    ids: FxSet<i64>,
    staged: FxMap<u32, Vec<Row>>,
    next_batch: u32,
    pub version: u64,   // bumped on every change (memo key)
    max_id: Option<i64>, // newest id among rows, kept up to date (revisions)
    stats_memo: Cell<Option<(usize, usize, u64, i64)>>, // (from, to, version, newest id) of a partial range
}

#[derive(Deserialize, Serialize)]
pub struct WindowEcho {
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub rolling: bool,
}

/// An /observations page, its rows converted as they are parsed (RowsSeed).
struct PageSeed<'s> {
    i: &'s mut Interner,
    rows: &'s mut Vec<Row>,
}

/// A page's fields besides its rows.
struct PageHead {
    window: WindowEcho,
    generation: String,
    more: bool,
    next_cursor: Option<String>,
}

impl<'de> serde::de::DeserializeSeed<'de> for PageSeed<'_> {
    type Value = PageHead;

    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<PageHead, D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> serde::de::Visitor<'de> for PageSeed<'_> {
    type Value = PageHead;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("an observations page")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<PageHead, A::Error> {
        use serde::de::Error;
        let (mut window, mut generation, mut more, mut next_cursor) = (None, None, false, None);
        while let Some(k) = m.next_key::<std::borrow::Cow<'de, str>>()? {
            match &*k {
                "window" => window = Some(m.next_value()?),
                "generation" => generation = Some(m.next_value()?),
                "more" => more = m.next_value()?,
                "next_cursor" => next_cursor = m.next_value()?,
                "rows" => m.next_value_seed(RowsSeed { i: &mut *self.i, keep: |_: &Row| true, out: &mut *self.rows })?,
                _ => {
                    m.next_value::<serde::de::IgnoredAny>()?;
                }
            }
        }
        Ok(PageHead {
            window: window.ok_or_else(|| A::Error::missing_field("window"))?,
            generation: generation.ok_or_else(|| A::Error::missing_field("generation"))?,
            more,
            next_cursor,
        })
    }
}

/// What the caller needs from a page; the rows stay in the engine.
#[derive(Serialize)]
pub struct PageMeta {
    pub window: WindowEcho,
    pub generation: String,
    pub more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub batch: u32,
    pub rows: usize,
}

fn by_time(a: &Row, b: &Row) -> std::cmp::Ordering {
    a.t.cmp(&b.t).then(a.id.cmp(&b.id))
}

impl Store {
    /// The rows held, ordered by (observed_at, id).
    pub fn rows(&self) -> &[Row] {
        &self.buf[self.start..]
    }

    /// Parses one /observations page into a staged batch (batch 0 starts a new one).
    pub fn stage(&mut self, text: &str, batch: u32, i: &mut Interner) -> Result<PageMeta, String> {
        use serde::de::DeserializeSeed;
        let mut rows = Vec::new();
        let mut d = serde_json::Deserializer::from_str(text);
        let page = PageSeed { i, rows: &mut rows }.deserialize(&mut d).and_then(|p| d.end().map(|_| p)).map_err(|e| format!("invalid page: {e}"))?;
        let batch = if batch == 0 {
            self.next_batch += 1;
            self.next_batch
        } else {
            batch
        };
        let n = rows.len();
        self.staged.entry(batch).or_default().extend(rows);
        Ok(PageMeta { window: page.window, generation: page.generation, more: page.more, next_cursor: page.next_cursor, batch, rows: n })
    }

    pub fn commit(&mut self, batch: u32) -> usize {
        let rows = self.staged.remove(&batch).unwrap_or_default();
        self.merge(rows)
    }

    pub fn discard(&mut self, batch: u32) {
        self.staged.remove(&batch);
    }

    /// Parses a JSON array of rows and merges those at or after `lo` (live rows, restored chunks).
    pub fn add_json(&mut self, text: &str, lo: i64, i: &mut Interner) -> Result<usize, String> {
        let rows = parse_rows(text, i, |r| r.t >= lo).map_err(|e| format!("invalid rows: {e}"))?;
        Ok(self.merge(rows))
    }

    pub fn merge(&mut self, rows: Vec<Row>) -> usize {
        let mut fresh: Vec<Row> = rows.into_iter().filter(|r| self.ids.insert(r.id)).collect();
        if fresh.is_empty() {
            return 0;
        }
        fresh.sort_unstable_by(by_time);
        let n = fresh.len();
        self.max_id = fresh.iter().map(|r| r.id).chain(self.max_id).max();
        let append = self.rows().last().is_none_or(|tail| by_time(&fresh[0], tail).is_ge());
        if append {
            self.buf.extend(fresh);
        } else {
            self.merge_older(fresh);
        }
        self.version += 1;
        n
    }

    /// Merges sorted rows, some older than rows held, into place: an older
    /// range filled in, routine since day commits arrive out of order
    /// (D-160). From the back, held rows move up into the room made for the
    /// new ones and the new ones fill the gaps: no scratch beyond that room
    /// (a stable sort would take half the store's size, in memory that never
    /// shrinks), and only rows after the first new one move.
    fn merge_older(&mut self, mut fresh: Vec<Row>) {
        // The first held row the new ones go before.
        let p = self.start + self.rows().partition_point(|h| by_time(h, &fresh[0]).is_le());
        // Room at the end, filled with a cheap row (no boxed parts) to be overwritten.
        let room = Row { pos: None, detail: None, ..fresh[0].clone() };
        let mut held = self.buf.len(); // held[p..held] still to place
        self.buf.resize(held + fresh.len(), room);
        // Slots w and above are placed; held..=w are free.
        let mut w = self.buf.len();
        while let Some(f) = fresh.last() {
            w -= 1;
            if held > p && by_time(&self.buf[held - 1], f).is_gt() {
                held -= 1;
                self.buf.swap(held, w);
            } else {
                self.buf[w] = fresh.pop().unwrap();
            }
        }
    }

    /// Drops every committed row. Staged batches belong to fetches in flight
    /// (a fresh start commits the batch it just fetched), so they stay.
    pub fn reset(&mut self) {
        self.buf = Vec::new();
        self.start = 0;
        self.ids.clear();
        self.max_id = None;
        self.version += 1;
    }

    fn lower_bound(&self, t: i64) -> usize {
        self.rows().partition_point(|r| r.t < t)
    }

    /// Indices [from, to) into rows of observed_at in [start, end).
    pub fn range(&self, start: i64, end: i64) -> (usize, usize) {
        let (a, b) = (self.lower_bound(start), self.lower_bound(end));
        (a, b.max(a))
    }

    /// Rows with observed_at in [start, end).
    pub fn slice(&self, start: i64, end: i64) -> &[Row] {
        let (a, b) = self.range(start, end);
        &self.rows()[a..b]
    }

    pub fn trim_before(&mut self, t: i64) {
        let k = self.lower_bound(t);
        if k == 0 {
            return;
        }
        let (a, b) = (self.start, self.start + k);
        let mut newest_gone = false;
        for r in &mut self.buf[a..b] {
            self.ids.remove(&r.id);
            newest_gone |= Some(r.id) == self.max_id;
            // What a dropped row owns goes now; only its fixed part waits
            // for the compaction below.
            r.detail = None;
            r.pos = None;
        }
        self.start = b;
        // Moving the kept rows down costs as much as the rows kept: done
        // once the dropped prefix is a quarter of the vector, it stays
        // linear overall and holds at most a third more than the rows kept.
        if 4 * self.start >= self.buf.len() {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        if newest_gone {
            self.max_id = self.rows().iter().map(|r| r.id).max();
        }
        self.version += 1;
    }

    /// Calls `f` on every interned id held, committed or staged (Interner::retain).
    pub fn for_each_id(&mut self, mut f: impl FnMut(&mut u32)) {
        // Only rows held. The trimmed prefix keeps its old ids, which go
        // stale (or u32::MAX) once the interner renumbers; that is safe only
        // because nothing reads those rows again before compaction drops them.
        let start = self.start;
        for r in self.buf[start..].iter_mut().chain(self.staged.values_mut().flatten()) {
            r.for_each_id(&mut f);
        }
    }

    pub fn newest_t(&self) -> i64 {
        self.rows().last().map_or(0, |r| r.t)
    }

    /// Rows with observed_at in [lo, hi) as the API's JSON array.
    pub fn export(&self, lo: i64, hi: i64, i: &Interner) -> String {
        let rows: Vec<JRow> = self.slice(lo, hi).iter().map(|r| to_json(r, i)).collect();
        serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into())
    }

    /// (rows, newest id) in [start, end): part of a view's revision, asked
    /// for on every view request. A window holding every row (the usual
    /// case) uses the maintained newest id; any other range is scanned once
    /// per store version.
    pub fn stats(&self, start: i64, end: i64) -> (usize, i64) {
        let (a, b) = self.range(start, end);
        if a == b {
            return (0, 0);
        }
        if a == 0 && b == self.rows().len() {
            return (b, self.max_id.unwrap_or(0));
        }
        if let Some((ma, mb, v, m)) = self.stats_memo.get()
            && (ma, mb, v) == (a, b, self.version)
        {
            return (b - a, m);
        }
        let m = self.rows()[a..b].iter().map(|r| r.id).max().unwrap_or(0);
        self.stats_memo.set(Some((a, b, self.version, m)));
        (b - a, m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR_MS: i64 = 3_600_000;

    fn row(i: i64, t: i64) -> String {
        format!(r#"{{"i":{i},"t":{t},"b":"x","s":1,"y":"text","l":"{i:016x}","o":"{:016x}","sg":"unsigned"}}"#, i + 1000)
    }

    #[test]
    fn stage_commit_dedupe_and_order() {
        let mut i = Interner::default();
        let mut s = Store::default();
        let page = format!(r#"{{"window":{{"start":"a","end":"b","rolling":true}},"generation":"g","more":true,"next_cursor":"c","rows":[{},{}]}}"#, row(2, 20), row(1, 10));
        let m = s.stage(&page, 0, &mut i).unwrap();
        assert_eq!((m.rows, m.more, m.next_cursor.as_deref()), (2, true, Some("c")));
        assert_eq!(s.rows().len(), 0, "staged, not committed");
        assert_eq!(s.commit(m.batch), 2);
        assert_eq!(s.rows().iter().map(|r| r.id).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(s.add_json(&format!("[{},{}]", row(2, 20), row(3, 30)), 0, &mut i).unwrap(), 1, "duplicate ignored");
        assert_eq!(s.add_json(&format!("[{}]", row(4, 5)), 0, &mut i).unwrap(), 1, "older row sorted in");
        assert_eq!(s.rows().iter().map(|r| r.id).collect::<Vec<_>>(), vec![4, 1, 2, 3]);
        assert_eq!(s.add_json(&format!("[{}]", row(5, 1)), 10, &mut i).unwrap(), 0, "before lo");
        assert_eq!(s.slice(10, 30).len(), 2);
        s.trim_before(20);
        assert_eq!(s.rows().len(), 2);
        assert_eq!(s.add_json(&format!("[{}]", row(1, 10)), 0, &mut i).unwrap(), 1, "trimmed ids may return");
        // Starting over keeps a batch staged by the fetch that caused it.
        let m = s.stage(&page, 0, &mut i).unwrap();
        s.reset();
        assert_eq!(s.commit(m.batch), 2);
    }

    #[test]
    fn older_rows_merge_into_place_in_order() {
        let mut i = Interner::default();
        // A small linear congruential generator: varied, repeatable batches.
        let mut seed = 7u64;
        let mut next = |m: i64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as i64).rem_euclid(m)
        };
        for round in 0..50 {
            let mut s = Store::default();
            let mut id = 1;
            let mut want: Vec<(i64, i64)> = Vec::new();
            for _ in 0..6 {
                let base = next(1000);
                let batch: Vec<String> = (0..next(40)).map(|_| {
                    id += 1;
                    // Equal times among batches, ordered by id.
                    let t = base + next(50);
                    want.push((t, id));
                    row(id, t)
                }).collect();
                s.add_json(&format!("[{}]", batch.join(",")), 0, &mut i).unwrap();
                if round % 2 == 1 {
                    s.trim_before(next(200)); // an offset start: order alone is checked
                }
            }
            let got: Vec<(i64, i64)> = s.rows().iter().map(|r| (r.t, r.id)).collect();
            let mut sorted = got.clone();
            sorted.sort_unstable();
            assert_eq!(got, sorted, "round {round}: in order");
            if round % 2 == 0 {
                want.sort_unstable();
                assert_eq!(got, want, "round {round}: every row once");
            }
        }
    }

    #[test]
    fn a_page_parses_in_any_field_order_with_or_without_rows() {
        let mut i = Interner::default();
        let mut s = Store::default();
        let w = r#""window":{"start":"a","end":"b"}"#;
        let m = s.stage(&format!(r#"{{"rows":[{}],"extra":{{"x":[1]}},"generation":"g",{w}}}"#, row(1, 10)), 0, &mut i).unwrap();
        assert_eq!((m.rows, m.generation.as_str(), m.more, m.next_cursor), (1, "g", false, None), "rows first, unknown fields skipped");
        assert_eq!(s.stage(&format!(r#"{{{w},"generation":"g","rows":null}}"#), 0, &mut i).unwrap().rows, 0, "null rows");
        assert_eq!(s.stage(&format!(r#"{{{w},"generation":"g"}}"#), 0, &mut i).unwrap().rows, 0, "no rows");
        assert!(s.stage(&format!(r#"{{{w},"rows":[]}}"#), 0, &mut i).err().is_some_and(|e| e.contains("generation")));
        assert!(s.stage(&format!(r#"{{{w},"generation":"g","rows":[{{"i":1}}]}}"#), 0, &mut i).is_err(), "a bad row fails the page");
        assert!(s.stage(&format!(r#"{{{w},"generation":"g"}} x"#), 0, &mut i).is_err(), "trailing text");
        assert!(s.add_json("[1]", 0, &mut i).is_err());
    }

    #[test]
    fn stats_follow_additions_and_eviction() {
        let mut i = Interner::default();
        let mut s = Store::default();
        let scan = |s: &Store, a: i64, b: i64| (s.slice(a, b).len(), s.slice(a, b).iter().map(|r| r.id).max().unwrap_or(0));
        let check = |s: &Store| {
            for (a, b) in [(0, 100), (0, 25), (15, 100), (25, 26), (90, 100)] {
                assert_eq!(s.stats(a, b), scan(s, a, b), "[{a}, {b})");
                assert_eq!(s.stats(a, b), scan(s, a, b), "[{a}, {b}) again");
            }
        };
        s.add_json(&format!("[{},{},{}]", row(1, 10), row(9, 20), row(3, 30)), 0, &mut i).unwrap();
        check(&s);
        s.add_json(&format!("[{}]", row(2, 15)), 0, &mut i).unwrap();
        check(&s);
        s.trim_before(20); // evicts nothing newest
        check(&s);
        s.trim_before(25); // evicts the newest id (9)
        assert_eq!(s.stats(0, 100), (1, 3));
        check(&s);
        s.reset();
        assert_eq!(s.stats(0, 100), (0, 0));
    }

    #[test]
    fn small_trims_keep_order_dedupe_and_ranges() {
        let mut i = Interner::default();
        let mut s = Store::default();
        let ids = |s: &Store| s.rows().iter().map(|r| r.id).collect::<Vec<_>>();
        s.add_json(&format!("[{}]", (1..=10).map(|k| row(k, k * 10)).collect::<Vec<_>>().join(",")), 0, &mut i).unwrap();
        s.trim_before(15); // drops 1 row of 10: kept in place behind the offset
        assert_eq!(ids(&s), (2..=10).collect::<Vec<_>>());
        assert_eq!(s.add_json(&format!("[{}]", row(1, 10)), 0, &mut i).unwrap(), 1, "a trimmed id may return");
        s.trim_before(15);
        // Out of order: sorted among the rows held, not the trimmed ones.
        s.add_json(&format!("[{},{}]", row(11, 25), row(12, 200)), 0, &mut i).unwrap();
        assert_eq!(ids(&s), vec![2, 11, 3, 4, 5, 6, 7, 8, 9, 10, 12]);
        assert_eq!(s.slice(25, 41).iter().map(|r| r.id).collect::<Vec<_>>(), vec![11, 3, 4]);
        assert_eq!(s.stats(0, 1000), (11, 12));
        s.trim_before(65); // over half dropped: compacted
        assert_eq!(ids(&s), vec![7, 8, 9, 10, 12]);
        s.trim_before(75);
        assert_eq!(ids(&s), vec![8, 9, 10, 12]);
        assert_eq!(s.stats(0, 1000), (4, 12));
        assert_eq!(s.add_json(&format!("[{}]", row(8, 80)), 0, &mut i).unwrap(), 0, "kept ids still deduplicate");
    }

    #[test]
    fn export_round_trips() {
        let mut i = Interner::default();
        let mut s = Store::default();
        s.add_json(&format!("[{},{}]", row(1, 10), row(2, HOUR_MS + 5)), 0, &mut i).unwrap();
        let text = s.export(0, HOUR_MS, &i);
        let mut t = Store::default();
        assert_eq!(t.add_json(&text, 0, &mut i).unwrap(), 1);
        assert_eq!(t.rows()[0], s.rows()[0]);
    }
}
