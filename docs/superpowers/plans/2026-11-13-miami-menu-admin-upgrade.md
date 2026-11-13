# Miami, menu, unified administration and review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a more realistic Miami with a new closed route, small safe menu fixes, verified advance car preparation, one admin login, and measured quality-preserving optimizations.

**Architecture:** Keep the existing Three.js/Vite client and two independent Node worlds. Divide delivery into four independently tested subplans: Miami, menu/preparation, administration, and optimization/review. Highway is the administration authority; it authenticates the browser once and proxies an allowlisted Miami admin API to a configured internal backend.

**Tech Stack:** TypeScript, Three.js r187, Vite, Node HTTP/WebSocket, SQLite, Vitest, existing Playwright browser scripts.

**Spec:** `docs/superpowers/specs/2026-11-12-miami-menu-admin-upgrade-design.md` (approved by the user's “Делай” on 2026-11-13).

## Execution status

Tasks 1–7 and both Task 8 checkpoints are implemented and independently reviewed. The detailed checklists below preserve the planned gates; actual results, deviations, deferred findings and reproducible commands are in `docs/reviews/2026-11-13-miami-upgrade.md`.

| Scope | Accepted checkpoint |
| --- | --- |
| 1 — Miami geometry | `45f8659` |
| 2 — scenery and marina visibility repair | `0d8fd2a` |
| 3 — menu/native focus/loader locks | `0671114` |
| 4 — selected/remote readiness and retry | `70a782c` |
| 5 — authorized central gateway | `90da34f` |
| 6 — shared browser session/world switching | `1cc28b3` |
| 7 — render correctness/equivalent work elimination | `1556543` |
| 8A — audited lifecycle/read/telemetry/deploy repairs | `4e24cef` |
| 8B — integrated browser acceptance and report | `4b27ce0` |

Fresh whole-change review and controller-only final main integration/deployment verification remain pending at this planning checkpoint. Local acceptance: 1273 tests passed, 1 baseline platform skip; types, both builds, performance checks, both-map proxy smoke and four browser suites passed. Physical-GPU/phone/VPS performance and actual new rollout are not certified by these local results.

## Global Constraints

- Miami remains a 12 000 m closed ring; spawn remains at 300 m on an open straight; curvature radius is at least 1200 m.
- Natural uncorrected closure error is below 1e-7 m; heading advances 2π and curvature is continuous.
- Vehicle physics, shipped presets, protected builder/model hashes and original car assets remain unchanged.
- Preserve Highway behavior and independent databases, radio, tuning, moderation and records. No record wipe or new seasons.
- Preserve the menu composition and purple theme. Selection must not join a game; only an explicit start does.
- Preserve advance preparation of the selected vehicle, including actual GPU resource upload; no mandatory download of all detailed cars.
- No quality/DPR/draw-distance/detail reduction presented as optimization; no paid services or new framework.
- Workers do not deploy, push, merge, change credentials or mutate existing user data. After all gates pass, the controller may integrate into main and verify the documented automatic deployment, as newly requested by the user on 2026-11-13. Test servers use temporary databases/radio folders; production records/volumes are preserved.
- Every implementation task has a red/green test gate; review findings affecting frozen physics are report-only.

## Review Focus

1. Enter/Space on a focused button/select/range must activate only that control, not start or drive the game (Task 3).
2. A stale model selection or compile failure must not attach the wrong car, mark it ready, leak GPU resources, or lose retry (Task 4).
3. An offline/wrong-map/redirecting Miami backend must receive neither a privileged mutation nor leaked credentials (Task 5).
4. Logout and switching worlds while a request/upload is pending must not revive the old session or mutate/render the wrong world (Tasks 5–6).
5. View reuse, negative/future laps, floating-origin shifts and same-index replacement roads must not reuse stale geometry/transforms (Tasks 1–2, 7).

## File ownership and boundaries

- Miami: `src/sim/miami.ts`, `src/sim/maps.ts`; rendering in `src/render/miami.ts`, `roadView.ts`, `city.ts`, `scenery.ts`, `sky.ts`, `textures.ts`; geometry/visual tests.
- Menu/preparation: `src/main.ts`, `src/ui/serverPicker.ts`, new `src/ui/menuInput.ts`, `src/menu.css`; new `src/render/prepareObject.ts`, `src/render/view.ts`; targeted input/loading tests.
- Administration: new `server/adminGateway.ts`, reusable authorization in `server/admin.ts`, wiring in `server/main.ts`; `src/admin/{main,instance}.ts`, associated tests and Compose/deployment documentation.
- Optimization: `src/render/roadView.ts` update scheduling, `src/render/playerView.ts` private shadow ownership, isolated benchmark script/tests. Do not combine this with new visual content in A/B comparisons.
- Integration/report: `tests/features.browser.mjs`, new `tests/upgrade.browser.mjs`, relevant Markdown. The coordinator owns cross-subsystem integration and final documentation.
- Agents must not edit another task's files concurrently. No broad formatting or unrelated restructuring.

## Before implementation

- [ ] Create an isolated feature workspace using `using-git-worktrees`; preserve/copy the approved spec and this plan without discarding original changes.
- [ ] Establish dependencies using the existing lockfile and inspect test/browser availability.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, `npm run build:server`; record actual baseline failures separately rather than hiding them.
- [ ] Record baseline Highway rules hash, selected-car preparation behavior, screenshots and renderer metrics at matched states. Keep artifacts in the approved temporary directory, not source control.

---

## Subplan A — Miami

### Task 1: A naturally closed, varied Miami route

**Files:** Modify `src/sim/miami.ts`, `src/sim/maps.ts`, `tests/maps.test.ts`; extend `tests/mapNetwork.test.ts` where revision admission is tested.

**Interfaces:** Keep `miamiScript(): RoadScript` and `MIAMI_LEN = 12000`. Add `type MiamiDistrict = 'ocean-drive' | 'causeway' | 'marina' | 'downtown'` and `miamiDistrict(s: number): MiamiDistrict` in `src/sim/miami.ts`, periodic for negative and future laps. Set Miami map revision to 2, Highway revision remains 1; protocol remains 13.

- [ ] **Step 1 — Write failing geometry tests.** Replace only the obsolete four-identical-quarter assertion. Require two distinct bend radii, 120 chunks, length 12000, natural closure `< 1e-7`, heading `2π`, curvature seam continuity, no non-neighbor road segment crossings, and separation of the protected road envelopes. Preserve existing spawn/bridge/lap tests. Assert district values at 0, 2200, 5000, 8400 and periodic equivalents. Pin the baseline Highway rules hash captured above and prove old Miami revision admission is rejected.
- [ ] **Step 2 — Run red.** `npx vitest run tests/maps.test.ts tests/mapNetwork.test.ts`; expect new geometry/district/revision assertions to fail on the old map.
- [ ] **Step 3 — Implement the route.** Use one 6000 m half repeated after a heading change of π. Segments `(len,k0,k1)` are: straight 600; ramp 400 to `a=1/1500`; arc 1500 at a; ramp 400 to zero; straight 300; ramp 400 to `b=(Math.PI-1900*a)/2400`; arc 2000 at b; ramp 400 to zero. Repeat a fresh copy of the half, not shared mutable objects. This gives two different turn profiles with natural central-symmetry closure and both radii above 1200.
- [ ] **Step 4 — Implement section/district composition.** In chunk counts: open18, walls4, viaduct6, bridge16, viaduct6, open14, viaduct6, bridge8, viaduct6, open12, tunnel10, open14. District boundaries are 0/2200/5000/8400/12000; lookup is canonical modulo 12000. Keep spawn at 300 and no intersections/branches.
- [ ] **Step 5 — Run green and protection tests.** `npx vitest run tests/maps.test.ts tests/mapNetwork.test.ts tests/road.test.ts tests/frozenPhysics.test.ts tests/unchangedCars.test.ts`; all pass without altering protected hashes. Review the route plot/coordinates before scenery changes.
- [ ] **Step 6 — Checkpoint.** Record changed paths and test evidence; if committing under the chosen execution workflow, stage only Task 1 files and use `feat: rebuild Miami coastal ring geometry`.

### Task 2: Realistic district identity within bounded scenery budgets

**Files:** Modify `src/render/miami.ts`, `src/render/roadView.ts`, `src/render/city.ts`, `src/render/scenery.ts`, Miami-only portions of `src/render/sky.ts`/`textures.ts`; extend `tests/miamiVisuals.test.ts`.

**Interfaces:** Consume `miamiDistrict(s)`. Keep `miamiPalm`, `miamiDeco`, `canonicalChunk`, and `miamiChunkSeed` public signatures. Add rendering helpers only in `src/render/miami.ts` if needed; keep the seven existing chunk material batches and three existing procedural texture allocations. Any animated water parameter uses one shared theme-specific uniform, not per-chunk materials or lights.

- [ ] **Step 1 — Write failing content/safety tests.** Require district-dependent deterministic layouts, at least three distinguishable facade silhouettes, bounded palms/props outside the road/spawn envelope, no buffer overflow over all 120 chunks, stable negative/future laps and disposal once. Retain Highway/default geometry and material assertions; new content stays within existing buffer limits and 6000 triangles per chunk mesh.
- [ ] **Step 2 — Run red.** `npx vitest run tests/miamiVisuals.test.ts`; new district/silhouette assertions must fail before implementation.
- [ ] **Step 3 — Implement procedural detail.** Ocean Drive: low pale facade bands, restrained neon, setbacks, balconies/roof details. Causeway: open bay, consistent shoreline/bridge infrastructure and distant skyline. Marina: piers, boats, seawall/boardwalk details outside the road envelope. Downtown: varied stepped/slender towers with warm window structure and readable road lighting. Improve palm crown/trunk shape without per-frond scene objects; retain canopies outside the barrier.
- [ ] **Step 4 — Improve only Miami lighting/materials.** Use warm practical lights and a cooler blue sky, localized neon and physically plausible dark water with subtle highlights; no global SSR, extra fullscreen pass, black fog mask or excess bloom. Prefer shader/vertex attributes and merged geometry to new materials/draw calls. Procedural windows remain stable rather than flickering.
- [ ] **Step 5 — Run green and visual gate.** `npx vitest run tests/miamiVisuals.test.ts tests/maps.test.ts tests/renderPerformance.test.ts`; capture active-road views of all four districts, bridge approaches, tunnel portals and lap seam at fixed positions/cameras. Confirm signs, road and cars are readable and geometry stays grounded. Adjust content, never weaken safety/buffer tests to hide overflow.
- [ ] **Step 6 — Checkpoint.** `feat: improve Miami district scenery and night lighting`, only owned files and truthful evidence.

---

## Subplan B — Small menu fixes and advance preparation

### Task 3: Choice controls cannot start a game accidentally

**Files:** Create `src/ui/menuInput.ts`, `tests/menuInput.test.ts`, `tests/loadingFocus.test.ts`; modify `src/main.ts`, `src/core/input.ts`, `src/ui/loading.ts`, `src/ui/serverPicker.ts`, `src/menu.css` only as needed; browser assertions in `tests/upgrade.browser.mjs` owned by integration.

**Interfaces:** Export `isMenuControl(target: EventTarget | null): boolean` from `menuInput.ts`: recognizes button/input/select/textarea/summary, contenteditable and their child targets. Call it before the global menu Enter/Space start shortcut; actual start-button native activation remains valid. Keep `selectedMap`, `mapNavigation`, `modeNavigation` signatures and existing control IDs.

- [ ] **Step 1 — Write failing tests.** Nested elements in choice buttons count as controls; Enter/Space on selects, text/color/range inputs, details and buttons do not trigger the global start shortcut. Keyboard choice retains focus and remains usable; keyup still releases previously held driving keys. Name-field Enter saves/finishes editing but must not start a session; repeated events/duplicate click on the actual start button must not create a second session.
- [ ] **Step 2 — Run red.** `npx vitest run tests/menuInput.test.ts tests/carSelection.test.ts`; expect absent guard/new interaction assertions to fail.
- [ ] **Step 3 — Apply narrow fix.** Add the guard to the `state === 'menu'` global shortcut and remove the direct name-field Enter start action. Remove unconditional selection-button blur where it breaks keyboard focus, without allowing Space/Enter leakage. Scope contrast/focus/selected-state styling to the existing picker/segmented controls, retain the same menu composition. Keep map/mode navigation in menu and no automatic join.
- [ ] **Step 3a — Repair loader focus-lock ownership.** Baseline review H2 in the SDD baseline-menu-review.md demonstrates `LoadingScreen.lockUI(false)` clears lifecycle-owned inert flags. Add desktop boot/online-join/paused-car-load regression cases: both hidden overlays remain inaccessible after load finish/failure-action; loading never unlocks currently visible background controls. Compose loader/lifecycle state or synchronously reapply lifecycle state on lock changes. Native Space activation of focused controls must not be prevented by the global Input BLOCK handler. Preserve keyup release and actual-start-button behavior.
- [ ] **Step 4 — Run green.** Targeted unit tests plus browser test that observes zero WebSocket connects until explicit start on both maps, selects map/mode/car using keyboard and touch, then connects once and returns to resident menu. Preserve `?server`/map navigation rules and loading overlay behavior.
- [ ] **Step 5 — Checkpoint.** `fix: keep menu selection separate from game start`.

### Task 4: Verify and complete selected-car GPU preparation

**Files:** Create `src/render/prepareObject.ts`, `tests/prepareObject.test.ts`; modify `src/render/view.ts`, `src/render/remoteCar.ts`, `src/main.ts` preparation/recovery paths, `tests/viewLoading.test.ts`, `tests/remoteLoading.test.ts`, `tests/menuLifecycle.test.ts`; extend `tests/onlineCarWarmupFailure.test.ts` only to reflect stronger readiness, never to block boot on optional bodies.

**Interfaces:** `prepareObject(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, root: THREE.Object3D): Promise<void>` awaits asynchronous shader compilation, then performs a tiny offscreen render with the selected subtree visible/non-culled, and restores all changed renderer/object state in `finally`. `View.prepareCar(): Promise<void>` remains coalesced per cached `PlayerView`, invalidates on failure/supersession and covers exterior/cockpit and opaque/ghost material variants before readiness. Preserve its public signature and callers.

- [ ] **Step 1 — Write failing tests.** Model attachment precedes compile and warm draw; hidden bumper/cockpit meshes are genuinely prepared; `render` is called after attachment/compile, and target/viewport/scissor/clear/visibility/culling states are restored on success or exception. A superseded selection cannot become cached as ready. Repeat selection coalesces, rejected preparation retries, optional remote failure remains nonblocking. Include transparent/opaque variant restoration without changing car appearance.
- [ ] **Step 2 — Run red.** `npx vitest run tests/prepareObject.test.ts tests/viewLoading.test.ts tests/onlineCarWarmupFailure.test.ts`; old preparation must fail the added real-draw/readiness assertions.
- [ ] **Step 3 — Implement the helper and integration.** Reuse a bounded offscreen target or dispose a temporary 4×4 target, do not alter camera rigs or car builders. Keep upload/compile work under the existing loading overlay. Save/restore selected-car cockpit, ghost and root visibility even on failure. Do not race overlapping warm draws or mark a disposed/replaced model ready. Apply the same helper to optional remote warming where appropriate without eagerly downloading all models at boot.
- [ ] **Step 3a — Repair confirmed late-readiness recovery.** Baseline review M1/M2 in the SDD baseline-menu-review.md demonstrates identity may be committed before `prepareCar` fails and same-car/authoritative guards suppress retry. Add post-download failure tests for menu/solo and accepted-online identities. Retry must actually prepare again; evict an instance whose immutable attachment readiness rejected, but retain authoritative online physics. Also warm the actual lazy RemoteCar path before reveal, in bounded/yielded steps rather than a claim that a tiny target makes large texture uploads free. Keep failure/retry/dispose cancellation and no-eager-optional-download boot tests.
- [ ] **Step 4 — Run green and browser evidence.** Run the three targeted suites plus `tests/unchangedCars.test.ts`/`tests/frozenPhysics.test.ts`. On each of the four selected cars measure first startup, first chase/cockpit transition and warm menu→play; verify no repeated model HTTP/GLB decode or shader/resource rebuilding after returning to the cached choice. Report remaining driver-specific timing limitations honestly.
- [ ] **Step 5 — Checkpoint.** `fix: complete car GPU warmup before driving`.

---

## Subplan C — One administration login

### Task 5: Authorized, identity-checked Miami admin gateway

**Files:** Create `server/adminGateway.ts`, `tests/adminGateway.test.ts`; modify `server/admin.ts`, `server/main.ts`, `compose.yaml`, and add coverage to `tests/mapDeployment.test.ts`, `tests/clientAddress.test.ts` and the existing admin auth tests in `tests/store.test.ts` without changing world volumes or exposing game ports.

**Interfaces:** Add `Admin.authorize(req: IncomingMessage, res: ServerResponse, upload?: boolean): boolean` to reuse enabled/origin/session checks. Add `AdminGateway` with `handle(req: IncomingMessage, res: ServerResponse): boolean`, constructed with `{ admin: Admin; url?: string; password: string; timeoutMs?: number }`. Handle only `/api/admin/maps/miami/<allowlisted-path>`. Local Highway endpoints, login/logout remain `/api/admin/*`. `ADMIN_MIAMI_URL` is optional and server-controlled; `ADMIN_MIAMI_PASSWORD` defaults to ADMIN_PASSWORD. In Compose set the URL only on Highway to `http://game-miami:8787`; do not give Miami a self-proxy URL.

- [ ] **Step 1 — Write failing HTTP tests.** Start temporary real Node HTTP fixtures. One central login can read/mutate Miami through the gateway; no browser token means 401 and zero upstream requests. Wrong origin means 403. Wrong-map health/header, redirection, malformed URLs, forbidden paths/methods, offline service and timeouts fail closed without upstream credentials/mutations. Test bounded service-session caching and reauthentication before dispatch, no automatic mutation replay, central logout denial, streaming upload size/abort and sanitization of upstream errors/headers.
- [ ] **Step 2 — Run red.** `npx vitest run tests/adminGateway.test.ts`; tests fail because the gateway/authorization interface does not exist.
- [ ] **Step 3 — Implement gateway authorization and transport.** Use only the configured HTTP(S) origin/base; do not accept target URL/Host/redirects from clients. Before login/credentials and mutations, request public health and require Miami identity. Cache a single bounded internal admin token with its expiry and coalesce refresh, never return it to the browser. Explicitly allow existing state/logs/board reads and traffic/players/kick/unban/say/tuning/radio/board-remove/upload writes. Forbid proxied login/logout and arbitrary routing. Preserve JSON/write checks and wrong-map response protection.
- [ ] **Step 4 — Implement streaming and lifecycle.** Use Node HTTP(S) piping/backpressure or equivalent bounded streaming; enforce the existing 40-MB upload limit and 16-KiB JSON limit before forwarding excessive data. Bound request/response time and headers, propagate client cancellation, avoid buffering uploads or replaying writes. Treat upstream auth failure as an unavailable target, not browser logout; credentials never appear in diagnostics. Recheck central session and authorization after asynchronous health/login awaits, before dispatching a mutation.
- [ ] **Step 5 — Wire server/config.** Invoke the gateway before ordinary Admin handling. Only Highway configures it; absent URL gives a clear target-unavailable error to authorized requests. Existing public API and two WebSocket routes remain unchanged. Add explicit env documentation later in Task 8.
- [ ] **Step 5a — Preserve distinct trusted-proxy admin identities.** Confirmed baseline-server-review.md finding 1: Admin ignores main's configured resolver, collapsing Caddy clients into one login bucket/audit address. Add optional `clientAddress?: ClientAddressResolver` to `AdminOptions`, default to the existing safe socket-only resolver and pass main's trusted resolver. Test real-client separation and forged-prepend rejection through a trusted proxy, retain direct-client XFF rejection and overall/per-address limits. Prune expired limiter keys. Gateway must not copy arbitrary browser forwarding headers or expand trusted peers; internal service requests are identified as the gateway, not a forged original browser.
- [ ] **Step 6 — Run green.** `npx vitest run tests/adminGateway.test.ts tests/mapDeployment.test.ts tests/adminInstance.test.ts`; retain all preexisting auth/origin/map boundaries. Compile both server and client.
- [ ] **Step 7 — Checkpoint.** `feat: add unified authorized admin gateway`.

### Task 6: One browser session and safe world switching

**Files:** Modify `src/admin/instance.ts`, `src/admin/main.ts`, `tests/adminInstance.test.ts`, affected admin unit tests; update existing integrated admin browser URLs under coordinator ownership.

**Interfaces:** `adminInstance(params)` keeps its map/name/api/tabKey shape; its tokenKey is the common `tcu.admin`, Highway api `/api/admin`, Miami api `/api/admin/maps/miami`. Login/logout always use central `/api/admin`. Instance state becomes replaceable with existing dashboard epoch/abort guards; URL `?map=` remains a deep link and arbitrary `?server` is still ignored.

- [ ] **Step 1 — Write failing tests.** Both maps share tokenKey but not target API/tab identity; explicit map navigation strips credentials/custom server. A delayed old-map 401/state cannot log out or repopulate a new dashboard. Refusing a dirty-world switch retains form/upload; accepting aborts old requests, resets the target verification and retains the central token. Tests cover a missing Miami backend without losing the session.
- [ ] **Step 2 — Run red.** `npx vitest run tests/adminInstance.test.ts tests/adminDraftSave.test.ts tests/adminSlowState.test.ts tests/adminTabs.test.ts`; new shared-auth/race assertions must fail.
- [ ] **Step 3 — Implement narrow UI change.** One login form without server-specific authentication; dashboard retains the six existing tabs and explicit target-map label. Switching map confirms dirty/upload loss, aborts old epochs, updates history and remounts the dashboard against the new allowlisted API without full page reload or re-login. Keep origin/map verification before mutations. Logout invalidates central session and clears the shared browser key only.
- [ ] **Step 4 — Run green and real browser acceptance.** Login once, switch both directions, confirm no second login POST; update traffic on one map and verify the other is unchanged, upload/cancel a harmless fixture WAV in temporary data, test expiry/logout and a wrong-map response. Preserve drafts across same-map tab switches.
- [ ] **Step 5 — Checkpoint.** `feat: share admin login across isolated worlds`.

---

## Subplan D — Optimization, project review and integration

### Task 7: Measured, visually equivalent render/resource fixes

**Files:** Modify `src/render/roadView.ts`, `src/render/playerView.ts`, `src/render/view.ts`, `src/render/tyreEffects.ts`, `src/render/trafficView.ts`, and `src/render/sparks.ts` only for the confirmed audit mechanisms below; add small owned helpers if needed. Create `tests/roadViewScheduling.test.ts`, `tests/playerViewDisposal.test.ts`, `scripts/roadViewPerfcheck.ts`; extend focused existing render/effect/traffic/readiness tests and add resource/fog coverage. Do not alter Task 2 content to improve benchmark numbers.

**Interfaces:** Keep `RoadView.update(road,sMin,sMax,ox,oz): void` and `PlayerView.dispose(): void`. Cache road identity/version, index range and origin for RoadView scheduling; version/range changes reconcile chunks and origin-only changes reposition all live chunks. Empty-road transitions must be handled safely. Track only the privately created shadow geometry for disposal; never dispose imported/shared geometry.

- [ ] **Step 1 — Write failing tests.** Same range/version/origin performs no redundant reconciliation/position writes and preserves every geometry/material/transform. Moving origin updates all transforms, moving range builds/recycles correct chunks, replacement Road with equal indexes invalidates cache, teleport/negative lap and empty state do not leave stale views. Private shadow geometry disposes once and shared car geometry never does.
- [ ] **Step 2 — Run red.** `npx vitest run tests/roadViewScheduling.test.ts tests/playerViewDisposal.test.ts`; old implementation fails scheduling/ownership assertions.
- [ ] **Step 3 — Implement only confirmed redundant work and leak fixes.** Early-return when all scheduling inputs match; do not skip origin rebase or a changed road. Keep public output/buffers and draw budgets unchanged. Dispose private shadow geometry once in `PlayerView.dispose` without changing builder geometry/material logic.
- [ ] **Step 3a — Confirmed renderer repairs.** Use baseline-render-review.md R01–R05 as reproducible mechanisms, with separate RED/GREEN gates: keep the transform/light root active and hide only owned car visuals in bumper mode; attenuate additive pool/spark contribution to zero in fog without fog-colour injection; skip unchanged empty tyre-pool uploads/draws without changing allocated capacities, active effect bytes/lifetimes or detail; share one transform attribute within each traffic type/LOD batch without cross-batch/view sharing or premature buffer disposal; dispose temporary PMREM room resources after capture while retaining its output. Keep each repair scoped, protect authored visibility/beam poses, full/empty/rebase transitions and resource lifetimes. Tests intentionally requiring redundant dirty/version increments may change only those expectations, not CPU/GPU visual-state comparisons. The suspected tyre-effect fog policy S01 is report-only unless separately confirmed. Preserve Task 4 camera readiness, refreshing first-transition call-count evidence after the headlight fix.
- [ ] **Step 4 — Run green/equivalence.** Run new suites, `tests/miamiVisuals.test.ts`, `tests/renderOptimization.test.ts`, `tests/unchangedCars.test.ts` and `tests/frozenPhysics.test.ts`. Compare output hashes/buffers/transforms through identical routes, rebases, teleports and road replacement.
- [ ] **Step 5 — Measure.** `npx tsx scripts/roadViewPerfcheck.ts` alternates reference/current updates over the same prebuilt scene with warmup and at least nine trials; report median CPU time for steady-state and origin/range changes. Do not label isolated CPU timing as whole-game FPS. If measured benefit is absent, keep only justified correctness fixes and report it.
- [ ] **Step 6 — Checkpoint.** `perf: avoid redundant road view updates and release private shadows`.

### Task 8: Independent project review, integration and final evidence

**Files:** Create `tests/upgrade.browser.mjs`, `docs/reviews/2026-11-13-miami-upgrade.md`; update `README.md`, `docs/{mobile-miami-upgrade,admin-settings-radio,performance,performance-loading,deploy}.md`, existing integrated browser assertions and this plan.

**Interfaces:** Reuse `window.__game` dev hook, existing real temporary-server startup and `PLAYWRIGHT_MODULE` support. The acceptance script supports a base URL, explicit output directory and externally started isolated servers. Do not change package dependencies just to duplicate a working external Playwright installation.

**Confirmed audit repair boundaries:** After renderer/admin owners finish, a focused integration repair checkpoint may modify `src/online/gameServer.ts`/`server/main.ts` for exactly-once explicit-leave/shutdown run finalization, `server/api.ts` for bounded aggregate admission/cache of public leaderboard reads without altered rankings/history, `src/sim/scoring.ts` for prefix-preserving bookkeeping growth, `scripts/netcheck.ts` plus a small headless collection helper for truthful correction-event sampling, and deployment workflow/templates for the main-ref guard and exact proxy-header/trust contract. Each needs a focused regression, RED/GREEN evidence and independent scoped review before browser/documentation acceptance. Do not change protected physics/contact equations or scoring formulas. Baseline wreck re-hit episode policy and finite-showcase stopping behavior are explicitly deferred existing defects: they are outside the new closed Miami/admin/readiness acceptance and require separate policy-focused follow-up, not silent omission.

- [ ] **Step 1 — Review by independent scopes.** Fresh read-only reviewers cover (a) graphics/resources/quality, (b) menu/input/preparation, (c) network/admin/security, (d) simulation/tests/deployment. Record file/line, reproduction, severity, confirmed vs suspected, proposed repair, and frozen/report-only cases. Do not turn style preferences into project-wide rewrites.
- [ ] **Step 2 — Add regression tests before confirmed material repairs.** Keep each review fix scoped and rerun its red/green gate; never recapture hashes or relax timeout/security assertions to hide a failure. Changes expanding the approved behavior require a user decision rather than silent implementation.
- [ ] **Step 3 — Build browser evidence.** Real user input chooses map/mode/car and starts once; no socket before start; selected car is attached/prepared; return/reselect reuses resources; check both online maps, mobile 390×844 and 844×390, desktop 1280×800, chase and cockpit, seam and district boundaries. One central admin login covers switching, offline target, stale responses, logout, uploads and wrong-map prevention. Screenshots are inspected, not treated as automatic visual-quality proof.
- [ ] **Step 4 — Run full gates.** `npm test`, `npm run typecheck`, `npm run build`, `npm run build:server`, `npm run perfcheck`, `npm run perfcheck:r34`, existing map-aware real-server smoke and the relevant browser suites. Use test-only databases/radio and clean up only resources created for this task. Confirm `git diff --check`.
- [ ] **Step 5 — Document evidence and limits.** Report baseline vs final counts/timings, image comparisons, new Miami revision, unchanged protocol/Highway/physics, unified-auth configuration, retained records and no rollout performed. Separate SwiftShader captures from real-GPU/physical-phone claims; list unresolved review findings and meaningful next priorities.
- [ ] **Step 6 — Final branch review/checkpoint.** Independent whole-change review, address confirmed blockers and rerun affected gates. Per the user's added instruction, then integrate the accepted result into main, create the final main commit and verify the documented automatic deployment/health of both maps. Preserve unrelated work, never force-push or destroy existing data, and distinguish local acceptance from an actually verified rollout.

## Plan self-review

- [x] Spec coverage: route/visuals Tasks 1–2; small menu Task 3; advance GPU readiness Task 4; unified auth Tasks 5–6; measured optimization Task 7; project review, actual evidence and roadmap Task 8.
- [x] Interfaces: `miamiDistrict` is defined before use; existing car and road public signatures remain; shared admin token and central login endpoints are defined once.
- [x] Review Focus: each of five risk classes has its owning task and explicit tests.
- [x] Proportion: exact route mathematics and trust boundaries are fixed; scenery composition within budgets and ordinary implementation bodies are left to the builder.
- [x] Checkpoints are limited to owned changes and the chosen isolated execution workflow; the user's later conditional main/deployment authorization is restricted to final acceptance and controller execution.
