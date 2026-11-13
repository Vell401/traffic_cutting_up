# Miami authored-world rebuild — local evidence

## Outcome / release boundary

This rebuild replaces Miami's procedural city/palms/boats, not its route. Fifteen
project-authored Blender prototypes provide actual recessed facades, balconies,
colonnades, feathered palm geometry, yacht hulls/decks/rails and human-scale props.
The photographed PBR surfaces/HDR are self-hosted CC0 originals. Assetto Corsa is
an art reference, **not an asset source, parity claim or performance guarantee**.

Controller-only final whole-change review, main integration and deployment remain
outside this task. No production credentials/data/API writes or main/push/deploy
actions were used. The immutable old checkout was not modified or used to run new
integration tests.

## What changed visually

- Ocean Drive: real rounded/stepped hotel geometry, recessed window surrounds,
  balconies/rails and open colonnades replace shader-grid boxes. Task3 varies
  parcel height, setback, paint and glazing rather than repeating a uniform wall.
  Uniform model scaling retains geometry proportions; instance tints share PBR.
- Coastal foreground: upper promenade with visible near palms, furniture,
  planting islands and masonry edging; a separate green verge/beach, seawall
  coping and irregular shore rock footprints replace the broad bare grey slab.
- Marina: shore at 48m (previous authored integration 98m); upper path level to 24m,
  planted descent to 32m, lower boardwalk at -2.4m and visual water at -3m. The former
  -8m basin concealed real decks behind the unchanged road barrier. All production
  water/island/far-disc elevations now agree; this does not move the road. Yacht scales
  1.6/1.3 retain scaled 0.9m draft; the pontoon/gangway uses the same shore constant.
- Downtown: distinct glazed/setback silhouettes with podiums and physical facade
  detail, now with varied parcel heights and setbacks rather than two equal
  towers every 100m. Causeway stays open, with a composed island skyline on land.
- Asphalt: same verified photograph and metric 2m scale, cooler/darker factor,
  roughness .98 and restrained .28 normal strength instead of .65. No texture resize,
  geometry deletion or rendering-resolution workaround.
- The default Miami sky label remains compatible with saved `miami-night`, but
  now presents a photographed sunset. Alternative saved sky choices still work.
  Lighting uses a bounded moving shadow volume; no per-window lights or giant
  bloom/fog veil was added by Task3.

## Contracts and licenses

Miami remains 12km/spawn300/revision2/hash `5d573e53`; Highway remains revision1/
`766e63c6`; protocol 13. Frozen physics, presets, car builders/models/assets and
animation are not rewritten. Legacy Miami scenery is suppressed in production
asset mode; Highway stays on its original rendering path.

Runtime-shared photo maps are intentional: GLB has no image references. Manifest
materials restore sRGB diffuse, linear normal/roughness, `flipY=false`, repeat UV,
scalar×roughnessMap.G. The full-AABB bottom-centred metre/Y-up/front-Z roots and
part-relative geometry remain intact. Generator 1.0.2 fixes Blender source and
reimport-preview scalar/G sampling before previews; the actual Blender node test
first failed on the old direct-photo input, then passed for all five photo materials.

Models/source are project-authored. Photo originals: Poly Haven
`aerial_asphalt_01` (Rob Tuytel), `concrete_wall_007` (Charlotte Baglioni, Dario
Barresi, Rico Cilliers), `painted_plaster_wall` (Amal Kumar), and
`kloppenheim_06_puresky` (Greg Zaal, Jarod Guest), all CC0-1.0. No ripped game/mod,
paid or unverified assets. Original URLs, author credits, publishedMD5, localSHA256,
dimensions and reproduction commands: [asset contract](../assets/miami.md).

Kit: 23,675,324-byte GLB, 6,443,564-byte photos/HDR, 58,958-byte manifest = 30,177,846 bytes
(28.78 MiB), under 48 MiB. Ten source textures, 74 prototype/material batches,
371,112 unique model triangles. Source blend 25,773,628 bytes is not browser payload.
GLB SHA256 remains `a3bede50494f6d62d2adea2c9b43d4dbf2c706a11f639ee34554349795f52cee`.

## Reproduce safely

