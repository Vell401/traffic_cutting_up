# Task 2 — production Miami world replacement

**Status: implemented, but NOT acceptance-complete.** The full R34 120-pose sweep
passes 500 calls / 5M submitted triangles. An additional selected-default-A45 probe
exposed **966 whole-frame calls** at8600 (4,628,235 triangles, Medium/DPR1). The
binding call budget therefore does not pass with the default car. Do not promote
this report to DONE or hide this by changing car selection, DPR/detail, budgets or
protected vehicle hashes. Controller decision is needed on the additional render-
budget integration (e.g. bounded car-shadow policy plus scaffolding batching, or
full-detail car batching); protected builders/models have deliberately not been
edited. See final evidence below.

## Outcome / boundary

Production Miami now attaches and actually renders the authored coastal kit, shared
photo PBR materials and photographed HDR, not just a loaded-but-unused asset. The
new layer has close hotel frontage, colonnades, terrace residences, two tower
silhouettes, feathered palms, furniture, yachts and pontoons. Four districts use
different compositions. The original road/collision route, barriers and lamp
anchors remain. Production suppresses legacy city/palm/boat/quay/lamp geometry
and the blimp. The legacy helper/default RoadView path remains available for its
existing tests; it is not production Miami's fallback.

No plan/spec/ledger edits, dependency additions, third-party runtime URLs,
vehicle/preset/builder changes, hash recaptures, network/schema/admin/data/security
changes, real data access, new branch/worktree, frontend server, push or deployment.
Task 3 still owns broader art refinement and final acceptance. This is not an
Assetto Corsa parity or physical-GPU/FPS claim.

## Runtime decisions

- Existing `miami-night` is Miami's new photographed coastal-dusk/default
  presentation. No map/network/sky-ID registry change. Its *Highway* interpretation
  is unchanged. The other five sky choices retain their gradient/stars, own fog and
  lighting; Miami uses lower HDR reflection intensity for them. The browser checked
  all six transitions and the independent Highway default.
- All 15 semantic roots / 74 prototype-material parts are used. Extract by names,
  clone and bake root-relative child transforms exactly once, never recenter parts.
  Bottom-centred full bounds govern clearance and longitudinal foundation grounding;
  boats/pontoons use manifest waterline offsets. Actual GLB vertices are checked
  outside the protected corridor for placements across all 120 canonical chunks.
- The same immutable extracted geometry and material objects are shared by batches.
  Nine photo maps are shared by ID, plus one linear Radiance HDR. Diffuse is sRGB;
  normal/roughness maps are NoColorSpace, flipY=false, RepeatWrapping, repeat=(1,1).
  Linear colour factors, normalScale, scalar roughness and roughnessMap are both
  applied: Three's standard shader multiplies scalar roughness by map.g. The
  deferred Blender preview factor issue is not reproduced in runtime.
- Road/structural geometry has independently metric UVs; asphalt uses its actual
  photo triplet and real geometric lane markings. Scaffolding concrete and textured
  PBR water borrow shared maps. The lower marina boardwalk is flat for furniture;
  a sloped gangway joins each floating pontoon. Outside-barrier maintenance walks
  support kit streetlight feet even on bridge spans without changing collision.
- Fixed full-detail authored window: 100m behind / 600m ahead, at most eight chunks.
  No decimation/distance LOD, DPR/preset reduction or special screenshot geometry.
  Existing road range remains 150m behind / 1300m ahead. All nearby authored model
  detail is retained. Long-range continuity/pop/haze remains an art-review item.
- One fixed 2048 directional shadow map follows the local road, 260m wide. Physical
  walls, glazing, hulls and foliage cast shadows; small frame/metal/emissive trim
  stays fully visible/receives shadows but does not add a redundant shadow pass.
  Calls/triangles below include the actual shadow submissions, not unique kit size.
- Miami-only gentler LUT/saturation/bloom/vignette use the existing post chain.
  Highway retains original defaults, room reflections and no new shadow map.

