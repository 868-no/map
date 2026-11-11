"""Helpers for scripts/mui_tiles.sh; run inside the pinned Python image.

  mui_tiles.py style  --src web/styles/light.json --layers frontend/src/map/layers.ts \
                      --out style.json [--show g,..] [--hide g,..]
  mui_tiles.py render --server http://tileserver:8080/styles/mui --regions regions.geojson \
                      --norway W,S,E,N --mbtiles out.mbtiles --name NAME ...

`style` writes the bundled style for tileserver-gl, with the layer groups the
web map shows by default (frontend/src/map/layers.ts) and nothing else.
`render` asks tileserver-gl for every tile MUI should get, converts each to
an 8-bit palette PNG (as the MUI maps README recommends) and stores it in an
MBTiles file. Tiles already stored are skipped, so an interrupted run resumes,
unless --source-id (style and basemap fingerprint) changed since.
"""

import argparse
import concurrent.futures
import io
import json
import math
import re
import sqlite3
import sys
import time
import urllib.request


def style_cmd(a):
    style = json.load(open(a.src))
    src = open(a.layers).read()
    groups = {
        m.group(1): (m.group(2) == "true", re.findall(r"'([^']+)'", m.group(3)))
        for m in re.finditer(r"id: '(\w+)'[^}]*?on: (true|false), layers: \[([^\]]*)\]", src)
    }
    if not groups:
        sys.exit(f"no basemap layer groups found in {a.layers}")
    show = set(filter(None, a.show.split(",")))
    hide = set(filter(None, a.hide.split(",")))
    unknown = (show | hide) - groups.keys()
    if unknown:
        sys.exit(f"unknown layer group(s): {', '.join(sorted(unknown))}; known: {', '.join(groups)}")
    hidden = set()
    for gid, (on, layers) in groups.items():
        if (on or gid in show) and gid not in hide:
            continue
        hidden.update(layers)
    ids = {l["id"] for l in style["layers"]}
    missing = hidden - ids
    if missing:
        sys.exit(f"layers.ts names layers the style lacks: {', '.join(sorted(missing))}")
    for l in style["layers"]:
        if l["id"] in hidden:
            l.setdefault("layout", {})["visibility"] = "none"
    style["sources"]["openmaptiles"]["url"] = "pmtiles://{basemap}"
    style["glyphs"] = "{fontstack}/{range}.pbf"
    json.dump(style, open(a.out, "w"))
    shown = [g for g, (on, _) in groups.items() if (on or g in show) and g not in hide]
    print(f"style: {', '.join(shown)} shown")


def tile_xy(lon, lat, z):
    n = 2**z
    lat = max(min(lat, 85.0511), -85.0511)
    return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n


def bbox_tiles(b, z):
    w, s, e, n = b
    x0, y0 = tile_xy(w, n, z)
    x1, y1 = tile_xy(e, s, z)
    m = 2**z - 1
    return {
        (x, y)
        for x in range(max(0, int(x0)), min(m, int(x1)) + 1)
        for y in range(max(0, int(y0)), min(m, int(y1)) + 1)
    }


def polygon_tiles(features, z, margin):
    """Tiles a polygon touches at zoom z (edges and interior), grown by margin tiles."""
    n = 2**z
    out = set()
    for f in features:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        rings = [[tile_xy(lon, lat, z) for lon, lat in ring] for poly in polys for ring in poly]
        # Edges, sampled finer than a tile.
        for ring in rings:
            for (ax, ay), (bx, by) in zip(ring, ring[1:]):
                steps = max(1, int(max(abs(bx - ax), abs(by - ay)) * 4))
                for i in range(steps + 1):
                    t = i / steps
                    out.add((int(ax + (bx - ax) * t), int(ay + (by - ay) * t)))
        # Interior: even-odd scanline through each tile row's centre.
        ys = [y for ring in rings for _, y in ring]
        for row in range(max(0, int(min(ys))), min(n - 1, int(max(ys))) + 1):
            cy = row + 0.5
            xs = sorted(
                ax + (cy - ay) * (bx - ax) / (by - ay)
                for ring in rings
                for (ax, ay), (bx, by) in zip(ring, ring[1:])
                if (ay <= cy) != (by <= cy)
            )
            for x0, x1 in zip(xs[::2], xs[1::2]):
                out.update((x, row) for x in range(int(x0), int(x1) + 1))
    grown = set()
    for x, y in out:
        for dx in range(-margin, margin + 1):
            for dy in range(-margin, margin + 1):
                if 0 <= x + dx < n and 0 <= y + dy < n:
                    grown.add((x + dx, y + dy))
    return grown


