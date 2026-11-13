# Task 2 — DONE_WITH_CONCERNS: production Miami world replacement

**Current status: DONE_WITH_CONCERNS at `706367a`.** Existing completed evidence
passes the controller-clarified fixed Medium/DPR1 **normal opaque selected-car**
reference gate for **all four cars**, including first usable frames, authored world,
sun shadows and post: maximum499 calls and4,633,191 submitted triangles. Full
geometry/material/caster detail, correct transparency ordering, Highway defaults
and protected source fingerprints remain intact. No new implementation or rerun
was needed for this status-only handoff.

Limits remain explicit: the fixed marina poses leave only **1 call A45 /2 calls
W204** headroom. Correctly ordered protected-spawn ghost transitions cost **716
calls A45 /697 W204 at6100** and are measured/disclosed separately under the latest
design-budget and ledger ruling. This is not a universal call/FPS guarantee across
ghost, preparation or arbitrary multiplayer density. No cap raise, geometry/caster
cut, forced car/DPR or transparency rewrite was used. Task3 art refinement and
independent task/final acceptance remain separate gates.

The original966-call checkpoint and subsequent NEEDS_CONTEXT investigation below
are historical evidence; the normal-state blocker is fixed and the controller has
resolved the ghost-reference scope. The final continuation tables are authoritative.

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

## Extra-ownership continuation from `1c9760d`

Controller explicitly granted the Miami-only lossless helper and opt-in wrapper
wiring in the updated Task2 brief. This continuation adds
`src/render/miami/carBatching.ts`, opts in only from Miami View construction/car
cache/optional remote preparation, and wires PlayerView/RemoteCar before readiness
and GPU warm-up. Highway's constructor default remains false. No original builder,
GLB, physics, camera rig, quality preset or protected hash assertion was edited.
The coordinator's plan edit is left unstaged and was not changed by this task.
Owned source/tests continuation commit: **`706367a`**. Per the ruling's
"commit ONLY owned source/tests", this appended report is left as an unstaged
owned handoff artifact; the separate coordinator plan edit remains unstaged too.

### Actual source boundary and equivalence

- A45: actual downloaded GLB has394 meshes /77 materials /828 nodes. Real builder
  boundary gives789 colour+sun draw submissions and1,314,218 complete triangles in
  the Node fixture. No placeholder/proxy is used. Node substitutes only native
  image decoding, as existing W204 tests do; actual geometry, hierarchy, quantized
  buffers and material definitions pass through GLTFLoader/Meshopt and real builders.
- A45 wheel/disc/front-suspension controls, steering wheel and shift paddles are
  independent motion domains. Rear calipers are genuinely non-animated in the
  original ImportedWheels implementation. W204 adds its independent steering wheel,
  calibrated speed/tach needles, rolling pivots and front steering pivots; its rear
  fixed calipers/discs consolidate separately under wheelRoot, never suspended body.
- Same material **object identity**, complete compatible attribute layout and draw
  flags are required. No material-value merging or decimation. Skinned/instanced,
  morph, material-array, displacement/object-normal-map, custom depth/distance and
  non-default per-mesh render-callback cases are excluded. Existing source nodes,
  setters and authored hidden branches stay present.
- Real RED exposed normalized Int16 POSITION wrapping when transforms were baked
  in place. The helper now decodes transformed POSITION/NORMAL/TANGENT into shader-
  input Float32 first, without re-quantization. Other attributes remain byte-identical.
  Root-relative transforms are applied once; negative determinants reverse index
  winding to match Three's original front-face convention, not normals/tangent.w.
- Actual A45 and W204 tests inspect every derived vertex/index and material binding
  through representative steering, independent spin, suspension, cockpit/visibility,
  paint, brake, signals and ghost states. Position/normal tolerance is1e-5 (render
  Float32 precision); all remaining original attribute components and index mapping
  match exactly. Synthetic negative/non-uniform/mirrored parent+child cases verify
  effective triangle orientation, normals and tangent handedness as well.
