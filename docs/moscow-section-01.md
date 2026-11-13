# Moscow section 01 — northbound start reference inventory

## Applied pilot correction

[Top-down runtime schematic](moscow-section-01.svg), including the optional
2,061 m buffer and ramp-width before/after inset. Rebuild with
`npx tsx scripts/render-moscow-section.ts`.

The parent session compared the ramp curvature and its east-side merge on the
satellite overview with the segment-20 frame's mini-map. On that visual alignment,
`data/moscow/manual-edits.json` now sets way **1207836341** to **one lane**.
This is a provisional visual interpretation, not a measured carriageway width or
camera geolocation. Raw OSM data stays unchanged; custom source fixtures do not
receive this default overlay. Mainline remains three lanes, coordinates/heights
and all connections unchanged. The runtime inventory below records the **before**
state (two-lane fallback); the corrected ramp is nominally 6.6 m wide instead of
10.2 m, both including the existing generic shoulders. Curbs, shoulder shape and
the precise merge taper are still unrefined. No satellite pixels are game textures.

## Scope and evidence

Manual-refinement pilot: **0–1,942.3 m** along the stored directed route,
from node **11191288649** to **7566321589**. This ends at an existing OSM
control point before the next merge; do not cut or reroute the rest of the map.
An optional inspection buffer reaches node 7566321442 at 2,061.3 m.

- Requested start: **55.576894, 37.616692**; route snap:
  **55.5769236, 37.6164958**, 12.764 m away.
- Evidence: `data/moscow/route.json` sections 0–3; matching way geometry/node
  order/tags in `data/moscow/roads.osm.json`; projected nodes, tags and audit
  records in `data/moscow/network.json`.
- Cached OSM base: **2026-11-13T12:18:02Z**; route generated
  **2026-11-13T12:19:32.567037+00:00**.
- Chainages below are cumulative haversine distances on the **source route**,
  rounded to 0.1 m, not rendered spline or driving distances. Coordinates are
  latitude, longitude. Runtime uses east +X, north −Z, metres, no map scaling.
- **This investigator did not directly inspect imagery.** The parent session
  subsequently supplied visual observations, recorded separately below with
  provenance and alignment caveats. Landmarks in the inventory are topology/tag
  landmarks, not independently verified visual observations.
  Present-day lane counts, lane widths, signs, barriers, markings, terrain and
  actual bridge elevations remain unverified. OSM confidence is not visual confidence.

## Directed itinerary and tags

All four ways are traversed in their stored OSM node order (`oneway=yes`),
runtime direction `1`. The first ramp trends northwest then north; this is not
a due-north mainline start. It joins the northbound chord at 287.1 m.

| Chainage (m) | OSM way | Directed endpoints | Source lanes | Meaning |
| --- | --- | --- | --- | --- |
| 0–287.1 | 1207836341 | 11191288649 → 7566321603 | **absent** | Unnamed `primary_link`, asphalt; no speed/bridge/layer tags |
| 287.1–1,334.0 | 809185810 | 7566321603 → 7566321596 | 3 | `primary`, Юго-Восточная хорда, northbound approach |
| 1,334.0–1,486.5 | 809185809 | 7566321596 → 7566321595 | 3 | Same road; **`bridge=yes`, `layer=1`** |
| 1,486.5–1,942.3 | 809185806 (partial) | 7566321595 → 7566321589 | 3 | Same road; bridge tags end; way continues to 7566321442 |

The three named mainline ways share `maxspeed=90`, `motorroad=yes`, `foot=no`,
`lit=yes`, `surface=asphalt`, `parking:both=no`,
`parking:both:restriction=no_stopping`, `toll=yes`, and:

```text
toll:conditional=no @ (Mo-Fr 0:00-7:00;Mo-Fr 11:00-16:00;Mo-Fr 20:00-24:00; Sa-Su; PH)
```

Absence of `bridge`/`layer` on approaches does **not** establish surveyed ground height.
Toll/speed/light tags are reference metadata, not a claim of implemented gameplay.

### Exact ordered node inventory