Use existing Vite15274 proxying isolated built Highway19071/Miami19072 backends;
do not start a duplicate frontend or point at production data. Fresh GUID/timestamp
DB/radio directories, synthetic passwords and map-labelled `GIT_SHA` are required.
The complete server setup is the same as the
[earlier integration instructions](2026-11-13-miami-upgrade.md#reproduce-safely-external-toolsbackends),
substituting those three ports. Run adminClient first on fresh fixture DBs (its
empty-log assertion is deliberate), before game reconnect tests create logs.

```powershell
$env:PLAYWRIGHT_MODULE='C:/Users/sosi/AppData/Local/Temp/opencode/traffic-browser-check/node_modules/playwright/index.mjs'
$env:MIAMI_REBUILD_BASE_URL='http://127.0.0.1:15274'
$env:MIAMI_REBUILD_OUTPUT_DIR='C:/Users/sosi/AppData/Local/Temp/opencode/miami-rebuild-task3/manual-art'
$env:MIAMI_REBUILD_BROWSER_EXECUTABLE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
# Match the fresh backends' synthetic central password from the setup above.
$env:ADMIN_BASE_URL=$env:MIAMI_REBUILD_BASE_URL
$env:ADMIN_TEST_PASSWORD='synthetic-central-only'
$env:ADMIN_PLAYWRIGHT_MODULE=([uri]$env:PLAYWRIGHT_MODULE).AbsoluteUri
$env:ADMIN_BROWSER_EXECUTABLE=$env:MIAMI_REBUILD_BROWSER_EXECUTABLE
$env:UPGRADE_BASE_URL=$env:ADMIN_BASE_URL
$env:UPGRADE_ADMIN_PASSWORD=$env:ADMIN_TEST_PASSWORD
$env:UPGRADE_OUTPUT_DIR=Join-Path $env:MIAMI_REBUILD_OUTPUT_DIR 'upgrade'
$env:FEATURE_BASE_URL=$env:ADMIN_BASE_URL
$env:FEATURE_ADMIN_PASSWORD=$env:ADMIN_TEST_PASSWORD
$env:FEATURE_OUTPUT_DIR=Join-Path $env:MIAMI_REBUILD_OUTPUT_DIR 'features'
$env:MOBILE_BASE_URL=$env:ADMIN_BASE_URL
$env:MOBILE_PROOF_DIR=$env:MIAMI_REBUILD_OUTPUT_DIR
# Existing suites retain their own assertions and timeouts. Fresh admin DB first:
node tests/adminClient.browser.mjs
node tests/miamiRebuild.browser.mjs
node tests/upgrade.browser.mjs
node tests/features.browser.mjs
node tests/mobile.browser.mjs
node dist-server/smoke.js --url ws://127.0.0.1:15274/ws --map highway --origin http://127.0.0.1:15274 --clients 3 --seconds 10
node dist-server/smoke.js --url ws://127.0.0.1:15274/miami/ws --map miami --origin http://127.0.0.1:15274 --clients 3 --seconds 10
```

The new harness fingerprints actual sources/assets before/after, uses seeded
traffic, fixed Medium/DPR1, canonical R34 chase poses/FOV and the real View/post/
shadow pipeline. Extra lane/mouse-look close views are labelled separately, not
substituted for the canonical comparison. Teleports are solo-only. No production
screenshot mode, quality cut, screenshot-mock test or permanent dependency.

The unchanged menu still declares Google font URLs. Controlled browser fixtures
block that pre-existing font CSS locally (matching the older browser suites) and
record it separately. The zero-external-request assertion concerns actual unhandled
runtime requests/new environment assets, not a false claim that the existing UI
has no external links. No new third-party request or font/menu redesign was added.

## Evidence and measurements

Captured source: `063fd364f8c929fc8599054b9d3d02248ddb8a48`, 314 source/test/asset
paths (src/scripts/tests/public Miami model/maps), SHA256
`073632fb40b233b67e246763938d8686379df25afb751a0b1f240b50cb9b9402`.
The later documentation-only commit does not change this rendered code/assets.
Software WebGL is not hardware acceptance.

Normal opaque, 1280×800, Medium, DPR1; scene + selected car + shadows + post:

| Selected car | Maximum calls over 9 reference poses | Maximum submitted triangles |
| --- | ---: | ---: |
| A45 | 499 | 4,808,699 |
| Porsche | 360 | 3,744,440 |
| R34 | 317 | 4,317,619 |
| W204 | 498 | 3,963,739 |

R34's additional 120-pose/100m whole-lap sweep: 317 calls / 4,318,205 triangles max.
Only **one call** and 191,301 triangles remain below the rejection limits in the
heaviest selected-car references; these are not comfortable hardware margins.
Twelve identical final poses retained 322 geometries/52 whole-renderer textures
and unchanged environment instance-buffer versions. That proves stable measured
GPU resource counts/instance work, not zero allocations across all JavaScript or
low driver latency. The 52 include vehicle/post/reflection/shadow resources; the
environment's 10 source textures (plus generated targets) are not 52 source maps.
The actual runtime world sweep reaches 264 submitted placement instances and 67
active prototype/material batches (74 allocated), under 1800/120. This is a much
heavier art scene than 815a188's roughly 0.5M R34 submitted triangles/~200 calls;
neither the art rebuild nor static-car batching establishes a whole-frame FPS gain.

Transparent-ghost samples at s12010: A45 694 calls, Porsche 416, R34 299, W204 672.
These are labelled samples, **not ghost maxima**; the earlier Task2 marina samples
reached 716/697 for A45/W204. Original ordered ghost colour draws and tests remain
unchanged. The normal 500-call bound is not misapplied to ghosts.

Artifacts: `C:/Users/sosi/AppData/Local/Temp/opencode/miami-rebuild-task3/final-1794566579481/`.
The new harness writes `art/evidence.json` and 66 actual canvas PNGs. Full-size inspection
includes all eight matched Miami district/tunnel/seam images, all six skies,
normal moving traffic, cockpit/bumper, all four selected-car examples, near hood
facades/palms and the **stock far-camera mouse-look** yacht/quay image. This last
image shows hull, glazing, rail and pontoon silhouettes from a real selectable
game camera, not a separate flycam/render. Canonical chase remains the comparator.

The old immutable comparison is
`C:/Users/sosi/AppData/Local/Temp/opencode/miami-rebuild-baseline/` at815a188.
All eight Miami camera position/quaternion/FOV objects compare **exactly equal**
to the immutable JSON, at1280×800/Medium/DPR1; changed default sky is intentional.
Seeded moving traffic is present, but traffic phase is not a pixel-identical old/
new fixture. No image is a mock assertion or a physical-GPU/FPS measurement.

The permanent harness's s850 phone views were inspected and are partially occluded
by a naturally present truck after the solo teleport; they remain in the evidence,
not passed off as clear art proof. Additional unchanged-quality actual-game spawn300
phone views were captured/inspected at 390×844/844×390, with traffic and native touch
UI, under `miami-rebuild-task3/phone-spawn-probe/{portrait300,landscape300}{,-ui}.png`.
Reproduce this supplemental art-only probe with
`node C:/Users/sosi/AppData/Local/Temp/opencode/miami-rebuild-task3/quick-art.mjs --phone`.
It mocks API reads only, not geometry/rendering; the real online/admin proof is
the separate fixtures below. Fixed-pose HUD numbers are not movement assertions.

Both Highway300/3800 PNGs were inspected: original night theme/rendering path,
no Miami model/map requests. Their random solo-world cadence/heading is not a
pixel-identical815a188 fixture (Highway3800 camera differs); same-seed Highway
geometry/material-path tests and real revision/hash checks supply that regression
coverage, rather than a falsely claimed screenshot identity.

### Completed local gates

| Gate | Result |
| --- | --- |
| `npm test` |122 files, 1350 pass, 1 existing platform skip; SQLite warnings retained |
| Client/server typechecks, both builds |Pass;428 client/50 server modules |
| Asset validator / real Blender material test |Pass; actual reimport previews regenerated and inspected |
| `miamiRebuild.browser.mjs` |Pass;66 captures,783733ms end-to-end fixture time, source fingerprint unchanged |
| `adminClient.browser.mjs` |Pass on fresh isolated DBs,21753ms |
| `upgrade.browser.mjs` |Pass,345183ms; both online worlds, real peers/movement/reconnect, shared admin session/uploads |
| `features.browser.mjs`, `mobile.browser.mjs` |Pass,114344/52658ms; real per-map upload/wrong-map boundary, touch/tablet/keyboard/W204 |
| Built-server prefixed smokes |Both pass,3 clients/world,10s; each sees2 peers; Highway151–292m/Miami266–292m movement |
| `git diff --check` |Pass |

These elapsed times are fixture totals, not frame/GPU/FPS measurements. Raw logs
and `commands.json` are in the artifact root. `upgrade/result.json` retains the
integration source fingerprint. The asset retry made 2 manifest attempts and 0
pre-start game joins. Renderer/document/environment and all four cached car views
survived ordinary menu return; saved dusk was restored after a real reload. There
were 0 uncaught page errors/unhandled external runtime requests in the new harness;
9 pre-existing font-CSS attempts were intercepted/disclosed. Tests/admin mutations
used only fresh synthetic local data. The owned19071/19072 backends were stopped;
the original15273/15274 Vite listeners remain. No production acceptance is implied.

## Hardware / remaining priorities

Windows/Node24/installed Edge ANGLE SwiftShader; no physical GPU, phone GPU, VRAM,
hardware FPS or deployed TLS/WSS performance proof. Submitted triangle counts
include shadows/post; decoded texture memory and indivisible driver stalls remain
important. Existing A45 texture footprint is not made small by batching.

500 calls/5M submitted triangles is a rejection bound for the stated **normal opaque
selected-car Medium/DPR1 reference poses**, all four cars, not a promise for spawn
ghosts/unbounded multiplayer/preparation. Transparent ghosts deliberately retain
the original colour ordering and are measured separately. No protected car/
transparency rewrite or hidden DPR/range/detail reduction was used.

The architecture is still modular, not a photogrammetric city; facade/window-family
repetition is reduced by parcel composition, not eliminated. Small leaflets alias
at distance and the lower deck remains harder to see over the protected barrier
than yacht superstructure. A **distant island-tower entry pop is visible** in the
2199/2201 transition pair; the 100m-behind/600m-ahead asset window is unchanged, not
hidden with stronger fog or reduced range. Portal-bank occlusion also leaves tiny
trim slivers around10599/10601. These and moving shadow shimmer are remaining art/
hardware-review priorities, not declared solved by the budget counters. Hardware/
profile-driven next work must not silently trade away close detail. Task2's
deferred readability Minor in `src/render/miami/carBatching.ts:81–142` and
`tests/miamiCarBatching.test.ts:165–239` is carried to final review unchanged.

## Complete concise changelog of previous815a188

The immutable release being visually replaced already delivered:

1. Independent Highway/Miami worlds; Miami's authored12km ring, smooth bends,
   spawn300, bridges/viaducts/tunnel and four procedural coastal districts; revised
   route hash/revision, marina visibility fixes and night lighting.
2. Responsive/mobile driving/menu and touch controls; native map/mode/car choices
   separate from explicit Start, focus/loading locks across responsive audio moves.
3. Chosen-car attachment, shader/texture/actual-draw preparation before reveal,
   genuine retry, exterior/cockpit/ghost variants and bumper headlights; resident
   four-car/model/program caches and sequential nearby remote preparation.
4. One Highway-rooted admin session across isolated maps, fixed-target authenticated
   Miami gateway, map-safe history/requests/drafts, independent traffic/tuning/
   radio/records/logs, streaming upload/cancel and central logout. Separate bounded
   control/upload deadlines, no browser service credential forwarding.
5. Renderer scheduling/empty-work/shared-matrix cleanup and private shadow/PMREM
   disposal, plus additive-fog/headlight correctness; no historical hardware-FPS
   claim. Frozen cars/physics/presets retained.
6. Exactly-once final run persistence and shutdown finalization, scorer bookkeeping
   preservation, public leaderboard SELECT-cost admission/cache, receive-boundary
   correction telemetry and bounded sampled percentiles; security boundaries kept.
7. Main-ref deployment guard, rollback/proxy/fresh-host operational documentation,
   peer-welcome timeout/close handling and Node-compatible CloseEvent regression.
8. Unit/type/build, both-map online/reconnect, mobile/admin/upload regressions,
   local evidence and honest remaining limitations/retained decisions. It did not
   supply the new authored kit or prove physical-GPU/production visual acceptance.

Historical detail/remaining unrelated issues remain in the
[previous release report](2026-11-13-miami-upgrade.md), not silently claimed fixed.