- Transparent **colour** objects are never merged or re-ordered. Compatible static
  shadow/depth draws can consolidate on a Miami sun-only layer: identical-material
  depth writes have no transparent blend ordering. Original duplicate shadow draws
  are routed off only while the full replacement caster is active; caster triangle
  totals are equal, not reduced. Material, transform or visibility changes restore
  the exact source path. Ghost opaque-to-transparent transitions keep original colour
  objects/order and use the same full shadow geometry. No caster-quality disable.
- Private derived geometry is bounded per resident car (53 A45 batches,44 W204),
  reused across camera/ghost/visibility changes and disposed once. Materials/maps/
  source geometry remain borrowed. Disposal restores source layers/caster flags;
  late-cancel cannot attach. Actual optional remote preparation/reveal/repaint and
  default-unbatched Highway wrapper paths have focused regressions.

### RED/GREEN and verification commands

- `npm test -- tests/miamiCarBatching.test.ts`: real A45 RED789 submissions against
  absent opt-in integration; transformed-geometry RED found2.81m quantization wrap;
  W204 RED found zero supported batches and later missing wheelRoot consolidation.
  All corresponding regressions are GREEN. The final A45 fixture is286 submissions
  with exactly the same1,314,218 triangles. An initial arbitrary280 helper estimate
  was replaced by the explicit measured286 assertion; the binding whole-frame
  **500/5M** bounds have never been changed.
- Final focused command also covered `viewLoading`, `remoteLoading`, `miamiLoading`,
  `playerView` and `playerViewDisposal`; all passed. Final full `npm test` was run
  **once after this integration**: **122 files,1338 passed /1 existing Linux-only
  systemd-analyze skip**. No test timeout, skip, frozen assertion or source fingerprint
  was weakened/recaptured. Existing experimental SQLite notices only.
- `npm run typecheck`: pass. `npm run build`: pass (428 modules).
  `npm run build:server`: pass (50 modules; unchanged gameServer bundle identity).

### Actual renderer evidence — all cars, unchanged world/shadows/detail

`all-car-budgets.mjs` / `all-car-budgets.json` are in the same approved scratch
directory. Each car has a fresh Medium/DPR1 1280×800 native Edge context, only its
own selected heavy model request, required world/HDR readiness, first usable frame
measurement and real View.render at300/850/6100/8600/8800. Normal car-camera rigs
and all authored world geometry remain unchanged. Photos/HDR, local shadows and
post remain active. Page errors zero. No software timings/FPS claim.

| Car | First usable calls | Normal pose max calls | Normal pose max triangles |
|---|---:|---:|---:|
| Default A45 |472|499|4,633,191|
| Porsche |333|360|3,568,932|
| R34 |289|316|4,139,039|
| W204 |471|498|3,788,231|

Normal firstframes and fixed poses therefore pass, but A45/W204 marina headroom
is only1/2 calls in this fixed evidence. Broader traffic/content acceptance still
belongs to the controller/Task3; this is not an arbitrary-density guarantee.
The final A45 spawn/downtown and all four downtown PNGs were opened and inspected;
full exterior/interior detail, surfaces and actual car/world shadows remain present.

### Disclosed ordered ghost colour draws — scope resolved

`ghost-structure.mjs` / `ghost-structure.json` instrument the actual game's main and
sun submissions and read the actual sorted render list at6100, Medium/DPR1:

| Ghost car | Full calls | Main | Sun shadow | Post | Own transparent draws | Own transparent materials | Own consecutive material runs |
|---|---:|---:|---:|---:|---:|---:|---:|
| A45 |716|558|149|9|389|83|283|
| W204 |697|525|163|9|263|81|211|

Both have153 opaque render-list items. The whole scene has286/214 consecutive
transparent material runs. Even optimistically merging those whole-scene runs
without attribute/motion/visibility restrictions gives153+286+149+9=**597** A45
and153+214+163+9=**539** W204 (ignoring additional two-sided costs). Non-adjacent
same-material items have other transparent materials between them in the actual
camera-depth order, so a static per-material colour merge is not equivalent.
Existing wheel, needle and paddle domains prevent simply joining the remaining
dynamic casters either. Camera/visibility/ghost equivalence tests deliberately keep
these original draws; hiding the issue or merging by approximate material colour
would violate the ruling.