## Readiness and ownership

`loadMiamiAssets()` has no import-time HTTP, coalesces pending work and clears real
rejections for retry. Partial failures settle and dispose even late successful
resources. The GLB source geometry/material set is disposed once after extraction.
Extracted geometry/materials/maps/HDR have explicit leases; the cache is not an
owner and drops disposed data. Worlds own instance buffers only. RoadView owns
derived scaffolding materials/procedural maps but borrows photo maps through a
lease; FarGround only borrows RoadView's water material. The HDR environment owns
its PMREM target, not its texture separately. View owns/disposes its shadow target.
Cancellation and disposal are idempotent; late work cannot attach or report ready.
A cancelled first waiter defers disposal by one microtask so another waiter on the
same coalesced promise can claim its lease; a dedicated two-consumer RED/GREEN
regression protects this otherwise subtle race.

The existing initial overlay awaits required environment load, attach, compile and
real texture/geometry uploads **before** selected-car preparation and usable menu.
HTTP/compile/upload failures leave it locked and provide an actual retry, never
old-map fallback. Selected-only boot, resident car cache and optional remote queue/
restoration code remain intact. Highway `prepareEnvironment()` is a true no-op.

Browser failure/hold/retry evidence (`readiness.json`): manifest HTTP503 left menu
inert, environment unready and selected car unprepared. Retry made a second actual
manifest request. Held GLB still did not unlock UI. Release then produced attached
world + prepared car before unlock; instrumented WebGL calls rose from 7 texture /
0 buffer uploads while held to 71 texture / 1402 buffer uploads at readiness.
All six sky transitions passed; Highway made **zero** Miami asset requests, retained
legacy scaffolding/default dome and had shadows disabled. Page errors: zero.

## Tests / RED → GREEN

- Initial new loader/world/readiness suites failed for the absent modules/APIs.
- Subsequent behavioural REDs exposed the original all-parts shadow cost, missing
  streetlight support over bay, floating portal-approach foundations, missing
  gangway, and undisposed shadow target. Each was followed by focused GREEN.
- Loader tests cover coalescing, real retry, late partial success cleanup, semantic
  extraction, a transformed child (baked once), exact shared PBR factors/maps, no
  HTTP at Node import and shared ownership/PMREM disposal.
- Actual GLB world tests cover full-AABB/vertex safety in every district/lap,
  canonical descriptors, explicit capacities and real instanced/shadow triangle
  multiplication, unchanged-input no reconciliation, origin-only rebase, road
  identity/version/range/empty/pool transitions, grounding/waterline and disposal.
- Readiness tests cover attachment/compile/upload gates, real required retry,
  cancellation during loading and compile, state restoration, legacy suppression
  with road/barrier/anchor identity, and the focused Highway default-path regression.
- Existing Miami-art limits were **not** weakened: they continue to test the legacy
  helper path. New explicit budgets apply only to the production asset layer.
  Highway, route/rules/protocol and protected vehicle/security assertions remain.

Full suite run: **121 files, 1327 passed / 1 pre-existing skipped** (Linux-only
`systemd-analyze verify`, unavailable on Windows); no added skips or timeout changes.
`npm run typecheck`, `npm run build`, `npm run build:server` passed. Existing Node
experimental SQLite notices only. Final focused/regression results are recorded
in the final verification update below. After that full run, self-review added one
extra coalesced-cancellation test and its one-microtask guard; the final affected
suite and both builds/types were rerun rather than repeatedly running the full
suite while iterating.

## Payload / browser evidence

- Model + photos/HDR + manifest: **30,177,847 bytes** (<48 MiB).
- Shared downloaded textures: **10** (<48); kit part batches: **74** (<120).
- Captured visible placement maximum187; sum of every prototype capacity360
  (<1800) is a hard upper bound even before layout/range culling.
- Unique kit triangles: 371,112 — explicitly **not** reported as frame cost.
- Unit sweep tests every canonical chunk, all batch capacities and a complete
  counted shadow policy, reserving whole-frame headroom for car/traffic/road/post.
