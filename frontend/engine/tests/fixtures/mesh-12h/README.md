# Golden fixture: 12 hours of mqtt.868.no

`observations.json` holds every decoded observation (the API's compact rows)
of a 12-hour window captured from the community broker on 2026-10-31: public
RF traffic, like the capture fixtures in `backend/test/fixtures`.

`expected.json` holds the server's views of that same window, recorded from
the Go backend's `/snapshot`, `/traffic` and `/nodes/{id}` endpoints just
before they were retired (D-041): the snapshot (also filtered to position and
NodeInfo packets), traffic, and ten node panels, plus the geolocation
settings in effect. `tests/golden.rs` holds the engine to them field by field
(times to the millisecond, numbers to 1e-4), with the CLIENT_MUTE, MQTT-link,
move and signal-strength rules off since they postdate the server views.

`engine.json` holds the engine's own views of that window with default
options (CLIENT_MUTE rule and MQTT links on), engine-only fields included:
the same snapshot, filtered snapshot, traffic and node panels, plus packet
logs and routes for a few nodes and packets. It locks current behaviour for
refactors; after an intended change, record it again with `UPDATE_GOLDEN=1`
set for `cargo test --test golden`.
