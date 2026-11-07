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
options (CLIENT_MUTE, MQTT-link, move and signal-strength rules on),
engine-only fields included: the same snapshot, filtered snapshot, traffic
and node panels, plus health, packet logs and routes for a few nodes and
packets, reach from two nodes, one link's history, a watchlist and the
regions (with the map's Regions layer handed over after health, so health
stays without the topic-region rule): every view kind the engine serves.
It locks current behaviour for refactors, and `frontend/tests/viewTypes.test.ts`
checks every view in it against the TypeScript mirror in
`frontend/src/derive/views.ts`; after an intended change, record it again
with `UPDATE_GOLDEN=1 scripts/wasm.sh test` (`cargo test --test golden`
with `UPDATE_GOLDEN=1` set).
