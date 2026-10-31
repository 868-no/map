//! The browser's copy of the packet log: rows ordered by (observed_at, id),
//! deduplicated by id. Fetched pages are staged first, so the caller can
//! still decide to start over before they are committed.

use serde::{Deserialize, Serialize};

use crate::row::{to_json, Interner, JRow, Row};
use crate::util::{FxMap, FxSet};

pub const HOUR_MS: i64 = 3_600_000;

#[derive(Default)]
pub struct Store {
    pub rows: Vec<Row>,
    ids: FxSet<i64>,
    staged: FxMap<u32, Vec<Row>>,
    next_batch: u32,
    dirty: FxSet<i64>,  // hour starts with rows added since the last take_dirty
    pub version: u64,   // bumped on every change (memo key)
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
        fresh.sort_by(by_time);
        for r in &fresh {
            self.dirty.insert(r.t.div_euclid(HOUR_MS) * HOUR_MS);
        }
        let n = fresh.len();
        let append = self.rows.last().is_none_or(|tail| by_time(&fresh[0], tail).is_ge());
        self.rows.extend(fresh);
        if !append {
            // Rare (an older range being filled in): the engine's merge sort handles the two runs.
            self.rows.sort_by(by_time);
        }
        self.version += 1;
        n
    }

    /// Drops every committed row. Staged batches belong to fetches in flight
    /// (a fresh start commits the batch it just fetched), so they stay.
    pub fn reset(&mut self) {
        self.rows.clear();
        self.ids.clear();
        self.dirty.clear();
        self.version += 1;
    }

    fn lower_bound(&self, t: i64) -> usize {
        self.rows.partition_point(|r| r.t < t)
    }

    /// Rows with observed_at in [start, end).
    pub fn slice(&self, start: i64, end: i64) -> &[Row] {
        let (a, b) = (self.lower_bound(start), self.lower_bound(end));
        &self.rows[a..b.max(a)]
    }

    pub fn trim_before(&mut self, t: i64) {
        let k = self.lower_bound(t);
        if k == 0 {
            return;
        }
        for r in self.rows.drain(..k) {
            self.ids.remove(&r.id);
        }
        self.version += 1;
    }

    /// Keeps only [lo, hi) (the row cap).
    pub fn keep_only(&mut self, lo: i64, hi: i64) {
        let keep: Vec<Row> = self.slice(lo, hi).to_vec();
        self.reset();
        self.merge(keep);
    }

    pub fn newest_t(&self) -> i64 {
        self.rows.last().map_or(0, |r| r.t)
    }

    /// Hours that gained rows since the last call (persisted as chunks).
    pub fn take_dirty(&mut self) -> Vec<i64> {
        let mut v: Vec<i64> = self.dirty.drain().collect();
        v.sort();
        v
    }

    /// Rows with observed_at in [lo, hi) as the API's JSON array.
    pub fn export(&self, lo: i64, hi: i64, i: &Interner) -> String {
        let rows: Vec<JRow> = self.slice(lo, hi).iter().map(|r| to_json(r, i)).collect();
        serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into())
    }

    /// (rows, newest id) in [start, end): part of a view's revision.
    pub fn stats(&self, start: i64, end: i64) -> (usize, i64) {
        let s = self.slice(start, end);
        (s.len(), s.iter().map(|r| r.id).max().unwrap_or(0))
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
        assert_eq!(s.rows.len(), 0, "staged, not committed");
        assert_eq!(s.commit(m.batch), 2);
        assert_eq!(s.rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(s.add_json(&format!("[{},{}]", row(2, 20), row(3, 30)), 0, &mut i).unwrap(), 1, "duplicate ignored");
        assert_eq!(s.add_json(&format!("[{}]", row(4, 5)), 0, &mut i).unwrap(), 1, "older row sorted in");
        assert_eq!(s.rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![4, 1, 2, 3]);
        assert_eq!(s.add_json(&format!("[{}]", row(5, 1)), 10, &mut i).unwrap(), 0, "before lo");
        assert_eq!(s.slice(10, 30).len(), 2);
        s.trim_before(20);
        assert_eq!(s.rows.len(), 2);
        assert_eq!(s.add_json(&format!("[{}]", row(1, 10)), 0, &mut i).unwrap(), 1, "trimmed ids may return");
        // Starting over keeps a batch staged by the fetch that caused it.
        let m = s.stage(&page, 0, &mut i).unwrap();
        s.reset();
        assert_eq!(s.commit(m.batch), 2);
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
        assert_eq!(t.rows[0], s.rows[0]);
    }
}
