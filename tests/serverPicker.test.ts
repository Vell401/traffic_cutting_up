import { describe, expect, it } from 'vitest';
import { loadMapSky, mapNavigation, modeNavigation, saveMapSky, saveSelectedMap, selectedMap } from '../src/ui/serverPicker';

const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

describe('server selection keeps map identity across menu navigation', () => {
  it('uses valid URL, then saved selection, then the original highway default', () => {
    const saved = storage();
    expect(selectedMap(new URLSearchParams(), saved)).toBe('highway');
    saveSelectedMap('miami', saved);
    expect(selectedMap(new URLSearchParams(), saved)).toBe('miami');
    expect(selectedMap(new URLSearchParams('map=highway'), saved)).toBe('highway');
    expect(selectedMap(new URLSearchParams('map=unknown'), saved)).toBe('miami');
    saved.setItem('tcu.map', 'unknown');
    expect(selectedMap(new URLSearchParams(), saved)).toBe('highway');
  });
  it('survives blocked browser storage without masking an explicit map URL', () => {
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    expect(selectedMap(new URLSearchParams(), blocked)).toBe('highway');
    expect(selectedMap(new URLSearchParams('map=miami'), blocked)).toBe('miami');
    expect(() => saveSelectedMap('miami', blocked)).not.toThrow();
  });
  it('switches built-in instances without keeping a conflicting custom endpoint', () => {
    const before = new URL('https://example.test/?solo&server=wss%3A%2F%2Fcustom.test%2Fws&debug&lag=80#controls');
    const next = mapNavigation(before, 'miami');
    expect(next.origin).toBe(before.origin); expect(next.searchParams.get('map')).toBe('miami');
    expect(next.searchParams.has('server')).toBe(false); expect(next.searchParams.has('solo')).toBe(true);
    expect(next.searchParams.has('debug')).toBe(true); expect(next.hash).toBe('#controls');
    expect(before.searchParams.has('server')).toBe(true);
  });
  it('preserves map, custom endpoint and debug flags when switching solo/online', () => {
    const before = new URL('https://example.test/?map=miami&online&test&server=wss%3A%2F%2Fdev.test%2Fws&debug');
    const solo = modeNavigation(before, 'solo');
    expect(solo.searchParams.has('solo')).toBe(true); expect(solo.searchParams.has('online')).toBe(false);
    expect(solo.searchParams.has('test')).toBe(false); expect(solo.searchParams.get('map')).toBe('miami');
    expect(solo.searchParams.get('server')).toBe('wss://dev.test/ws'); expect(solo.searchParams.has('debug')).toBe(true);
    const online = modeNavigation(solo, 'online');
    expect(online.searchParams.has('solo')).toBe(false); expect(online.searchParams.get('map')).toBe('miami');
  });
  it('keeps Miami night independent of an old highway sky preference', () => {
    const saved = storage(); saved.setItem('tcu.sky', 'sunset');
    expect(loadMapSky('highway', 'night', saved)).toBe('sunset');
    expect(loadMapSky('miami', 'miami-night', saved)).toBe('miami-night');
    saveMapSky('miami', 'violet', saved);
    expect(loadMapSky('miami', 'miami-night', saved)).toBe('violet');
    expect(loadMapSky('highway', 'night', saved)).toBe('sunset');
  });
});
