# Miami coastal kit — authored source and offline provenance

This is a new physical environment kit, **not** a recolour of the legacy Miami
procedural scenery. Models are original project-authored Blender meshes. No
Assetto Corsa/game/mod models, logos, paid assets or extracted content were used.
Assetto Corsa is a visual reference, not an asset source or a claim of parity.

## Delivered files

- `scripts/blender/build_miami.py`: deterministic metre-scale bpy authoring,
  seed `13062026`, Blender 4.5 LTS. No pip packages/add-ons required.
- `assets/miami/coastal-kit.blend`: editable source with packed CC0 surface maps;
  roots are **staged for inspection in this source only**. Rebuild with the script
  rather than exporting those staging transforms by hand.
- `assets/miami/authoring.json`: generator/material definitions and feature counts.
  Counts supplement, but do not substitute for, inspecting the geometry.
- `assets/miami/sources.json`: locked original URLs, published MD5, local SHA-256,
  authors, licenses and dimensions of all downloaded originals.
- `public/models/miami/coastal-kit.glb`: self-contained geometry/shared material
  factors; **no embedded or external image references, lights or cameras**.
- `public/models/miami/manifest.json`: schema1 runtime contract, parsed GLB bounds,
  part names/materials/triangle counts, explicit shared PBR map assignments and
  provenance. `totalBytes` is model + ten photo files; include manifest bytes too
  when checking the initial 48 MiB budget.
- `public/textures/miami/*`: exactly nine 1K JPEG surface maps and one 1K HDR.

The delivered kit has 15 prototypes, **74 prototype/material mesh parts**,
**371,112 unique triangles**, 15 materials used by the GLB and one additional
road-only material definition. The GLB is **23,675,324 bytes**; photos/HDR total
**6,443,564 bytes**. Model + photos = **30,118,888 bytes (28.72 MiB)**; the manifest
is another 58,958 bytes. Source `.blend` is 25,773,628 bytes and is not a browser
payload. No mesh compression decoder or new game dependency is needed.

## Physical models

| Prototype | Triangles | Parts | Modelled detail |
| --- | ---: | ---: | --- |
| `hotel_deco` | 38,434 | 10 | Three rounded/stepped tiers, 144 recessed windows with continuous rebated/bevelled frames, corner flutes, stepped illuminated blade, awning, balcony slabs/rails, parapets/HVAC/louvres |
| `hotel_colonnade` | 38,406 | 7 | Genuinely open 4m-deep arcade, nine columns with plinths/capitals/flutes, 137 recessed windows, wrapping balconies, stepped roof pavilion |
| `condo_terrace` | 69,624 | 9 | Eight progressively set-back floors, 174 recessed windows, eight continuous balcony slabs with 1,286 individual balusters, entrance and roof equipment |
| `tower_glass` | 74,766 | 8 | Broad curtain glazing above a three-level podium, 21 curtain floors, 546 projecting vertical fins, physical floor nosings, crown/service screen |
| `tower_setback` | 105,428 | 8 | Distinct 70m stepped silhouette, deep framed apertures, terrace rails at setbacks, podium, roof plant and louvred crown |
| `garage_canopy` | 1,852 | 7 | Rounded layered canopy, six bevelled columns/plinths, sunshade louvres, kiosk and emissive diffusers |
| `palm_coconut` | 12,964 | 2 | Curved tapered trunk/growth rings, 13 curved rachises, **696 individually modelled closed ridged leaflets**, upward spears and coconuts |
| `palm_royal` | 13,584 | 3 | Bulged/ringed trunk, green crownshaft, 15 rachises, **792 closed leaflets**, different taller crown profile |
| `yacht` | 5,434 | 4 | 28-section lofted V/chine hull with tapered rising bow, shaped teak deck, raked cabin/windscreen, flybridge seats, arch/radar, perimeter rail/stanchions, portholes and swim platform |
| `streetlight` | 324 | 2 | Human-scale base, tapered curved arm, bevelled luminaire and emissive diffuser; no exported point light |
| `bench` | 768 | 2 | Separate bevelled seat/back slats, curved legs and arms, cross-brace; 0.91m overall height |
| `bollard` | 308 | 3 | Bevelled cylindrical body/cap/base and reflective band; 0.94m height |
| `planter` | 428 | 3 | Tapered hollow container, bevelled rim, inset soil and separate closed leaves |
| `hedge` | 5,024 | 3 | Irregular overlapping foliage clusters, 500 individual broad leaflets, stems and concrete border |
| `marina_pontoon` | 3,768 | 3 | Rounded float, 60 separate deck boards, metal edging, cleats, fenders and landward guardrail |

