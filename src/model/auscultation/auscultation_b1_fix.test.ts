import { describe, expect, it, vi } from 'vitest';
import { AuscultationSynth } from './AuscultationSynth';
import { MasterPhysiologyClock, type ClockCommand } from '../../controller/MasterPhysiologyClock';
import { defaultParams, createLiveState } from '../../controller/usePhysiologyStore';
import type { ClinicalParams, SimContext } from '../contracts/types';
import { HemoEventKind } from '../contracts/types';
import { HemodynamicEngine } from '../hemodynamics/HemodynamicEngine';

interface SoundDispatch {
  freq: number;
  tauSec: number;
  gainAmp: number;
  delaySec: number;
  tSim: number;
  scheduledTimeMs: number;
  offsetMs: number;
  eventKindAtDispatch: HemoEventKind | null;
}

interface BeepDispatch {
  map: number;
  tSim: number;
  offsetMs: number;
  eventKindAtDispatch: HemoEventKind | null;
}

interface CycleData {
  cycleIndex: number;
  tQrs: number;
  tNextQrs: number;
  rrMs: number;
  m1: SoundDispatch[];
  t1: SoundDispatch[];
  beeps: BeepDispatch[];
  a2: SoundDispatch[];
  p2: SoundDispatch[];
  b3: SoundDispatch[];
  b4: SoundDispatch[];
  mitralCloseDispatches: number;
  tricuspidCloseDispatches: number;
}

interface ScenarioDef {
  id: string;
  label: string;
  mut: (p: ClinicalParams) => void;
}

const SCENARIOS: ScenarioDef[] = [
  { id: 'sinus50', label: 'Sinusal FC 50', mut: (p) => { p.ecg.heartRate = 50; } },
  { id: 'sinus75', label: 'Sinusal FC 75', mut: (p) => { p.ecg.heartRate = 75; } },
  { id: 'sinus100', label: 'Sinusal FC 100', mut: (p) => { p.ecg.heartRate = 100; } },
  { id: 'sinus130', label: 'Sinusal FC 130', mut: (p) => { p.ecg.heartRate = 130; } },
  { id: 'sinus150', label: 'Sinusal FC 150', mut: (p) => { p.ecg.heartRate = 150; } },
  { id: 'brd75', label: 'BRD 75', mut: (p) => { p.ecg.heartRate = 75; p.ecg.bundleBranchBlock = 'rbbb'; } },
  { id: 'bre75', label: 'BRE 75', mut: (p) => { p.ecg.heartRate = 75; p.ecg.bundleBranchBlock = 'lbbb'; } },
  { id: 'fa75', label: 'FA 75', mut: (p) => { p.ecg.heartRate = 75; p.ecg.rhythm = 'af'; } },
  { id: 'flutter41', label: 'Flutter 4:1', mut: (p) => { p.ecg.rhythm = 'flutter'; p.ecg.flutterConduction = 4; p.ecg.heartRate = 75; } },
];

