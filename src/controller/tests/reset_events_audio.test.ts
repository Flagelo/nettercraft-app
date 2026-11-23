import { afterEach, describe, expect, it, vi } from 'vitest';
import { HemodynamicEngine } from '../../model/hemodynamics/HemodynamicEngine';
import { AuscultationSynth } from '../../model/auscultation/AuscultationSynth';
import { ElectroEngine } from '../../model/electrophysiology/ElectroEngine';
import { EventRing } from '../../model/signals/EventRing';
import { HemoEventKind as K, type ClinicalParams } from '../../model/contracts/types';

const detectorKeys = ['prevZMi', 'prevZAo', 'prevZTr', 'prevZPu', 'rapidFillingFired', 'atrialKickFired'];
const audioKeys = ['eventCursor', 'phonoEnv', 'phonoPhase', 'pendingSecondB2Time', 'pendingSecondB2Amp', 'pendingSecondB2Freq', 'lastAlarmTime', 'lastQrsBeatIndex'];
const channels = ['t', 'phi', 'phiResp', 'pAo', 'pLV', 'pLA', 'vLV', 'pRA', 'pRV', 'pPA', 'pPl', 'qAo', 'qMi', 'ivcD', 'phono', 'II'];
function fields(obj: object, keys: string[]) {
  const record = obj as Record<string, unknown>;
  return Object.fromEntries(keys.map(k => [k, record[k]]));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function boot(audioFirst = false) {
  vi.resetModules();
  const { usePhysiologyStore: store, defaultParams } = await import('../usePhysiologyStore');
  const { getSimulationLoop } = await import('../SimulationLoop');
  const loop = getSimulationLoop();
  const engine = new HemodynamicEngine();
  const audio = new AuscultationSynth();
  const electro = new ElectroEngine();
  if (audioFirst) loop.register(audio, electro, engine);
  else loop.register(engine, electro, audio);
  // Observe dispatches while leaving real synthesis/consumption/sample logic intact.
  // No AudioContext is created: these are requests, not sounds heard or PCM tests.
  const probe = audio as unknown as {
    triggerHeartSound: (f: number, tau: number, amp: number, delay?: number) => void;
    triggerMonitorQrsBeep: (map: number) => void;
    triggerMonitorAlarm: () => void;
  };
  const sounds: number[][] = []; const beeps: number[] = [];
  vi.spyOn(probe, 'triggerHeartSound').mockImplementation((f, tau, amp, delay = 0) => { sounds.push([loop.clock.state.t, f, tau, amp, delay]); });
  vi.spyOn(probe, 'triggerMonitorQrsBeep').mockImplementation(() => { beeps.push(loop.clock.state.t); });
  const alarms = vi.spyOn(probe, 'triggerMonitorAlarm');
  return { store, defaults: defaultParams, loop, engine, audio, sounds, beeps, alarms };
}
type Harness = Awaited<ReturnType<typeof boot>>;
function reset(h: Harness, p: ClinicalParams, direct = false) {
  h.store.getState().loadPreset(p);
  if (direct) h.loop.reset(); else h.store.getState().requestReset();
  h.sounds.length = h.beeps.length = 0; h.alarms.mockClear();
}
function events(h: Harness, cursor = 0) {
  const out: number[][] = [];
  h.loop.context.live.hemo.events.forEachSince(cursor, (k, t) => out.push([k, t]));
  return out;
}
function snapshot(h: Harness) {
  return structuredClone({ clock: h.loop.clock.state, detectors: fields(h.engine, detectorKeys),
    audio: fields(h.audio, audioKeys), seq: h.loop.context.live.hemo.events.seq, events: events(h) });
}
function trace(h: Harness) {
  const allEvents: number[][] = []; const states = []; let cursor = h.loop.context.live.hemo.events.seq;
  for (let i = 1; i <= 9000; i++) {
    h.loop.advance(0.001);
    allEvents.push(...events(h, cursor)); cursor = h.loop.context.live.hemo.events.seq;
    if (i % 200 === 0) states.push(snapshot(h));
  }
  const bank = h.store.getState().bank;
  return { allEvents, states, sounds: h.sounds, beeps: h.beeps, bank: channels.map(k => Array.from(bank.read(k) ?? [])),
    head: bank.head, count: bank.count, total: bank.total };
}
function vm(p: ClinicalParams) {
  Object.assign(p.ecg, { heartRate: 95, bundleBranchBlock: 'rbbb' });
  p.circulation.bloodVolume = 4000; p.drugs.nitroprusside = 3;
  Object.assign(p.ventilation, { mode: 'mechanical', peep: 12, drivingPressure: 20 });
}
function af(p: ClinicalParams) {
  Object.assign(p.ecg, { rhythm: 'af', heartRate: 130, bundleBranchBlock: 'lbbb' });
  p.circulation.bloodVolume = 6200;
  Object.assign(p.drugs, { dobutamine: 8, norepinephrine: 0.4 });
}
const targets: Array<[string, (p: ClinicalParams) => void]> = [
  ['sinus', () => {}], ['FA92', p => Object.assign(p.ecg, { rhythm: 'af', heartRate: 92 })],
  ['flutter3', p => Object.assign(p.ecg, { rhythm: 'flutter', flutterConduction: 3 })],
  ['VM', vm], ['FR0', p => { p.ventilation.respRate = 0; }],
];
async function reused(target: ClinicalParams, history: number) {
  const h = await boot(); const p = h.defaults();
  (history === 0 ? vm : af)(p); reset(h, p); h.loop.advance(history === 0 ? 3.517 : 5.233);
  reset(h, target, history === 1); return h;
}

describe('CC-P0-02: isolated warmup and deterministic phonocardiogram', () => {
  for (const [name, configure] of targets) {
    it(`${name}: t0 without residue after two independent histories`, async () => {
      const fresh = await boot(); const p = fresh.defaults(); configure(p); reset(fresh, p);
      const a = await reused(p, 0); const b = await reused(p, 1);
      console.log(JSON.stringify({ scenario: name, fresh: snapshot(fresh), historyA: snapshot(a), historyB: snapshot(b) }));
      expect.soft(snapshot(a)).toEqual(snapshot(fresh)); expect.soft(snapshot(b)).toEqual(snapshot(fresh));
      for (const h of [fresh, a, b]) {
        expect.soft(events(h)).toEqual([]); expect.soft(h.loop.context.live.hemo.events.seq).toBe(0);
        expect.soft(fields(h.audio, audioKeys)).toEqual({ eventCursor: 0, phonoEnv: 0, phonoPhase: 0,
          pendingSecondB2Time: -1, pendingSecondB2Amp: 0, pendingSecondB2Freq: 58, lastAlarmTime: -10, lastQrsBeatIndex: -1 });
        expect.soft(fields(h.engine, detectorKeys)).toEqual({ prevZMi: h.engine.y[12], prevZAo: h.engine.y[13],
          prevZTr: h.engine.y[14], prevZPu: h.engine.y[15], rapidFillingFired: false, atrialKickFired: false });
      }
    });
    it(`${name}: first 9s, first event/cycle and SignalBank equal`, async () => {
      const fresh = await boot(); const p = fresh.defaults(); configure(p); reset(fresh, p);
      const expected = trace(fresh);
      for (let history = 0; history < 2; history++) {
        const h = await reused(p, history);
        expect.soft(trace(h)).toEqual(expected);
      }
      expect(expected.allEvents.length).toBeGreaterThan(20);
      expect(expected.beeps).toEqual(expected.allEvents.filter(e => e[0] === K.QRS).map(e => e[1]));
      const b1 = expected.sounds.filter(s => s[1] === 52);
      expect(b1.map(s => s[0])).toEqual(expected.beeps);
      expect(expected.sounds.filter(s => s[1] === 46).length).toBe(b1.length);
      const b2 = expected.allEvents.filter(e => e[0] === K.AorticClose);
      expect(b2.length).toBeGreaterThan(1);
      expect(expected.sounds.filter(s => s[1] === 64).map(s => s[0])).toEqual(b2.map(e => e[1]));
      expect(expected.sounds.filter(s => s[1] === 54).length).toBe(b2.length);
      expect(expected.sounds.every(s => s[0] > 0)).toBe(true);
    });
  }

  it('three consecutive resets, references and preferences preserved', async () => {
    const h = await boot(); const p = h.defaults(); reset(h, p);
    h.audio.focus = 'pulmonary'; h.audio.piece = 'bell'; h.audio.volume = 0.31;
    h.audio.enabled = true; h.audio.monitorBeepEnabled = true;
    const refs = [h.loop.context.live, h.loop.context.clock, h.store.getState().bank, h.loop.context.live.hemo.events];
    const expected0 = snapshot(h); const expected = trace(h);
    for (let i = 0; i < 3; i++) {
      reset(h, p, i % 2 === 0);
      expect(snapshot(h)).toEqual(expected0);
      expect([h.audio.focus, h.audio.piece, h.audio.volume, h.audio.enabled, h.audio.monitorBeepEnabled]).toEqual(['pulmonary', 'bell', 0.31, true, true]);
      const nextRefs = [h.loop.context.live, h.loop.context.clock, h.store.getState().bank, h.loop.context.live.hemo.events];
      nextRefs.forEach((ref, j) => expect(ref).toBe(refs[j]));
      expect(trace(h)).toEqual(expected);
    }
  });

  it('adverse registration order, stale cursor and reset after overflow', async () => {
    const h = await boot(true); reset(h, h.defaults());
    h.loop.advance(30); // seq exceeds capacity; cursor is from the previous epoch
    expect(h.loop.context.live.hemo.events.seq).toBeGreaterThan(h.loop.context.live.hemo.events.capacity);
    const old = fields(h.audio, ['eventCursor']).eventCursor as number;
    h.loop.reset();
    expect(old).toBeGreaterThan(h.loop.context.live.hemo.events.seq);
    expect(fields(h.audio, ['eventCursor']).eventCursor).toBe(0);
    h.sounds.length = h.beeps.length = 0;
    const result = trace(h);
    expect(result.beeps).toEqual(result.allEvents.filter(e => e[0] === K.QRS).map(e => e[1]));
    expect(result.beeps.length).toBeGreaterThan(5);
    expect(result.sounds.filter(s => s[1] === 52).length).toBe(result.beeps.length);
  });

  it('ring: overflow retains only live events; clear requires realigning the cursor', () => {
    const ring = new EventRing(4);
    for (let i = 0; i < 11; i++) ring.push(K.QRS, i);
    const times: number[] = [];
    expect(ring.forEachSince(1, (_k, t) => times.push(t))).toBe(11);
    expect(times).toEqual([7, 8, 9, 10]);
    ring.clear(); const cursor = ring.seq; ring.push(K.QRS, 0.04);
    const after: number[] = [];
    expect(ring.forEachSince(cursor, (_k, t) => after.push(t))).toBe(1);
    expect(after).toEqual([0.04]); expect(ring.lastTime(K.QRS)).toBe(0.04);
  });

  it('reset with pause: no event/audio until resume and first QRS preserved', async () => {
    let now = 1000; let tick: FrameRequestCallback = () => {};
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { tick = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const h = await boot(); h.loop.start(); h.loop.advance(2.319);
    h.store.getState().setRunning(false); h.store.getState().requestReset();
    now += 100; tick(now);
    expect(h.loop.clock.state.t).toBe(0); expect(h.store.getState().bank.count).toBe(0);
    expect(events(h)).toEqual([]);
    h.sounds.length = h.beeps.length = 0;
    h.store.getState().setRunning(true);
    for (let i = 0; i < 8; i++) { now += 20; tick(now); }
    expect(h.beeps).toHaveLength(1); expect(h.sounds.filter(s => s[1] === 52)).toHaveLength(1);
    h.loop.stop();
  });
});
