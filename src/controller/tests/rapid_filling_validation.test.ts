import { afterEach, describe, expect, it, vi } from 'vitest';
import { HemodynamicEngine } from '../../model/hemodynamics/HemodynamicEngine';
import { ElectroEngine } from '../../model/electrophysiology/ElectroEngine';
import { AuscultationSynth } from '../../model/auscultation/AuscultationSynth';
import { HemoEventKind as K, type Rhythm } from '../../model/contracts/types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function boot(rhythm: Rhythm = 'sinus', hr = 72, mode = 'spontaneous', respRate = 14) {
  vi.resetModules();
  const { usePhysiologyStore: store, defaultParams } = await import('../usePhysiologyStore');
  const { getSimulationLoop } = await import('../SimulationLoop');
  const loop = getSimulationLoop(), audio = new AuscultationSynth(), engine = new HemodynamicEngine();
  loop.register(engine, new ElectroEngine(), audio);
  const p = defaultParams();
  p.ecg.rhythm = rhythm; p.ecg.heartRate = hr; p.ecg.flutterConduction = 3;
  p.echo.lvef = 25; p.echo.septum = p.echo.posteriorWall = 14;
  p.circulation.baroreflex = false;
  p.ventilation.mode = mode === 'mechanical' ? 'mechanical' : 'spontaneous';
  p.ventilation.respRate = respRate;
  if (mode === 'mechanical') p.ventilation.peep = 12;
  store.getState().loadPreset(p); loop.reset();
  const sounds: { frequency: number; t: number; delay: number }[] = [];
  const probe = audio as unknown as { triggerHeartSound(f: number, tau: number, amp: number, delay?: number): void };
  vi.spyOn(probe, 'triggerHeartSound').mockImplementation((frequency, _tau, _amp, delay = 0) => {
    sounds.push({ frequency, t: loop.clock.state.t, delay });
  });
  return { loop, store, engine, sounds };
}

type Harness = Awaited<ReturnType<typeof boot>>;
function observe(h: Harness, seconds: number) {
  const events: { kind: K; t: number }[] = [];
  let cursor = h.loop.context.live.hemo.events.seq, latestQrs = -Infinity, rapidInInterval = 0;
  const volume = h.engine.y.slice(0, 8).reduce((a, b) => a + b, 0);
  for (let i = 0; i < seconds * 1000; i++) {
    h.loop.advance(.001);
    cursor = h.loop.context.live.hemo.events.forEachSince(cursor, (kind, t) => {
      events.push({ kind, t });
      const c = h.loop.clock.state;
      if (kind === K.QRS) { latestQrs = t; rapidInInterval = 0; }
      if (kind === K.RapidFillingEnd) {
        expect(Number.isFinite(latestQrs), 'QRS must belong to this observable epoch').toBe(true);
        expect(t - latestQrs).toBeGreaterThan(c.ts + .16 - 1e-10);
        expect(c.tInBeat).toBeGreaterThanOrEqual(c.pr);
        expect(++rapidInInterval, 'at most one B3 trigger per QRS interval').toBe(1);
      }
      if (kind === K.AtrialKick) {
        expect(c.atrialActive).toBe(true);
        expect(c.tSinceP).toBeGreaterThan(.05);
        expect(c.tSinceP).toBeLessThan(.08);
      }
    });
    expect(h.engine.y.every(Number.isFinite)).toBe(true);
    expect(Math.abs(h.engine.y.slice(0, 8).reduce((a, b) => a + b, 0) - volume)).toBeLessThan(1e-7);
  }
  const times = (kind: K) => events.filter(e => e.kind === kind).map(e => e.t);
  const soundTimes = (frequency: number) => h.sounds.filter(s => s.frequency === frequency).map(s => s.t);
  // Dispatch contracts only: this probe does not schedule Web Audio or produce PCM.
  expect(soundTimes(52)).toEqual(times(K.QRS));
  expect(soundTimes(46)).toEqual(times(K.QRS));
  expect(h.sounds.filter(s => s.frequency === 52).every(s => s.delay === .018)).toBe(true);
  expect(h.sounds.filter(s => s.frequency === 46).every(s => s.delay === .04)).toBe(true);
  expect(soundTimes(64)).toEqual(times(K.AorticClose));
  expect(soundTimes(54)).toEqual(times(K.AorticClose));
  expect(soundTimes(28)).toEqual(times(K.RapidFillingEnd));
  expect(soundTimes(30)).toEqual(times(K.AtrialKick));
  expect(times(K.QRS).length).toBeGreaterThanOrEqual(2);
  return { events, times };
}

