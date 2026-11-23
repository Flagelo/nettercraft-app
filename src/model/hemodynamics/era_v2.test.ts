import { describe, expect, it } from 'vitest';
import { MasterPhysiologyClock } from '../../controller/MasterPhysiologyClock';
import { defaultParams, createLiveState } from '../../controller/usePhysiologyStore';
import { HemodynamicEngine, doubleHill, RA_LA_ACTIVATION_LEAD_S } from './HemodynamicEngine';
import { SimContext } from '../contracts/types';

interface StepData {
  t: number;
  rawTSinceP: number;
  tSinceP: number;
  tSinceQRS: number;
  beatIndex: number;
  eRA: number;
  eLA: number;
  pRA: number;
  pLA: number;
  qTr: number;
  qMi: number;
  vLV: number;
  vRV: number;
  pLV: number;
  pRV: number;
  pAo: number;
  pPA: number;
}

function runSimulation(hr: number, rhythm: 'sinus' | 'af' = 'sinus') {
  const clock = new MasterPhysiologyClock();
  const params = defaultParams();
  params.ecg.heartRate = hr;
  params.ecg.rhythm = rhythm;
  const live = createLiveState();
  live.clock = clock.state;
  const ctx: SimContext = { clock: clock.state, live, params };
  const cmd = {
    hr,
    rhythm: params.ecg.rhythm,
    flutterConduction: params.ecg.flutterConduction,
    qtc: params.ecg.qtc,
    respRate: params.ventilation.respRate,
    inspFraction: 1 / 3,
  };

  clock.reset(cmd);
  const engine = new HemodynamicEngine();
  engine.reset(ctx);

  const steps: StepData[] = [];
  const totalSteps = 10000; // 10 s at 1 ms

  for (let i = 0; i <= totalSteps; i++) {
    clock.step(0.001, cmd);
    engine.step(0.001, ctx);

    const t = Number(clock.state.t.toFixed(4));
    const rawTSinceP = clock.state.tSinceP;
    const tSinceP = Number(clock.state.tSinceP.toFixed(4));
    const tSinceQRS = Number(clock.state.tSinceQRS.toFixed(4));

    if (t >= 4.0) {
      steps.push({
        t,
        rawTSinceP,
        tSinceP,
        tSinceQRS,
        beatIndex: clock.state.beatIndex,
        eRA: live.hemo.eRA,
        eLA: live.hemo.eLA,
        pRA: live.hemo.pRA,
        pLA: live.hemo.pLA,
        qTr: live.hemo.qTricuspid,
        qMi: live.hemo.qMitral,
        vLV: live.hemo.vLV,
        vRV: live.hemo.vRV,
        pLV: live.hemo.pLV,
        pRV: live.hemo.pRV,
        pAo: live.hemo.pAo,
        pPA: live.hemo.pPA,
      });
    }
  }

  return { ctx, steps };
}

