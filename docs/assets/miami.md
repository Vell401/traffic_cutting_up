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
**372,334 unique triangles**, 15 materials used by the GLB and one additional
road-only material definition. The GLB is **23,724,768 bytes**; photos/HDR total
**6,443,564 bytes**. Model + photos = **30,168,332 bytes (28.77 MiB)**; the manifest
is another 58,959 bytes. Source `.blend` is 25,772,082 bytes and is not a browser
payload. No mesh compression decoder or new game dependency is needed.

## Physical models

| Prototype | Triangles | Parts | Modelled detail |
| --- | ---: | ---: | --- |
| `hotel_deco` | 38,668 | 10 | Three rounded/stepped tiers, 144 recessed windows with continuous rebated/bevelled frames, corner flutes, stepped illuminated blade, awning, balcony slabs/rails, parapets/HVAC/louvres |
| `hotel_colonnade` | 38,536 | 7 | Genuinely open 4m-deep arcade, nine columns with plinths/capitals/flutes, 137 recessed windows, wrapping balconies, stepped roof pavilion |
| `condo_terrace` | 69,832 | 9 | Eight progressively set-back floors, 174 recessed windows, eight continuous balcony slabs with 1,286 individual balusters, entrance and roof equipment |
| `tower_glass` | 74,844 | 8 | Broad curtain glazing above a three-level podium, 21 curtain floors, 546 projecting vertical fins, physical floor nosings, crown/service screen |
| `tower_setback` | 106,000 | 8 | Distinct 70m stepped silhouette, deep framed apertures, terrace rails at setbacks, podium, roof plant and louvred crown |
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
   one material, finite indexed geometry, normals and UV0. Share one material
   object per semantic name. Extract by root name and manifest part name, not array
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
`d572be94c0e7d83ce1cdab3f256d69505f40e1521b89df0255b201e8d2412ff5`.

For a separate inspection of the **actual reimported GLB** rather than the source,
use the same Blender command with `-- --inspect-glb --preview-dir <scratch>`.
This mode does not modify the exported assets; it restores only the explicitly
declared shared PBR maps for previews. The source authoring and reimported-GLB
previews both include frontage, skyline, palms, yacht/pontoon, props and a close
window/railing view. Preview lighting/staging is for inspection, not game evidence.

The contract tests inspect parsed buffers, triangle areas, normal lengths, UV
variation, ground pivots, actual front/bow orientation, real material identity,
part/whole bounds, source headers and payload/checksums. Offline validator also
reads actual image dimensions and binary geometry. No frozen/security/physics
tests or old Miami-art caps were weakened. Route/collision/network, vehicle
models/builders/presets, menu/admin/storage and game quality remain untouched.
