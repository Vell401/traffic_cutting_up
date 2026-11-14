import { describe, expect, it } from 'vitest';
import { createMoscowNetwork } from '../src/network/moscow';
import { edgeById, sampleEdge } from '../src/network/geometry';
import { NetworkSession, orderedExits } from '../src/network/session';

/** Physics drive through section 01 with a simple lane-keeping controller (no teleports). */
const network = createMoscowNetwork();
function drive(target: (edgeId: string) => { d: number; branch?: string }, until: (edgeId: string, s: number) => boolean, limit = 260) {
  const session = new NetworkSession(network, { trafficCount: 0 });
  const driver = session.addDriver('pilot');
  const visited: string[] = [driver.edgeId];
  let worstMargin = Infinity, worstGradeJump = 0, previousY: number | undefined, maxClimb = 0;
  for (let t = 0; t < limit && !until(driver.edgeId, driver.s); t += 1 / 60) {
    const edge = edgeById(network, driver.edgeId), plan = target(edge.id), surface = sampleEdge(edge, driver.s);
    const lookahead = sampleEdge(edge, Math.min(edge.length, driver.s + 12));
    const curve = Math.atan2(Math.sin(lookahead.heading - surface.heading), Math.cos(lookahead.heading - surface.heading));
    const steer = Math.max(-1, Math.min(1, (plan.d - driver.d) * .18 - driver.psi * 2.2 + curve * 1.4));
    const exits = plan.branch ? orderedExits(network, edge) : [];
    const branch = plan.branch ? exits.findIndex(e => e.id === plan.branch) : -1;
    session.step(1 / 60, { pilot: { steer, throttle: driver.speed < 19 ? 1 : 0, brake: driver.speed > 23 ? .4 : 0, ...(branch >= 0 ? { branch } : {}) } });
    if (visited.at(-1) !== driver.edgeId) visited.push(driver.edgeId);
    const here = sampleEdge(edgeById(network, driver.edgeId), driver.s, driver.d);
    worstMargin = Math.min(worstMargin, here.halfWidth - Math.abs(driver.d));
    if (previousY !== undefined) { worstGradeJump = Math.max(worstGradeJump, Math.abs(here.y - previousY)); maxClimb = Math.max(maxClimb, here.y); }
    previousY = here.y;
  }
  return { visited, driver, worstMargin, worstGradeJump, maxClimb, time: session.time };
}

const mainline = new Set(['1207836341', '809185810', '809185809', '809185806']);
describe('section 01 continuous physics drive', () => {
  it('drives 0–1942.3 m on the mainline through both pilot junctions without leaving the surface', () => {
    const result = drive(id => ({ d: id.includes(':1207836341:') ? 0 : 0, branch: id === 'osm:809185806:1:0' ? 'osm:809185806:1:1' : undefined }),
      id => id === 'osm:809185806:1:4');
    expect(result.driver.edgeId).toBe('osm:809185806:1:4');
    expect(result.visited.every(id => mainline.has(id.split(':')[1]))).toBe(true);
    expect(result.visited).toContain('osm:809185809:1:0');
    expect(result.worstMargin).toBeGreaterThan(.5);
    // One fixed 1/60 s tick never jumps more than a smooth grade allows at ~23 m/s.
    expect(result.worstGradeJump).toBeLessThan(.05);
    expect(result.maxClimb).toBeGreaterThan(7);
    console.info('MSD pilot drive', { seconds: result.time.toFixed(1), edges: result.visited.length, worstMargin: result.worstMargin.toFixed(2) });
  }, 120000);
  it('takes the 1575.7 m exit onto its own surface', () => {
    const result = drive(id => ({ d: 0, branch: id === 'osm:809185806:1:0' ? 'osm:809185786:1:0' : undefined }),
      id => id === 'osm:809185786:1:1');
    expect(result.driver.edgeId).toBe('osm:809185786:1:1');
    expect(result.visited).toContain('osm:809185786:1:0');
    expect(result.worstMargin).toBeGreaterThan(.3);
  }, 120000);
});
