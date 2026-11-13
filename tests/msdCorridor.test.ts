import { describe, expect, it } from 'vitest';
import source from '../data/moscow/network.json';
import { createMoscowNetwork } from '../src/network/moscow';
import { msdCorridor, osmWayId } from '../src/network/msdCorridor';

describe('MSD-only road polish scope', () => {
  it('includes mainline and start ramp but never MKAD carriageways', () => {
    const network = createMoscowNetwork(), selected = msdCorridor(network);
    expect(selected.size).toBeGreaterThan(100);
    expect(network.edges.filter(e => osmWayId(e.id) === 1207836341).every(e => selected.has(e.id))).toBe(true);
    const mkad = new Set(source.ways.filter(w => /МКАД/.test((w.tags as Record<string, string>).name ?? '')).map(w => w.id));
    expect(network.edges.filter(e => mkad.has(osmWayId(e.id))).some(e => selected.has(e.id))).toBe(false);
    expect(msdCorridor(network)).toBe(selected);
  });
});
