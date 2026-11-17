# probe

The map's mesh derivation, run natively against a deployment's rows: what [map.868.no](https://map.868.no) would show, without a browser.

The probe fetches a window of rows from a deployment's public API the way the browser does, hands them to the same engine (`frontend/engine`) with the same inputs, and prints the engine's views as tables or JSON. Those inputs are the site's geolocation settings, the regions' outlines and the line-of-sight classes of router links. It reads only the public API, as any visitor does, so nothing needs to be configured.

## Install

Download the file for your platform from a release. Each is one self-contained binary with nothing else to install:

- [probe-main](https://github.com/868-no/map/releases/tag/probe-main) (pre-release) is rebuilt from main whenever the engine or the probe changes, once that commit has passed its tests and been deployed. It derives what map.868.no shows now.
- `probe-vX.Y.Z` releases are fixed versions.

`probe --version` names the commit a binary was built from, and so the engine inside it.

| Platform | File |
| --- | --- |
| Linux x86_64 (static) | `probe-linux-x86_64` |
| Linux arm64 (static) | `probe-linux-arm64` |
| macOS (Apple silicon and Intel) | `probe-macos` |
| Windows x86_64 | `probe-windows-x86_64.exe` |

Check it against `SHA256SUMS` from the same release, make it executable (`chmod +x`), and rename it to `probe` if you like.

The binaries are not signed:
- **macOS** quarantines the download. Run `xattr -d com.apple.quarantine probe-macos` once, or allow it under System Settings → Privacy & Security after the first try.
- **Windows** SmartScreen may ask: More info → Run anyway.

HTTPS is verified against the operating system's trust store, so certificates come from the system. A minimal Linux container may have none (`No CA certificates were loaded from the system`): install its `ca-certificates` package.

From a checkout of this repository, `scripts/probe.sh` builds the probe with cargo and runs it, taking the same arguments.

## Use

```sh
probe nodes gråkallen                     # nodes in the default window whose id or name matches
probe --hours 24 node Bringebærpai        # identity, position, telemetry, every link, who hears it, health
probe --start 2026-11-14 --end 2026-11-15 health --detail
probe health '!4e95f741'                  # one node's health issues
probe view packetlog '!4e95f741' | jq .   # any engine view as JSON
probe save w.rows                         # the window's rows and inputs, for offline runs
probe --rows w.rows health                # the same views again, offline
```

A node is named by its id (`!4e95f741`, or decimal) or by a unique match in its short or long name, in any case. A name matching several nodes lists them instead of guessing.

### Commands

| Command | Prints |
| --- | --- |
| `nodes [text]` | Nodes in the window, most packets first: role, last heard, packets, gateway, position or location estimate |
| `node <id\|name>` | One node: identity, place, telemetry, every link (direction, confidence, samples, SNR and RSSI medians, evidence), the gateways hearing it, its health issues |
| `health [id\|name]` | Health issues of the whole mesh or one node; `--detail` adds each issue's explanation |
| `view <kind> [arg]` | A raw engine view as JSON: `snapshot`, `traffic`, `regions`, `health`, `node <id>`, `packetlog <id>`, `route <packet key>`, `reach <id>[\|internet]`, `link <a>\|<b>`, `watch <id,id,...>` |
| `save <file>` | The window's rows, with the site's settings and the terrain classes used, for `--rows` |

### Options

| Option | |
| --- | --- |
| `--site URL` | The deployment (default https://map.868.no, or `$PROBE_SITE`) |
| `--hours N` | The window's length (default: the site's default window, 72 h on map.868.no) |
| `--start T`, `--end T` | The window's bounds in UTC: `2026-11-14`, `2026-11-14T06:00Z`. The end defaults to now, or to the newest row with `--rows` |
| `--rows FILE` | Rows saved by `save` instead of fetching |
| `--filters JSON` | The map's filters, e.g. `'{"types":["position"]}'` (also `channels`, `brokers`) |
| `--max-nodes N` | The snapshot's node limit (default: the engine's, as on the map) |
| `--no-terrain` | Skip line-of-sight classes of router links |
| `--json` | Print the view behind `nodes`, `node` and `health` as JSON instead of a table |
| `--quiet` | No progress on stderr |

Times are printed in UTC.

### Caching

Whole UTC days the server marks as final never change, so they are cached and later runs fetch only what is new:

| Platform | Directory |
| --- | --- |
| Linux | `$XDG_CACHE_HOME/meshmap/probe`, else `~/.cache/meshmap/probe` |
| macOS | `~/Library/Caches/meshmap/probe` |
| Windows | `%LOCALAPPDATA%\meshmap\probe` |

`PROBE_CACHE` names another directory. Set it to an empty value to cache nothing. The cache is kept per site and per data generation: a new generation (a decoder or row-format change) starts afresh, and older ones can be deleted.

## Development

The probe is a crate of its own (`tools/probe`) on the engine, so its HTTP and TLS crates (ureq, rustls with ring, rustls-platform-verifier) stay out of the WebAssembly build. The regions' outlines are compiled in from `frontend/src/assets/regions.geojson`.

```sh
scripts/probe.sh <args>              # build (profile fast) and run
scripts/wasm.sh test probe           # tests, in the pinned Rust image, as CI runs them
scripts/wasm.sh clippy probe         # clippy, warnings as errors
scripts/wasm.sh deny probe           # cargo-deny, for the release targets (deny.toml)
tools/probe/notices.py               # rewrite THIRD_PARTY_NOTICES.md after a dependency change
```

The binary contains the engine and the regions' outlines, so CI checks and rebuilds it when any of them change, not only the probe. `.github/workflows/probe.yml` runs the tests, clippy and cargo-deny, checks that `THIRD_PARTY_NOTICES.md` is current, builds all four binaries and runs each against production:

- **Pull requests and main:** the tests workflow (`tests.yml`) calls it once the engine's job has passed, beside the frontend's job. Map deploys never wait for it.
- **main:** after the deploy, the `probe-main` job replaces the `probe-main` pre-release with the binaries just built (`release.sh`). That happens only when something the binary is built from changed since the last `probe-main`.
- **A tag `probe-v<version>`** (equal to `version` in `Cargo.toml`): `.github/workflows/probe-release.yml` builds and publishes a versioned release.
- **By hand:** `probe.yml` builds, nothing published.

Each release carries the binaries, `SHA256SUMS`, this README, the notices and the license.

## License

GPL-3.0-only, as the rest of the repository ([LICENSE](../../LICENSE)). The binaries contain the third-party crates and data listed, with their license texts, in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
