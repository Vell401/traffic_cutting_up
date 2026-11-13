# Miami/menu/admin upgrade — local acceptance, 13 November 2026

## Outcome and release boundary

Implementation through Task8A is approved; this checkpoint adds permanent integration coverage and reconciles the operational documentation. **Production rollout is pending**, not certified by local tests. The controller's read-only PRE-UPGRADE check found `b9c7a06` on the site, Highway and Miami and successful Deploy **43089599677**. That is the old deployment, not evidence that this upgrade shipped. Fresh whole-change review must precede controller-only main integration and verification of automatic deployment. No push, deployment, Actions dispatch, runner registration or production API writes were performed here.

Miami is now **revision2 / `5d573e53`**, Highway stays **revision1 / `766e63c6`**, both 12 km and protocol **13**. Miami replaces the repeated-quarter profile with two authored 6-km halves, smooth curvature transitions, bridges, tunnel and four district compositions. Highway geometry is retained. Vehicle physics, supplied presets, protected models/builders and their hash expectations remain frozen. Historical records are retained: no seasons/wipe/migration of scores, and no promise that old/new Miami results are comparable.

## Acceptance evidence and scope

Runtime: Windows, Node **24.13.0**, external Playwright, installed Edge/ANGLE **SwiftShader**. These are local software-renderer and CPU checks, not physical-GPU/phone/VPS/Node22/TLS performance certification. No dependencies were added. All datasets/passwords are synthetic and isolated under `C:/Users/sosi/AppData/Local/Temp/opencode/miami-upgrade-task8`.

| Gate | Current result / evidence |
| --- | --- |
| `npm test` | Final-fix refresh: **117 files, 1294 passed, 1 existing skipped**, 53.62s (prior Task8:116/1273/1); baseline SQLite ExperimentalWarnings and Linux-only native systemd skip retained |
| `npm run typecheck` | Client and server pass |
| `npm run build`, `npm run build:server` | Pass, 422 client / 50 server modules |
| `npm run perfcheck`, `npm run perfcheck:r34` | Pass; CPU-only figures in [performance.md](../performance.md), not GPU/network/VPS capacity |
| Both-map `netcheck -- 20` | Nine cases each; stalled Highway count16, p50/p95/max **15.1/63.2/63.2 cm**; Miami count28, **7.4/63.1/63.2 cm** |
| Built-server smoke | Three clients/world, 10s, real `/ws` **and** `/miami/ws` via existing Vite15174 proxy; both pass, see two peers and move 183–293m |
| New `upgrade.browser.mjs` | Pass on implementation `4e24cef` plus the owned browser-test changes; source fingerprint and coverage below |
| Updated `features.browser.mjs` | Pass: both online worlds, pause, touch, drafts, real target uploads and wrong-map blocking |
| Existing admin/mobile suites | Pass on fresh built-server fixtures: stale/current401, filters, drafts/uploads, 320/390px admin; phone390/844/tablet1024, native touch capture/cancel, desktop keyboard/pause/W204 |

The short synthetic netcheck/smoke does not supersede the historical **2.639m** stalled-contact observation or establish a universal correction ceiling. Old tables are deliberately retained, not silently relabelled as current all-event measurements. New count/max include every receive-boundary event; above **16384** events, p50/p95 are explicitly sampled reservoir estimates.

New-harness acceptance source: commit **`4e24cefd5081a7ac03e97df595cfd66c5c809c80`** plus the two owned `.browser.mjs` changes; **295** tracked/untracked non-ignored files under src/server/scripts/tests, SHA256 **`70d92b3a796b915cb69cf260ab7dc868266fe64405457b40b83e50c8a9159834`** (sorted path + NUL + complete bytes + NUL). Before/after fingerprints matched. Evidence: `C:/Users/sosi/AppData/Local/Temp/opencode/miami-upgrade-task8/browser-1794542486284/upgrade/{result.json,*.png}`. Production src/server/scripts had no working diff from that implementation commit. Documentation summaries were finalized afterward; this is not a claim that a later checkpoint commit itself ran under its eventual commit ID.

Companion logs: `browser-1794542486284/features.log` and fresh-fixture `browser-1794542854364/{adminClient.log,mobile.log,commands.json}` under the same evidence root. The initial combined admin run correctly found the reconnect test's client log, contradicting its empty-log fixture assumption; rerunning against a fresh pair passed without changing that assertion. Earlier new-harness fixture/interception-order failures are retained in the Task8B execution report, not omitted or called production repairs. All owned backend/browser children were stopped; only pre-existing Vite15174/PID41452 remained listening.

