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
    #[serde(default)]
    pub gateways: Vec<u32>,
}

/// Rows passing the filters (empty lists mean all).
pub fn apply_filters<'a>(rows: &'a [Row], f: &Filters, i: &Interner) -> Vec<&'a Row> {
    let ids = |v: &[String]| -> Option<FxSet<u32>> { (!v.is_empty()).then(|| v.iter().map(|s| i.get(s).unwrap_or(u32::MAX)).collect()) };
    let (ch, br, ty_) = (ids(&f.channels), ids(&f.brokers), ids(&f.types));
    let gw: Option<FxSet<u32>> = (!f.gateways.is_empty()).then(|| f.gateways.iter().copied().collect());
    rows.iter()
        .filter(|r| {
            ch.as_ref().is_none_or(|s| r.channel != 0 && s.contains(&r.channel))
                && br.as_ref().is_none_or(|s| s.contains(&r.broker))
                && gw.as_ref().is_none_or(|s| r.gw.is_some_and(|g| s.contains(&g)))
                && ty_.as_ref().is_none_or(|s| s.contains(&r.ty))
        })
        .collect()
}