describe('B3 validation beyond the frozen first-QRS test', () => {
  for (const rhythm of ['sinus', 'af', 'flutter'] as const) {
    for (const hr of [20, 40, 72, 150, 250]) {
      it(`${rhythm} HR command ${hr}: QRS epochs, sound dispatch and conserved physics`, async () => {
        const h = await boot(rhythm, hr);
        const r = observe(h, 7);
        // At short RR the legacy temporal window may not fit. No invented B3 is required.
        if (hr <= 72 || rhythm === 'flutter') expect(r.times(K.RapidFillingEnd).length).toBeGreaterThan(0);
        if (rhythm !== 'sinus') expect(r.times(K.AtrialKick)).toHaveLength(0);
        else expect(r.times(K.AtrialKick)[0]).toBeLessThan(r.times(K.QRS)[0]);
      });
    }
  }
  for (const [mode, respRate] of [['mechanical', 14], ['spontaneous', 0]] as const) {
    it(`${mode} FR ${respRate}: consecutive resets preserve the first two cycles`, async () => {
      const h = await boot('sinus', 72, mode, respRate);
      const baseline = observe(h, 3).events;
      for (let reset = 0; reset < 3; reset++) {
        h.store.getState().requestReset(); h.sounds.length = 0;
        expect(h.loop.clock.state.t).toBe(0);
        expect(h.loop.context.live.hemo.events.seq).toBe(0);
        expect(observe(h, 3).events).toEqual(baseline);
      }
    });
  }
  it('pause, resume and repeated paused reset keep QRS and B4 contracts', async () => {
    let now = 1000, id = 0;
    const pending = new Map<number, FrameRequestCallback>();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { pending.set(++id, cb); return id; });
    vi.stubGlobal('cancelAnimationFrame', (n: number) => pending.delete(n));
    const frame = (dt: number) => {
      now += dt; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(cb => cb(now));
    };
    const h = await boot(); h.loop.start(); frame(100);
    h.store.getState().setRunning(false);
    const t = h.loop.clock.state.t; frame(100); expect(h.loop.clock.state.t).toBe(t);
    for (let i = 0; i < 3; i++) { h.store.getState().requestReset(); frame(100); }
    expect(h.loop.clock.state.t).toBe(0); expect(h.loop.context.live.hemo.events.seq).toBe(0);
    h.sounds.length = 0; h.store.getState().setRunning(true);
    // Real frame path resumes the clock, with B4 allowed before QRS.
    frame(60); expect(h.loop.clock.state.t).toBeGreaterThan(0);
    expect(h.loop.context.live.hemo.events.lastTime(K.AtrialKick)).toBeGreaterThan(0);
    expect(h.loop.context.live.hemo.events.lastTime(K.QRS)).toBe(-Infinity);
    expect(h.loop.context.live.hemo.events.lastTime(K.RapidFillingEnd)).toBe(-Infinity);
    frame(100);
    expect(h.loop.context.live.hemo.events.lastTime(K.QRS)).toBeGreaterThan(0);
    expect(h.loop.context.live.hemo.events.lastTime(K.RapidFillingEnd)).toBe(-Infinity);
    h.loop.stop(); expect(pending.size).toBe(0);
  });
});
