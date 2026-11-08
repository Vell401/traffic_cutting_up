# R34 casual drift physics

`src/sim/vehicleR34.ts` exports `R34Car`, `R34Tune` and the independently mutable
`r34Tune`. `R34Car` extends `PlayerCar`, **not** `DriftCar`, and retains physics ID 2.
It neither imports nor mutates the A45/Porsche models or their tunes.

## Integration contract

- Factory ID 2 → `new R34Car()`; tuning registry ID `2` → `r34Tune`.
- `saveState` / `loadState` use **34 Float64 values**, support offsets and work with
  the existing ≤64-value prediction buffer. The first 28 values retain the base
  order. Extra values: rear breakaway, manual mode, blinker, refused shift,
  handbrake and horn. This is a new ID-2 state layout; do not restore old V8 states.
- The inherited reverse, steering ramp, boost, manual-shift validation, footprint,
  road-velocity setters and wall contact/cooldown helpers retain their contracts.
  One reverse-to-first shift request is consumed once, not applied again as an upshift.
- Existing curated global fields are present. Power/torque/efficiency/longitudinal
  grip control acceleration; mass and drag affect resistance; brake distribution
  affects reattachment while braking; front-drive share, TC and LSD affect rear
  breakaway; ESP supplies the outer-envelope restoring moment. Defaults are RWD.
- `yawAssist`, `tireB` and `tireC` remain structural `CarTune` compatibility fields;
  this model uses `yawResponse` and a reduced-order rear-tyre curve instead.

