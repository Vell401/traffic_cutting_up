import { describe, expect, it } from 'vitest';
import route from '../data/moscow/route.json';
import data from '../data/moscow/network.json';
import { createMoscowNetwork, projectMoscow } from '../src/network/moscow';
import { networkLength, outgoing, validateNetwork } from '../src/network/geometry';
import { NetworkSession } from '../src/network/session';

describe('Moscow OSM itinerary candidate', () => {
  const network = createMoscowNetwork();
  it('retains provenance, waypoint errors and the unresolved length discrepancy', () => {
    expect(route.source.license).toBe('ODbL-1.0');
    expect(route.status).toBe('osm-route-candidate');
    expect(route.waypoints).toHaveLength(4);
    expect(route.waypoints.every(p => p.errorMetres < 50)).toBe(true);
    expect(route.lengthMetres).toBeGreaterThan(59000);
    expect(route.lengthMetres).toBeLessThan(60000);
    expect(route.sections.some(s => s.tags.name?.includes('МКАД'))).toBe(true);
    expect(route.sections.some(s => s.tags.name?.includes('хорда'))).toBe(true);
  });
  it('uses metre-based east/north projection and explicit approximate relative levels', () => {
    expect(projectMoscow(55.576894, 37.616692)).toEqual({ x: 0, y: .2, z: -0 });
    expect(projectMoscow(55.577894, 37.616692).z).toBeCloseTo(-111.195, 2);
    expect(projectMoscow(55.576894, 37.617692).x).toBeGreaterThan(62);
    expect(network.edges.some(e => e.kind === 'bridge' && e.points.some(p => p.y > 7))).toBe(true);
    expect(network.edges.some(e => e.kind === 'tunnel' && e.points.some(p => p.y < 0))).toBe(true);
  });
  it('is deterministic, valid and retains real boundary dead ends rather than fabricated loops', () => {
    expect(createMoscowNetwork()).toEqual(network);
    expect(validateNetwork(network)).toEqual([]);
    expect(network.openBoundaries).toBe(true);
    expect(networkLength(network)).toBeGreaterThan(route.lengthMetres * 2);
    expect(network.edges.some(e => outgoing(network, e.id).length === 0)).toBe(true);
    expect(network.edges.some(e => outgoing(network, e.id).length > 1)).toBe(true);
    // Check every segment, but avoid ~1.6 million matcher allocations for the
    // densely sampled vertical/XY profiles. NaN still poisons Math.max and fails.
    let maxStep = 0, maxGrade = 0;
    for (const edge of network.edges) {
      for (let i = 1; i < edge.points.length; i++) {
        const a = edge.points[i - 1], b = edge.points[i];
        const ds = Math.hypot(b.x - a.x, b.z - a.z);
        maxStep = Math.max(maxStep, ds);
        maxGrade = Math.max(maxGrade, Math.abs(b.y - a.y) / ds);
      }
    }
    expect(maxStep).toBeLessThan(5.02);
    expect(maxGrade).toBeLessThan(.125);
  });
  it('imports every selected OSM ramp and both directions of ordinary two-way roads', () => {
    for (const way of data.ways) {
      expect(network.edges.some(e => e.id.startsWith(`osm:${way.id}:`))).toBe(true);
      const tags: Record<string, string | undefined> = way.tags;
      const oneway = tags.oneway ?? (tags.highway === 'motorway' || tags.junction === 'roundabout' ? 'yes' : 'no');
      if (!['yes', '1', 'true', '-1'].includes(oneway)) {
        expect(network.edges.some(e => e.id.startsWith(`osm:${way.id}:1:`))).toBe(true);
        expect(network.edges.some(e => e.id.startsWith(`osm:${way.id}:-1:`))).toBe(true);
      }
    }
    expect(data.ways.filter(w => w.tags.highway.endsWith('_link')).length).toBeGreaterThan(400);
  });
  it('resolves all centreline crossings with different OSM levels to at least six metres', () => {
    expect(data.crossingAudit.crossings).toBeGreaterThan(400);
    expect(data.crossingAudit.ambiguousPairs).toHaveLength(data.crossingAudit.ambiguousSameLayer);
    expect(data.crossingAudit.unresolved).toEqual([]);
    expect(data.crossingAudit.minimumClearance).toBeGreaterThanOrEqual(5.99);
  });
  it('supports the existing local driving session without changing car physics', () => {
    const session = new NetworkSession(network, { trafficCount: 0 });
    session.addDriver('test');
    expect(session.drivers.has('test')).toBe(true);
  });
});
