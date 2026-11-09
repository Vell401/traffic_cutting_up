# Mercedes W204 — default C63 AMG model conversion

This is the delivered-asset/conversion record, not the current menu order: A45
remains the first/default body. C63 is **body 4 / physics 5 / M156**. All physics
is frozen after the R34-only grip update; model/presentation work must not
recapture physics hashes. Current integration and validation limits are in
[w204.md](w204.md) and [mobile-miami-upgrade.md](mobile-miami-upgrade.md).

## Delivered asset and budgets

- `public/models/mercedes-w204.glb`: **21,045,480 bytes / 20.07 MiB**.
- `public/models/mercedes-w204.manifest.json`: part provenance, materials, exact anchors, hashes and verification results.
- **234,632 assembled triangles**, 102 nodes, 263 mesh primitives, **77 delivered materials**.
- **63 embedded images; 184,953,600 bytes / 176.39 MiB** estimated RGBA8 plus mipmaps. This is an estimate, not measured driver allocation.
- Verification caps are **260,000 triangles, 24 MiB delivered GLB and 192 MiB estimated texture memory**. The larger file/texture budgets are a deliberate appearance-restoration cost for retained texture detail, emissive masks and AO; they are not evidence of runtime performance.
- Required `EXT_meshopt_compression`; every compressed geometry buffer is round-trip checked byte-for-byte. No geometric simplification was necessary. All indices checked against vertex counts.
- Both authored UV channels retained; **59 primitives contain TEXCOORD_1**. Static parts retain source world transforms; local transforms of authored cockpit props are not reset.

### Authored normals restoration

Blender 3.0's COLLADA importer discarded authored corner normals. `inspect-w204.py` now invokes `w204_collada_normals.py` immediately after each DAE import to restore custom split normals from the source NORMAL indices, after checking corner positions and face order. Geometry/UV hashes and object-transform checks prove the repair preserves geometry, UVs, material assignments and transforms. Zero source normals use explicit fallbacks; zero-area faces remain intact and are reported as excluded from normal verification.

The final audit in `verify-w204-normals.py` compares authored DAE corners directly with NORMAL accessors in the decoded delivered GLB, rather than trusting normals recalculated by a Blender GLB reimport. **10 selected panels** (body, hood, four doors, two fenders and two bumpers), **243,873 authored corners** passed, with maximum angular error **0.127°** (rounded; tolerance 1°). The audit excludes 222 degenerate corners and no zero-normal corners on these panels. Triangle-corner matching preserves crease distinctions; delivery/inspection SHA256 checks and byte-for-byte meshopt round-trip provenance bind the audit to the final asset.

Source: `mods_to_convert/MercedesW204/vehicles/c63w204kene/c63amg_dorest.pc`. Actual recursively resolved selection contains **91 parts**, not every DAE variant. Pre-facelift body, selected interior, original standard 18-inch rims and Michelin tyres are included. Source metadata: 1800 kg, 245/40R18, nominal radius 0.325 m. These are adapter metadata, not a physics implementation.

## Runtime contract

All positions below are **model-root world coordinates**, metres: **+X right, +Y up, -Z forward**. Source BeamNG `(x,y,z)` maps to `(-x,z,y)`. The GLB includes a rotated `Mercedes_W204` parent; do not apply the source conversion again. Use `getWorldPosition`/root-relative conversions, not raw child translations.

| Node | World position |
| --- | --- |
| `Wheel_FL` | `[-0.745, 0.33, -1.4]` |
| `Wheel_FR` | `[0.745, 0.33, -1.4]` |
| `Wheel_RL` | `[-0.73, 0.33, 1.295]` |
| `Wheel_RR` | `[0.73, 0.33, 1.295]` |
| `SteeringWheel` | `[-0.343852401, 0.926682830, -0.298687190]` |
| `CockpitCamera` | `[-0.344, 1.16, 0.17]` |
| `Headlamp_L` | `[-0.6, 0.7, -2.04]` |
| `Headlamp_R` | `[0.6, 0.7, -2.04]` |
| `InstrumentCluster` | `[-0.341, 0.95, -0.59]` |
| `DashboardScreen` | `[0, 0.99, -0.72]` |

Wheel nodes contain `<WheelName>_Rim` and `<WheelName>_Tyre`. Radius is 0.325 m, front/rear track 1.49/1.46 m, wheelbase 2.695 m. Position comes from selected wheel nodeOffset: front `.51 + .245 - .01`, rear `.51 + .225 - .005`; rear/front axle y=1.295/-1.4 in source coordinates. Tyres are calibrated to 0.245 m width and 0.650 m diameter. Rim geometry remains unscaled (0.501 m outer flange diameter, not bead diameter).