Suggested R34-only panel ranges (no changes to other cars' panel values):

`counterSteer` also exists on legacy `DriftTune`: gate these added controls by car
ID, rather than adding every numerically matching field to A45/Porsche schemas.

| Field | Default | Suggested range | Meaning |
| --- | ---: | ---: | --- |
| `driftAngle` | .61 rad | .3–.8 | Full-power rear-slip equilibrium before other grip/control effects |
| `driftBuild` | 1.6 /s | .6–3 | Breakaway and powered rear-moment response |
| `driftRecover` | 2.6 /s | 1–5 | Progressive tyre reattachment on lift/braking |
| `counterSteer` | .85 rad/s | .35–1.5 | Opposite steering's rear-slip authority |
| `yawResponse` | 9 /s | 4–16 | Body yaw response |

## Handling

Steer and hold throttle to break the rear loose above roughly 35–55 km/h, or use
a brief handbrake pull for a faster entry. Small countersteer corrections chiefly
place the trajectory; committed opposite steering recovers or transitions. More
gas sustains more angle. Lifting progressively reconnects the rear tyres. Zero
wheel input always means zero steering angle.

The reduced-order bicycle evolves speed, yaw and velocity-derived rear slip
separately, with a saturating rear moment and bounded lateral impulse. There is
no stored drift direction, target road heading, automatic lane keeping, random
spin, or handbrake direction chosen without steering/yaw. Road curvature only
appears in Frenet-coordinate integration. It is an intentionally forgiving game
model, not a physical four-contact tyre simulation.

## Measured defaults

120 Hz, starting at 90 km/h unless noted:

- Full steering + throttle: **19° at 1 s, 28° at 1.5 s, 32° at 2 s**, then a
  bounded sustained slide in the low/mid thirties.
- A .375 s handbrake entry: **27° at .5 s** instead of 6° without handbrake.
- After entry, two seconds with centered wheel: **18° / 25° / 33°** at
  .55 / .7 / 1 throttle. At .35 throttle it regrips below 1°.
- Lift from 32°: **4.2° after 1 s, .33° after 2 s, .024° after 3 s**, without
  pulling the exit heading back toward the road.
- Full opposite steering: crosses zero in about 1 s; reaches the opposite **30°**
  slide in about 2 s. Small opposite input can hold a lower angle instead.
- A test driver using only left/right/released keyboard keys holds **21–29°**
  for six seconds after entry on the actual straight highway, inside **4.7 m**
  lateral offset over **252 m**, accelerating from 90 to **172 km/h**, without
  barrier contacts, rebasing, or physics-state edits. The same
  entry with no corrections hits the barrier: there is no trajectory autopilot.
- At 220 km/h, short keyboard taps settle without sustained rear slip.
- Straight-line 0–100 km/h: **5.5 s**; 0–200: **14.1 s**; unboosted top speed
  settles around **285 km/h**. Braking 100–0 km/h takes **30.9 m / 2.24 s**.

`tests/r34Driving.test.ts` covers actual trajectories, both slide directions,
transitions, real highway keyboard balance, gas/countersteer/lift/handbrake,
analog/direct input, reverse/manual gears/boost/cosmetics, barrier cooldowns,
collision impulses, 12,000 mixed variable-step frames, step-rate convergence,
offset serialization and exact replay. It also compares every serialized A45
and Porsche float over 1,200-step golden trajectories captured on main
`7a9a0c2`, including after live changes to the R34 tune.

## Collision / prediction robustness

Rear-slip sustain requires an **already released rear axle**. Lateral slip caused
by a collision is not evidence of powered wheelspin: it must not open gripped
rear tyres on its own. Steering + power and handbrake initiation remain unchanged;
an existing driver-initiated drift still sustains. This uses the existing serialized
`rearRelease` history, not a contact flag, prediction-only exception or new state.
It does not clamp/delete collision velocity or angular impulses.

Headless reproduction: `NetSession(9)`, R34 body/physics 2, 60 fps, both links
`link(75, 40, .01)`, reckless 220 km/h/no weaving, 60 s. Before the fix, a predicted
contact at 35.568 s reduced forward speed **60.60 → 37.63 m/s** and kicked yaw
**.047 → 10.114 rad/s** while the authoritative car only received a small overlap
separation. The speculative slip then manufactured power-sustain history from
zero. Worst reconciliation was **6.446 m / .832 rad**. Most of that positional
error was longitudinal (**6.408 m**), so not all uncertainty was drift amplification.

After gating sustain, the same full session measures **.761 m / .508 rad** maximum
correction (no stalls: **.189 m**). Six seeds, 4/5/9/11/21/42, with stalls range
**.465–.783 m**; all journals replay exactly. Changing post-impact handling changes
the bot's later inputs/contact timings, so these are whole-session results, not a
claim that the same speculative linear impulse can be made authoritative.

An isolated replay of the identical 10.114 rad/s yaw impulse confirms the local
mechanism independently: before, it creates `rearRelease=.909` and remains at
**32.7° after 2 s** with centered steering/full throttle. After, `rearRelease`
stays zero and slip recovers to **.49° after 2 s**. Initial impact rotation remains
visible (peak **42.3°**, yaw still above **9 rad/s** after the first step); modest
impulses are bit-identical to their former response. Remaining speculative-contact
corrections cannot be removed without changing collision prediction or suppressing
legitimate contact impulses, neither of which this R34-only fix does.

## Model and runtime integration

- The runtime R34 uses `r34Exterior.ts` / `r34Materials.ts` and
  `r34Cockpit.ts` / `r34CabinMaterials.ts`, not the retired RHD procedural model.
- Exterior: 340,578 triangles including instanced tyre tread, 27 mesh draws.
  Combined with the cabin: 507,183 triangles / 52 meshes before view culling
  (not counting the simple ground-shadow plane). Pearl paint, carbon, brushed
  metal, rubber and lettering use cached procedural artwork; the largest
  exterior atlas is 1024×1024, not a large uniform texture.
- The cabin has 166,605 triangles, sculpted seats, modeled vents, switches,
  pedals, shifter/handbrake, door trim, analog needles and a small live LCD.
  Driver eye is at `(-.36, 1.08, .7)`, steering wheel at `(-.36, .82, .1)`.
- Static geometry and texture resources are cached. Body paint, lamps and
  ghostable materials belong to individual cars. The 256×128 instrument atlas
  updates at most 12 Hz while visible; the rest of the cabin remains visible
  through the windows in chase view and on remote cars.
- R34 wheels use the actual road-wheel angle locally and over the network;
  A45/Porsche wheel animation paths are unchanged. Protocol version is 9.
- Admin/debug panels expose the five drift parameters above only for R34.
  Persisted pre-rework settings receive a one-time R34-only reset with
  `r34Revision: 1`; custom A45/Porsche/Grip and traffic values remain intact.
  Later restarts preserve the customised new R34 tune too.
- `tests/unchangedCars.test.ts` protects other cars' assets, rendering builders,
  cameras, equations, defaults and sampled trajectories against baseline
  `7a9a0c2`. Integration tests cover factory/tuning, replicated steering,
  externally visible cabin, repaint isolation, ghost restoration and disposal.
