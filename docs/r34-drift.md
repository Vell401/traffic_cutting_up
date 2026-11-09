# R34: external tyre and steering foundations

This replaces the rejected custom force-model prototype. The actual force core
is a TypeScript port of **Project Chrono TMeasy**, with **Sketchbook** as the
keyboard steering baseline. Exact source revisions, licenses, and port boundaries
are documented in [r34-foundation.md](r34-foundation.md).

## Current frozen checkpoint

The final authorized physics change was **R34 grip only**:
`gripFront=1.22`, `gripRear=1.07`, `longGrip=1.10`. All vehicle physics,
controllers, shared contacts and shipped presets are now frozen, including C63
(body 4 / physics 5 / M156). Do not recapture `tests/frozenPhysics.test.ts` hashes
to accommodate review or optimization. Shift remains BOOST; Ctrl is CLUTCH.

Settings revision **4** migrates revision 3 field by field: only exact untouched
old grip values `1.16 / .93 / 1.04` become `1.22 / 1.07 / 1.10`. Custom values and
all other R34 fields survive, as do other cars and traffic. Revision 1/2 or an
absent revision replaces the retired R34 preset only. See
[mobile-miami-upgrade.md](mobile-miami-upgrade.md) for integrated usage.

## Responsibilities

- `src/sim/r34/chronoTMeasy.ts`: load-dependent passenger-car tyre coefficients,
  adhesion/post-peak/sliding curves, combined-slip forces and aligning moment.
- `src/sim/r34/sketchbookSteering.ts`: adapted keyboard steering demand and spring
  response. It changes actual steering, not chassis heading or body velocity.
- `src/sim/vehicleR34.ts`: R34-only road/driveline adapter, wheel inertia,
  load transfer, gearing and rigid-body integration.

The model remains planar. It is not the complete Chrono engine, an Assetto Corsa
port, or a measured R34 tyre dataset. It does not add a hidden target slip angle,
road-centering controller or automatic correction of the car's trajectory.

## Input and feedback

Digital steering is separate from direct mouse steering. Manual gears follow
the approved shared sequence `R (0) ↔ N (-1) ↔ 1…6`. Clutch and neutral disconnect
drive torque, including boost; tyre forces still act while coasting. Direction
changes are guarded by total speed, not merely the body-forward velocity.

The imported spring retains its 60 Hz cadence and two cached frames. Key release
disconnects driver pressure; TMeasy aligning moment and mechanical trail then
move an inertial, damped rack. There is no released-key body-slip/yaw target.
The extra steering memory and summed ground moment are serialized: **58 scalars**.

### Historical fixed-input driving examples (before the grip-only increase)

The measurements below document the earlier accepted replacement. They are
retained as colleague notes, not remeasured claims for revision 4. Current tests
in the repository define the frozen-checkpoint regressions; passing them does
not revalidate every old angle, timing or clearance below.

On an unlimited pad, using automatic gears and keyboard mode:

| Initial speed | Hold W + A or D | Then |
|---|---|---|
| 60–80 km/h | about 0.5 s | release steering, keep W, lift to exit |
| 100–120 km/h | about 0.6 s | release steering, keep W, lift to exit |

These are measured examples, not a guaranteed angle for every tap. Shorter
entries can remain shallow; longer held steering can spin. Holding W through
3.5 s in the examples produces a powered slide; lifting then recovers grip.
Countersteer gives additional authority rather than merely duplicating release.
Mouse mode intentionally does not provide the keyboard rack assistant.

Deep pad drifting and a safe highway line are different requirements. A 16 m road
does not permit indefinite sideways travel; neutral steering does not secretly
recenter the road line. No automatic road/path controller is added.

A measured fixed highway example at 90 km/h, starting 4 m opposite the entry:
hold W + A/D for about 0.5 s, pulse Space from 0.20–0.35 s, lift W and countersteer
for 1.6 s, briefly return the original key for 0.2 s, then release. Mirrored
production-keyboard runs with 0.45/0.50/0.55 s entries reached 24.8–28.5° and
stayed wall-free for five seconds, with at least 4.27 m clearance. These timings
describe a reproducible test, not a required rhythm or a road-centering feature.

For R34 only, chase framing blends toward actual travel direction so the chassis
angle remains visible. HUD/instruments use total speed rather than road progress.
Current tyre feedback reads four contact speeds and available actual wheel omega;
wheel rotation, pooled smoke/skids and four local tyre-audio voices follow that
read-only presentation layer. Legacy axle models use axle omega; Grip without
wheel dynamics uses signed rolling fallback, not brake-button lock guesses.
Estimated effect loads are not new physical suspension. These changes add no yaw
or sliding forces. Protocol 12 adds four quantized remote omega values (8 bytes,
scale 16), for a 36-byte remote-driver record; owner rewind remains unchanged.

## Validation and isolation

- `r34TMeasy.test.ts`: independent numerical fixtures from upstream equations,
  both post-peak branches, load interpolation, derivatives, signs and passivity.
- `r34ForceAcceptance.test.ts`: force causality, zero-grip momentum, wheel inertia,
  clutch/neutral, steering, serialization and network replay.
- `r34KeyboardFeel.test.ts`: fixed keyboard scripts, distinct from feedback-driven
  skidpad probes. Highway walls and unlimited-pad handling are separate tests.
- `r34Provenance.test.ts`: pinned upstream source hashes and distributed licenses.
- `unchangedCars.test.ts` / `r34Isolation.test.ts`: approved A45/Porsche files,
  assets, settings and trajectories, plus other-car settings preservation.

All persistent physics/controller memory must fit the existing 64-scalar state
budget and rewind exactly. Numerical tests alone do not prove good driving feel.
Historical acceptance note: after local driving review the user approved this
replacement for publication; the colleague's newer shared-physics changes were
retained separately from R34. This is not a claim that the present Miami/mobile
update has been pushed or deployed.

Network replay correctness does not eliminate collision/pacing corrections.
The measured 150 ms stalled-contact/traffic stress run recorded a **2.639 m** worst reconciliation
(35 cm p95); ordinary cases were substantially smaller. The shared collision
prediction equations remain frozen; map integration does not remove this limit.
Local integrated Edge/smoke checks are not human audio approval, physical-iOS
validation or a Docker/remote deployment.