### Permanent integration coverage

`tests/upgrade.browser.mjs` asserts zero game WebSockets while choosing actual maps/modes/cars, native focused Enter/Space, one explicit start on each map, revision/hash identity, movement, a second real WS peer, same-slot reconnect, and resident renderer/selected-view reuse across menu return/restart. It captures desktop1280×800, Miami touch390×844 and844×390 (including pointer cancellation), and clean fixed-pose district/seam framebuffers at s=850/3800/6100/8600/11990/12010. Fixed visual evidence uses **Medium/DPR1** and the normal chase rig; only existing adaptive-resolution observation is disabled externally for controlled captures. This is not a new optimization or a reduced-quality performance claim.

All twelve new PNGs were inspected at full size: no loading/menu/debug obstruction or black world; roads, district silhouettes, headlights, touch controls and separate target boards are present. Traffic can partially overlap the ghost car/teleported solo fixture (not a collision gate); the marina remains distant. The Miami desktop HUD even shows **3470ms** ping in this software-renderer run: functional assertions are not low-latency/smooth-driving acceptance or proof of external network RTT. No image is used as a physical-GPU/FPS benchmark.

The same harness logs in **once** through `/api/admin/login`, switches Miami→Highway→Miami in the same document/token, checks independent traffic/radio/board data, same-map drafts and pending file retention, dirty/upload switch refusal, real target-specific WAV uploads, cancellation and central logout. `tests/features.browser.mjs` retains its prior online/pause/touch/draft/upload/wrong-map assertions with corrected central Miami paths. Existing `tests/adminClient.browser.mjs` and `tests/mobile.browser.mjs` remain separate regressions, not part of `npm test`.

Adversarial admin details are reused from the accepted **Task6 real-server Edge proof**, not falsely claimed as newly repeated by every ordinary integration run: delayed real old-target200/401, accepted-switch XHR abort, wrong-map mutation blocking, physically stopped/restarted Miami503 recovery, and actual12h expiry branch via external +13h backend clock fixture. Evidence: `miami-upgrade-task6/run-1794537326359/{result.json,history-proof.json,network.jsonl}` under the same Temp/opencode parent. Expiry was not twelve wall-clock hours of waiting. Production-entry unit tests in the current full suite retain the stale/expiry/security assertions. Picker switches replace history; native Back leaves admin and Forward returns to the latest deep link, not an old target URL.

### Prior renderer/readiness evidence (not rerun blindly)

- Task7 is the current renderer tree: `1556543`, content fingerprint `c1e18ebdddce1761339734835e7aa181e287539ef2e2a6e8589c63d203c4ecb1`, artifacts `miami-upgrade-task7/browser-results.json`, twenty `car-*-first-*.png`, `gpu-fog.json`, `remote-final.json`. All four selected cars/cockpits and all five first cameras had zero additional instrumented compile/static-upload entrypoints. Bumper retained both beams with no own visual meshes. Actual additive pool/spark draws tend to background at full fog, rather than adding fog colour. These **R01/R02 are correctness/appearance changes**, not old/new visual equivalence.
- Task4's decoder/cache proof at `70a782c` measured three GLTF parses/requests for the three imported models; all four cached roots and geometry/material/texture identities survived return with no repeat decode/request. Task7 reaffirmed current camera/cache preparation entrypoints. Old exact-HEAD Task4 scripts were not invoked unchanged against the newer bumper semantics.
- Current Task7 lazy-remote preparation took **67864.3ms** under SwiftShader; individual `initTexture` up to **3370.6ms**, warm draw **2927.5ms**, sampled rAF p95/max **1721.4/2485.2ms**. Task4 also observed multisecond cockpit submission despite zero of its four instrumented counters. Selected/lazy resources are prepared before reveal, but indivisible upload/draw/driver stalls remain. No zero-lag/FPS/real-GPU claim follows.
- Road scheduling, empty-effect work elimination, shared traffic matrices and private/PMREM disposal have bounded structural tests and tiny alternating CPU evidence. Nine-trial RoadView steady medians fell by about0.00018ms/update; version reconciliation got slower and rebuild results were mixed. No whole-frame speedup is established. Pools/LOD/draw budgets/meaningful texture detail are unchanged.
- Task2's corrected marina proof (`0d8fd2a`) uses stock chase at s6100 and actual deck visibility/projection tests. Earlier occluded/sky-only/overlaid frames remain rejected evidence, not quality gates. The deferred quay-furniture Minor is separate from that repaired dock occlusion.