- Scratch only: `C:/Users/sosi/AppData/Local/Temp/opencode/miami-rebuild-task2/`.
  Uses coordinator Vite `http://127.0.0.1:15274`, isolated browser contexts, solo API
  stubs, external Playwright/native Edge, 1280×800, fixed Medium/DPR1, normal chase.
  No backends or duplicate frontend were started by this implementation.
- Matched old 300/850 reference PNGs and actual kit previews were opened before
  implementation. New normal-game canvas PNGs at 300/850/6100 were captured and
  opened/inspected without menu/loading overlays: recessed/railed authored frontage,
  feathered palms, furniture, marina/yachts, real surfaces and photographed sky are
  present; foreground car/traffic are readable. Downtown 8600 was also inspected.
- Final whole-frame renderer.info samples (shadows/post/selected R34 included):

  | Normal chase pose | Calls | Submitted triangles | DPR |
  |---|---:|---:|---:|
  |300|291|3,841,443|1|
  |850|288|3,848,551|1|
  |3800|251|1,472,197|1|
  |6100|316|2,366,605|1|
  |8600|280|4,134,093|1|
  |10050|243|1,136,049|1|
  |11990|293|3,755,745|1|
  |12010|291|3,694,723|1|

  Full120-pose sweep (every100m, actual game render): maximum **316 calls** and
  **4,139,777 submitted triangles**. No page errors. Original normal chase height
  2.05m retained; no orbit/raised/low-detail camera. The final 300/850/6100 PNGs
  were reopened and visually inspected after the completed run; causeway3800 too.
  Readiness is true and HDR background is the actual manifest HDR in all captures.
  Whole renderer texture count52 includes car/post/render targets; the new shared
  downloaded-photo/HDR count is10, not52.

  **Additional default A45 selection at8600: 966 calls / 4,628,235 triangles,
  DPR1.** This is an explicit failing call-budget result, not a passing sample.
  `evidence.json` includes the full scan and default-car probe. A separate
  `a45-budget.json` diagnostic isolates the existing car's contribution; it is not
  used as a passing production pose or a reason to hide the real car.
  A fresh default-A45 boot independently reproduced **966 calls / 4,626,751
  triangles** at8600. With only the car and current Miami lighting/post retained,
  it measured **801 calls / 1,314,243 triangles**. The actual car has395 visible
  meshes /657,110 main-pass triangles. Its existing builder marks all imported
  meshes as shadow casters (`src/render/car/index.ts:337`); the new Miami sun adds
  the extra car shadow pass. This is **not** a claim that Highway's shadow-disabled
  car alone costs801 calls. It identifies why merely shrinking the environment
  would not honestly solve the integration budget. Page errors: zero. No protected
  builder/model was changed.

## Limits / handoff

No mobile/final online/admin acceptance or hardware timings claimed; Task3/controller
own those gates. Current presentation is substantially brighter than old Miami night;
Task3 should review warmth/exposure, broad empty promenade/shore stretches, distant
window cadence, material finesse, shadow-volume edges and the authored-window seam.
No change to Task1's deferred Blender preview roughness-factor multiplication.

## Final verification update

Final affected run: **9 files / 86 tests passed**, including the new two-consumer
cancellation RED/GREEN. Final types, client build and server build passed again
after that fix. `git diff --check` found no whitespace errors.

Expanded browser evidence completed successfully (`evidence.json`). One earlier scratch sweep was
interrupted by development HMR; a subsequent 240s software-rendering run exceeded
the shell capture limit. The final fixture freezes only automatic simulation/
duplicate draws (not camera, detail, DPR, shadows or post), seeds traffic and calls
the actual game renderer for every fixed pose with a longer shell allowance. No
test timeout or skip was changed. The final full sweep passed for the matched R34
reference car, but its additional A45 probe exposed the blocking call-budget issue
above. No car-asset/builder optimization was silently added outside the owned scope.
