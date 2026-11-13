import { describe, expect, it } from 'vitest';
import data from '../data/moscow/network.json';
import { createMoscowNetwork } from '../src/network/moscow';
import { outgoing, sampleEdge, validateNetwork, type NetworkEdge, type Vec3 } from '../src/network/geometry';

const turn = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
const headingGap = (a: NetworkEdge, b: NetworkEdge) => turn(sampleEdge(a, a.length).heading, sampleEdge(b, 0).heading);
const way = (id: number, nodes: number[], oneway = 'yes') => ({ id, nodes, tags: { oneway, lanes: '2', highway: 'primary' } });
const fixture = (ways = [way(1, [1, 2]), way(2, [2, 3])], nodes: Record<string, number[]> = {
  1: [-100, .2, 0], 2: [0, .2, 0], 3: [100, .2, -40],
}) => createMoscowNetwork({ nodes, ways, startWayId: 1 });

describe('Moscow restrained geometry', () => {
  it('rounds sparse flat corners across way boundaries with matching travel headings', () => {
    const network = fixture(), [a, b] = network.edges;
    expect(validateNetwork(network)).toEqual([]);
    expect(a.to).toBe(b.from);
    expect(a.points.at(-1)).toEqual(b.points[0]);
    expect(headingGap(a, b)).toBeLessThan(.015);
    const seam = a.points.at(-1)!;
    expect(Math.hypot(seam.x, seam.z)).toBeLessThanOrEqual(.251);
    expect(seam.z).toBeLessThan(0);
    for (const edge of network.edges) for (const p of edge.points) expect(p.y).toBe(.2);
  });

  it('keeps two-way offsets through ordinary way seams, and dead ends cannot U-turn', () => {
    const network = fixture([way(1, [1, 2], 'no'), way(2, [2, 3], 'no')]);
    expect(validateNetwork(network)).toEqual([]);
    for (const direction of [1, -1]) {
      const a = network.edges.find(e => e.id === `osm:${direction === 1 ? 1 : 2}:${direction}:0`)!;
      const exits = outgoing(network, a.id);
      expect(exits).toHaveLength(1);
      expect(headingGap(a, exits[0])).toBeLessThan(.015);
      expect(Math.hypot(a.points.at(-1)!.x, a.points.at(-1)!.z)).toBeGreaterThan(1.7);
      expect(outgoing(network, exits[0].id)).toHaveLength(0);
    }
  });

  it('does not move a real junction, grade break, hairpin or nearby crossing', () => {
    const cases = [
      fixture([way(1, [1, 2]), way(2, [2, 3]), way(3, [2, 4])], {
        1: [-100, .2, 0], 2: [0, .2, 0], 3: [100, .2, -40], 4: [0, .2, 100],
      }),
      fixture(undefined, { 1: [-100, .2, 0], 2: [0, 2, 0], 3: [100, 5, -40] }),
      fixture(undefined, { 1: [-100, .2, 0], 2: [0, .2, 0], 3: [-80, .2, 10] }),
      fixture([way(1, [1, 2]), way(2, [2, 3]), way(3, [4, 5])], {
        1: [-100, .2, 0], 2: [0, .2, 0], 3: [100, .2, -40], 4: [-10, 8.2, -100], 5: [-10, 8.2, 100],
      }),
    ];
    for (const network of cases) {
      const a = network.edges[0], p = a.points.at(-1)!;
      expect(p.x).toBe(0); expect(p.z).toBe(0);
      expect(validateNetwork(network)).toEqual([]);
    }
    expect(cases[1].edges[0].points.at(-1)!.y).toBe(2);
    expect(outgoing(cases[3], cases[3].edges[0].id)).toHaveLength(1);
  });

  it('shares a rounded midpoint at an artificial sample-count chunk seam', () => {
    const network = fixture([way(1, [1, 2, 3])], {
      1: [-300, .2, 0], 2: [0, .2, 0], 3: [300, .2, -100],
    });
    expect(network.edges.length).toBeGreaterThan(1);
    const [a, b] = network.edges;
    expect(a.points.at(-1)).toEqual(b.points[0]);
    expect(headingGap(a, b)).toBeLessThan(.015);
  });

  it('preserves legacy raw branch coordinates/heights and gives clipped two-way ends distinct graph nodes', () => {
    // Isolate source construction from the explicitly height-editing pilot.
    const network = createMoscowNetwork(undefined, { pilotVerticalAlignment: false, pilotWidths: false });
    const neighbours = new Map<number, Set<number>>();
    for (const w of data.ways) for (let i = 1; i < w.nodes.length; i++) {
      for (const [a, b] of [[w.nodes[i - 1], w.nodes[i]], [w.nodes[i], w.nodes[i - 1]]]) {
        const set = neighbours.get(a) ?? new Set<number>(); set.add(b); neighbours.set(a, set);
      }
    }
    const raw = data.nodes as Record<string, number[]>;
    let branches = 0, boundaries = 0;
    for (const node of network.nodes) {
      const n = Number(node.id.split(':')[1]);
      if ((neighbours.get(n)?.size ?? 0) > 2) {
        const p: Vec3 = { x: raw[n][0], y: raw[n][1], z: raw[n][2] };
        expect(node.position).toEqual(p); branches++;
      }
    }
    for (const edge of network.edges) if (edge.to.includes(':boundary:')) {
      expect(outgoing(network, edge.id)).toHaveLength(0); boundaries++;
    }
    expect(branches).toBeGreaterThan(100);
    expect(boundaries).toBeGreaterThan(0);
    expect(validateNetwork(network)).toEqual([]);
  });
});