Small trim uses a real single-segment bevel; silhouette pieces use two segments
or sampled rounded outlines. The continuous window-frame rings replace hidden
overlapping bar ends, reducing payload **without removing recesses or rails**.
There are no per-window materials, textures or runtime mesh objects. Glazing is
opaque PBR reflective glazing, intentionally avoiding transparent-window sorting
and pretending that interiors exist. Geometry has normals and baked physical UV0;
no shader-generated window grid or palm ribbons, no fabricated baked-AO claim.

Generator 1.0.1 (retained in 1.0.2) gives each exposed terrace/podium a single finish cap: recessed
cores are closed by the wider upper spandrel; where a setback balcony supplies
the finish, that spandrel's hidden top cap is omitted too. This removes 47
overlapping caps (1,222 triangles), without moving floors, rails, pivots or bounds.
Actual-GLB downward-ray regressions check fifteen open-surface probes across hotel
setbacks, both tower podiums and all three tower setbacks, including same-material
duplicate caps. No runtime depth offset or quality workaround is involved.

## Exact Task2 extraction / material contract

1. Load `/models/miami/manifest.json` and `/models/miami/coastal-kit.glb` locally.
   No third-party runtime HTTP. The GLB parses with the existing `GLTFLoader` from
   `three-stdlib`, without a decoder. Top-level roots are precisely the fifteen
   semantic names above, all identity transforms, **metres, glTF +Y-up, front -Z**.
   The yacht's bow and the hotel's illuminated blade establish front geometrically.
2. Each root is at `(0,0,0)` and has **bottom-centred full-AABB pivot**:
   `minY=0`, `minX=-maxX`, `minZ=-maxZ`, including overhangs/leaves/railings. A curved
   palm's trunk foot or an asymmetric streetlight's base is not necessarily the
   horizontal centre of its complete crown/arm bounds. Use the supplied full bounds
   for corridor clearance, not an assumed point radius.
3. Each direct child is one identity mesh named `<prototype>__<material>`, with
    one material, finite indexed geometry, normals and UV0. Extraction shares one
    material per semantic name; the bounded skyline variants below borrow its maps.
    Extract by root name and manifest part name, not array
   order. If using generic extraction, bake
   `inverse(root.matrixWorld) * mesh.matrixWorld` into copied geometry exactly once.
   Do not copy the `.blend` inspection layout, normalize/rescale bounds, or recenter
   each part independently. The scene has no animations/cameras/lights.
4. **PBR maps are intentionally runtime-shared**, not embedded in the GLB. Assign
   `materials[].maps` by texture ID, cache each `textures[].path` once, and retain
   the GLB's shared material factors (or the manifest's identical linear factors).
   Otherwise the GLB alone will show only its fallback factors, not the photo PBR.
   `plaster_ivory`, `plaster_coral`, `plaster_mint` share the plaster triplet;
   `concrete_warm` uses concrete; `asphalt_road` is a road-only runtime definition.
   All other materials are deliberately untextured PBR metal/wood/glass/vegetation
   surfaces whose real geometry supplies their shape/shadows.
5. Diffuse `map`: **sRGB**. OpenGL `normalMap` and grayscale `roughnessMap`:
   **linear/NoColorSpace**. Roughness JPEG channels are identical (Three samples G).
   Apply the manifest's `normalScale`. Use `RepeatWrapping`, **`flipY=false` for GLB
   UVs**, and `repeat=(1,1)`: UV0 is already position-in-metres / **2m tile size**.
   Do not multiply tiling by another 0.5 or reuse a colour texture's colour space
   for normals. For road/terrain geometry authored elsewhere, Task2 must provide
   its own metric UV scale without changing protected collision/route positions.
   No tangent dependency: standard Three normal-map derivatives use the supplied UVs.
6. Use the HDR as a linear Radiance equirectangular source, original for background
   and PMREM for reflections. It is photographed sunset sky, not neutral room light.
   Runtime owns/disposes generated PMREM resources, maps and instanced geometry.
   Emissive materials are geometry/factors, **not** a request for a light per window.
