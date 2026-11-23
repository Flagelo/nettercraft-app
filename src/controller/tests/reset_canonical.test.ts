import { afterEach, describe, expect, it, vi } from 'vitest';
import { MasterPhysiologyClock, type ClockCommand } from '../MasterPhysiologyClock';
import type { ClinicalParams, ClockState, SimSystem } from '../../model/contracts/types';
import { HemodynamicEngine } from '../../model/hemodynamics/HemodynamicEngine';

const channels = ['t', 'phi', 'phiResp', 'pAo', 'pLV', 'pLA', 'vLV', 'pRA', 'pRV', 'pPA', 'pPl', 'qAo', 'qMi', 'ivcD'];
const cmd: ClockCommand = { hr: 72, rhythm: 'sinus', flutterConduction: 2, qtc: 0.41, respRate: 14, inspFraction: 1 / 3 };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function boot() {
  // Each import graph owns a fresh Zustand store and singleton. Old graphs remain independent.
  vi.resetModules();
  const { usePhysiologyStore, defaultParams } = await import('../usePhysiologyStore');
  const { getSimulationLoop } = await import('../SimulationLoop');
  const loop = getSimulationLoop();
  const engine = new HemodynamicEngine();
  loop.register(engine);
  return { store: usePhysiologyStore, defaults: defaultParams, loop, engine };
}
type Harness = Awaited<ReturnType<typeof boot>>;

function mechanical(p: ClinicalParams): void {
  Object.assign(p.ecg, { heartRate: 95 });
  Object.assign(p.circulation, { bloodVolume: 4000 });
  Object.assign(p.drugs, { nitroprusside: 3 });
  Object.assign(p.ventilation, { mode: 'mechanical', peep: 12, drivingPressure: 20 });
}
function afHistory(p: ClinicalParams): void {
  Object.assign(p.ecg, { rhythm: 'af', heartRate: 130 });
  Object.assign(p.circulation, { bloodVolume: 6200 });
  Object.assign(p.drugs, { dobutamine: 8, norepinephrine: 0.4 });
  Object.assign(p.ventilation, { respRate: 22, spontaneousEffort: 8 });
}
const cases: Array<{ name: string; history: (p: ClinicalParams) => void; target: (p: ClinicalParams) => void; viaStore: boolean }> = [
  { name: 'nominal após VM/hipovolemia/NPS', history: mechanical, target: () => {}, viaStore: true },
  { name: 'VM/NPS após FA/drogas', history: afHistory, target: mechanical, viaStore: false },
  { name: 'FA FC92 após VM', history: mechanical, target: p => Object.assign(p.ecg, { rhythm: 'af', heartRate: 92 }), viaStore: true },
  { name: 'flutter 3:1 após FA', history: afHistory, target: p => Object.assign(p.ecg, { rhythm: 'flutter', flutterConduction: 3 }), viaStore: false },
  { name: 'sinus FC115/FR22 após flutter', history: p => Object.assign(p.ecg, { rhythm: 'flutter', flutterConduction: 4 }), target: p => { p.ecg.heartRate = 115; p.ventilation.respRate = 22; }, viaStore: true },
  { name: 'FR zero após VM', history: mechanical, target: p => { p.ventilation.respRate = 0; }, viaStore: true },
];

function reset(h: Harness, params: ClinicalParams, viaStore = true): void {
  h.store.getState().loadPreset(params);
  if (viaStore) h.store.getState().requestReset();
  else h.loop.reset();
}
function snapshot(h: Harness) {
  const { events, ...hemo } = h.loop.context.live.hemo;
  // These warmup event detector fields belong to P2b, declared before execution.
  const eventFields = new Set(['prevZMi', 'prevZAo', 'prevZTr', 'prevZPu', 'rapidFillingFired', 'atrialKickFired']);
  const engine = Object.fromEntries(Object.entries(h.engine).filter(([k]) => !eventFields.has(k)));
  const bank = h.store.getState().bank;
  return structuredClone({ clock: h.loop.clock.state, hemo, engine,
    bank: { head: bank.head, count: bank.count, total: bank.total, latest: channels.map(k => bank.latest(k)) } });
}
function activeEvents(h: Harness, cursor: number) {
  const events: Array<[number, number]> = [];
  h.loop.context.live.hemo.events.forEachSince(cursor, (k, t) => events.push([k, t]));
  return events;
}
function bankSequence(h: Harness) {
  const bank = h.store.getState().bank;
  return channels.map(k => Array.from({ length: bank.count }, (_, i) => bank.latest(k, bank.count - 1 - i)));
}
function trajectory(h: Harness, seconds = 9) {
  const cursor = h.loop.context.live.hemo.events.seq;
  const states = [snapshot(h)];
  let respiratoryBoundaries = 0;
  for (let i = 1; i <= seconds * 1000; i++) {
    const prevPhi = h.loop.clock.state.phiResp;
    h.loop.advance(0.001);
    const boundary = h.loop.clock.state.phiResp < prevPhi;
    if (boundary) respiratoryBoundaries++;
    if (i % 200 === 0 || boundary) states.push(snapshot(h));
  }
  return { states, respiratoryBoundaries, bank: bankSequence(h), events: activeEvents(h, cursor) };
}

