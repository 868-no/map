//! The browser's copy of the packet log: rows ordered by (observed_at, id),
//! deduplicated by id. Fetched pages are staged first, so the caller can
//! still decide to start over before they are committed.

use std::cell::Cell;

use serde::{Deserialize, Serialize};

use crate::row::{to_json, Interner, JRow, Row};
use crate::util::{FxMap, FxSet};

pub const HOUR_MS: i64 = 3_600_000;

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
    dirty: FxSet<i64>,  // hour starts with rows added since the last take_dirty
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

#[derive(Deserialize)]
struct JPage<'a> {
    window: WindowEcho,
    generation: String,
    #[serde(default)]
    more: bool,
    #[serde(default)]
    next_cursor: Option<String>,
    #[serde(borrow, default)]
    rows: Option<Vec<JRow<'a>>>,
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
        let page: JPage = serde_json::from_str(text).map_err(|e| format!("invalid page: {e}"))?;
        let batch = if batch == 0 {
            self.next_batch += 1;
            self.next_batch
        } else {
            batch
        };
        let rows: Vec<Row> = page.rows.unwrap_or_default().into_iter().map(|r| r.into_row(i)).collect();
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
        let rows: Vec<JRow> = serde_json::from_str(text).map_err(|e| format!("invalid rows: {e}"))?;
        let rows: Vec<Row> = rows.into_iter().map(|r| r.into_row(i)).filter(|r| r.t >= lo).collect();
        Ok(self.merge(rows))
    }

    pub fn merge(&mut self, rows: Vec<Row>) -> usize {
        let mut fresh: Vec<Row> = rows.into_iter().filter(|r| self.ids.insert(r.id)).collect();
        if fresh.is_empty() {
            return 0;
        }
        fresh.sort_unstable_by(by_time);
        for r in &fresh {
            self.dirty.insert(r.t.div_euclid(HOUR_MS) * HOUR_MS);
        }
        let n = fresh.len();
        self.max_id = fresh.iter().map(|r| r.id).chain(self.max_id).max();
        let append = self.rows().last().is_none_or(|tail| by_time(&fresh[0], tail).is_ge());
        self.buf.extend(fresh);
        if !append {
            // An older range filled in, routine since day commits arrive out
            // of order (D-160): the stable sort finds the two sorted runs and
            // merges them in linear time, where an unstable sort would not.
            self.buf[self.start..].sort_by(by_time);
        }
        self.version += 1;
        n
    }

    /// Drops every committed row. Staged batches belong to fetches in flight
    /// (a fresh start commits the batch it just fetched), so they stay.
    pub fn reset(&mut self) {
        self.buf = Vec::new();
        self.start = 0;
        self.ids.clear();
        self.dirty.clear();
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

    /// Returns memory to the allocator once the rows use under half of it
    /// (after the row cap). Not after a trim: the rows it keeps grow back
    /// into the room as new ones arrive.
    fn shrink(&mut self) {
        if self.buf.capacity() > 2 * self.buf.len() {
            self.buf.shrink_to_fit();
        }
    }

    /// Keeps only [lo, hi) (the row cap), in place: no copy of the kept
    /// rows, so memory does not peak at twice the cap. The kept hours count
    /// as changed, as after starting over with them.
    pub fn keep_only(&mut self, lo: i64, hi: i64) {
        let (a, b) = self.range(lo, hi);
        self.buf.truncate(self.start + b);
        self.buf.drain(..self.start + a);
        self.start = 0;
        self.shrink();
        self.ids.clear();
        self.ids.extend(self.buf.iter().map(|r| r.id));
        self.dirty.clear();
        self.dirty.extend(self.buf.iter().map(|r| r.t.div_euclid(HOUR_MS) * HOUR_MS));
        self.max_id = self.buf.iter().map(|r| r.id).max();
        self.version += 1;
    }

    /// Calls `f` on every interned id held, committed or staged (Interner::retain).
    pub fn for_each_id(&mut self, mut f: impl FnMut(&mut u32)) {
        // Only rows held: the trimmed prefix is never read again.
        let start = self.start;
        for r in self.buf[start..].iter_mut().chain(self.staged.values_mut().flatten()) {
            r.for_each_id(&mut f);
        }
    }

    pub fn newest_t(&self) -> i64 {
        self.rows().last().map_or(0, |r| r.t)
    }

    /// Hours that gained rows since the last call (persisted as chunks).
    pub fn take_dirty(&mut self) -> Vec<i64> {
        let mut v: Vec<i64> = self.dirty.drain().collect();
        v.sort_unstable();
        v
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
        s.keep_only(0, 0);
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
        s.keep_only(80, 100); // the cap, with an offset
        assert_eq!(ids(&s), vec![8, 9]);
        assert_eq!(s.stats(0, 1000), (2, 9));
        assert_eq!(s.add_json(&format!("[{}]", row(8, 80)), 0, &mut i).unwrap(), 0, "kept ids still deduplicate");
    }

    #[test]
    fn export_round_trips() {
        let mut i = Interner::default();
        let mut s = Store::default();
        s.add_json(&format!("[{},{}]", row(1, 10), row(2, HOUR_MS + 5)), 0, &mut i).unwrap();
        assert_eq!(s.take_dirty(), vec![0, HOUR_MS]);
        let text = s.export(0, HOUR_MS, &i);
        let mut t = Store::default();
        assert_eq!(t.add_json(&text, 0, &mut i).unwrap(), 1);
        assert_eq!(t.rows()[0], s.rows()[0]);
    }
}