Wheel spin axis in model world is `[1,0,0]`; front steering axis `[0,1,0]`. Prefer separate steer/spin wrappers preserving bind matrices. Brake discs (`Wheel_FL_BrakeDisc`, etc.) and calipers are **outside** spinning wheel groups. Adapter must steer front discs/calipers together with the wheel hub, without spinning calipers. Caliper nodes: `brake_caliper_6pot_red_amg_Selected` and `.001` (front); `brake_caliper_4pot_red_amg_Selected` and `.001` (rear). Identify side from world position rather than suffix.

Steering axis in model world: `[0,0.390400112,0.920645297]`. The exported node's **local axis is `[0,1,0]`** (Blender source local Z becomes glTF local Y). Multiply bind quaternion by an axis-angle about local Y; do not replace its authored inclination. Steering angle/sign/ratio are runtime responsibilities.

Camera and headlamp anchors are placement recommendations derived from the cockpit/lamp locations, not calibrated optics. Headlamp direction `[0,0,-1]`; optional downward pitch belongs to runtime. InstrumentCluster/ DashboardScreen are approximate adapter attachment points, not a finished live instrument overlay. Stock needles/screens are retained.

### Material names

- Editable paint: `W204_BodyPaint` (white `[.88,.88,.88,1]` preset, Porsche-style single-coat PBR approximation: metallic **.5**, roughness **.22**, clearcoat **1**, clearcoat roughness **.03**). Authored AO, normals and mapped roughness remain connected when available; palette/multilayer base and metallic maps are disconnected for editable paint.
- Headlamp reflector/atlas: `c63w204kene_c63_hl_PBR`.
- Headlamp running surface: `c63w204kene_c63_hl_running_PBR`.
- Front indicators: `c63w204kene_c63_hl_signal_l_PBR`, `c63w204kene_c63_hl_signal_r_PBR`.
- Brake: `c63w204kene_c63_taillights_stop_PBR`.
- Tail running: `c63w204kene_c63_taillights_lowhighbeam_PBR`.
- Rear indicators: `c63w204kene_c63_taillights_signal_l_PBR`, `c63w204kene_c63_taillights_signal_r_PBR`.
- Reverse: `c63w204kene_c63_taillights_reverse_PBR`.
- Fog: `c63w204kene_foglight_PBR`.
- Mirror signals: `c63w204kene_signal_L_mirrors_PBR`, `c63w204kene_signal_R_mirrors_PBR`.
- Gauges/navigation: `c63w204kene_gauges_screen_PBR`, `c63w204kene_screen_dorest_PBR`.

Full original-to-export material mapping is in the manifest. Selected JBeam `glowMap` slots resolve their `off` material definitions while keeping independent semantic slot names; `on` definitions supply the original emissive masks. The manifest records 80 material aliases overall (including legacy atlas and generic PBR aliases), **21 delivered materials with emissive textures** and **14 with occlusion textures**. Runtime-controlled emission defaults off through a black emissive factor while retaining its mask; runtime must set the factor/intensity to activate it. Clone materials when instance-specific state is required. This preserves off/on material inputs, not BeamNG's complete dynamic lighting system.

## Assembly and material limitations

