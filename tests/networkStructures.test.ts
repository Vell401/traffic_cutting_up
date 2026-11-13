import { describe, expect, it } from 'vitest';
import { BRIDGE_DECK_THICKNESS, bridgePierClearance, bridgePierGeometry } from '../src/network/structures';
import { sampleEdge, type NetworkEdge, type RoadNetwork, type Vec3 } from '../src/network/geometry';
import { NetworkRenderer } from '../src/network/render';

const edge = (id: string, y: number, x: number): NetworkEdge => ({ id, from: `${id}:a`, to: `${id}:b`,
  route: id, lanes: 2, kind: y > 0 ? 'bridge' : 'road', length: 100,
  points: [{ x, y, z: -50 }, { x, y, z: 50 }] });
describe('speculative bridge pier placement', () => {
  it('keeps the actual rendered flat pier top below its own graded asphalt and deck underside', () => {
    const bridge = edge('graded', 12, 0);
    bridge.points[0].y = 7; bridge.points[1].y = 17;
    const boxes: Array<{ p: Vec3; h: number }> = [];
    const renderer = { asphaltKeys: new Map([[bridge.id, 'road']]), quad: () => {},
      box: (key: string, p: Vec3, _w: number, h: number) => { if (key === 'support') boxes.push({ p, h }); } };
    const build = (NetworkRenderer.prototype as unknown as { build: (net: RoadNetwork) => void }).build;
    build.call(renderer, { id: 'moscow-osm-test', edges: [bridge], nodes: [], parkings: [] });
    expect(boxes.length).toBeGreaterThan(0);
    const pier = bridgePierGeometry(bridge, 2.5);
    expect(boxes[0].p.y + boxes[0].h / 2).toBeCloseTo(pier.top);
    for (let s = .3; s <= 4.7; s += .1) expect(pier.top).toBeLessThanOrEqual(sampleEdge(bridge, s).y - BRIDGE_DECK_THICKNESS);
    expect(pier.top).toBeLessThan(sampleEdge(bridge, 2.5).y - BRIDGE_DECK_THICKNESS);
  });

  it('rejects piers intruding into a nearly coplanar other deck, not just roads 0.5m below', () => {
    const net: RoadNetwork = { id: 'test', edges: [edge('upper', 12, 0), edge('nearby', 11.9, 0)], nodes: [], parkings: [] };
    expect(bridgePierClearance(net)('upper', { x: 0, y: 11.6, z: 0 })).toBe(false);
  });
  it('rejects piers over a lower carriageway including its road width', () => {
    const network: RoadNetwork = { id: 'test', edges: [edge('upper', 12, 0), edge('lower', 0, 8)], nodes: [], parkings: [] };
    const safe = bridgePierClearance(network);
    expect(safe('upper', { x: 0, y: 12, z: 0 })).toBe(false);
    expect(safe('upper', { x: -30, y: 12, z: 0 })).toBe(true);
  });
  it('does not reject a pier just because a road crosses above it', () => {
    const network: RoadNetwork = { id: 'test', edges: [edge('upper', 12, 0), edge('higher', 24, 0)], nodes: [], parkings: [] };
    expect(bridgePierClearance(network)('upper', { x: 0, y: 12, z: 0 })).toBe(true);
  });
});
