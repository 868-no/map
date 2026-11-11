# Promo video recorder

Records the promo video ([STORYBOARD.md](STORYBOARD.md)) from the real app,
against production's data and map tiles: `out/promo.mp4`, 1920×1080 at 60 fps,
without sound (the music is added in post). Two takes: the map
(`takes/map.spec.ts`), then a generic phone installing and launching the app
(`takes/phone.spec.ts`, its stage in `phone.ts`), which starts on the map
take's last frame so the two join without a cut.

## How it works

- The app is built with the end-to-end test hook (`window.__meshmap`) into
  `.dist` and served by `vite preview` on 127.0.0.1:4173, which proxies the
  API, tiles, fonts and styles to production (`vite.config.ts`; `PROMO_SITE`
  points it elsewhere).
- A take (`takes/*.spec.ts`) is a Playwright script driving that app as a
  viewer would (camera moves, clicks, tabs), with the toolkit in `lib.ts`.
- The page's clock is fake and paused: every frame advances it by exactly
  1/60 s and saves a screenshot, so motion is smooth however long a frame
  takes to draw (about 0.3 s on the laptop's GPU: some 17 minutes for the map take, 9 for the phone).
- The page draws at twice its size, and each frame is the part of it the
  "lens" shows: the whole page, or zoomed in up to 2× on a panel, still
  sharp. Frames therefore vary in size; the encoder scales them to 1920×1080.
- A drawn pointer moves to everything the take clicks, with a ripple on the
  click; the real mouse then leaves the map, so no hover tooltip lingers.
- Zooms between the country and a city are scripted (`glide`): the place
  zoomed into moves in a straight line across the screen. MapLibre's own
  easing interpolates the centre, which swings an off-centre place sideways.
- Pings are drawn at their real range, so up close one ring covers the
  screen: the recorder fades their layer out between zoom 6.5 and 8.5.
- Live traffic still arrives on the wall clock, which runs about 12 times
  slower than video time: pings come out denser than they really are.
- While the zoom changes, the recorder makes the app recluster markers on
  every frame (the live app does it once the zoom settles, D-204), so
  clusters come apart smoothly instead of all at once.
- The phone take is a page of its own (served at /promo-stage.html beside
  the app) holding the app in an iframe at phone size, so the app lays itself
  out as on a phone. The browser bar, install dialog, home screen and splash
  are drawn by that page; the app's own "Install" button is real, offered by
  a synthetic `beforeinstallprompt` event as Chrome would.
- Captions are drawn in the page, centred over the map the open panel leaves
  free. The node count is the map's own at recording time, rounded down; the
  address on the end card is `PROMO_ADDRESS` (default `map.868.no`).
- Chrome runs in `docker/Dockerfile` (Playwright's image plus Mesa) with the
  host's GPU (`/dev/dri`); without it, drop the `--device` and `PROMO_GPU`
  flags and it draws in software, about 15 times slower.

## Recording

From the repository root:

```sh
# 1. Build the app with the test hook, and serve it against production.
scripts/node.sh sh -c 'VITE_E2E_HOOKS=true npx vite build --outDir promo/.dist --emptyOutDir'
NODE_NETWORK=host scripts/node.sh npx vite preview --config promo/vite.config.ts --outDir promo/.dist &

# 2. The recorder's image (once).
. ./versions.env
docker build -t meshmap-promo:local --build-arg PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" frontend/promo/docker

# 3. Record the two takes (the phone take starts on the map take's last frame), then join them.
cd frontend
for take in map phone; do
  docker run --rm --network host --ipc=host --device /dev/dri --group-add "$(getent group render | cut -d: -f3)" \
    -e PROMO_GPU=1 -u "$(id -u):$(id -g)" -e HOME=/tmp/home \
    -v "$PWD/..":/src -w /src/frontend meshmap-promo:local npx playwright test -c promo/playwright.config.ts $take.spec
done
cd promo
ffmpeg -framerate 60 -i .frames/map/%05d.png -framerate 60 -i .frames/phone/%05d.png -filter_complex \
  '[0]scale=1920:1080:flags=lanczos,setsar=1[a];[1]scale=1920:1080:flags=lanczos,setsar=1[b];[a][b]concat=n=2:v=1,format=yuv420p' \
  -c:v libx264 -preset slow -crf 16 -movflags +faststart out/promo.mp4
```

`takes/test.spec.ts` is a 7-second take for trying changes to the toolkit;
`PROMO_BG=<image>` lets the phone take run without a fresh map take.
Frames (`.frames`), the build (`.dist`), Playwright's output (`.results`) and
the videos (`out`) are not committed.

## When the site changes

The take is written against the interface's own labels ("Layers", "Router
links", "Health", the node panel's tabs, "Include relayed") and one router's id and position
(Grefsenkollen, `!bfa97d12`). If it is renamed, moved or gone, pick another
well-linked router near Oslo in `takes/promo.spec.ts`. The packet route is
chosen while recording: the first traceroute in the router's log (relayed
packets included) whose every node has a position, found by trying them
unseen before the take selects it on camera.
