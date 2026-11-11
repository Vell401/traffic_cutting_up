import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Post } from '../src/render/post';
import { View } from '../src/render/view';
import { QUALITY } from '../src/settings';

vi.mock('postprocessing', async () => {
  const T = await import('three');
  class Effect { offset = new T.Vector2(); enabled = true; }
  return {
    BloomEffect: Effect, ChromaticAberrationEffect: Effect, EffectPass: Effect,
    LUT3DEffect: Effect, LookupTexture: Effect, RenderPass: Effect,
    ToneMappingEffect: Effect, ToneMappingMode: { ACES_FILMIC: 1 }, VignetteEffect: Effect,
    EffectComposer: class { addPass() {} setSize() {} render = vi.fn(); },
  };
});

function harness() {
  const post = new Post({ capabilities: { maxSamples: 4 } } as THREE.WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera(), QUALITY.medium);
  const state = post as unknown as { caPass: { enabled: boolean }; ca: { offset: THREE.Vector2 } };
  const chase = { kick: vi.fn() };
  const view = Object.assign(Object.create(View.prototype), { post, chase, scoreDistortion: 0 }) as View;
  const feedback = (kick: number, pulse: number) => (view as unknown as { scoreFeedback(kick: number, pulse: number): void }).scoreFeedback(kick, pulse);
  return { view, post, state, chase, feedback };
}

describe('optional near-miss/speed distortion', () => {
  it('defaults to no score camera kick or chromatic-aberration pass even at high speed', () => {
    const { post, state, chase, feedback } = harness();
    feedback(.25, .8); feedback(.35, .9); post.render(0, 320);
    expect(chase.kick).not.toHaveBeenCalled();
    expect(state.caPass.enabled).toBe(false); expect(state.ca.offset.x).toBe(0);
  });

  it('scales camera kick and aberration together and clears score pulses when disabled', () => {
    const { view, post, state, chase, feedback } = harness();
    view.setScoreDistortion(.5); feedback(.25, .8); post.render(0, 320);
    expect(chase.kick).toHaveBeenLastCalledWith(.125);
    expect(state.ca.offset.x).toBeCloseTo((.0016 + .8 * .004) * .5);
    expect(state.caPass.enabled).toBe(true);
    view.setScoreDistortion(0); post.render(0, 320);
    expect(state.caPass.enabled).toBe(false); expect(state.ca.offset.x).toBe(0);
    view.setScoreDistortion(1); post.render(0, 0);
    expect(state.ca.offset.x).toBe(0); // No stale near-miss pulse when re-enabled.
  });

  it('preserves impact feedback independently of the disabled score effect', () => {
    const { post, state } = harness();
    post.pulse(1); post.render(0, 0);
    expect(state.caPass.enabled).toBe(true); expect(state.ca.offset.x).toBe(.004);
    post.render(1, 0); expect(state.caPass.enabled).toBe(false);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('treats invalid/negative levels as off (%s)', level => {
    const { view, post, state } = harness();
    view.setScoreDistortion(level); post.scorePulse(1); post.render(0, 320);
    expect(state.caPass.enabled).toBe(false);
  });
});
