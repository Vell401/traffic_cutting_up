# Mobile / Miami upgrade and independent review

Working branch: `feat/mobile-miami-audio-review`, based on colleague checkpoint
`4d10523`. After local acceptance, the user authorized committing and publishing
this feature branch. That authorization does not include merging into `main` or
deploying to production; the validation below remains local.

## Feature acceptance

- Phone-only driving controls, multitouch cancellation/release, portrait/landscape
  menus and native fullscreen: Edge checks at 390×844, 844×390 and 1024×768.
- Smaller ESC/resume card; desktop controls and C63 W204 retained.
- Read-only per-wheel slip feedback, independent wheel phases, pooled smoke/skids,
  slip-driven stereo tyre audio and three geometry-blended tunnel impulse banks.
- R34 defaults only: front grip 1.22, rear grip 1.07, longitudinal grip 1.10.
  Identical lift-recovery test: lateral travel 8.73 → 6.65 m; recovery 2.12 → 1.89 s.
  After this requested change, all vehicle physics are frozen by
  `tests/frozenPhysics.test.ts`; the checkpoint must not be recaptured to pass fixes.
- Independent highway and Miami worlds/databases/radio libraries. Miami is a real
  12 km four-quarter coastal ring, with its own spawn and night rendering theme.
- Six stable-mounted admin tabs, instance-specific login/routing and authoritative
  map-identity guard before moderation, tuning or upload actions.
- Both built-server smokes through `/ws` and `/miami/ws`: two actual clients per
  map, movement/mutual visibility and 0.0 cm maximum correction in that scenario.
- Integrated Edge checks cover both online maps, pause, admin login, keyboard tabs,
  dirty-field preservation and blocking a deliberately wrong-map admin response.

Reproduction: `tests/mobile.browser.mjs`, `tests/features.browser.mjs`,
`tests/remoteWheelNetwork.test.ts`, and the map-aware built smoke CLI. Browser
scripts use an external Playwright installation configured by `PLAYWRIGHT_MODULE`.
Screenshots are opt-in with `FEATURE_SCREENSHOTS=1`; they are not test assertions.

After the network/security fixes, rebuilt-server six-second smokes passed again:
Highway maximum correction .6 cm, Miami .0 cm. Independent 60-second-per-case
netchecks covered nine latency/jitter/stall/20–60 FPS/contact scenarios on each
map. Highway stalled-150-ms maximum was .632 m; Miami was 2.389 m. These are
scenario-specific measurements, not a universal reconciliation bound; the older
2.639 m stress result remains a documented limitation.

## Review scope and fix budget

Independent read-only reviewers covered server/security; network/maps/replay;
UI/admin/input; all rendering/audio; and remaining simulation, tools and deployment.
A separate auditor reconciled every tracked Markdown file. Separate optimization
agents are **not** counted as bug-fix agents.

Twenty `problem` findings were each assigned to a separate confirmation/fix agent:

| ID | Confirmed problem | Repair scope |
| --- | --- | --- |
| P01 | Expired-slot/new-ID reconnect resets the adopted input sequence | Client welcome/reset lifecycle |
| P02 | History overflow rewinds sequence and stalls input transmission | Client backlog recovery |
| P03 | Docker test context excludes workflow fixtures read by tests | Filtered build context |
| P04 | Image rollback leaves revision-4 tuning incompatible with old image | Settings-only deployment backup/restore |
| P05 | Strict systemd sandbox cannot write default DB/radio location | Explicit private state/log directories |
| P06 | Fractional HTTP SQLite LIMIT can terminate the server | Bounded integer query parsing |
| P07 | Invalid HTTP request target throws before authentication | Narrow request-target validation |
| P08 | Input pacing allows sustained accelerated authoritative stepping | Network admission/time credit |
| P09 | Respawn floods amplify into broadcasts and empty run events | Control-action admission |
| P10 | Unhandshaken WebSockets have no independent bound or expiry | Pending-connection admission/deadline |
| P11 | Untrusted forwarded headers spoof rate-limit/ban identity | Explicit trusted-proxy resolution |
| P12 | Solo writes have no instance-wide rate ceiling | Aggregate write admission |
| P13 | Permanent driver removal loses the current online run | Exactly-once finalization |
| P14 | Optional W204 model failure blocks unrelated online startup | Model warm-up rejection/retry lifecycle |
| P15 | Porsche sampled audio cannot recover after transient failure | Engine initialization retry |
| P16 | Slow polling responses never initialize the admin dashboard | Coalesced state polling |
| P17 | Earlier save completion erases a newer tuning/traffic draft | Versioned form dirtiness |
| P18 | Native map-select keys also trigger game controls | Picker keyboard isolation |
| P19 | Invisible mixer remains focusable and captures driving keys | Hidden-control focus lifecycle |
| P20 | Default unrestricted test workers overload asset decoding and intermittently fail the test gate | Bounded test-runner parallelism, unchanged tests/timeouts |

P01–P20 have completed confirmation/repair handoffs. P14 additionally verifies
selected-model failure → explicit reload/retry → attached car → online join;
optional Porsche/A45/W204 failures do not block an R34 session. Original model
builder hashes and frozen vehicle physics remain unchanged. P20 caps test workers
at two with isolation preserved. The original 5,000 ms asset timeout, decoding and
all assertions remain unchanged; the uncapped failure was reproduced at 5,182 ms,
while the controlled two-worker decode completed in 2,655 ms. Two agent runs and
the independent coordinator run of plain `npm test` passed.
Budget: **20 of 20 fix agents assigned**. Minor findings are deliberately not swept
into unrelated repairs. Any additional material issue requires explicit tracking.

## Final independent validation

