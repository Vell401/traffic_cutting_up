# Miami Asset-Based Visual Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Miami's rejected procedural-box appearance with a Blender-authored, PBR coastal environment, verify the actual game appearance, then integrate main and verify deployment.

**Architecture:** Keep the existing Three.js game/simulation and introduce a Miami-only authored-asset world. Load one semantic GLB kit plus self-hosted CC0 textures/HDR under the initial loading overlay, place bounded instanced batches from deterministic canonical descriptors, and preserve the road/network/vehicle/admin contracts.

**Tech Stack:** TypeScript, Three.js r187, Blender4.5LTS/Python authoring, CC0 photo maps/HDR, existing Vite/Vitest/Node/Playwright and deployment.

**Spec:** `docs/superpowers/specs/2026-11-13-miami-assetto-visual-rebuild-design.md` — executor design under user's explicit no-questions mandate, not a separate user aesthetic approval.

## Global Constraints

- Keep12,000m route/collision geometry, spawn300, Miami revision2/hash5d573e53; Highway revision1/hash766e63c6/protocol13 unchanged.
- Protected vehicle equations/presets/models/builders/hash expectations unchanged; no engine temperature/warm-up feature.
- Preserve menu, selected-car and optional-remote preparation, four-car cache, common admin session and independent data/radio/records/security.
- Production Miami must use authored replacement models, not merely add trim/recolour the old boxes. Self-host licensed assets; no live API, paid dependencies or unauthorized Assetto Corsa asset extraction.
- Model pivots bottom-centred/metres/glTFY-up/front-Z. Keep full model bounds outside the protected road corridor; terrain/water/boardwalk contact must be coherent.
- Environment asset payload<=48MiB, sharedtextures<=48, drawbatches<=120, visibleenvironmentinstances<=1800. FixedMedium/DPR1 normal opaque reference whole-frame evidence<=500calls/5million submittedtriangles for allfourcars. Measure/disclose protected-spawn transparentghost transitions separately, preserving original transparency order; no all-density/ghost/preparation FPS guarantee. No quality/DPR/range cuts to pass.
- New Miami asset-layer budget supersedes only old Miami-art caps. Highway/current safety, frozen-source, data/auth and protocol tests are not weakened.
- Workers commit only owned changes, never push/merge/deploy. Controller integrates and verifies final normal deployment after all gates, no force-push/data deletion.

## Review Focus

1. An asset fails/finishes late during retry: no partially ready menu or silently restored rejected scenery (Task2).
2. Fast travel, negative/future laps and floating-origin shifts: coherent deterministic scenery, no drift/stale instances (Task2).
3. Imported material/texture sharing and asset cancellation/disposal: no shared-resource double dispose, cache poisoning or per-frame allocations (Tasks1–2).
4. New lighting/default sky in a saved night/cockpit/bumper choice: readable actual road/cars and no global Highway appearance change (Tasks2–3).
5. Art/detail goals exceed runtime limits: inspect normal-game closeup and moving views at fixed quality, not a standalone Blender render or artificially empty/low-DPR scene (Task3).

## Baseline/setup

- [x] Verify clean original main815a188; no AGENTS.md in relevant root/ancestor/owned directories.
- [x] Create native isolated worktree `miami-assetto-visual-rebuild`; install locked dependencies.
- [x] Full baseline:117files1295passed/1existing platformskip; existing SQLiteExperimentalWarnings retained.
- [x] Verify official portable Blender checksum/version; Blender4.5.9LTS at approved temp `miami-rebuild-tools/blender-4.5.9-windows-x64/blender.exe`, officialZIP SHA25641da973b9bf95bb312cbeff4d1982feb13259b43c821686b9bafea4dfe5477cf.
- [x] Record actual pre-change fixed-pose Miami/Highway pictures and metrics from immutable original815a188; ten captures/metrics retained in approved temp `miami-rebuild-baseline`.

### Task 1: Author and validate the physical asset kit