Read top to bottom. Shared boundary nodes appear once. This plus the way table
specifies every directed source segment in the pilot.

| Chainage (m) | OSM node ID | Latitude, longitude |
| --- | --- | --- |
| 0.0 | 11191288649 | 55.5769236, 37.6164958 |
| 25.0 | 13395069831 | 55.5770115, 37.6161306 |
| 53.0 | 11191329956 | 55.5771486, 37.6157559 |
| 77.4 | 11198482013 | 55.5773083, 37.6154887 |
| 102.8 | 11191329957 | 55.5774993, 37.6152675 |
| 131.0 | 13395069832 | 55.5777337, 37.6150986 |
| 163.9 | 13395069833 | 55.5780132, 37.6149266 |
| 195.0 | 11191329958 | 55.5782841, 37.6148007 |
| 230.5 | 11191329959 | 55.5786018, 37.6147485 |
| 287.1 | 7566321603 | 55.5791108, 37.6147166 |
| 452.5 | 7566321602 | 55.5805886, 37.6150042 |
| 719.9 | 7566321601 | 55.5829870, 37.6153207 |
| 909.4 | 7566321600 | 55.5846879, 37.6155192 |
| 976.6 | 7566321599 | 55.5852882, 37.6156425 |
| 1,033.4 | 7566321598 | 55.5857915, 37.6157981 |
| 1,108.7 | 7566321597 | 55.5864509, 37.6160663 |
| 1,334.0 | 7566321596 | 55.5884231, 37.6168925 |
| 1,486.5 | 7566321595 | 55.5897600, 37.6174343 |
| 1,575.7 | 7566321594 | 55.5905391, 37.6177669 |
| 1,644.5 | 7566321593 | 55.5911241, 37.6181263 |
| 1,708.7 | 7566321592 | 55.5916546, 37.6185286 |
| 1,786.2 | 7566321591 | 55.5922669, 37.6191187 |
| 1,860.6 | 7566321590 | 55.5928156, 37.6197946 |
| 1,942.3 | 7566321589 | 55.5933855, 37.6206154 |

### Topology landmarks and neighbouring ways

- **Start, 0 m:** way 1207824618 ends at 11191288649, feeding the selected ramp.
  Its tags are `primary_link`, asphalt, no explicit oneway/lanes.
  Its other endpoint is 413021834, 55.5767879, 37.6180214.
- **Mainline merge, 287.1 m:** northbound mainline 1207836340 and selected
  ramp 1207836341 both end at 7566321603; continuation is 809185810.
  Preserve both incoming connections; do not replace this with an isolated ramp.
- **Bridge tag boundaries, 1,334.0 / 1,486.5 m:** 809185809 spans the two
  listed nodes. In plan it crosses tertiary way **809185783**, segment
  **7566321393 → 7566321392**, without a shared node; do not introduce a junction.
  The crossing is approximately chainage 1,453.6 m (linear plan intersection).
- **Exit, 1,575.7 m:** way **809185786** starts at interior mainline node
  **7566321594**, directed toward 7566321450 (55.5915318, 37.6186278).
  Tags: `tertiary`, `oneway=yes`, asphalt, lit, no stopping; **lanes absent**.
  This is a genuine outgoing branch, not just a tag boundary.
- **Pilot end, 1,942.3 m:** node 7566321589 is an ordinary geometry node, not
  a named real-world destination. Keep the continuation to **7566321442**
  (55.5942107, 37.6218214, 2,061.3 m), where **1568395036**, one lane,
  merges into the mainline and mainline way 1194199517 begins.
- Opposite-carriageway context, not alternate route: **809185811** southbound
  approach, **809185812** (`bridge=yes`, `layer=1`), **809185807** southbound
  continuation. All are named Юго-Восточная хорда, `oneway=yes`, three lanes.

## Runtime start versus intended start

Read-only execution of `createMoscowNetwork()` and `sampleEdge()` established:

