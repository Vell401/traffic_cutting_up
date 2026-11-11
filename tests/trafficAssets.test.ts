import { describe, expect, it } from 'vitest';
import { cloneTrafficModel } from '../src/render/trafficAssets';
import { buildModel, defaults, type Kind, type LOD } from '../src/render/trafficModels';

describe('bounded traffic geometry cache', () => {
  it.each(['sedan', 'boxTruck', 'semi'] as Kind[])('keeps every attribute/index/bound unchanged for %s at all LODs', kind => {
    for (const lod of [0, 1, 2] as LOD[]) {
      const original = buildModel(kind, lod, { ...defaults, cargoColor: '#ffffff' });
      const cached = cloneTrafficModel(kind, lod);
      expect(cached.triangles).toBe(original.triangles); expect(cached.bytes).toBe(original.bytes);
      expect(cached.axles).toEqual(original.axles);
      original.parts.forEach((part, i) => {
        expect(cached.parts[i].index!.array).toEqual(part.index!.array);
        for (const [key, attribute] of Object.entries(part.attributes)) expect(cached.parts[i].attributes[key].array).toEqual(attribute.array);
        expect(cached.parts[i].boundingBox).toEqual(part.boundingBox);
        expect(cached.parts[i].boundingSphere).toEqual(part.boundingSphere);
      });
      for (const part of [...original.parts, ...cached.parts]) part.dispose();
    }
  });

  it('does not share mutable arrays, instance attributes, axle records or disposal with another view', () => {
    const first = cloneTrafficModel('sedan', 0), second = cloneTrafficModel('sedan', 0);
    const position = second.parts[0].getAttribute('position');
    const x = position.getX(0), axle = second.axles[0].r;
    expect(first.parts[0].getAttribute('position').array).not.toBe(position.array);
    first.parts[0].getAttribute('position').setX(0, 999);
    first.axles[0].r = 999;
    first.parts.forEach(g => g.dispose());
    expect(position.getX(0)).toBe(x); expect(second.axles[0].r).toBe(axle);
    const third = cloneTrafficModel('sedan', 0);
    expect(third.parts[0].getAttribute('position').getX(0)).toBe(x);
    for (const part of [...second.parts, ...third.parts]) part.dispose();
  });
});