**Controller ruling resolved this context:** the design budget and ledger now
explicitly apply500 calls /5M submitted triangles to fixed Medium/DPR1 normal
opaque reference poses for every selected car, including sun/post/world. Correctly
ordered protected-spawn transparent ghost transitions are measured and disclosed
separately, not subject to that fixed-reference cap. The716/697-call measurements
remain explicit; no500-call ghost result or universal FPS claim is made. Therefore
no global transparency rewrite or further ghost-colour merging is required or
performed. The unchanged normal cap passes for all four cars on the completed
evidence above, with the narrow1–2-call marina headroom retained as a concern.

**Final handoff: DONE_WITH_CONCERNS.** Commits `1c9760d` and `706367a`; completed
verification is122 files /1338 passed /1 existing platform skip, typecheck and both
builds passing. This report and the coordinator plan/spec edits remain unstaged
for the controller's handoff commit. No other file was changed for finalization.

## Task2 fix round1/5 — Important I1 (FIX_BASE `706367a`)

Review: `.superpowers/sdd/2026-11-13-miami-assetto-visual-rebuild/task-2-review.md`,
I1 only. A definite required model/map/HDR failure now rejects promptly and clears
only that job's coalescing/retry slot, without awaiting unrelated stalled transfers.
Each failed job retains its own completion/rejection handlers and resource registry;
already-loaded and late-successful textures/source geometry/materials are disposed
exactly once. Old jobs never extract/attach a late model, clear a newer pending
retry, replace its cached success, or dispose its distinct resources. Successful
extraction retains the existing ownership handoff, including extraction-failure
cleanup without a second disposal by the request job. No timeout, global abort
rewrite, car/art change or deferred M1 readability work was introduced.

Owned covering files: `src/render/miami/assets.ts` and
`tests/miamiEnvironment.test.ts`. The loader tests use the actual
`createMiamiAssetLoader` and delivered manifest, controlled unresolved sibling
promises, coalesced callers, and separate model/map/HDR failures. They assert
rejection and successful retry **before** releasing old siblings, then late old
model/map cleanup, shared-resource disposal-once, successful-cache isolation and
a second late old rejection while the new retry is still pending. The successful
retry's textures, materials and derived geometry stay undisposed through old-job
cleanup and are disposed once only on its own final lease release. A separate
invalid-semantic-root test checks original/copied geometry, source materials and
maps are consumed once on extraction failure and can be retried cleanly.

Exact RED command/output:

```text
npm test -- tests/miamiEnvironment.test.ts
Test Files  1 failed (1)
Tests       3 failed | 6 passed (9)
model / map / HDR: required failure must reach callers before stalled siblings
are released: expected 'pending' to be 'rejected'
```

An intermediate run confirmed the new immediate rejection exposed the existing
late-cleanup test's delayed rejection observer (PromiseRejectionHandledWarning).
That test now observes rejection immediately and still asserts eventual once-only
cleanup after releasing its held sibling; its ownership assertions were not removed.

Exact final covering GREEN commands/output:

```text
npm test -- tests/miamiEnvironment.test.ts tests/miamiLoading.test.ts tests/viewLoading.test.ts
Test Files  3 passed (3)
Tests       33 passed (33)
Duration    1.31s

npm run typecheck
tsc --noEmit && tsc --noEmit -p server
Exit 0
```

No unhandled errors or rejection warnings in the final covering run. Full suite,
builds and browser were intentionally not rerun for this localized fix, as directed;
the earlier complete campaign remains historical evidence, not a new recertification.
The coordinator plan/spec and this report remain unstaged for handoff; only owned
loader/tests are included in the fix commit. I1 is addressed, pending localized
re-review. Existing normal-budget headroom, ghost-cost disclosure and Task3/final
acceptance limits are unchanged.

Fix commit: **`4b0c782`**, based on `706367a`; contains only
`src/render/miami/assets.ts` and `tests/miamiEnvironment.test.ts`. Ready for focused
I1 re-review. The report and coordinator plan/spec edits are not included in this
commit and remain unstaged for controller handoff.