| Item | Current value |
| --- | --- |
| Source start way | `network.json.startWayId = 1207836341` |
| Parking/spawn edge | `osm:1207836341:1:0` |
| Edge endpoints | `osm-node:11191288649` → `osm-node:11191329956` |
| Edge length / lanes | 52.961952 m / **2 (fallback, not OSM evidence)** |
| Nominal spawn | `s=20`, `d=0`, relative yaw `psi=0` |
| Sample position | X −30.734290, Y 0.2, Z −11.126268 m |
| Inverse-projected coordinate | **55.5769941, 37.6162031** |
| Separation from requested coordinate | **32.686 m** (horizontal geodesic) |
| Travel heading | −1.167571 rad relative north, approximately **293.1° compass** |

This is 20 m along the rendered ramp after the snapped route origin, not the
requested coordinate and not a due-north mainline pose. `src/network/moscow.ts:191–192`
chooses the first forward edge by way prefix and offsets 20 m; `spawnDriver`
resets at that parking (`src/network/driving.ts:83–89`). Session slot allocation
can subsequently move the actual car for occupancy (`src/network/session.ts:86–103`).
Do not label this a surveyed parking area.

## Data-backed issues and implementation recommendations

1. **Start semantics — high confidence.** If “route start” means the stored snapped
   origin, explicitly anchor section 01 to node **11191288649**, direction **1**,
   and expose any car-length safety offset as a deliberate setting rather than
   silently claiming the requested coordinate. Keep the current technical spawn
   if that offset is wanted, but report both coordinates. Do **not** force heading
   north on the ramp; verify with the user/Yandex whether the ramp or mainline was
   intended before relocating to way 1207836340. The importer snaps to nearest
   routable **node**, without requested heading or carriageway constraints
   (`scripts/import-moscow-route.py:101–107`).

2. **Unsupported ramp lane count — high confidence in missing evidence; actual
   count unknown.** `src/network/moscow.ts:43–49` assigns **two lanes** to
   1207836341 because OSM has no `lanes` tag. `sampleEdge` then gives half-width
   **5.1 m** (10.2 m total, including generic shoulders). Parent-session imagery
   now supports a **one-lane ramp**, but exact way-to-camera alignment remains
   conditional (see observations below). Once alignment is confirmed, apply an
   ID-keyed override **`1207836341: direction=1, lanes=1`**, retaining the absent
   raw OSM tag. With unchanged generic shoulders this gives half-width **3.3 m**,
   not a surveyed width. Do not infer actual shoulders, taper length, or a width
   override from lane count alone. Mainline three-lane tags agree with the
   reported mainline panorama; actual lane widths remain unmeasured.

3. **Local bridge/opposite-carriageway conflict — high confidence as a stored
   audit result, not as measured reality.** `network.json.ribbonAudit.unresolved`
   contains way pair **809185811 / 809185809**, segments
   **7566321527 → 7566321526 / 7566321596 → 7566321595**:
   signed separation **−6.45 m**, maximum signed **−5.0517 m**, minimum absolute
   **5.0517 m**, classification `insufficient-absolute-separation`.
   Northbound bridge endpoints are **Y=14.65 m**; adjacent southbound bridge end
   7566321527 (55.5886555, 37.6167596) is **Y=21.1 m**. These are solver outputs,
   not real elevations. Inspect both carriageway outlines, bridge boundaries and
   the road below together before correcting local width/profile; **do not lift
   the whole map or impose a grade-separated crossing between parallel lanes**.
   This record alone does not prove the meshes intersect; exact runtime mesh
   clearance still needs checking. Same-layer overlaps with southbound bridge
   **809185812** are separately flagged as ambiguous, not solved evidence.

4. **Preserve branch-specific geometry — high confidence topology, unverified
   visuals.** Keep incoming mainline **1207836340** at 7566321603 and exit
   **809185786** at 7566321594. Current generic rendering suppresses markings
   within 60 m and barriers within 100 m of degree>2 edge endpoints
   (`src/network/render.ts:128–155`); those distances are heuristics, not observed
   gore/merge lengths. Replace only local confirmed layouts, without deleting
   graph connections or treating nearby parallel centrelines as junctions.