- BeamNG base definitions `brakepad_R_sport`, `brakepad_F_sport`, `soundscape_horn_7` are absent. They do not prevent the 91 locally available parts resolving.
- Absent base meshes `brake_disc_drilled`, `brake_hub_5l` are replaced by simple 64-segment brake discs (front radius .18 m, rear .165 m); hidden hubs omitted. These are solid, not fake drilled copies.
- Missing licenseplate meshes replaced by plain white .52 × .11 m plates. No invented registration.
- Missing `c63w204kene_halfshaft_R_wide` and selected hidden suspension/engine/transmission/fuel components omitted. Enginebay/trunkbay internal duplicate detail omitted; selected visible shell, cabin, lights, exhaust and underbody retained. Damage-only windshield overlay omitted.
- Local textures rebuilt into metallic-roughness PBR; DirectX normals have green flipped for OpenGL. Pillow uses color/data caps of **2048/1024 px** for tire/tyre/Michelin (including `michlen`)/badge/logo matches, **1024/512 px** for `c63_tex`/interior atlases, gauges/symbols, headlight/taillight (`c63_hl`/`c63_lights`) and screen matches, and **512/512 px** otherwise (in that precedence, matching material name plus base-map path). Existing smaller maps retain size/aspect. Symbols, gauges, logos, badges, decals and screens use lossless base images; linear data, alpha-bearing maps and emissive masks are also lossless.
- Base textures multiply the source base/diffuse color factor rather than a generic dark tint; missing factors default to white for textured surfaces. Roughness/metallic maps supply packed G/B values directly, with source scalar factors baked only for missing channels. Source normal strength and per-map UV selections are retained. Explicit opacity maps and opacity factors are preserved; opacity/ORM UV mismatches are checked rather than silently combining incompatible UV sets. Source AO is exported separately as glTF occlusion.
- Texture resolver repairs duplicated `/Seat/Seat/` references and can resolve a unique same-filename local file. The **default selection did not require a repaired path**; red/beige variant references are not selected.
- Source dependencies remain incomplete: BeamNG common/ETK base-color, normal, roughness, metallic and AO maps are absent. A defined material with missing maps may use scalar defaults without appearing in `fallbackMaterials`, which lists undefined material slots. Generic rubber/brake/mirror slots have explicit physical approximations; unresolved legacy slots remain neutral fallbacks. DAE diffuse bindings are checked before assigning a texture; this source has no `library_images`, so unrelated atlases are not guessed.
- Some cockpit warning-symbol slots (for example `abs`, `checkengine`, `battery`, `oil`, `signal_L`/`signal_R` and `decals_gauges`) remain unresolved fallbacks despite restoration of supplied symbol atlases elsewhere. HTML/render-target gauge/screen content is unavailable; retained screen geometry/materials are not a restored live display. Layered paint remains an editable single clearcoat approximation. These source/fallback limitations remain unresolved.
- 263 material primitives remain: file/triangle/texture budgets pass, but draw-call/FPS performance was not measured. No claim of 60 FPS or sub-three-second load time.

## Rebuild and verification

From repository root, requires Python 3 + Pillow, Blender 3.0.1 COLLADA/glTF, NumPy available to Blender, and installed `meshoptimizer`:

```sh
python3 scripts/prepare-w204.py
/usr/bin/blender -b --factory-startup --python-exit-code 1 --python scripts/inspect-w204.py
python3 scripts/textures-w204.py
PYTHONPATH="$HOME/.local/lib/python3.10/site-packages" /usr/bin/blender -b --factory-startup --python-exit-code 1 --python scripts/export-w204.py
node scripts/compress-w204.mjs
/usr/bin/blender -b --factory-startup --python-exit-code 1 --python scripts/verify-w204-normals.py
PYTHONPATH="$HOME/.local/lib/python3.10/site-packages" /usr/bin/blender -b --factory-startup --python-exit-code 1 --python scripts/render-w204.py
python3 scripts/verify-w204.py
```

`--python-exit-code 1` makes Blender Python exceptions fail the command. Run the final normal verifier after export/compression and before `verify-w204.py`: the latter requires a passing `normals-final.json` whose hashes match the delivered and decoded GLBs before publishing the manifest. NumPy path is environment-specific. Blender's bundled 3.0 glTF importer requires the local `np.bool=bool` compatibility shim in the render script. This Blender install exposes only Linear/sRGB image spaces; linear data maps use Linear when Non-Color is unavailable.

Historical conversion workspace: intermediate selection manifests, DAE import, assembled blend, raw GLB, staged textures, and decompressed inspection GLB were kept exclusively in `/tmp/opencode/w204*`. Those local files/paths are not guaranteed in this Windows checkout. Original source files were not written. The compression algorithm reuses the Porsche lossless approach, adjusted for Blender 3's target-less views and padded ushort indices.

### Historical conversion-stage inspection status — preserved colleague note

`docs/w204-model-front.png`, `-rear.png`, `-side.png`, and `-cockpit.png` are genuine background Cycles renders **after decoding and reimporting the delivered compressed GLB**. They are not source-only previews. Automated authored-normal and material checks passed, but the image-read attempt reported **“Cannot read image (this model does not support image input)”**. **There is no human visual approval; visual approval remains unverified.** A human/image-capable reviewer should inspect these four frames before final integration. **No FPS measurements or in-game frame timings have been collected**; structural budgets and successful renders do not establish runtime performance.

**Current integration update:** C63 has since been integrated in the browser;
the reported integrated Edge acceptance exercises C63 on the Miami phone layout.
This supersedes the old implication that runtime integration is still pending,
not the absence of human visual/audio approval. The four conversion renders
remain historical evidence, not fresh screenshots of this update. Physical iOS,
human listening and comparable device FPS measurements remain unverified; no
Docker-daemon or remote deployment was performed.