## Operational changes and audit disposition

One browser session is rooted in Highway. `ADMIN_MIAMI_URL` is a fixed server-configured Miami upstream; `ADMIN_MIAMI_PASSWORD` defaults to `ADMIN_PASSWORD` and must match Miami's own `ADMIN_PASSWORD`. Compose wires `http://game-miami:8787`, separate volumes, and no Miami self-proxy. Browser service credentials are never copied; direct `/miami/api/admin/*` is still authenticated. Highway/auth outage makes the unified admin unavailable; Miami-only outage permits Highway recovery without losing central auth. Full route/deadline/config details: [admin-settings-radio.md](../admin-settings-radio.md).

Original radio limits remain **40MiB/track, 200 tracks/playlist, 30 playlists, 1GiB/library**. After final-review I1, the gateway uses **15s control/health/login** deadlines and a separate **180s absolute upload** deadline at both dispatch and streaming exchange, including setup/downstream delivery. Progress never resets the deadline. Rejected incomplete input retains a short, at-most-1MiB discard; **16KiB** ordinary JSON body and **32MiB** JSON reply bounds remain. Constructor budgets are finite/defaulted/capped; production needs no new env setting. Uploads stream with backpressure/cancellation; no ambiguous-write replay. Admin now receives the same trusted-proxy resolver as API/WS, while safe default/direct socket-only behavior remains. No broad XFF trust; upstream Miami audits see the gateway connection, not an impersonated browser address.

| Audit area | Disposition |
| --- | --- |
| Menu H1/H2, loading/reparenting/focus | Task3 native-control separation and composed loader/lifecycle locks; intentional selected-car loading retained |
| Late failure/retry and upload readiness M1/M2 | Task4 preparation-before-commit/reveal, genuine retry, serialized state restoration; software stalls remain disclosed |
| Admin/proxy identity | Tasks5/6 authenticated fixed-target gateway, shared browser session, stale-work guards; injected trusted resolver and bounded login/session state |
| Renderer R01–R05 / private-shadow leak | Task7 headlight/additive-fog correctness plus scheduling, empty effects, matrix lifetime and disposal; not all visual-equivalent |
| Final run S01/server2 | Task8A exactly-once leave and separate shutdown finalization before Store closure; transient disconnect remains resumable, not crash durability |
| Scorer growth S03 | Task8A copies five bookkeeping prefixes; no repeated split/lost crossing from reserve; formulas unchanged |
| Public read admission/server3 | Six **SELECT-cost reservations** per rolling second, not six wall-clock SQL starts; whole miss-cost reserved, TTL2s, max32 names, bounded/invalidation-correct mode cache. Individual synchronous queries still history-dependent; one Store writer assumed |
| Telemetry S04 | Receive-boundary exact count/max; bounded, labelled sampled percentiles above16384; historical telemetry not rewritten |
| Deploy S06/server4 and proxy templates/server5 | Main-ref job guard before self-hosted steps; preserves historical-main reruns. Systemd trusts actual127.0.0.1; nginx overwrites XFF. External runner/org policy unverified |
| Fresh-host S07 / stale wreck paragraph | Docs now run actual checked-in `bash deploy/runner-register.sh`, not a nonexistent installed helper; wreck lifetime corrected to existing10s, no behavior change |

**Explicitly not repaired:** wreck re-hit/new-run event suppression (simulation S02); finite-showcase stable parking/reverse issue (S05); suspected tyre-effect fog (renderer S01); quay-furniture grounding Minor. Frozen manual-shift double-timer remains **report-only**; no protected hashes/equations recaptured. Other historical limitations/minors remain in [the earlier review](../review-upgrade-report.md): trusted solo scores, unbounded lifetime run history, replay cosmetic identity, netsim queued old-connection delivery, SQLite Cyrillic case handling and map-default log CLI. This checkpoint does not claim to repair them. Radio crash-window/orphan-byte hypothesis remains untested; metadata quota is not a filesystem quota.

## Reproduce safely (external tools/backends)