- Plain `npm test`: **83 files passed; 866 tests passed, one skipped** in 38.18 s.
  The skip is unavailable native Linux/systemd verification, not a failing case.
- `npm run typecheck`, `npm run build`, `npm run build:server`: passed.
- Final integrated Edge run: both actual online maps, Miami phone/W204 controls,
  pause, instance-scoped admin login, keyboard tabs, dirty forms, real per-map
  radio uploads continuing across tab changes, and wrong-map mutation blocking.
- Final mobile suite: 390×844, 844×390, 1024×768, desktop; actual native fullscreen
  gesture succeeded, with no browser runtime errors.
- Rebuilt two-instance prefixed smokes and 18 sixty-second network scenarios
  completed; correction limitations are reported above rather than suppressed.
- Independent CPU benchmarks reproduced both optimizations; output-equivalence,
  frozen-physics and protected model/hash checks passed.
- Compose config, Bash syntax and tracked whitespace checks passed. Container
  runtime and native systemd execution remain unavailable.

No assigned `problem` remains open; none was left beyond the 20-agent cap. The
thirteen `smallproblem` findings below remain intentionally unfixed. This is not
a claim that the project has no other bugs or operational risks.

## `smallproblem` — reported, not automatically repaired

1. Cosmetic body changes on reconnect are absent from replay journals;
   `src/online/gameServer.ts`, `src/online/world.ts`.
2. Netsim can deliver queued messages from dropped/replaced connections;
   `tests/netsim.ts`. Production Link closes its old socket instead.
3. Fresh W204 authoring rebuild does not create missing temporary parent
   directories; `scripts/prepare-w204.py`.
4. Frozen physics, **report only**: manual shift timers are decremented twice in
   shared/legacy step paths. Measured completion: Grip .075 s vs .140 configured,
   A45 .083/.150, Porsche .050/.085, W204 .100/.180. No solver changes authorized.
5. Admin login limiter does not prune expired address entries;
   `server/admin.ts`.
6. SQLite ASCII `lower()` does not merge Cyrillic case variants such as
   `Кира` / `кира`; `server/store.ts`.
7. Log CLI without explicit DB_PATH ignores Miami's map-specific default;
   `server/logs.ts`.
8. Paused barrier scraping can emit a spark at dt=0; `src/render/view.ts`.
9. Tunnel decal index capacity silently drops exit/niche triangles after light
   bands consume the budget; `src/render/roadView.ts`, `meshBuilder.ts`.
10. Per-car shadow geometry is not disposed with its private materials;
    `src/render/playerView.ts`.
11. Stale leaderboard responses can replace the current name's rank;
    `src/ui/leaderboard.ts`.
12. Fullscreen rejection text promises a compact `.immersive` mode that has no
    corresponding CSS rule; `src/ui/fullscreen.ts`.
13. The older optional admin browser suite reads obsolete `tcu.admin` tokens
    rather than instance-scoped keys; `tests/adminClient.browser.mjs`. The current
    integrated browser suite uses the actual scoped login flow instead.

## Measured optimization — no graphics/physics reduction

Skid transform matrices are cached while a slot and floating origin remain
unchanged. Fade, upload and smoke work is preserved. Equivalence tests compare
every state/GPU buffer byte across 2,700 frames, slot reuse, expiry, invalid/zero
dt and origin shifts. Tradeoff: 1,536 additional CPU bytes per effect instance.
Budgets remain 240 smoke billboards, 1,536 skids, two draws and 3,552 triangles.

Independent coordinator rerun, alternating A/B, nine trials, 600 frames/trial:

| CPU workload | Original median | Optimized median |
| --- | ---: | ---: |
| 384 resident skids | 78.99 µs/frame | 14.38 µs/frame |
| 1,536 resident skids | 286.79 µs/frame | 26.67 µs/frame |
| Full pool with continuous emission | 176.25 µs/frame | 27.95 µs/frame |

Machine contention changes absolute timings. These are isolated CPU measurements,
**not whole-game FPS**. Idle performance has no established meaningful win.
Reproduce with `npx tsx scripts/renderPerfcheck.ts`.

The traffic record encoder performs one capacity check/cursor update rather than
16 scalar writes, retaining the exact 26-byte representation. No new caches,
per-record allocations, selection changes or socket-copy ownership changes.
Independent coordinator rerun, 1.5-second warmup and 11 trials per encoder:

| Complete snapshot fan-out | Original median | Optimized median |
| --- | ---: | ---: |
| Two players, 80–86 NPCs | .02012 ms | .00869 ms |
| 32 players, 1,200 NPCs | 1.53055 ms | 1.05953 ms |

High-load median improved 30.8%; 30 Hz fan-out CPU cost 45.92 → 31.79 ms/second.
Both runs produced matching byte totals and checksums. Tests additionally verify
byte-identical snapshots, both-map replay, boundary rounding and buffer ownership.
Reproduce with `npx tsx scripts/serverPerfcheck.ts --reference` and
`npx tsx scripts/serverPerfcheck.ts`. This excludes simulation/network I/O.

## Operational and measurement limits

- Docker Compose config is checked; no Docker daemon/Caddy container runtime or
  remote deployment was available. Linux/systemd runtime is not exercised here.
- Physical iOS/Android fullscreen and human audio audition remain unverified.
- Miami artwork and tyre-effect budgets have isolated software-renderer captures;
  they do not establish physical-device GPU frame rates.
- Known 150 ms stalled-contact stress can reach 2.639 m reconciliation despite
  bit-exact replay. The short smoke's 0 cm result does not erase that limitation.
- Vehicle/audio provenance manifests are not proof of redistribution permission;
  imported-asset permissions still require operator verification.
- Rate limiting bounds write rate, not lifetime database size. No existing runs,
  colleague assets or custom physics settings may be deleted as an optimization.