7. Grounded props/buildings: pivot at terrain height. Yacht:
   **pivotY = waterY - 0.9m** (keel pivot, 0.9m draft). Pontoon:
   **pivotY = waterY - 0.3m** (deck top 0.42m above water). Both offsets are in the
   manifest. Bounds are physical, not pre-scaled to road chunk dimensions.
8. 74 parts is the potential prototype/material batch count, not measured game
   calls. Runtime must still bound visible placements to 1,800, whole-layer batches
   to 120, initial bytes to 48 MiB and textures to 48, and verify the whole-frame
   500-call / 5-million-submitted-triangle limits including shadows and selected
   car. Do not lower quality/DPR to hide a budget failure. Task1 is **not** game
   screenshot acceptance or physical-GPU performance evidence.

## Downloaded originals / licenses

All ten files are self-hosted **byte-identical originals**, not derived/resized
files. The selected 1K resolution is an upstream published variant. Each asset's
`https://api.polyhaven.com/files/<id>` publishes the original URL, byte length and
MD5. `sources.json` and runtime manifest additionally record a verified local
SHA-256 and dimensions read from the actual JPEG/Radiance headers.

| Poly Haven asset | Author credits (as published) | Selected files | Actual dimensions | License |
| --- | --- | --- | --- | --- |
| [aerial_asphalt_01](https://polyhaven.com/a/aerial_asphalt_01) | Rob Tuytel (All) | diffuse, OpenGL normal, roughness JPEG | 1024×1024 each | CC0-1.0 |
| [concrete_wall_007](https://polyhaven.com/a/concrete_wall_007) | Charlotte Baglioni (Photography); Dario Barresi (Processing); Rico Cilliers (Tiling) | diffuse, OpenGL normal, roughness JPEG | 1024×1024 each | CC0-1.0 |
| [painted_plaster_wall](https://polyhaven.com/a/painted_plaster_wall) | Amal Kumar (All) | diffuse, OpenGL normal, roughness JPEG | 1024×1024 each | CC0-1.0 |
| [kloppenheim_06_puresky](https://polyhaven.com/a/kloppenheim_06_puresky) | Greg Zaal (Original); Jarod Guest (Sky edits) | Radiance HDR | 1024×512 | CC0-1.0 |

License reference: <https://polyhaven.com/license>. API terms:
<https://github.com/Poly-Haven/Public-API/blob/master/ToS.md>.
Downloads identify themselves as `TrafficCuttingUp-MiamiRebuild/1.0`. Only the ten
needed bounded files are selected; no source archives or multi-resolution dumps.
The downloader refuses an upstream MD5 change against the checked-in lock for
manual inspection rather than silently replacing an original. It validates before
writing a file; a local corrupt original is an error, not silently accepted.

**CC0 applies only to those credited photo/HDR originals.** The `.blend`, authored
models and authoring script are project-authored work; existing project rights are
unchanged. This document does not invent a new license for the whole project.

## Reproduce / validate

From the repository root (portable Blender path is an example, not a dependency):

```powershell
node --use-env-proxy scripts/miamiAssets.mjs download
& 'C:/Users/sosi/AppData/Local/Temp/opencode/miami-rebuild-tools/blender-4.5.9-windows-x64/blender.exe' --background --factory-startup --python scripts/blender/build_miami.py -- --preview-dir 'C:/Users/sosi/AppData/Local/Temp/opencode/miami-rebuild-task1/previews'
node scripts/miamiAssets.mjs manifest
node scripts/miamiAssets.mjs validate
npm test -- tests/miamiAssets.test.ts
```

`--use-env-proxy` is Node 24's environment proxy support; omit it on networks that
do not require it. No permanent Blender or package installation occurs. After the
originals are checked in, rebuilding/validating is completely offline. Repeated
authoring on Blender 4.5.9 produced byte-identical GLB SHA-256
`a3bede50494f6d62d2adea2c9b43d4dbf2c706a11f639ee34554349795f52cee`.

For a separate inspection of the **actual reimported GLB** rather than the source,
use the same Blender command with `-- --inspect-glb --preview-dir <scratch>`.
This mode does not modify the exported assets; it restores only the explicitly
declared shared PBR maps for previews. The source authoring and reimported-GLB
previews both include frontage, skyline, palms, yacht/pontoon, props and a close
window/railing view. Preview lighting/staging is for inspection, not game evidence.

Generator 1.0.2 resolves the deferred authoring discrepancy: source and restored
preview shaders explicitly separate the **green** roughness channel and multiply
it by the scalar factor, matching Three's runtime sampling (not RGB luminance).
`scripts/blender/test_miami_materials.py` checks the actual Blender node links,
non-colour image and a deliberately unequal-channel sample for all five photo
materials. Run with `--python-exit-code 1` so a failed assertion fails the command.
The asphalt now has a cooler/darker factor, roughness .98 and normal strength .28;
photo originals, 2m UV scale and all geometry remain unchanged. The GLB SHA above
therefore remains unchanged; the editable `.blend` and manifest factors are updated.

## Revision 3: the 30 km lap (map rework)

The kit above is unchanged, byte for byte. What changed is everything around it:

- **Route** (`src/sim/miami.ts`): a 30 km ring, two identical 15 km halves each turning π (closes by
  central symmetry), with sweepers both ways, S-bends and long straights; minimum radius 1331 m.
  Eleven districts in driving order: South Beach, MacArthur Causeway with Watson Island, Downtown,
  Port tunnel, Wynwood, Coconut Grove marina, Rickenbacker Causeway, Key Biscayne, Bear Cut,
  Coral Gables, Brickell tunnel, Bayfront. Map revision 3; the rules hash changes with the script,
  so clients and the Miami server must be deployed together.
- **Terrain** (`src/render/miami/terrain.ts`): pure functions of lap position. Each side of each
  chunk has a scene (beach, hotel strip, towers, arts, quay, lush, dunes, golf, villas, park, bay,
  hill) = surface bands + shore + bank. Shore/bank numbers blend between chunk centres, so
  coastlines curve instead of stepping. Islands are ellipses in road coordinates. `miamiGround`
  is the single source of truth for land mesh, prop feet and tests. Water is at -3 m.
- **Surfaces** (`surfaces.ts`): no photographs. Ten ground layers (concrete, pavers, grass, sand,
  asphalt, rock, wood, planting, tiles, lawn) are generated as pixels into one 256² texture array;
  a land vertex carries its layer, so a chunk of land is one draw. A low-frequency layer varies
  tone over tens of metres. Road asphalt, structure concrete and the water normal map are generated
  the same way; only the kit's asphalt normal map is still borrowed. The bay is the single far disc
  with world-anchored scrolling swells; there are no per-chunk water meshes.
- **Land** (`land.ts`): per chunk, the ground of both sides, islands, kerbs, parking bays, side
  streets every 100 m, hedges, seawall copings, the downtown people-mover, and cheap facade
  buildings (12 triangles each, procedural windows, lit at night) that fill the blocks behind the
  front row and the far shores.
- **Props** (`props.ts`): thirteen code-built models of a few hundred triangles (two palms, shade
  tree, bush, villa, shop, beach umbrella set, lifeguard stand, sloop, cruise ship, gantry crane,
  container stack, observation wheel). They share one vertex-coloured material plus paint/glass.
- **Layout** (`layout.ts`) rations the heavy kit to the front row (at most two kit buildings per
  side per block) and lets props carry the density. `world.ts` sizes every batch to the exact peak
  of the layout; landmarks (cruise ships, cranes, containers, the wheel) use a 300/1300 m window so
  they arrive through the haze, everything else 100/600 m. The island-skyline dither is gone with
  the kit towers it served.

Measured in the real game on the whole lap with traffic (1280×720, medium, DPR 1): 439 draw calls
and 2.37 M triangles on average, 501 / 3.75 M at the worst spots (lap seam at Bayfront, Downtown). The previous
12 km map measured 493 / 3.49 M at its Downtown.

The contract tests inspect parsed buffers, triangle areas, normal lengths, UV
variation, ground pivots, actual front/bow orientation, real material identity,
part/whole bounds, source headers and payload/checksums. Offline validator also
reads actual image dimensions and binary geometry. Frozen/security/physics tests
remain unchanged. Collision, barriers, vehicle models/builders/presets,
menu/admin/storage and game quality remain untouched by the map rework.