Use an existing checkout with installed project dependencies, built `dist-server`, an external Playwright module, and locally installed Edge. The harness **does not start servers or install dependencies**. Never target shared databases or production URLs. In this acceptance the pre-existing Vite15174 already proxied Highway18971/Miami18972 and was not stopped/restarted.

Run each backend in its own PowerShell terminal, using a fresh directory each time:

```powershell
# Terminal 1: Miami, built server
$root = Join-Path $env:TEMP ('opencode/miami-upgrade-task8/manual-miami-' + [guid]::NewGuid())
$env:HOST='127.0.0.1'; $env:PORT='18972'; $env:MAP_ID='miami'
$env:DB_PATH="$root/test.db"; $env:RADIO_DIR="$root/radio"
$env:ORIGINS='http://127.0.0.1:15174'; $env:TRUSTED_PROXIES=''
$env:ADMIN_PASSWORD='synthetic-service-only'; $env:ADMIN_MIAMI_URL=''
$env:GIT_SHA='acceptance-miami'; $env:JOURNAL_DIR=''
node dist-server/main.js
```

```powershell
# Terminal 2: Highway, built server; same synthetic service password as Miami
$root = Join-Path $env:TEMP ('opencode/miami-upgrade-task8/manual-highway-' + [guid]::NewGuid())
$env:HOST='127.0.0.1'; $env:PORT='18971'; $env:MAP_ID='highway'
$env:DB_PATH="$root/test.db"; $env:RADIO_DIR="$root/radio"
$env:ORIGINS='http://127.0.0.1:15174'; $env:TRUSTED_PROXIES=''
$env:ADMIN_PASSWORD='synthetic-central-only'
$env:ADMIN_MIAMI_URL='http://127.0.0.1:18972'; $env:ADMIN_MIAMI_PASSWORD='synthetic-service-only'
$env:GIT_SHA='acceptance-highway'; $env:JOURNAL_DIR=''
node dist-server/main.js
```

If not already running Vite, a separate owned terminal can use `GAME_SERVER=http://127.0.0.1:18971` and `GAME_MIAMI_SERVER=http://127.0.0.1:18972` with `npm run dev -- --host 127.0.0.1 --port 15174 --strictPort` (set variables with `$env:` in PowerShell). Do not replace an occupied listener. Keep map-labelled `GIT_SHA` values above: the admin harness verifies target metadata as well as picker state.

```powershell
# Terminal 3, repo root; choose your actual external module/browser paths
$env:PLAYWRIGHT_MODULE='C:/Users/sosi/AppData/Local/Temp/opencode/traffic-browser-check/node_modules/playwright/index.mjs'
$env:UPGRADE_BASE_URL='http://127.0.0.1:15174'
$env:UPGRADE_OUTPUT_DIR=Join-Path $env:TEMP ('opencode/miami-upgrade-task8/manual-proof-' + [guid]::NewGuid())
$env:UPGRADE_ADMIN_PASSWORD='synthetic-central-only'
$env:ADMIN_BASE_URL=$env:UPGRADE_BASE_URL; $env:ADMIN_TEST_PASSWORD=$env:UPGRADE_ADMIN_PASSWORD
$env:ADMIN_PLAYWRIGHT_MODULE=([uri]$env:PLAYWRIGHT_MODULE).AbsoluteUri
$env:ADMIN_BROWSER_EXECUTABLE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
# This suite assumes no client log rows: run first on fresh fixtures, not after reconnect tests.
node tests/adminClient.browser.mjs
node tests/upgrade.browser.mjs
$env:FEATURE_BASE_URL=$env:UPGRADE_BASE_URL; $env:FEATURE_OUTPUT_DIR=$env:UPGRADE_OUTPUT_DIR
$env:FEATURE_ADMIN_PASSWORD=$env:UPGRADE_ADMIN_PASSWORD; $env:FEATURE_SCREENSHOTS='1'
node tests/features.browser.mjs
$env:MOBILE_BASE_URL=$env:UPGRADE_BASE_URL; $env:MOBILE_PROOF_DIR=$env:UPGRADE_OUTPUT_DIR
node tests/mobile.browser.mjs
node dist-server/smoke.js --url ws://127.0.0.1:15174/ws --map highway --origin http://127.0.0.1:15174 --clients 3 --seconds 10
node dist-server/smoke.js --url ws://127.0.0.1:15174/miami/ws --map miami --origin http://127.0.0.1:15174 --clients 3 --seconds 10
```