**Files:** Create `scripts/blender/build_miami.py`, `scripts/miamiAssets.mjs` (download/provenance/validation support), `public/models/miami/coastal-kit.glb`, authoring `.blend` under `assets/miami/`, `public/models/miami/manifest.json`, `public/textures/miami/*`, `docs/assets/miami.md`, `tests/miamiAssets.test.ts`.

**Interfaces:** GLB scene roots contain required named prototypes from the spec, common material slots and physical bounds. Manifest schema1 contains generator/version/source asset URL/license/checksum/dimensions, totalbytes, prototype `{name, bounds:{min:[x,y,z],max:[x,y,z]}, triangles, parts, materials}` and texture entries. Export source blend alongside script for reproducibility. Runtime Task2 consumes manifest/GLB and downloaded files, no Blender dependency on deployment.

- [x] Write asset-contract tests requiring all15 prototype names, nonempty finite geometry/normals/UVs/triangles, metre-scale ground pivots/bounds, material sharing, source/license/checksum coverage and payload bound. No vacuous missing-file-only final gate.
- [x] Observe RED before export; use official verified portable Blender to author physically detailed kit, not names around boxes. Bevel/recess/facade/rails/leaflet/yacht geometry, explicit UV scale, shared PBR materials, optional baked vertex AO.
- [x] Download only needed self-hosted CC0 maps/HDR with identifying User-Agent and recorded authors/checksums; no remote runtime URLs. Keep derived files reproducible/documented.
- [x] Export/inspect Blender asset previews, validate actual GLB with existing GLTFLoader/BufferGeometry utilities and manifest tests. Review model silhouettes, windows/railings, palm feathering, yacht shape and material assignments.
- [x] Run focused new tests, frozen/model tests and typecheck; commit owned source/assets/docs only. Report actual Blender command/version/export statistics and file budget, no claim of game visual acceptance yet.

### Task 2: Replace production Miami's world and lighting

**Files:** Create `src/render/miami/{assets,layout,world,materials,environment}.ts`; modify `src/render/{view,roadView,sky,post,scenery}.ts`, `src/main.ts` environment readiness wiring; new `tests/miami{World,Environment,Loading}.test.ts` and focused affected render/loading fixtures. A measured new-shadow/default-car call-budget failure additionally permits a Miami-only lossless static draw-batching helper and opt-in wiring in `src/render/{playerView,remoteCar}.ts`, with actual model/animation/visibility/material equivalence tests. Do not edit original vehicle builders/models or decimate geometry.

**Interfaces:** `loadMiamiAssets(): Promise<MiamiAssets>` coalesces/retries, parses semantic kit and owns shared resources. `MiamiPlacement` pure data `{prototype,s,d,y,heading,scale}`; `miamiPlacements(index:number): readonly MiamiPlacement[]` canonical modulo120chunks. `MiamiWorld` exposes `group`, `update(road:Road,s:number,ox:number,oz:number,time:number):void`, `dispose():void`; shared batch capacities explicit. `View.prepareEnvironment():Promise<void>` no-op forHighway, loads/attaches/updates/warms required Miami before menu readiness and retries real failed loads.

- [x] Write RED tests for coalescing/retry/late-cancel, named model extraction/shared ownership, placement bounds/grounding across120chunks and laps, same-input no rebuild, origin/road/version/range changes, disposal once and required-load UI not released early.
- [x] Implement loader/pure layout/instanced world using Task1 contract. Populate four materially different dense/near districts and plausible coast; suppress legacy production Miami buildings/palms/boats/props without affecting road/collision/Highway. Correct the existing buried marina furniture by new grounded placements.
- [x] Implement new photo-based road/structural PBR/water, HDR sky/reflections and readable Miami-specific sunset/default grading/lights. Preserve other sky choices and car/highway behavior; reuse existing post architecture, no extra full-screen miracle effects. Bounded local shadows/foliage motion optional only if tested and budgeted.
- [x] Await required environment under existing loader before chosen-car preparation/usable menu; failed required environment offers retry, no optional unrelated-car boot dependency. Warm actual world shader/texture resources so initial driving doesn't do asset decode/upload.
- [x] Run new/affected loading/render/Highway tests, fullsuite once, types/bothbuilds; document intentional replacements of obsolete Miami art assertions and unchanged protected checks. Commit owned code/tests only.
- [x] Check the actual default A45 and every other selected car against whole-frame budgets, not only the R34 reference. If the new sun multiplies imported static-part draws, consolidate only equivalence-safe static draws in a Miami opt-in wrapper: same complete triangle/attribute/material output, independent animated wheel/cockpit/visibility domains, no material merging, geometry simplification or hidden shadow/detail cuts. Prove paint/signals/ghost/camera/steering/spin/suspension/cache/disposal and Highway isolation; optional remotes need the same opted-in policy before reveal.

