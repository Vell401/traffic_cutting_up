# External foundation of the replacement R34

The previous custom four-contact prototype was rejected. It is not the handling
baseline for this replacement. **Historical publication context:** before user-authorized publication, the branch
was rebased onto `2e1ef96`, retaining the colleague's continuous-slip fix in
addition to the already approved Porsche update. Other vehicles match that
independently captured upstream baseline, not the older `4ed6c0b`.

That rebase note describes the earlier R34 replacement, not a new push/deploy.
The current boundary is the post-grip frozen checkpoint in
`tests/frozenPhysics.test.ts`: the only final authorized physics changes were
R34 `gripFront=1.22`, `gripRear=1.07`, `longGrip=1.10`. All other physics,
including the retained C63/M156 and colleague controls (Shift BOOST / Ctrl
CLUTCH), must remain unchanged; freeze hashes must not be recaptured.

## Project Chrono: tyre forces

- Repository: <https://github.com/projectchrono/chrono>
- Revision: `bdfd07c2edee80361acffbe01df392c36c6d8ef6`
- Original files: `src/chrono_vehicle/wheeled_vehicle/tire/ChTMeasyTire.cpp` and `.h`
- License: BSD-style three-clause text, retained verbatim in
  `third_party/chrono/LICENSE`.
- Original implementation author: Rainer Gericke.

`src/sim/r34/chronoTMeasy.ts` ports the horizontal TMeasy force curve:
load-dependent coefficients, rational adhesion, post-peak parabolas/cubic
fallback, full sliding, combined longitudinal/lateral slip and aligning torque.
The passenger-car coefficient set is derived from `GuessPassCar70Par`.
The R34 adapter calls this core for its actual tyre forces; this is not merely
a reference citation around the rejected sine/arctangent approximation.

This is **not the full Chrono engine** and not Assetto Corsa physics. The road
adapter, driveline, keyboard controls and planar body integration belong to this
game. Full Chrono vertical suspension, terrain contacts, camber dynamics and its
low-speed bristle state are outside this port. The passenger-car coefficients
are a starting model, not measured R34 drift-tyre data.

## Sketchbook: keyboard steering

- Repository: <https://github.com/swift502/Sketchbook>
- Revision: `62f4b7986fd1ce1e4f91daba89ef032c20a6ce55`
- License: MIT, copyright 2020 swift502.
- Source: `src/ts/vehicles/Car.ts`, spring simulation helpers and
  `src/ts/core/FunctionLibrary.ts`.

The reusable baseline is its directional steering demand and spring response.
Its release-to-zero behavior needs adaptation for R34 keyboard countersteering;
air-control and direct body-state edits are not incorporated. Steering assistance
must act through the front wheels, not overwrite heading or body velocity.

## Reproducibility and distribution

Unmodified source copies and SHA-256 manifests live in `third_party/chrono/` and
`third_party/sketchbook/`. `public/THIRD_PARTY_LICENSES.txt` carries both licenses
into the browser distribution. No runtime dependency on native/WASM engines is
introduced. **Historical migration:** revision 3 replaced retired R34 presets.
Current settings revision **4** preserves a revision-3 custom preset and updates
each grip field only if it exactly equals its old shipped value (`1.16`, `.93`,
`1.04`). Older revision 1/2 or missing revisions still replace only the retired
R34 preset. Saved values for other cars and traffic survive; missing C63 settings
are added separately. See [admin-settings-radio.md](admin-settings-radio.md).

Force causality and deterministic rewind remain necessary checks, but they do
not prove good keyboard feel. Feel acceptance uses fixed key sequences with
timing variations, separate hold/lift/countersteer cases, and real highway walls.
An external controller targeting a slip angle is not the acceptance driver.

`npm run perfcheck:r34` benchmarks the actual R34 solver with 5/25/50 cars.
The original general `perfcheck` exercises physics ID 1 and is not evidence of
TMeasy performance. The port uses allocation-light scalar derivatives; it does
not replace the upstream curve with an approximate lookup or mutable cache.