def plan(a):
    norway = [float(v) for v in a.norway.split(",")]
    features = json.load(open(a.regions))["features"]
    tiles = {}
    for z in range(a.minzoom, a.maxzoom + 1):
        if z <= a.world_maxzoom:
            tiles[z] = {(x, y) for x in range(2**z) for y in range(2**z)}
        elif z <= a.bbox_zoom:
            tiles[z] = bbox_tiles(norway, z)
        else:
            tiles[z] = polygon_tiles(features, z, a.margin)
    if a.extra_bbox:
        extra = [float(v) for v in a.extra_bbox.split(",")]
        for z in range(a.minzoom, a.extra_maxzoom + 1):
            tiles.setdefault(z, set()).update(bbox_tiles(extra, z))
    return tiles


def fetch(server, z, x, y):
    from PIL import Image

    url = f"{server}/{z}/{x}/{y}.png"
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = r.read()
            break
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2**attempt)
    # 8-bit palette, no dithering: the MUI maps README's mogrify settings.
    img = Image.open(io.BytesIO(data)).convert("RGB")
    img = img.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return z, x, y, buf.getvalue()


def render_cmd(a):
    tiles = plan(a)
    total = sum(len(t) for t in tiles.values())
    for z, t in sorted(tiles.items()):
        print(f"  z{z:<2} {len(t):>9,} tiles")
    print(f"  all {total:>9,} tiles")
    if a.dry_run:
        return

    db = sqlite3.connect(a.mbtiles)
    db.execute("CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT)")
    db.execute(
        "CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER,"
        " tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row))"
    )
    w, s, e, n = (float(v) for v in a.norway.split(","))
    meta = {
        "name": a.name,
        "format": "png",
        "type": "baselayer",
        "minzoom": str(min(tiles)),
        "maxzoom": str(max(tiles)),
        "bounds": "-180,-85.0511,180,85.0511",
        "center": f"{(w + e) / 2},{(s + n) / 2},{a.bbox_zoom}",
        "attribution": "© OpenMapTiles © OpenStreetMap contributors",
        "description": "868.no map basemap rendered for Meshtastic UI",
    }
    # Tiles from another style, layer set or basemap build must not mix in.
    row = db.execute("SELECT value FROM metadata WHERE name = 'meshmap:source'").fetchone()
    stored = db.execute("SELECT 1 FROM tiles LIMIT 1").fetchone()
    if stored and (row is None or row[0] != a.source_id):
        print("style, layers or basemap changed: starting over")
        db.execute("DELETE FROM tiles")
    meta["meshmap:source"] = a.source_id
    db.executemany("INSERT OR REPLACE INTO metadata VALUES (?, ?)", meta.items())
    # MBTiles rows count from the south (TMS).
    have = {(z, x, (1 << z) - 1 - r) for z, x, r in db.execute("SELECT zoom_level, tile_column, tile_row FROM tiles")}
    # Tiles an earlier run made beyond this run's area or zooms are dropped.
    planned = {(z, x, y) for z, t in tiles.items() for x, y in t}
    extra = have - planned
    if extra:
        db.executemany(
            "DELETE FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
            [(z, x, (1 << z) - 1 - y) for z, x, y in extra],
        )
        db.commit()
        print(f"{len(extra):,} tiles outside this run's area or zooms dropped")
    have &= planned
    todo = [(z, x, y) for z in sorted(tiles) for x, y in sorted(tiles[z]) if (z, x, y) not in have]
    print(f"{total - len(todo):,} already stored, {len(todo):,} to render")

    start = time.time()
    done = 0
    with concurrent.futures.ThreadPoolExecutor(a.workers) as pool:
        # Submit in chunks so millions of tiles do not all queue at once.
        for i in range(0, len(todo), 2000):
            futures = [pool.submit(fetch, a.server, *t) for t in todo[i : i + 2000]]
            for f in concurrent.futures.as_completed(futures):
                z, x, y, data = f.result()
                db.execute("INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)", (z, x, (1 << z) - 1 - y, data))
                done += 1
            db.commit()
            rate = done / (time.time() - start)
            left = (len(todo) - done) / rate if rate else 0
            print(f"  {done:,}/{len(todo):,} tiles, {rate:.0f}/s, {left / 60:.0f} min left", flush=True)
    db.commit()
    db.close()


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("style")
    s.add_argument("--src", required=True)
    s.add_argument("--layers", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--show", default="")
    s.add_argument("--hide", default="")
    r = sub.add_parser("render")
    r.add_argument("--server", required=True)
    r.add_argument("--regions", required=True)
    r.add_argument("--norway", required=True)
    r.add_argument("--mbtiles", required=True)
    r.add_argument("--name", required=True)
    r.add_argument("--source-id", required=True)
    r.add_argument("--minzoom", type=int, default=0)
    r.add_argument("--maxzoom", type=int, default=12)
    r.add_argument("--world-maxzoom", type=int, default=5)
    r.add_argument("--bbox-zoom", type=int, default=7)
    r.add_argument("--margin", type=int, default=1)
    r.add_argument("--extra-bbox", default="")
    r.add_argument("--extra-maxzoom", type=int, default=0)
    r.add_argument("--workers", type=int, default=8)
    r.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    style_cmd(a) if a.cmd == "style" else render_cmd(a)


if __name__ == "__main__":
    main()