describe('CC-P0-01 — public canonical reset (pre-registered criteria)', () => {
  for (const c of cases) it(c.name, async () => {
    const fresh = await boot();
    const target = fresh.defaults(); c.target(target);
    reset(fresh, target, c.viaStore);
    const expected0 = snapshot(fresh);
    const expected = trajectory(fresh);
    const reused = await boot();
    const history = reused.defaults(); c.history(history);
    reset(reused, history);
    reused.loop.advance(12.001);
    const refs = { live: reused.loop.context.live, clock: reused.loop.clock.state, bank: reused.store.getState().bank };
    reset(reused, target, c.viaStore);
    expect(reused.loop.context.live).toBe(refs.live);
    expect(reused.loop.context.clock).toBe(refs.clock);
    expect(reused.store.getState().bank).toBe(refs.bank);
    expect(snapshot(reused), 'fresh/reused em t0').toEqual(expected0);
    expect(trajectory(reused), 'fresh/reused em evolução e sinais/eventos ativos').toEqual(expected);
    expect(expected.respiratoryBoundaries).toBe(target.ventilation.respRate > 0 ? Math.floor(9 * target.ventilation.respRate / 60) : 0);
    // The legacy base has no validity flags: equality must not imply valid respiratory metrics.
    expect('flowMetrics' in reused.loop.context.live.hemo).toBe(false);
    expect('respMetrics' in reused.loop.context.live.hemo).toBe(false);
  });

  for (const rhythm of ['sinus', 'af', 'flutter'] as const) it(`complete ClockState/RNG/listeners: ${rhythm}`, () => {
    const command = { ...cmd, rhythm, inspFraction: 0.42 };
    const fresh = new MasterPhysiologyClock(8471);
    const reused = new MasterPhysiologyClock(8471);
    fresh.formula = reused.formula = 'bazett';
    const ref = reused.state;
    reused.reset({ ...cmd, rhythm: 'af', hr: 130, inspFraction: 0.2 });
    for (let i = 0; i < 7333; i++) reused.step(0.001, { ...cmd, rhythm: 'af', hr: 130 });
    let seen: ClockState | undefined;
    const listener = vi.fn((s: ClockState) => { seen = { ...s }; });
    const unsubscribe = reused.addListener({ onBeatStart: listener });
    fresh.reset(command); reused.reset(command);
    expect(reused.state).toBe(ref);
    expect(seen).toEqual(fresh.state);
    expect(reused.formula).toBe('bazett');
    for (let cycle = 0; cycle < 3; cycle++) {
      fresh.reset(command); reused.reset(command);
      expect(reused.state).toEqual(fresh.state);
      for (let i = 0; i < 5000; i++) {
        fresh.step(0.001, command); reused.step(0.001, command);
        expect(reused.state).toEqual(fresh.state);
      }
    }
    expect(listener.mock.calls.length).toBeGreaterThan(3);
    unsubscribe(); const calls = listener.mock.calls.length;
    reused.reset(command);
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('distinct seed changes AF; reset repeats the series and applies zero inspiration', () => {
    function series(seed: number) {
      const c = new MasterPhysiologyClock(seed);
      const command = { ...cmd, rhythm: 'af' as const, inspFraction: 0 };
      c.reset(command);
      expect(c.state.isInspiration).toBe(false);
      const result = [c.state.rr];
      for (let i = 0; i < 4000; i++) { c.step(0.001, command); result.push(c.state.rr); }
      c.reset(command);
      expect(c.state.rr).toBe(result[0]);
      return result;
    }
    expect(series(1)).toEqual(series(1));
    expect(series(1)).not.toEqual(series(2));
  });

  it('consecutive resets keep state and initial sampling at 2 ms', async () => {
    const h = await boot(); reset(h, h.defaults());
    const initial = snapshot(h);
    for (let i = 0; i < 3; i++) {
      h.loop.advance(0.013);
      h.store.getState().requestReset();
      expect(snapshot(h)).toEqual(initial);
      h.loop.advance(0.001); expect(h.store.getState().bank.count).toBe(0);
      h.loop.advance(0.001); expect(h.store.getState().bank.count).toBe(1);
      expect(h.store.getState().bank.latest('t')).toBe(Math.fround(0.002));
    }
  });

  it('physiological feedback remains active across resets and after clinical changes', async () => {
    const h = await boot(); reset(h, h.defaults());
    h.loop.context.live.hemo.hrCommand = 140;
    const rr = h.loop.clock.state.rr;
    h.loop.advance(0.001);
    expect(h.loop.clock.state.rr).toBe(rr + (60 / 140 - rr) * 0.002);
    h.store.getState().patch('ecg', { heartRate: 95 });
    h.loop.advance(1);
    expect(h.loop.context.live.hemo.hrCommand).not.toBe(140);
    expect(h.loop.context.live.hemo.hrCommand).not.toBe(72);
    expect(Number.isFinite(h.loop.context.live.hemo.pLV)).toBe(true);
  });

  it('pause/reset/timeScale and StrictMode lifecycle keep a single rAF/system', async () => {
    let now = 1000; let nextId = 0;
    const pending = new Map<number, FrameRequestCallback>();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { pending.set(++nextId, cb); return nextId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
    function frame(dt: number) {
      now += dt;
      const entries = [...pending]; pending.clear();
      for (const [, cb] of entries) cb(now);
    }
    const h = await boot();
    const monitor = { id: 'lifecycle-monitor', order: 50, reset: vi.fn(), step: vi.fn() } satisfies SimSystem;
    h.loop.register(monitor); h.loop.register(monitor);
    expect(monitor.reset).toHaveBeenCalledTimes(1);
    h.loop.start();
    expect(monitor.reset).toHaveBeenCalledTimes(2);
    expect(pending.size).toBe(1);
    frame(17);
    const t = h.loop.clock.state.t;
    expect(t).toBeGreaterThan(0);
    h.loop.start(); expect(h.loop.clock.state.t).toBe(t); expect(pending.size).toBe(1);
    h.store.getState().setRunning(false); h.store.getState().setTimeScale(0.5);
    frame(100); expect(h.loop.clock.state.t).toBe(t);
    h.store.getState().requestReset();
    expect(h.store.getState().running).toBe(false);
    expect(h.store.getState().timeScale).toBe(0.5);
    expect(h.loop.physicsMs).toBe(0); expect(h.loop.lastSubsteps).toBe(0);
    expect(h.loop.clock.state.t).toBe(0); expect(h.store.getState().bank.count).toBe(0);
    frame(100); expect(h.loop.clock.state.t).toBe(0);
    h.store.getState().setRunning(true);
    frame(4); expect(h.loop.clock.state.t).toBe(0.002);
    expect(h.store.getState().bank.count).toBe(1);
    h.loop.stop(); h.loop.stop(); expect(pending.size).toBe(0);
    h.loop.register(monitor); h.loop.start();
    expect(pending.size).toBe(1); expect(h.loop.clock.state.t).toBe(0);
    expect(h.store.getState().bank.count).toBe(0);
    const steps = monitor.step.mock.calls.length;
    frame(4); expect(monitor.step.mock.calls.length - steps).toBe(2);
    h.loop.stop(); expect(pending.size).toBe(0);
    h.loop.unregister(monitor.id); expect(h.loop.hasSystem(monitor.id)).toBe(false);
    h.loop.start(); frame(4); expect(monitor.step.mock.calls.length - steps).toBe(2);
    h.loop.stop();
  });
});
