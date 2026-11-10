//! Probable MQTT downlinks (§6.5): traceroutes reaching a node at exactly
//! 0 dB, the reading of a packet taken from the broker.

use super::{Ctx, Issues};

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    for x in cx.nodes {
        if let Some(d) = &x.mqtt_downlink {
            out.add(x.num, "downlink", "warning", "Probably downlinks from MQTT".into(), format!("{} of {} traceroutes reached it at exactly 0 dB, the reading of a packet taken from the broker. A downlinking node rebroadcasts far-away packets locally, which draws links that do not exist and wastes airtime.", d.zero_snr, d.traceroutes));
        }
    }
}