describe('Pre-Registered Criteria D14 v2 (G1–G3)', () => {
  it('G1: eRA series after is bit-for-bit identical to the original doubleHill(tSinceP, 0.115) series (HR 72 and 100)', () => {
    for (const hr of [72, 100]) {
      const { steps } = runSimulation(hr);

      for (let i = 0; i < steps.length; i++) {
        // eRA is bit-for-bit identical to the original expression doubleHill(tSinceP, 0.115)
        const expectedEra = doubleHill(steps[i].rawTSinceP, 0.115);
        expect(steps[i].eRA).toBe(expectedEra);
      }
    }
  });

  it('G2: eLA_after(t) = eLA_before(t - 0.027) with |Δ| <= 1e-12; eLA peak 27 ± 1 ms after eRA; pLA a wave 15–40 ms after pRA', () => {
    // 1. Direct analytical check of doubleHill for all samples t ∈ [0, 1.0] every 1 ms
    for (let i = 0; i <= 1000; i++) {
      const t = i * 0.001;
      const elaDepois = doubleHill(t - RA_LA_ACTIVATION_LEAD_S, 0.115);
      const elaAntesAtDelayedT = doubleHill(t - 0.027, 0.115);
      expect(Math.abs(elaDepois - elaAntesAtDelayedT)).toBeLessThanOrEqual(1e-12);
    }

    // 2. Simulation at HR 72 and HR 100
    for (const hr of [72, 100]) {
      const { steps } = runSimulation(hr);

      // Group by beat
      const beatMap = new Map<number, StepData[]>();
      for (const st of steps) {
        if (!beatMap.has(st.beatIndex)) beatMap.set(st.beatIndex, []);
        beatMap.get(st.beatIndex)!.push(st);
      }

      for (const [_, b] of beatMap.entries()) {
        if (b.length < Math.round((60 / hr) * 1000) - 2) continue;

        // Samples during atrial systole (tSinceP <= 0.16)
        const atrialSteps = b.filter(s => s.tSinceP <= 0.16);
        let maxPra = -Infinity, tPeakPra = 0;
        let maxPla = -Infinity, tPeakPla = 0;
        let maxEra = -Infinity, tPeakEra = 0;
        let maxEla = -Infinity, tPeakEla = 0;

        for (const s of atrialSteps) {
          if (s.pRA > maxPra) { maxPra = s.pRA; tPeakPra = s.tSinceP; }
          if (s.pLA > maxPla) { maxPla = s.pLA; tPeakPla = s.tSinceP; }
          if (s.eRA > maxEra) { maxEra = s.eRA; tPeakEra = s.tSinceP; }
          if (s.eLA > maxEla) { maxEla = s.eLA; tPeakEla = s.tSinceP; }
        }

        const deltaPeakElaEra = Math.round((tPeakEla - tPeakEra) * 1000);
        // eLA peak 27 ± 1 ms after the eRA peak
        expect(Math.abs(deltaPeakElaEra - 27)).toBeLessThanOrEqual(1);

        const deltaPeakPlaPra = (tPeakPla - tPeakPra) * 1000;
        // pLA a-wave peak 15–40 ms after the pRA peak
        expect(deltaPeakPlaPra).toBeGreaterThanOrEqual(15);
        expect(deltaPeakPlaPra).toBeLessThanOrEqual(40);
      }
    }
  });

  it('G3: continuity at cycle rollover and start/end <= 2% of peak at HR 60, 72, 100, 150 and 180; eRA = eLA = 0 with atrialActive = false', () => {
    const fcs = [60, 72, 100, 150, 180];
    const peakAtrial = 1.0;
    const maxAllowedBoundaryStep = 0.02 * peakAtrial; // 2% of peak = 0.02

    for (const hr of fcs) {
      const { steps } = runSimulation(hr);

      // Group by beat to check the cycle rollover
      const beatMap = new Map<number, StepData[]>();
      for (const st of steps) {
        if (!beatMap.has(st.beatIndex)) beatMap.set(st.beatIndex, []);
        beatMap.get(st.beatIndex)!.push(st);
      }

      const beats: StepData[][] = [];
      for (const [_, bSteps] of beatMap.entries()) {
        if (bSteps.length >= Math.round((60 / hr) * 1000) - 2) {
          beats.push(bSteps);
        }
      }

      for (let b = 1; b < beats.length; b++) {
        const prevBeat = beats[b - 1];
        const curBeat = beats[b];

        // 1. Cycle rollover (last step of the previous cycle -> first step of the current cycle)
        const lastStepPrev = prevBeat[prevBeat.length - 1];
        const firstStepCur = curBeat[0];

        const jumpEraCycle = Math.abs(firstStepCur.eRA - lastStepPrev.eRA);
        const jumpElaCycle = Math.abs(firstStepCur.eLA - lastStepPrev.eLA);

        expect(jumpEraCycle).toBeLessThanOrEqual(maxAllowedBoundaryStep);
        expect(jumpElaCycle).toBeLessThanOrEqual(maxAllowedBoundaryStep);

        // 2. Activation onset (from 0 to the first active step)
        // eRA: tSinceP from 0 to 1 ms
        const eraStartStep = Math.abs(doubleHill(0.001, 0.115) - doubleHill(0, 0.115));
        expect(eraStartStep).toBeLessThanOrEqual(maxAllowedBoundaryStep);

        // eLA: tSinceP from 27 ms to 28 ms
        const elaStartStep = Math.abs(doubleHill(0.028 - 0.027, 0.115) - doubleHill(0.027 - 0.027, 0.115));
        expect(elaStartStep).toBeLessThanOrEqual(maxAllowedBoundaryStep);

        // 3. Activation end (cutoff at ts * 1.35)
        const eraCutoffStep = Math.abs(doubleHill(0.155, 0.115) - doubleHill(0.156, 0.115));
        expect(eraCutoffStep).toBeLessThanOrEqual(maxAllowedBoundaryStep);
      }
    }

    // 4. eRA = eLA = 0 when atrialActive = false (AF)
    const afSim = runSimulation(75, 'af');
    for (const st of afSim.steps) {
      expect(st.eRA).toBe(0);
      expect(st.eLA).toBe(0);
    }
  });
});
