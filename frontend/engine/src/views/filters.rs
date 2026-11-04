//! The request's row filters.

use serde::Deserialize;

use crate::row::{Interner, Row};
use crate::util::FxSet;

#[derive(Deserialize, Default, Clone)]
pub struct Filters {
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub brokers: Vec<String>,
    #[serde(default)]
    pub types: Vec<String>,
}

/// The filters as a row predicate. Invalid rows (failed decoding or
/// verification, sender possibly forged) never pass: they are evidence of
/// nothing, and only the packet log shows them (D-093).
pub fn filter_fn(f: &Filters, i: &Interner) -> impl Fn(&Row) -> bool {
    let invalid = i.get("invalid").unwrap_or(u32::MAX);
    let ids = |v: &[String]| -> Option<FxSet<u32>> { (!v.is_empty()).then(|| v.iter().map(|s| i.get(s).unwrap_or(u32::MAX)).collect()) };
    let (ch, br, ty_) = (ids(&f.channels), ids(&f.brokers), ids(&f.types));
    move |r: &Row| {
        r.ty != invalid
            && ch.as_ref().is_none_or(|s| r.channel != 0 && s.contains(&r.channel))
            && br.as_ref().is_none_or(|s| s.contains(&r.broker))
            && ty_.as_ref().is_none_or(|s| s.contains(&r.ty))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply_filters<'a>(rows: &'a [Row], f: &Filters, i: &Interner) -> Vec<&'a Row> {
        let keep = filter_fn(f, i);
        rows.iter().filter(|r| keep(r)).collect()
    }

    #[test]
    fn invalid_rows_never_pass() {
        let mut i = Interner::default();
        let text = r#"[
          {"i":1,"t":1,"b":"x","g":7,"s":5,"y":"position","l":"01","o":"01","sg":"unsigned"},
          {"i":2,"t":2,"b":"x","g":7,"s":5,"y":"invalid","l":"02","o":"02","sg":"not-applicable","iv":"sig_invalid"}
        ]"#;
        let rows: Vec<Row> = serde_json::from_str::<Vec<crate::row::JRow>>(text).unwrap().into_iter().map(|r| r.into_row(&mut i)).collect();
        assert_eq!(rows[1].invalid().map(|v| i.s(v)), Some("sig_invalid"));
        let kept = apply_filters(&rows, &Filters::default(), &i);
        assert_eq!(kept.iter().map(|r| r.id).collect::<Vec<_>>(), vec![1]);
        let asked = Filters { types: vec!["invalid".into()], ..Default::default() };
        assert!(apply_filters(&rows, &asked, &i).is_empty(), "not even when asked for");
    }
}