function attachMockAudio(synth: AuscultationSynth, getActiveEventKind: () => HemoEventKind | null, getSimTime: () => number) {
  const allSounds: SoundDispatch[] = [];
  const allBeeps: BeepDispatch[] = [];

  const mockCtx = {
    currentTime: 1.0,
    createGain: () => ({
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
        setTargetAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    }),
    createBiquadFilter: () => ({
      type: 'bandpass',
      frequency: { value: 200, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
      Q: { value: 1.5 },
      connect: vi.fn(),
    }),
    createOscillator: () => ({
      type: 'sine',
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }),
    createBuffer: () => ({
      getChannelData: () => new Float32Array(100),
    }),
    createBufferSource: () => ({
      buffer: null,
      loop: true,
      connect: vi.fn(),
      start: vi.fn(),
    }),
    destination: {},
  };

  (synth as any).ctx = mockCtx as unknown as AudioContext;
  (synth as any).masterGain = mockCtx.createGain();
  (synth as any).pieceFilter = mockCtx.createBiquadFilter();
  (synth as any).monitorGain = mockCtx.createGain();
  (synth as any).murmurGain = mockCtx.createGain();
  (synth as any).murmurFilter = mockCtx.createBiquadFilter();
  synth.enabled = true;
  synth.monitorBeepEnabled = true;

  const origTriggerHeartSound = (synth as any).triggerHeartSound.bind(synth);
  (synth as any).triggerHeartSound = vi.fn((freq: number, tauSec: number, gainAmp: number, delaySec = 0) => {
    const tSim = getSimTime();
    const scheduledTimeMs = (tSim + Math.max(0, delaySec)) * 1000;
    allSounds.push({
      freq,
      tauSec,
      gainAmp,
      delaySec,
      tSim,
      scheduledTimeMs,
      offsetMs: 0,
      eventKindAtDispatch: getActiveEventKind(),
    });
    return origTriggerHeartSound(freq, tauSec, gainAmp, delaySec);
  });

  const origTriggerMonitorQrsBeep = (synth as any).triggerMonitorQrsBeep.bind(synth);
  (synth as any).triggerMonitorQrsBeep = vi.fn((mapMmHg: number) => {
    const tSim = getSimTime();
    allBeeps.push({
      map: mapMmHg,
      tSim,
      offsetMs: 0,
      eventKindAtDispatch: getActiveEventKind(),
    });
    return origTriggerMonitorQrsBeep(mapMmHg);
  });

  return { allSounds, allBeeps, mockCtx };
}

function runScenarioSimulation(sc: ScenarioDef, warmupSeconds = 10, measuredCyclesTarget = 20): {
  scenario: ScenarioDef;
  cycles: CycleData[];
  params: ClinicalParams;
  rawM1CountTotal: number;
  rawT1CountTotal: number;
  rawBeepCountTotal: number;
} {
  const clock = new MasterPhysiologyClock();
  const params = defaultParams();
  sc.mut(params);

  const live = createLiveState();
  live.clock = clock.state;
  const ctx: SimContext = { clock: clock.state, live, params };

  let activeEventKind: HemoEventKind | null = null;
  const origForEachSince = live.hemo.events.forEachSince.bind(live.hemo.events);
  live.hemo.events.forEachSince = (fromSeq: number, cb: (k: HemoEventKind, t: number) => void) => {
    return origForEachSince(fromSeq, (k, t) => {
      activeEventKind = k;
      try {
        cb(k, t);
      } finally {
        activeEventKind = null;
      }
    });
  };

  const qrsTimes: number[] = [];
  clock.addListener({
    onBeatStart: (c) => {
      if (c.atrialActive) live.hemo.events.push(HemoEventKind.PWave, c.t);
      live.hemo.events.push(HemoEventKind.BeatStart, c.t);
    },
    onQRS: (c) => {
      live.hemo.events.push(HemoEventKind.QRS, c.t);
      qrsTimes.push(c.t);
    },
  });

  const cmd: ClockCommand = {
    hr: params.ecg.heartRate,
    rhythm: params.ecg.rhythm,
    flutterConduction: params.ecg.flutterConduction,
    qtc: params.ecg.qtc,
    respRate: params.ventilation.respRate,
    inspFraction: 1 / 3,
  };
  clock.reset(cmd);

  const engine = new HemodynamicEngine();
  engine.reset(ctx);

  const synth = new AuscultationSynth();
  synth.reset(ctx);
  const audio = attachMockAudio(synth, () => activeEventKind, () => clock.state.t);

  // 1. Warm-up of 10 s
  const stepH = 0.001;
  const warmupSteps = Math.round(warmupSeconds / stepH);
  for (let s = 0; s < warmupSteps; s++) {
    cmd.hr = live.hemo.hrCommand > 0 ? live.hemo.hrCommand : params.ecg.heartRate;
    cmd.rhythm = params.ecg.rhythm;
    cmd.flutterConduction = params.ecg.flutterConduction;
    cmd.qtc = params.ecg.qtc;
    cmd.respRate = params.ventilation.respRate;
    audio.mockCtx.currentTime = clock.state.t;

    clock.step(stepH, cmd);
    engine.step(stepH, ctx);
    synth.step(stepH, ctx);
  }

  // Discards sounds and beeps from the warm-up
  audio.allSounds.length = 0;
  audio.allBeeps.length = 0;
  qrsTimes.length = 0;

  // 2. Records exactly 20 measured cycles starting from the next QRS
  let startedRecording = false;
  const measuredQrsTimes: number[] = [];

  while (measuredQrsTimes.length <= measuredCyclesTarget) {
    const prevQrsLen = qrsTimes.length;
    cmd.hr = live.hemo.hrCommand > 0 ? live.hemo.hrCommand : params.ecg.heartRate;
    cmd.rhythm = params.ecg.rhythm;
    cmd.flutterConduction = params.ecg.flutterConduction;
    cmd.qtc = params.ecg.qtc;
    cmd.respRate = params.ventilation.respRate;
    audio.mockCtx.currentTime = clock.state.t;

    clock.step(stepH, cmd);
    engine.step(stepH, ctx);

    // At the instant the first post-warm-up QRS occurs, clean recording starts
    if (!startedRecording) {
      if (qrsTimes.length > prevQrsLen) {
        startedRecording = true;
        audio.allSounds.length = 0;
        audio.allBeeps.length = 0;
        measuredQrsTimes.push(qrsTimes[qrsTimes.length - 1]);
      }
    } else {
      if (qrsTimes.length > prevQrsLen) {
        measuredQrsTimes.push(qrsTimes[qrsTimes.length - 1]);
      }
    }

    synth.step(stepH, ctx);
  }

  // Groups events and sounds by cycle [tQrs[i], tQrs[i+1])
  const cycles: CycleData[] = [];
  let rawM1CountTotal = 0;
  let rawT1CountTotal = 0;
  let rawBeepCountTotal = 0;

  for (let i = 0; i < measuredCyclesTarget; i++) {
    const tStart = measuredQrsTimes[i];
    const tEnd = measuredQrsTimes[i + 1];
    const rrMs = (tEnd - tStart) * 1000;

    // Triggers whose tSim occurred within the cycle [tStart, tEnd)
    const cycleSounds = audio.allSounds.filter((s) => s.tSim >= tStart - 0.0001 && s.tSim < tEnd - 0.0001);
    const cycleBeeps = audio.allBeeps.filter((b) => b.tSim >= tStart - 0.0001 && b.tSim < tEnd - 0.0001);

    const m1: SoundDispatch[] = [];
    const t1: SoundDispatch[] = [];
    const a2: SoundDispatch[] = [];
    const p2: SoundDispatch[] = [];
    const b3: SoundDispatch[] = [];
    const b4: SoundDispatch[] = [];

    let mcDispatches = 0;
    let tcDispatches = 0;

    for (const snd of cycleSounds) {
      snd.offsetMs = snd.scheduledTimeMs - tStart * 1000;
      if (snd.eventKindAtDispatch === HemoEventKind.MitralClose) mcDispatches++;
      if (snd.eventKindAtDispatch === HemoEventKind.TricuspidClose) tcDispatches++;

      if (snd.freq === 52) { m1.push(snd); rawM1CountTotal++; }
      else if (snd.freq === 46) { t1.push(snd); rawT1CountTotal++; }
      else if (snd.freq === 64) { a2.push(snd); }
      else if (snd.freq === 54) { p2.push(snd); }
      else if (snd.freq === 28) { b3.push(snd); }
      else if (snd.freq === 30) { b4.push(snd); }
    }

    for (const bp of cycleBeeps) {
      bp.offsetMs = (bp.tSim - tStart) * 1000;
      if (bp.eventKindAtDispatch === HemoEventKind.MitralClose) mcDispatches++;
      if (bp.eventKindAtDispatch === HemoEventKind.TricuspidClose) tcDispatches++;
      rawBeepCountTotal++;
    }

    cycles.push({
      cycleIndex: i,
      tQrs: tStart,
      tNextQrs: tEnd,
      rrMs,
      m1,
      t1,
      beeps: cycleBeeps,
      a2,
      p2,
      b3,
      b4,
      mitralCloseDispatches: mcDispatches,
      tricuspidCloseDispatches: tcDispatches,
    });
  }

  return { scenario: sc, cycles, params, rawM1CountTotal, rawT1CountTotal, rawBeepCountTotal };
}

function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

describe('AuscultationSynth — Validation T1-T5 of the B1 Fix and Monitor Beep', () => {
  // Runs the 9 test scenarios
  const simulationResults = SCENARIOS.map((sc) => runScenarioSimulation(sc));

  // Table of triggers per cycle in the current code (for the report)
  it('count diagnostic: prints table of triggers per cycle', () => {
    console.log('\n=== TABELA DE DISPAROS POR CICLO NO CÃ“DIGO AVALIADO ===');
    console.log('CenÃ¡rio | Ciclos | M1/ciclo | T1/ciclo | Bipe/ciclo | M1 offset ms | T1 offset ms | Bipe offset ms');
    console.log('--------------------------------------------------------------------------------------------------');
    for (const res of simulationResults) {
      const n = res.cycles.length;
      const m1PerCycle = (res.rawM1CountTotal / n).toFixed(1);
      const t1PerCycle = (res.rawT1CountTotal / n).toFixed(1);
      const beepPerCycle = (res.rawBeepCountTotal / n).toFixed(1);

      const m1Offsets = res.cycles.flatMap((c) => c.m1.map((s) => s.offsetMs.toFixed(0))).slice(0, 4).join(', ');
      const t1Offsets = res.cycles.flatMap((c) => c.t1.map((s) => s.offsetMs.toFixed(0))).slice(0, 4).join(', ');
      const beepOffsets = res.cycles.flatMap((c) => c.beeps.map((b) => b.offsetMs.toFixed(0))).slice(0, 4).join(', ');

      console.log(
        `${res.scenario.id.padEnd(10)} | ${n} | ${m1PerCycle.padStart(8)} | ${t1PerCycle.padStart(8)} | ${beepPerCycle.padStart(10)} | [${m1Offsets}...] | [${t1Offsets}...] | [${beepOffsets}...]`
      );
    }
  });

  // (T1) exactly 1 M1, 1 T1 and 1 beep per cycle in ALL measured cycles
  it('T1: exactly 1 M1, 1 T1 and 1 beep per cycle in ALL measured cycles in the 9 scenarios', () => {
    const violations: string[] = [];

    for (const res of simulationResults) {
      for (const c of res.cycles) {
        if (c.m1.length !== 1 || c.t1.length !== 1 || c.beeps.length !== 1) {
          violations.push(
            `[${res.scenario.id}] ciclo #${c.cycleIndex}: M1=${c.m1.length}, T1=${c.t1.length}, Bipe=${c.beeps.length} (esperado 1, 1, 1)`
          );
        }
      }
    }

    expect(
      violations,
      `Falha T1: detectadas duplicaÃ§Ãµes ou omissÃµes de M1, T1 ou bipe por ciclo:\n${violations.slice(0, 10).join('\n')}`
    ).toEqual([]);
  });

  // (T2) the beep occurs at the QRS (0 to 5 ms) and M1 at 18 ms plus the left bundle delay (tolerance 3 ms)
  it('T2: the beep occurs at the QRS (0 to 5 ms) and M1 at 18 ms plus the left bundle delay (tolerance 3 ms)', () => {
    const violations: string[] = [];

    for (const res of simulationResults) {
      const isLbbb = res.scenario.id === 'bre75';
      const lvDelayMs = isLbbb ? 48 : 0;
      const expectedM1Offset = 18 + lvDelayMs;

      for (const c of res.cycles) {
        if (c.beeps.length !== 1 || c.m1.length !== 1) {
          violations.push(`[${res.scenario.id}] ciclo #${c.cycleIndex}: contagem invÃ¡lida (bipe=${c.beeps.length}, M1=${c.m1.length})`);
          continue;
        }

        const beepOffset = c.beeps[0].offsetMs;
        const m1Offset = c.m1[0].offsetMs;

        if (beepOffset < 0 || beepOffset > 5) {
          violations.push(`[${res.scenario.id}] ciclo #${c.cycleIndex}: bipe em ${beepOffset.toFixed(1)} ms (esperado 0 a 5 ms)`);
        }

        if (Math.abs(m1Offset - expectedM1Offset) > 3) {
          violations.push(`[${res.scenario.id}] ciclo #${c.cycleIndex}: M1 em ${m1Offset.toFixed(1)} ms (esperado ${expectedM1Offset} Â± 3 ms)`);
        }
      }
    }

    expect(
      violations,
      `Falha T2: bipe ou M1 fora da temporizaÃ§Ã£o pÃ³s-QRS:\n${violations.slice(0, 10).join('\n')}`
    ).toEqual([]);
  });

  // (T3) T1 minus M1 = 22 ms plus (rvDelay minus lvDelay) in ms (tolerance 3 ms): sinus 22, RBBB 67 and LBBB -26
  it('T3: T1 minus M1 = 22 ms plus (rvDelay minus lvDelay) in ms (tolerance 3 ms): sinus 22, RBBB 67 and LBBB -26', () => {
    const violations: string[] = [];

    for (const res of simulationResults) {
      const isLbbb = res.scenario.id === 'bre75';
      const isRbbb = res.scenario.id === 'brd75';
      const lvDelayMs = isLbbb ? 48 : 0;
      const rvDelayMs = isRbbb ? 45 : 0;
      const expectedSplit = 22 + (rvDelayMs - lvDelayMs); // sinus=22, RBBB=67, LBBB=-26

      for (const c of res.cycles) {
        if (c.m1.length !== 1 || c.t1.length !== 1) {
          violations.push(`[${res.scenario.id}] ciclo #${c.cycleIndex}: contagem invÃ¡lida (M1=${c.m1.length}, T1=${c.t1.length})`);
          continue;
        }

        const split = c.t1[0].offsetMs - c.m1[0].offsetMs;
        if (Math.abs(split - expectedSplit) > 3) {
          violations.push(`[${res.scenario.id}] ciclo #${c.cycleIndex}: split T1-M1 = ${split.toFixed(1)} ms (esperado ${expectedSplit} Â± 3 ms)`);
        }
      }
    }

    expect(
      violations,
      `Falha T3: desdobramento M1-T1 incorreto:\n${violations.slice(0, 10).join('\n')}`
    ).toEqual([]);
  });

  // (T4) no M1, T1 or beep trigger occurs in response to MitralClose or TricuspidClose
  it('T4: no M1, T1 or beep trigger occurs in response to MitralClose or TricuspidClose', () => {
    const violations: string[] = [];

    for (const res of simulationResults) {
      let mcCount = 0;
      let tcCount = 0;
      for (const c of res.cycles) {
        mcCount += c.mitralCloseDispatches;
        tcCount += c.tricuspidCloseDispatches;
      }
      if (mcCount > 0 || tcCount > 0) {
        violations.push(
          `[${res.scenario.id}]: ${mcCount} disparos ocorreram sob MitralClose e ${tcCount} sob TricuspidClose (esperado 0)`
        );
      }
    }

    expect(
      violations,
      `Falha T4: disparos de B1 ou bipe foram gerados sob eventos de MitralClose ou TricuspidClose:\n${violations.join('\n')}`
    ).toEqual([]);
  });

  // (T5) regression: A2 (AorticClose) and P2 once per cycle; B3, B4 and murmurs unchanged; splitting by median
  it('T5: regression: A2 and P2 once per cycle, B3/B4 and murmurs unchanged with splitting by median', () => {
    // 1. A2 and P2 once per cycle in the 9 main scenarios
    for (const res of simulationResults) {
      for (const c of res.cycles) {
        expect(c.a2.length, `[${res.scenario.id}] ciclo #${c.cycleIndex}: A2 deve ocorrer 1 vez`).toBe(1);
        expect(c.p2.length, `[${res.scenario.id}] ciclo #${c.cycleIndex}: P2 deve ocorrer 1 vez`).toBe(1);
      }

      // Median of the B2 splitting per post-warm-up cycle
      const b2Splits = res.cycles.map((c) => {
        // In LBBB, P2 precedes A2 in systole
        return c.p2[0].scheduledTimeMs - c.a2[0].scheduledTimeMs;
      });
      const medB2Split = median(b2Splits);

      if (res.scenario.id === 'sinus75') {
        // Normal physiological splitting: A2 precedes P2 (positive split ~16-52 ms)
        expect(medB2Split).toBeGreaterThanOrEqual(16);
        expect(medB2Split).toBeLessThanOrEqual(52);
      } else if (res.scenario.id === 'brd75') {
        // Wide splitting: split greater than in normal rhythm (~50-86 ms)
        expect(medB2Split).toBeGreaterThanOrEqual(50);
        expect(medB2Split).toBeLessThanOrEqual(86);
      } else if (res.scenario.id === 'bre75') {
        // Paradoxical splitting: P2 precedes A2 (negative split ~ -12 to -55 ms)
        expect(medB2Split).toBeLessThanOrEqual(-12);
        expect(medB2Split).toBeGreaterThanOrEqual(-55);
      }
    }

    // 2. B3 present in severe systolic dysfunction (HFrEF EF 25%) and absent in normal
    const icferSim = runScenarioSimulation(
      { id: 'icfer', label: 'ICFER FEVE 25%', mut: (p) => { p.echo.lvef = 25; } },
      10,
      10
    );
    const b3Counts = icferSim.cycles.map((c) => c.b3.length);
    expect(median(b3Counts)).toBe(1);

    const normalSim = runScenarioSimulation(
      { id: 'normal', label: 'Normal FEVE 60%', mut: (p) => { p.echo.lvef = 60; } },
      10,
      10
    );
    const normalB3Counts = normalSim.cycles.map((c) => c.b3.length);
    expect(median(normalB3Counts)).toBe(0);

    // 3. B4 present in ventricular hypertrophy in sinus rhythm and absent in AF
    const hveSinusSim = runScenarioSimulation(
      { id: 'hve_sinus', label: 'HVE Sinusal', mut: (p) => { p.echo.septum = 14; p.echo.posteriorWall = 14; } },
      10,
      10
    );
    const b4Counts = hveSinusSim.cycles.map((c) => c.b4.length);
    expect(median(b4Counts)).toBe(1);

    const hveFaSim = runScenarioSimulation(
      { id: 'hve_fa', label: 'HVE em FA', mut: (p) => { p.ecg.rhythm = 'af'; p.echo.septum = 14; p.echo.posteriorWall = 14; } },
      10,
      10
    );
    const faB4Counts = hveFaSim.cycles.map((c) => c.b4.length);
    expect(median(faB4Counts)).toBe(0);
  });
});
