# Test fixtures

## captured/

Real MQTT traffic from the Norwegian community broker `mqtt.868.no`, captured
read-only. Anything broadcast over RF is public; channel payloads here use the
public default key. One line per message, `mosquitto_sub -F '%U|%r|%t|%x'`:
`unix_ts|retained|topic|payload_hex`.

| File | Captured | Notes |
| --- | --- | --- |
| `mqtt868-2026-10-31-30min.txt` | 2026-10-31, 30 min | NarrowFast/default key; signed 2.8 NodeInfo and Telemetry; PKI, JSON, map, stat and retained messages |
| `mqtt868-2026-10-31-long.txt` | 2026-10-31, ~2.5 h | adds signed Position/NeighborInfo verified against learned keys (XEdDSA gate 3) |

Capture more (broker credentials from `secrets/mqtt-brokers.yaml`, never committed):

```sh
docker run --rm eclipse-mosquitto:2 mosquitto_sub -h mqtt.868.no -u "$MQTT_USER" -P "$MQTT_PASS" \
  -t 'msh/#' -F '%U|%r|%t|%x' -W 1800 > capture.txt
scripts/go.sh go run ./cmd/meshmap inspect test/fixtures/captured/<file>
```

`internal/ingest/captured_test.go` replays every file through the production
`ingest.Process` with production (sequential, first-contact) identity rules.
