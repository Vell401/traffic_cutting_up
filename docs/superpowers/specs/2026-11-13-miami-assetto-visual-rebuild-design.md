# Miami — asset-based visual rebuild

## Mandate and approval boundary

The user rejected the previous Miami appearance and requested a complete rework using Assetto Corsa as the visual reference, sourced models or Blender-authored models, no questions, and push to main with a successful verified deployment. This document records the executor's concrete design under that no-questions mandate; it is not a claim that the user separately approved these artistic choices.

The previous release is `815a18810707c395cccf2a1f47cd31aa032fa539`. Its full short changelog was delivered in conversation. Keep that release's working menu, vehicle preparation, shared administration and data safety.

## Why the previous result missed

The previous map changed the route and procedural silhouettes but remained a flat-colour, low-detail environment: polygon-ribbon palm crowns, shader-grid windows, repeated boxes, uniform banks, neutral room reflections and a simple gradient sky. More ornaments on those same boxes will not satisfy this request. The new production Miami must visibly replace that environment with authored three-dimensional facades, detailed vegetation and PBR surfaces.

## Chosen approach and alternatives

1. **Chosen: Blender-authored modular Miami kit + self-hosted CC0 PBR/sky photography**, streamed as bounded instanced scene batches around the existing road. This provides actual model geometry/material depth, reproducible source and a browser-sized payload without another engine.
2. Entire photogrammetry city: rejected for this delivery because no verified licensed route-aligned city dataset exists in the repository, and uncontrolled mesh/texture streaming would break loading and floating-origin assumptions.
3. Copying an Assetto Corsa track: rejected; the reference does not authorize redistributing somebody else's copyrighted game/mod assets. Assetto Corsa-level visual ambition is not a promise of literal parity on an unmeasured browser GPU.

## Art direction

- Coastal late sunset/blue hour as Miami's new default presentation: photographed sky, warm architecture and street lighting, controlled exposure and readable materials. Night and other existing sky choices remain usable; no giant bloom/fog cover-up.
- Ocean Drive: close continuous frontage, distinct rounded/stepped Art Deco hotels, colonnades, real recessed windows/frames, awnings, balcony slabs/railings, roof equipment, entry planting, sidewalks and furniture. Fictional names, no ripped branded signage.
- Causeway: open bay with textured water/normal variation, plausible shore transitions, repeating bridge infrastructure and a composed distant island skyline rather than random towers sticking out of water.
- Marina: visibly modelled yacht hulls/decks/rails, pontoons and gangways, correctly grounded boardwalk/furniture, landscaped frontage. Water/dock elevations and the protected road corridor stay coherent.
- Downtown: a different scale and palette, glazed towers and terrace/condominium forms with real facade depth, podiums, planted edges and a skyline that does not repeat one box every chunk.
- Palms: actual curved trunks, full feathered fronds/leaflets, varied crown profiles and bounded instances, not eight solid ribbons. Roadside props have bevels, physically plausible roughness and human scale.
- Asphalt/concrete/plaster/paving use real sampled surface maps with correct scale and colour-space handling, not just colour swaps. Preserve legible lane markings and traffic visibility.

## Architecture and interfaces

### Asset kit

`scripts/blender/build_miami.py` reproducibly authors `public/models/miami/coastal-kit.glb` and a source `.blend` under an authoring directory. Authoring uses portable official Blender, not a permanent/admin install. Model root pivots are bottom-centred, metres, glTF Y-up, front -Z. Export semantic metadata: prototype names, bounds, material/triangle counts and source provenance.

Minimum authored prototypes: `hotel_deco`, `hotel_colonnade`, `condo_terrace`, `tower_glass`, `tower_setback`, `garage_canopy`, `palm_coconut`, `palm_royal`, `yacht`, `streetlight`, `bench`, `bollard`, `planter`, `hedge`, `marina_pontoon`. Shared materials, nonzero bevel/window/leaflet depth, sane UVs/normals; no per-window materials or point lights.

CC0 photo maps/HDR are downloaded once from verified sources such as Poly Haven, checked against published checksums and self-hosted under `public/textures/miami/`. Record original URL, author/license, checksum, dimensions and any derivative processing in a manifest/license document. No live third-party asset/API dependency at runtime, paid service, unauthorized model extraction or dependency added to the game build.

