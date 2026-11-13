import { describe, expect, it } from 'vitest';
import data from '../data/moscow/network.json';
import manualEdits from '../data/moscow/manual-edits.json';
import { createMoscowNetwork } from '../src/network/moscow';
import { applyMoscowEdits, type MoscowEdits, type MoscowSource } from '../src/network/moscowEdits';

const evidence = { rationale: 'Synthetic fixture correction', sourceUrl: 'https://www.openstreetmap.org/way/10' };
const fixture = (): MoscowSource => ({
  nodes: { 1: [0, .2, 0], 2: [100, .2, 0], 3: [200, .2, 0] },
  ways: [
    { id: 10, nodes: [1, 2], tags: { oneway: 'yes', lanes: '2', name: 'Fixture' } },
    { id: 20, nodes: [2, 3], tags: { oneway: 'yes', lanes: '2' } },
  ], startWayId: 10,
});
const corrections = (): MoscowEdits => ({
  nodes: { 1: { ...evidence, position: [-10, 1.2, 0] } },
  ways: { 10: { ...evidence, tags: { lanes: '3', name: 'Corrected fixture' } } },
});

describe('Moscow manual source edits', () => {
  it('applies the reference-reviewed entry lane only to the default source', () => {
    expect(manualEdits.ways['1207836341'].tags.lanes).toBe('1');
    const original = data.ways.find(w => w.id === 1207836341)!;
    expect('lanes' in original.tags).toBe(false);
    const edited = createMoscowNetwork();
    const entry = edited.edges.filter(e => e.id.startsWith('osm:1207836341:'));
    expect(entry.length).toBeGreaterThan(0);
    expect(entry.every(e => e.lanes === 1)).toBe(true);
    expect(edited.edges.filter(e => e.id.startsWith('osm:809185810:')).every(e => e.lanes === 3)).toBe(true);
    expect(createMoscowNetwork(data).edges.filter(e => e.id.startsWith('osm:1207836341:')).every(e => e.lanes === 2)).toBe(true);
    expect('lanes' in original.tags).toBe(false);
    expect(applyMoscowEdits(data, { nodes: {}, ways: {} })).toBe(data);
  });

  it('persists JSON overrides across fresh source builds without mutating the original', () => {
    const source = fixture(), original = structuredClone(source);
    const edits: MoscowEdits = JSON.parse(JSON.stringify(corrections()));
    const edited = applyMoscowEdits(source, edits);
    expect(source).toEqual(original);
    expect(edited.nodes[1]).toEqual([-10, 1.2, 0]);
    expect(edited.nodes[1]).not.toBe(edits.nodes[1].position);
    expect(edited.nodes[2]).toBe(source.nodes[2]);
    expect(edited.ways[1]).toBe(source.ways[1]);
    expect(edited.ways[0].nodes).toBe(source.ways[0].nodes);
    expect(edited.ways[0].tags).toEqual({ oneway: 'yes', lanes: '3', name: 'Corrected fixture' });
    expect(applyMoscowEdits(fixture(), edits)).toEqual(edited);
    expect(applyMoscowEdits(edited, edits)).toEqual(edited);
    const network = createMoscowNetwork(edited);
    expect(network.edges[0].lanes).toBe(3);
    expect(network.edges[0].points[0]).toEqual({ x: -10, y: 1.2, z: 0 });
    expect(createMoscowNetwork(source).edges[0].lanes).toBe(2);
    expect(source).toEqual(original);
  });

  it('rejects stale IDs explicitly, including on unrelated sources', () => {
    expect(() => applyMoscowEdits(fixture(), { nodes: { 99: corrections().nodes[1] }, ways: {} })).toThrow('missing node 99');
    expect(() => applyMoscowEdits(fixture(), { nodes: {}, ways: { 99: corrections().ways[10] } })).toThrow('missing way 99');
    const unrelated = fixture(); unrelated.ways[0].id = 11;
    expect(createMoscowNetwork(unrelated).edges[0].lanes).toBe(2);
    expect(() => applyMoscowEdits(unrelated, corrections())).toThrow('missing way 10');
  });

  it('rejects invalid coordinates, lane counts and missing evidence without partial writes', () => {
    const source = fixture(), original = structuredClone(source);
    for (const position of [[0, NaN, 0], [0, Infinity, 0], [1, 2]]) {
      expect(() => applyMoscowEdits(source, { nodes: { 1: { ...evidence, position } }, ways: {} })).toThrow('finite coordinates');
    }
    for (const lanes of ['0', '-1', '2.5', '2;3', '3junk', 'Infinity']) {
      const edits = corrections(); edits.ways[10].tags.lanes = lanes;
      expect(() => applyMoscowEdits(source, edits)).toThrow('valid lane count');
    }
    const edits = corrections(); edits.nodes[1].rationale = '';
    expect(() => applyMoscowEdits(source, edits)).toThrow('rationale');
    edits.nodes[1] = { ...evidence, position: [0, 0, 0], sourceUrl: '' };
    expect(() => applyMoscowEdits(source, edits)).toThrow('source URL');
    expect(source).toEqual(original);
  });
});
