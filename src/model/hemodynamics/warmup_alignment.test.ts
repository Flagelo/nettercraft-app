import { describe, expect, it } from 'vitest';
import { MasterPhysiologyClock } from '../../controller/MasterPhysiologyClock';
import { defaultParams, createLiveState } from '../../controller/usePhysiologyStore';
import type { SimContext } from '../contracts/types';
import { HemodynamicEngine } from './HemodynamicEngine';

/**
 * reset() pre-warms the engine and then restores the clock at the beginning of the beat.
 * If the warmup does not end at an integer multiple of RR, the state (aortic valve open, high Q_ao)
 * becomes inconsistent with the restored clock. FATO VERIFICADO on the baseline: NaN at the 8th step at 60 bpm.
 */
function firstNonFinite(hr: number, steps = 6000): number {
  const clock = new MasterPhysiologyClock();
  const params = defaultParams();
  params.ecg.heartRate = hr;
  const live = createLiveState();
  live.clock = clock.state;
  const ctx: SimContext = { clock: clock.state, live, params };
  const cmd = {
    hr, rhythm: params.ecg.rhythm, flutterConduction: params.ecg.flutterConduction,
    qtc: params.ecg.qtc, respRate: params.ventilation.respRate, inspFraction: 1 / 3,
  };
  clock.reset(cmd);
  const engine = new HemodynamicEngine();
  engine.reset(ctx);
  for (let i = 0; i < steps; i++) {
    clock.step(0.001, cmd);
    engine.step(0.001, ctx);
    if (!Number.isFinite(live.hemo.pLV) || !Number.isFinite(live.hemo.pAo)) return i;
  }
  return -1;
}

describe('reset() warmup aligned to RR', () => {
  it('does not generate NaN/Infinity in the first 6 s at 40–180 bpm (includes 60 bpm)', () => {
    for (const hr of [40, 50, 60, 70, 75, 88, 100, 120, 150, 180]) {
      expect({ hr, firstNonFinite: firstNonFinite(hr) }).toEqual({ hr, firstNonFinite: -1 });
    }
  });

  it('ends the warmup at end-diastole: aortic valve closed and aortic flow ~0 right after reset()', () => {
    for (const hr of [50, 60, 75, 100, 120]) {
      const clock = new MasterPhysiologyClock();
      const params = defaultParams();
      params.ecg.heartRate = hr;
      const live = createLiveState();
      live.clock = clock.state;
      const ctx: SimContext = { clock: clock.state, live, params };
      clock.reset({ hr, rhythm: params.ecg.rhythm, flutterConduction: params.ecg.flutterConduction, qtc: params.ecg.qtc, respRate: params.ventilation.respRate, inspFraction: 1 / 3 });
      const engine = new HemodynamicEngine();
      engine.reset(ctx);
      expect({ hr, zAo: engine.y[13] < 0.25 }).toEqual({ hr, zAo: true });
      expect({ hr, qAoSmall: Math.abs(engine.y[9]) < 50 }).toEqual({ hr, qAoSmall: true });
    }
  });
});