## Parent-session visual observations (reported, not independently inspected)

Evidence supplied by the parent session after the read-only inventory:

| Reference | Reported observation | Confidence and use |
| --- | --- | --- |
| Initial Yandex MRC **id2918419713**, **seg1** | Two-way service street; sign on right reads **МСД-СЕВЕР / КАНТЕМИРОВСКАЯ** | High confidence in the parent's reported visible feature; low confidence in exact node alignment. Consistent with a two-way feeder, not proof that this frame lies on 1207836341. |
| **seg20**, normalized MRC **id2918419731** | Narrow single-lane curving ramp, no centre lane divider; left curb, greenery and pipes; right curb and sidewalk. Mini-map places junction southeast of МСД. | Strong visual support for one lane on the observed ramp; **medium confidence** that it is way 1207836341, pending coordinate/heading alignment. |
| **seg40**, normalized MRC **id3187292316** | Northbound mainline has **three lanes**, concrete central divider, metal barrier on right | Strong agreement with the mainline OSM lane tags; exact way/chainage is not established by segment number. Do not attach barrier endpoints to particular nodes yet. |
| Satellite **ll=37.619,55.582**, **z=16** | Ramp curls north from the east; railway west of МСД | Reported plan layout is consistent with the stored ramp's westward-then-northward curve into the northbound mainline. Railway position is context only, not a measured placement. |

Satellite reference URL:
<https://yandex.ru/maps/?ll=37.619%2C55.582&z=16&l=sat>.
Panorama launch URLs reconstructed from the reported IDs (not verified canonical
share URLs; preserve the IDs above if Yandex rewrites the link):

- <https://yandex.ru/maps/?l=stv&panorama%5Bid%5D=2918419713>
- <https://yandex.ru/maps/?l=stv&panorama%5Bid%5D=2918419731>
- <https://yandex.ru/maps/?l=stv&panorama%5Bid%5D=3187292316>

**Caveat:** the original full MRC/segment URLs, panorama geographic coordinates,
camera headings and imagery dates were not supplied. `seg20`/`seg40` and normalized
panorama IDs do **not** guarantee geographic alignment, a continuous drive, or
20/40 equal-distance steps. These reconstructed URLs are navigation aids, not
proof of alignment or successful panorama loading.

**Way-match conclusion:** 1207836341 is the best data-backed candidate: its exact
geometry starts east of the mainline, curls northwest then north, and terminates
at the northbound three-lane mainline merge 7566321603. This agrees with the
reported satellite and ramp/mainline observations, but does not conclusively
identify the observed single-lane camera position. Before applying the local
one-lane override, locate panorama id2918419731 on the map and confirm its camera
lies along the inventory's **11191288649 → 7566321603** curve and points toward
that merge. If confirmed, implement **only that way's forward lane override**;
retain three lanes on 809185810 / 809185809 / 809185806. Do not change feeder
1207824618 to one-way based on the ramp image. Curbs/sidewalk/pipes and barrier
types require local extent confirmation before implementation.

## Manual reference capture / acceptance handoff

Use Yandex satellite plus available panoramas at the coordinates in the node
table: **start → ramp curve (77–195 m) → merge (287 m) → approach (1,109 m) →
bridge ends → exit (1,576 m) → pilot end**. Record imagery date, camera coordinate,
view direction, link, observed feature, and confidence. Some imagery was viewed
by the parent as reported above; exact camera alignment and imagery dates are
still unknown. A convenient unverified launch point is
<https://yandex.ru/maps/?ll=37.616692%2C55.576894&z=17&l=sat> (URL order lon,lat).

Implementation boundary: route direction/order and all listed node connections
remain unchanged unless an explicit reference disproves them; local overrides
must be ID-keyed and must not rewrite the raw OSM extract. Verify the full pilot
drive in the stated order, branch accessibility at 287/1,576 m, continuity through
both bridge boundaries, and exact runtime road/barrier clearances. Stop at
7566321589; no whole-map automatic geometry/height pass is justified by this inventory.
