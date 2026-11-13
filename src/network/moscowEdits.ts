export type MoscowSource = {
  nodes: Record<string, number[]>;
  ways: Array<{ id: number; nodes: number[]; tags: Record<string, string | undefined> }>;
  startWayId: number;
};

type Evidence = { rationale: string; sourceUrl: string };
/** Keys are stable OSM IDs, not generated edge IDs. Positions use source [x, y, z]
 * metres (east, up, south). Tag edits merge; topology and generated data stay intact.
 */
export type MoscowEdits = {
  nodes: Record<string, Evidence & { position: number[] }>;
  ways: Record<string, Evidence & { tags: Record<string, string> }>;
};

const fail = (message: string): never => { throw new Error(`Moscow manual edits: ${message}`); };
const validId = (id: string) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id));
const validateEvidence = (edit: Evidence, target: string) => {
  if (typeof edit.rationale !== 'string' || !edit.rationale.trim()) fail(`${target} requires a rationale`);
  if (typeof edit.sourceUrl !== 'string' || !/^https?:\/\/\S+$/.test(edit.sourceUrl)) fail(`${target} requires a source URL`);
};

/** Pure clone-on-write overlay, reapplied after each source regeneration. Only
 * touched records are copied; callers must treat shared untouched records as read-only.
 * Stale IDs and malformed corrections fail explicitly instead of silently drifting.
 */
export function applyMoscowEdits<T extends MoscowSource>(source: T, edits: MoscowEdits): T {
  const nodeEdits = Object.entries(edits.nodes), wayEdits = Object.entries(edits.ways);
  if (!nodeEdits.length && !wayEdits.length) return source;
  let nodes = source.nodes, ways = source.ways;
  if (nodeEdits.length) {
    nodes = { ...nodes };
    for (const [id, edit] of nodeEdits) {
      if (!validId(id) || !Object.hasOwn(source.nodes, id)) fail(`missing node ${id}`);
      validateEvidence(edit, `node ${id}`);
      if (!Array.isArray(edit.position) || edit.position.length !== 3 || !edit.position.every(Number.isFinite)) {
        fail(`node ${id} position must contain three finite coordinates`);
      }
      nodes[id] = [...edit.position];
    }
  }
  if (wayEdits.length) {
    const indices = new Map(source.ways.map((way, index) => [String(way.id), index]));
    ways = [...ways];
    for (const [id, edit] of wayEdits) {
      const index = indices.get(id);
      if (!validId(id)) fail(`missing way ${id}`);
      if (index === undefined) return fail(`missing way ${id}`);
      validateEvidence(edit, `way ${id}`);
      for (const [key, value] of Object.entries(edit.tags)) {
        if (typeof value !== 'string') fail(`way ${id} tag ${key} must be a string`);
        if (/^lanes(?::(?:forward|backward|both_ways))?$/.test(key)
          && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))
            || Number(value) < (key === 'lanes:both_ways' ? 0 : 1))) {
          fail(`way ${id} tag ${key} must be a valid lane count`);
        }
      }
      const way = ways[index];
      ways[index] = { ...way, tags: { ...way.tags, ...edit.tags } };
    }
  }
  return { ...source, nodes, ways };
}
