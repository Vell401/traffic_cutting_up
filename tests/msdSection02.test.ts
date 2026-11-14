import { describe, expect, it } from 'vitest';
import { createMoscowNetwork } from '../src/network/moscow';
import { roadSampleDistances, sampleEdge, validateNetwork, type NetworkEdge } from '../src/network/geometry';
import { MSD_SECTION02, MSD_SECTION02_PROFILE, msdSection02Height, msdSection02Route } from '../src/network/msdSection02';
import { msdTerrain } from '../src/network/msdTerrain';
import { MSD_ENVIRONMENT } from '../src/network/msdEnvironment';
import { NetworkSession } from '../src/network/session';
import { edgeById } from '../src/network/geometry';

const net = createMoscowNetwork();
const route = msdSection02Route(net);
const way = (e: NetworkEdge) => e.id.split(':')[1];
const maxGrade = (e: NetworkEdge) => Math.max(...roadSampleDistances(e, .5).map(s => Math.abs(sampleEdge(e, s).grade)));
const near = (x: number, z: number, filter: (e: NetworkEdge) => boolean, radius = 20) => net.edges.filter(e => filter(e)
  && e.points.some(p => Math.hypot(p.x - x, p.z - z) < radius));

describe('MSD section 02 vertical alignment (1942.3–5849.8 m)', () => {
  it('keeps the published network valid and the northbound chain on the profile', () => {
    expect(validateNetwork(net)).toEqual([]);
    expect(route.edges[0].from).toBe('osm-node:7566321589');
    expect(route.chainage.at(-1)).toBeCloseTo(MSD_SECTION02.end, 0);
    for (const [c, h] of MSD_SECTION02_PROFILE) expect(msdSection02Height(c)).toBeCloseTo(h, 9);
    for (const e of route.edges) expect(maxGrade(e)).toBeLessThan(.05);
  });
  it('gives the opposite carriageway the same profile and eases every touched branch', () => {
    // Southbound counterparts project onto the northbound axis within the corridor.
    const south = net.edges.filter(e => /Юго-Восточная хорда/.test(e.route) && e.id.split(':')[2] === '1'
      && !route.edges.includes(e) && e.points.every(p => {
        const at = msdTerrain(net).route(p.x, p.z); return at.distance < 45 && at.chainage > 2000 && at.chainage < 5800;
      }));
    expect(south.length).toBeGreaterThan(5);
    for (const e of south) for (const s of roadSampleDistances(e, 10)) {
      const p = sampleEdge(e, s); expect(Math.abs(p.y - msdSection02Height(msdTerrain(net).route(p.x, p.z).chainage))).toBeLessThan(.35);
    }
    for (const id of ['1004930091', '942598241', '878341530', '1558292616', '942598228', '1000281857']) {
      for (const e of net.edges.filter(x => way(x) === id)) expect(maxGrade(e), e.id).toBeLessThan(.07);
    }
  });
  it('keeps the observed clearances (overpass, railway, road 878341533) and tunnel cover', () => {
    // Under the Podolskikh Kursantov overpass (≈3390 m): its deck soffit ≥ 5 m above the MSD.
    for (const over of net.edges.filter(e => ['10356288', '39093160'].includes(way(e)))) {
      for (const s of roadSampleDistances(over, 2)) {
        const p = sampleEdge(over, s), at = msdTerrain(net).route(p.x, p.z);
        if (at.distance < 8) expect(p.y - .4 - msdSection02Height(at.chainage)).toBeGreaterThan(5);
      }
    }
    // Over the Paveletsky main line (2600–2640 m): deck soffit ≥ 6.5 m above the rails.
    for (const c of [2607, 2614, 2625, 2634]) expect(msdSection02Height(c) - .4 - (-.05)).toBeGreaterThan(6.5);
    // Road 878341533 under the 809185797 bridge at ≈4600 m.
    const crossing = net.edges.filter(e => way(e) === '878341533');
    let checked = 0;
    for (const e of crossing) for (const s of roadSampleDistances(e, 1)) {
      const p = sampleEdge(e, s), at = msdTerrain(net).route(p.x, p.z);
      if (at.distance < 3) { expect(msdSection02Height(at.chainage) - .4 - p.y).toBeGreaterThan(4.5); checked++; }
    }
    expect(checked).toBeGreaterThan(0);
    // Tunnel under the railway: terrain cover rides above the 6.5 m roof slab.
    const tunnel = net.edges.find(e => e.id === 'osm:809185798:1:0')!, mid = sampleEdge(tunnel, tunnel.length / 2);
    expect(msdTerrain(net).height(mid.x, mid.z)).toBeGreaterThan(mid.y + 6.5);
  });
});

describe('MSD section 02 environment and drive', () => {
  it('carves watercourses and keeps lamp columns and towers off carriageways', () => {
    const terrain = msdTerrain(net);
    const river = MSD_ENVIRONMENT.waterways.find(w => w.width >= 8 && w.line.some(([x, z]) => terrain.route(x, z).distance < 60))!;
    expect(river).toBeDefined();
    const [x, z] = river.line[Math.floor(river.line.length / 2)];
    if (terrain.route(x, z).distance < 400) expect(terrain.height(x, z)).toBeLessThan(-1.5);
    expect(near(0, 0, () => false)).toEqual([]);
  });
  it('drives 0–5849.8 m on the mainline with physics, through the tunnel and over both viaducts', () => {
    const session = new NetworkSession(net, { trafficCount: 0 }), driver = session.addDriver('s02');
    const visited = new Set<string>([driver.edgeId]);
    let worst = Infinity;
    for (let t = 0; t < 420 && driver.edgeId !== 'osm:877932064:1:0'; t += 1 / 60) {
      const edge = edgeById(net, driver.edgeId), surface = sampleEdge(edge, driver.s), ahead = sampleEdge(edge, Math.min(edge.length, driver.s + 12));
      const curve = Math.atan2(Math.sin(ahead.heading - surface.heading), Math.cos(ahead.heading - surface.heading));
      const steer = Math.max(-1, Math.min(1, -driver.d * .18 - driver.psi * 2.2 + curve * 1.4));
      const exits = edge.id === 'osm:809185806:1:0' ? 0 : undefined;
      session.step(1 / 60, { s02: { steer, throttle: driver.speed < 19 ? 1 : 0, brake: driver.speed > 23 ? .4 : 0, ...(exits !== undefined ? { branch: exits } : {}) } });
      visited.add(driver.edgeId);
      const here = sampleEdge(edgeById(net, driver.edgeId), driver.s, driver.d);
      worst = Math.min(worst, here.halfWidth - Math.abs(driver.d));
    }
    expect(driver.edgeId).toBe('osm:877932064:1:0');
    for (const id of ['osm:809185801:1:2', 'osm:809185798:1:0', 'osm:809185797:1:1', 'osm:942598237:1:0']) expect(visited.has(id), id).toBe(true);
    expect(worst).toBeGreaterThan(.5);
  }, 240000);
});
