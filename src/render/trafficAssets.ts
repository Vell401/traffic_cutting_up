import { buildModel, defaults, type Kind, type LOD, type Model } from './trafficModels';

// The game has exactly eight types × three LODs. Do not cache arbitrary traffic-lab settings.
const templates = new Map<string, Model>();

/** Reuse expensive procedural construction, but give every view independently disposable buffers. */
export function cloneTrafficModel(kind: Kind, lod: LOD): Model {
  const key = `${kind}/${lod}`;
  let source = templates.get(key);
  if (!source) {
    // White cargo lets instanceColor select its final shade; neutral details retain theirs.
    source = buildModel(kind, lod, { ...defaults, cargoColor: '#ffffff' });
    templates.set(key, source);
  }
  return {
    parts: source.parts.map(part => part.clone()),
    axles: source.axles.map(axle => ({ ...axle })),
    triangles: source.triangles,
    bytes: source.bytes,
  };
}