### Task 3: Actual-game art direction, regression and final evidence

**Files:** Create `tests/miamiRebuild.browser.mjs`, `docs/reviews/2026-11-13-miami-asset-rebuild.md`; refine Task2's Miami-owned art/layout/material values only as actual pictures demonstrate, plus affected visual tests. Reproducible `scripts/blender/build_miami.py`/source blend/GLB/manifest changes are permitted for demonstrated geometry issues and Task1's deferred photo-roughness scalar mismatch; keep schema/provenance/pivot and budget contracts. Update `docs/assets/miami.md`, README and performance/loading docs for the real shipped contract; keep a concise previous815a188 changelog in report.

**Interfaces:** Harness accepts `MIAMI_REBUILD_BASE_URL`, `MIAMI_REBUILD_OUTPUT_DIR`, external `PLAYWRIGHT_MODULE` and installed browser path. Use existing dev hook/test-only fixed-quality control and isolated servers; don't pollute production or generate placeholder renders as game evidence.

- [ ] Capture/inspect matched1280x800MediumDPR1 old/new spawn300/Ocean850/causeway3800/marina6100/downtown8600/tunnel+seam11990/12010; near frontage/palms/boats/shore, cockpit/bumper and phone390x844/844x390. Include normal moving driving frame, actual selected cars/traffic, not empty marketing shots.
- [ ] Reject a result still dominated by flat old boxes, broad solid palm ribbons, floating facade trim, buried props or tiny invisible waterfront detail. Refine in code/source assets with focused tests; re-export from Blender when geometry is the issue. No reduced DPR/quality or hidden old scenery overlap.
- [ ] Verify asset initial failure/retry, no runtime external requests, zero joins before explicitstart, resident menu/car cache, both online worlds/reconnect, admin shared-session and upload regression. Measure calls/triangles/texture/batch/payload/steady allocation budgets; record software-vs-hardware limitations honestly.
- [ ] Full gates: `npm test`, `npm run typecheck`, bothbuilds, bothmap real built-server prefixedsmokes, relevant browser suites and newharness, `git diff --check`. No protected hashes/timeouts/security assertions relaxed. Inspect final PNGs rather than relying on counters.
- [ ] Write actual art/asset/license/evidence/limits/old-changelog/remaining-priority report. Commit owned changes; independent final whole-change review and at most one scoped repair wave before controller release.

## Controller release

- [ ] Review complete result, rerun fresh tests/types/builds on accepted tree; preserve any original user work.
- [ ] Normal main integration/commit/push per explicit user mandate; verify hosted CI, actual deployjob, exactnewSHA on site/Highway/Miami and public API/assets/admin boundary, both external map-aware WSSsmokes.
- [ ] Report actual outcome and remaining visual/hardware limitations, not just functional unit counts. Preserve authored sources/assets/evidence and all recorded executor decisions.

## Self-review

- [x] Spec coverage: Task1 actual licensed authored assets; Task2 complete production replacement/loading; Task3 art/evidence/integration; controller owns authorized rollout.
- [x] Interfaces and ownership are sequential; no concurrent writers or runtime Blender/API dependency.
- [x] Five review risks have focused tests/actual pictures; oldMiami appearance caps are intentionally replaced, not physics/security tests.
- [x] No questions/approval stalls: user's explicit opt-out authorizes executor's approach, with significant art/platform choices stated and recorded.