Run timing/captures sequentially without concurrent full suites/CPU benchmarks. AdminClient's empty-client-log race assertion needs a fresh fixture: if running it after game/reconnect tests, stop only your backends and relaunch the two commands with new GUID directories first; do not delete log rows or weaken its assertion. This acceptance used a separate fresh pair for admin/mobile. The new harness writes `result.json` (commit + complete src/server/scripts/tests content SHA256), PNGs and failure diagnostics. Inspect actual clean PNGs, not only counters. It rejects non-loopback targets. `UPGRADE_BROWSER_EXECUTABLE` optionally overrides installed Edge; `PLAYWRIGHT_MODULE` accepts a local module path. Other suites' tooling contracts remain as documented in their headers. Finally Ctrl+C **only the two backends/optional Vite you started**; retain evidence and synthetic directories for diagnosis, never delete user records. The automated Task8 scratch supervisor tracks and stops only its own children.

## Final-review fix-wave evidence (I1 / M2)

On base `aedfe4cde115c6839fd1154b5e180345151bc402` plus the owned fix, fresh gates passed: **117 files /1294 tests passed /1 baseline skip**, typecheck and both builds. Gateway/auth/deploy/handshake selection: **153 passed /1 skip**. Short-budget regressions distinguish a progressing upload from control timeouts, absolute stalls/overruns, cancellation, early-response drain and downstream delivery; fake-clock tests enforce the180s default/cap without long unit sleeps. The browser's real peer helper now has a15s welcome timer, early-close rejection and once-only cleanup; regression tests exercise that same helper, not a copied implementation.

A fresh Edge UI upload through existing Vite15174 and newly built isolated Highway18971/Miami18972 completed **10MiB in20875ms**, beyond the old15s cutoff. CDP limited the synthetic uplink to512KiB/s;77 target-file observations establish progressive writes, including after15s. Miami's stored track has exactly10485760 bytes and SHA256 `bc2eb79b018bf78881203965aea38dbe233d8b62c2048deab653c6c689700c59`, matching the input. A second native UI transfer was cancelled after540672 bytes reached Miami: `net::ERR_ABORTED`, no `.part` or extra track, Highway's radio remained empty. This is not a production-bandwidth/audio-listening guarantee.

Evidence: `C:/Users/sosi/AppData/Local/Temp/opencode/miami-upgrade-final-fix/browser-1794544966363/progressive-upload.json` and companion logs. Source identity:297 src/server/scripts/tests files, sorted path+NUL+bytes+NUL SHA256 `ad85e5f614b9e54dff64cecff707607eec862ba12a71e2c1d40361d441de0437`, checked unchanged before/after upload acceptance. Old Task8 artifacts are preserved. **M1 quay/furniture grounding is explicitly accepted deferred polish; all other deferrals above remain. Production rollout stays pending**, subject to the controller's scoped final re-review and later authorized integration/verification.

The complete updated `upgrade.browser.mjs` also passed (198003ms), with the same before/after source fingerprint: `browser-1794544966363/upgrade/result.json`, screenshots and `upgrade.log` in that fresh root. Both actual second peers welcomed as distinctid2 with two players; same-slot reconnect and the existing menu/touch/admin switching/upload/cancel assertions remain intact. No new visual/quality audit is claimed. Supervisor exit0 stopped its two owned backends; only the pre-existing Vite15174/PID41452 remained listening.

## Prioritized next steps

1. Fresh whole-change review, then controller-only authorized integration/deployment verification: site/health/API identity and both external map-aware smoke; keep status pending until observed. Separately verify protected runner/org policy and actual Docker/Caddy rollback, not just mocks.
2. Repair wreck re-hit and finite-showcase parking in unfrozen world/controller bookkeeping with regressions; do not alter protected contact/vehicle equations or recapture hashes. Keep manual double-timer report-only unless separately authorized.
3. Profile selected/cockpit/lazy remote on physical GPU, Android/iOS and the actual VPS; measure driver stalls, VRAM, stable-DPR frames and two-world load before making performance claims or changing quality/assets.
4. Measure mature-history SELECT duration and production429/cache invalidation patterns; consider separately reviewed query/storage work if one query exceeds the tick budget, retaining history/ranking/map isolation.
5. Investigate suspected tyre fog and polish quay furniture with clean fixed-pose comparisons; triage the retained historical minors and radio crash-window hypothesis separately.
