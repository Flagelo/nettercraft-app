import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuscultationSynth } from './AuscultationSynth';
import { createLiveState, defaultParams } from '../../controller/usePhysiologyStore';
import { HemoEventKind as K } from '../contracts/types';

function setup() {
  const sources: any[] = [], gains: any[] = [];
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  const source = () => {
    const s = { type: 'sine', frequency: param(), buffer: null, loop: false, onended: null as null | (() => void),
      connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    sources.push(s); return s;
  };
  class MockContext {
    currentTime = 10; sampleRate = 32; destination = {}; resume = vi.fn();
    createGain() { const g = { gain: param(), connect: vi.fn(), disconnect: vi.fn() }; gains.push(g); return g; }
    createBiquadFilter() { return { type: 'lowpass', frequency: param(), Q: param(), connect: vi.fn() }; }
    createBuffer() { return { getChannelData: () => new Float32Array(64) }; }
    createBufferSource = source;
    createOscillator = source;
  }
  vi.stubGlobal('window', { AudioContext: MockContext });
  const live = createLiveState(), params = defaultParams(), ctx = { live, params, clock: live.clock };
  live.hemo.map = 90; live.hemo.lvedp = 9; live.hemo.lvEes = 2.2; live.hemo.papMean = 15;
  const audio = new AuscultationSynth(); audio.toggleEnabled(); audio.toggleMonitorBeep(); audio.reset(ctx);
  // Resume the persistent murmur generator through the public SimSystem frame contract.
  ctx.clock.t = 0.001; (audio as any).frame?.(0.016, ctx);
  const active = () => sources.filter(s => !s.disconnect.mock.calls.length);
  const dispatch = (kind: K) => { live.hemo.events.push(kind, ctx.clock.t); audio.step(0.001, ctx); };
  return { audio, ctx, sources, gains, active, dispatch };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('CC-P0-07: cancellation of actual Web Audio sources', () => {
  it('C1 cancels B1/B2, QRS beep, future alarm notes and continuous noise, then empties the registry', () => {
    const h = setup(); h.dispatch(K.QRS); h.dispatch(K.AorticClose);
    h.ctx.live.hemo.map = 40; h.ctx.clock.t = 4; h.audio.step(0.001, h.ctx);
    const active = h.active();
    expect(active.length).toBeGreaterThanOrEqual(8);
    expect(active.some(s => (s.start.mock.calls[0]?.[0] ?? 0) > 10)).toBe(true);
    h.audio.reset(h.ctx);
    for (const s of active) { expect(s.stop).toHaveBeenCalledWith(0); expect(s.disconnect).toHaveBeenCalledTimes(1); }
    expect((h.audio as any).scheduledSources.size).toBe(0);
    expect(h.active()).toHaveLength(0);
  });

  it.each([K.QRS, K.AorticClose])('C2 repeated reset during event %s and while paused leaves no orphan', kind => {
    const h = setup();
    for (let i = 0; i < 6; i++) {
      h.ctx.clock.beatIndex++; h.ctx.clock.t += 0.1;
      (h.audio as any).frame?.(0.016, h.ctx); h.dispatch(kind);
      const pending = h.active(); expect(pending.length).toBeGreaterThan(0);
      expect(() => { h.audio.reset(h.ctx); h.audio.reset(h.ctx); }).not.toThrow();
      for (const s of pending) expect(s.disconnect).toHaveBeenCalledTimes(1);
      expect(h.active()).toHaveLength(0);
    }
  });

  it('C2 tolerates a source whose stop reports an already ended source and still disconnects the others', () => {
    const h = setup(); h.dispatch(K.QRS);
    const active = h.active(); active[0].stop.mockImplementation(() => { throw new DOMException('ended', 'InvalidStateError'); });
    expect(() => h.audio.reset(h.ctx)).not.toThrow();
    active.forEach(s => expect(s.disconnect).toHaveBeenCalledTimes(1));
    expect(h.active()).toHaveLength(0);
  });

  it('releases ended transients and their gain nodes before the next reset', () => {
    const h = setup(); h.dispatch(K.QRS);
    const transient = h.active().filter(s => !s.loop);
    expect(transient).toHaveLength(3);
    for (const s of transient) { expect(s.onended).toBeTypeOf('function'); s.onended(); expect(s.disconnect).toHaveBeenCalledTimes(1); }
    expect((h.audio as any).scheduledSources.size).toBe(1);
    expect(h.gains.slice(-3).every(g => g.disconnect.mock.calls.length === 1)).toBe(true);
    h.audio.reset(h.ctx);
    transient.forEach(s => expect(s.disconnect).toHaveBeenCalledTimes(1));
  });

  it('preserves context, fixed graph, preferences and listeners', () => {
    const h = setup(); h.audio.setFocus('pulmonary'); h.audio.setPiece('bell'); h.audio.setVolume(0.31);
    const record = h.audio as any, keys = ['ctx','masterGain','monitorGain','pieceFilter','murmurFilter','murmurGain'];
    const before = keys.map(k => record[k]), listener = vi.fn(); h.audio.subscribe(listener);
    h.audio.reset(h.ctx); keys.forEach((k,i) => expect(record[k]).toBe(before[i]));
    expect([h.audio.focus,h.audio.piece,h.audio.volume,h.audio.enabled,h.audio.monitorBeepEnabled]).toEqual(['pulmonary','bell',0.31,true,true]);
    expect(listener).not.toHaveBeenCalled(); h.audio.setFocus('aortic'); expect(listener).toHaveBeenCalledTimes(1);
  });

  it('cancels the old murmur envelope and restarts noise only after a new physics step', () => {
    const h = setup(), gain = (h.audio as any).murmurGain.gain;
    h.audio.reset(h.ctx);
    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(10);
    expect(gain.setValueAtTime).toHaveBeenCalledWith(0, 10);
    const n = h.sources.length;
    for (let i = 0; i < 6; i++) (h.audio as any).frame?.(0.016, h.ctx);
    expect(h.sources).toHaveLength(n); expect(h.active()).toHaveLength(0);
    h.ctx.clock.t += 0.001; (h.audio as any).frame?.(0.016, h.ctx);
    expect(h.active()).toHaveLength(1); expect(h.active()[0].loop).toBe(true);
    h.dispatch(K.QRS); expect(h.active()).toHaveLength(4);
  });
});
