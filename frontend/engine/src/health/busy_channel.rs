//! Busy channel: the channel utilisation and transmit airtime a node
//! reports in its last device telemetry.

use super::{Ctx, Issues};

/// Channel utilisation (%) a node reports: firmware stops its own optional
/// broadcasts above 25 % and goes quiet above 40 %.
pub const CH_UTIL_WARN: f64 = 25.0;
pub const CH_UTIL_PROBLEM: f64 = 40.0;
/// Transmit airtime (%) a node reports: EU 868 MHz allows 10 % per hour.
pub const AIR_UTIL_WARN: f64 = 10.0;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    for x in cx.nodes {
        let n = x.num;
        let Some(t) = &x.telemetry else { continue };
        if let Some(c) = t.ch_util.filter(|&c| c >= CH_UTIL_WARN) {
            let sev = if c >= CH_UTIL_PROBLEM { "problem" } else { "warning" };
            out.add(n, "channel_busy", sev, format!("Channel {c:.0} % busy"), format!("It reports {c:.1} % channel utilisation (the mesh median is usually a few per cent). Above 25 % firmware drops optional broadcasts, above 40 % nodes go quiet: something near it is flooding the channel."));
        }
        if let Some(a) = t.air_util.filter(|&a| a >= AIR_UTIL_WARN) {
            out.add(n, "airtime_limit", "warning", format!("Transmits {a:.0} % of the time"), format!("It reports {a:.1} % transmit airtime; EU 868 MHz allows 10 % per hour, after which it must stay silent."));
        }
    }
}