### Runtime

- `src/render/miami/assets.ts`: coalesced asset/texture/HDR loading and validation; rejected loads clear the cache for a real retry. No HTTP from Node unit imports. CPU model data/resource ownership are explicit.
- `src/render/miami/layout.ts`: deterministic district/prototype placements from canonical road position, model bounds and terrain heights. Pure typed descriptors; no model drift on negative/future laps.
- `src/render/miami/world.ts`: shared instanced prototype-part batches, bounded capacity, current road/range/version/origin reconciliation, no steady-frame rebuilds or per-object materials. Correct ground/water levels, visible setpieces, explicit disposal.
- `src/render/miami/materials.ts` and `environment.ts`: Miami-only PBR road/structural/water treatment and HDR environment/sky/lighting. A local shadow volume may follow the camera at a fixed quality, bounded resolution; do not change Highway rendering or global quality presets.
- `View.prepareEnvironment(): Promise<void>` is a no-op for Highway and awaited under the existing initial loading overlay for Miami before the first usable menu frame. Required environment failure has a retry, not a silent return to the rejected old scenery. Preserve selected-car and optional-remote readiness semantics.
- Production Miami road scaffolding suppresses its legacy procedural city/palms/boats/props once the new world is active. Existing road surface/barriers/collision geometry and lamp-anchor contracts remain; no overlapping old/new hotels or palms. A named asset-environment mode on RoadView is acceptable to avoid breaking Highway and legacy unit fixtures while the real runtime uses only the new layer.

## Invariants and intentional changes

- Keep the 12,000 m route/collision geometry, spawn300, minimum bend radius, revision2 and rules hash `5d573e53`; this is a visual world rebuild, not another physics/network map change. Highway revision1/hash`766e63c6`, protocol13 and protected vehicle/preset/model hashes remain unchanged.
- Keep menu composition, chosen-car upfront preparation, four-car residency, one admin session, independent data/radio/records, all prior security boundaries. No new engine warm-up mechanic.
- The previous Miami-only seven-material/three-procedural-texture/six-thousand-triangle-per-chunk art caps do not constrain the replacement asset layer. Replace them with measured explicit whole-layer bounds, not unbounded detail or relaxed road-safety tests. Legacy/Highway geometry caps remain meaningful where their code still runs.
- Initial new Miami environment payload at most48MiB, shared-texture count at most48, prototype-part draw batches at most120 and visible environment instances at most1800. Whole-frame target at fixed Medium/DPR1 **normal opaque selected-car reference poses**: at most500 calls and5million submitted triangles including shadows/post/selected car. Validate all four cars, not only R34. Protected-spawn transparent ghost transitions retain the original correctly ordered colour draws and are measured/disclosed separately; this cap is not a promise for ghost, unbounded multiplayer density or preparation passes. These are rejection bounds for the stated reference, not FPS promises or reasons to lower DPR/detail silently.
- No forced DPR/quality/draw-distance reduction or low-detail screenshot mode. New model batching/LOD, if used, must be explicit, preserve close detail and tested through transitions.
- Deterministic fixed-pose actual-game views must prove materially different geometry/material/lighting, not only unit counts. Inspect near frontage/palms/shore and cockpit views at several districts, seams, bridge/tunnel transitions; reject floating, clipping or invisible setpieces.
- Authoring/asset changes may replace obsolete Miami appearance assertions, but retain vehicle/network/storage/menu/security tests and strengthen current-world safety/ownership/resource tests.

## Acceptance and release

Authoring manifest/GLB validation; behavioural RED/GREEN loader/layout/rebase/ownership tests; complete unit suite, types and both builds; actual desktop/mobile fixed-DPR captures; selected-car/camera readiness and resident menu; both real online map smokes; one-login admin regression. Compare to `815a188` with matched camera/position/settings, and inspect the actual PNGs. Software rendering is not physical-GPU/FPS proof.

Independent task review and final whole-change review precede integration. The user explicitly authorizes a normal main commit/push and automatic deployment after acceptance; verify the exact final SHA on the site, both health/map endpoints and both external WSS smoke paths. Preserve user changes/data; never force-push or delete production records/volumes. If a required external service/CI/deployment gate fails, diagnose and repair rather than bypass it.
