import { afterEach, expect, it, vi } from 'vitest';
import { HemodynamicEngine } from '../../model/hemodynamics/HemodynamicEngine';
import { AuscultationSynth } from '../../model/auscultation/AuscultationSynth';
import { ElectroEngine } from '../../model/electrophysiology/ElectroEngine';
import { HemoEventKind as K } from '../../model/contracts/types';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('warmup neither publishes nor erases events from another producer; detectors start at the initial valves', async () => {
  vi.resetModules();
  const { defaultParams, createLiveState } = await import('../usePhysiologyStore');
  const live = createLiveState(), params = defaultParams();
  const ctx = { live, params, clock: live.clock };
  live.hemo.events.push(K.QRS, 0);
  const audio = new AuscultationSynth(); audio.reset(ctx);
  const engine = new HemodynamicEngine();
  const state = engine as unknown as Record<string, unknown>;
  state.prevZMi = 0; state.prevZAo = 1; state.prevZTr = 0; state.prevZPu = 1;
  state.rapidFillingFired = state.atrialKickFired = true;
  let first = true;
  const step = engine.step.bind(engine);
  vi.spyOn(engine, 'step').mockImplementation((h, c) => {
    if (first) {
      expect([state.prevZMi, state.prevZAo, state.prevZTr, state.prevZPu]).toEqual(Array.from(engine.y.slice(12)));
      expect([state.rapidFillingFired, state.atrialKickFired]).toEqual([false, false]);
      first = false;
    }
    step(h, c);
  });
  engine.reset(ctx);
  expect(first).toBe(false);
  expect(live.hemo.events.seq).toBe(1);
  expect(live.hemo.events.lastTime(K.QRS)).toBe(0);
  expect((audio as unknown as { eventCursor: number }).eventCursor).toBe(1);
});

it('mocked Web Audio: reset with pending B2 keeps graph/preferences without scheduling residual transients', async () => {
  vi.resetModules();
  const { usePhysiologyStore: store } = await import('../usePhysiologyStore');
  const { getSimulationLoop } = await import('../SimulationLoop');
  const starts: number[] = [];
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  class MockContext {
    currentTime = 10; sampleRate = 32; destination = {};
    resume = vi.fn();
    createGain() { return { gain: param(), connect: vi.fn() }; }
    createBiquadFilter() { return { type: 'lowpass', frequency: param(), Q: param(), connect: vi.fn() }; }
    createBuffer() { return { getChannelData: () => new Float32Array(64) }; }
    createBufferSource() { return { connect: vi.fn(), start: vi.fn() }; }
    createOscillator() { return { type: 'sine', frequency: param(), connect: vi.fn(), start: (t: number) => starts.push(t), stop: vi.fn() }; }
  }
  vi.stubGlobal('window', { AudioContext: MockContext });
  const loop = getSimulationLoop(), audio = new AuscultationSynth();
  loop.register(new HemodynamicEngine(), new ElectroEngine(), audio); loop.reset();
  audio.setFocus('pulmonary'); audio.setPiece('bell'); audio.setVolume(0.31);
  audio.toggleEnabled(); audio.toggleMonitorBeep();
  const record = audio as unknown as Record<string, unknown>;
  const graph = ['ctx','masterGain','monitorGain','pieceFilter','murmurGain','murmurFilter'].map(k=>record[k]);
  const listener = vi.fn(); audio.subscribe(listener);
  const ctx=loop.context;
  ctx.clock.t = 1; ctx.live.hemo.events.push(K.AorticClose, 1); audio.step(0.001,ctx);
  expect(record.pendingSecondB2Time as number).toBeGreaterThan(1);
  expect(starts).toHaveLength(2);
  const resetState = () => {
    expect([record.phonoPhase,record.pendingSecondB2Time,record.pendingSecondB2Amp,record.pendingSecondB2Freq]).toEqual([0,-1,0,58]);
    graph.forEach((node,i)=>expect(record[['ctx','masterGain','monitorGain','pieceFilter','murmurGain','murmurFilter'][i]]).toBe(node));
    expect([audio.focus,audio.piece,audio.volume,audio.enabled,audio.monitorBeepEnabled]).toEqual(['pulmonary','bell',0.31,true,true]);
  };
  loop.reset(); resetState();
  expect(starts).toHaveLength(2); expect(listener).not.toHaveBeenCalled();
  // No elapsed time or new events: sampling itself must not schedule sound.
  audio.sample(store.getState().bank,ctx); expect(starts).toHaveLength(2);
  // First real QRS after reset still schedules exactly one beep + M1 + T1.
  // Disable critical alarms only via noncritical clinical state in this isolated dispatch check.
  ctx.live.hemo.map=90; ctx.live.hemo.lvedp=9; ctx.clock.hr=72;
  ctx.clock.t=0.16; ctx.live.hemo.events.push(K.QRS,0.16); audio.step(0.001,ctx);
  expect(starts).toHaveLength(5);
  audio.step(0.001,ctx); expect(starts).toHaveLength(5);
  audio.setFocus('aortic'); expect(listener).toHaveBeenCalledTimes(1);
});

it('first cycle restores B3/B4 triggers and real ECG channels without interpreting PPV/IVC as valid', async () => {
  vi.resetModules();
  const { usePhysiologyStore: store, defaultParams } = await import('../usePhysiologyStore');
  const { getSimulationLoop } = await import('../SimulationLoop');
  const loop=getSimulationLoop(), audio=new AuscultationSynth();
  loop.register(new HemodynamicEngine(),new ElectroEngine(),audio);
  const p=defaultParams(); p.echo.lvef=25; p.echo.septum=p.echo.posteriorWall=14;
  store.getState().loadPreset(p); loop.reset();
  const result: number[][]=[];
  for(let i=0;i<150;i++) {
    const cursor=loop.context.live.hemo.events.seq; loop.advance(.001);
    loop.context.live.hemo.events.forEachSince(cursor,(k,t)=>result.push([k,t]));
  }
  expect(result.filter(e=>e[0]===K.AtrialKick)).toHaveLength(1);
  // The reset starts before the first QRS: pre-QRS B3 is an artifact, not a heart sound.
  expect(result.filter(e=>e[0]===K.RapidFillingEnd)).toHaveLength(0);
  for(let i=0;i<1500;i++) {
    const cursor=loop.context.live.hemo.events.seq; loop.advance(.001);
    loop.context.live.hemo.events.forEachSince(cursor,(k,t)=>result.push([k,t]));
  }
  const firstQrs = result.find(e=>e[0]===K.QRS);
  const firstRapid = result.find(e=>e[0]===K.RapidFillingEnd);
  expect(firstQrs).toBeDefined();
  expect(firstRapid).toBeDefined();
  expect(firstRapid![1]).toBeGreaterThan(firstQrs![1]);
  expect(store.getState().bank.read('ecg_II')?.some(v=>v!==0)).toBe(true);
  expect(store.getState().bank.read('phono')?.some(v=>v!==0)).toBe(true);
  expect('respMetrics' in loop.context.live.hemo).toBe(false);
});
