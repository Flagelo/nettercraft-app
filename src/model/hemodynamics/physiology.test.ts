import { describe, expect, it } from 'vitest';
import { MasterPhysiologyClock } from '../../controller/MasterPhysiologyClock';
import { defaultParams, createLiveState } from '../../controller/usePhysiologyStore';
import type { SimContext } from '../contracts/types';
import { HemodynamicEngine } from './HemodynamicEngine';
import { ElectroEngine } from '../electrophysiology/ElectroEngine';

describe('MasterPhysiologyClock (Fridericia / Bazett)', () => {
  it('shortens mainly the diastole in tachycardia', () => {
    const clock = new MasterPhysiologyClock();
    const iv60 = clock.scaleIntervals(1.0, 0.41); // 60 bpm (RR = 1.0 s)
    const iv150 = clock.scaleIntervals(0.4, 0.41); // 150 bpm (RR = 0.4 s)

    const td60 = 1.0 - iv60.ts - iv60.pr;
    const td150 = 0.4 - iv150.ts - iv150.pr;

    // Systole shrinks only ~26% (cube root), whereas diastole shrinks > 75%
    expect(iv150.ts / iv60.ts).toBeGreaterThan(0.68);
    expect(td150 / td60).toBeLessThan(0.30);
  });
});

describe('HemodynamicEngine 0D RK4 (Suga & Sagawa + Windkessel + Mynard Valves)', () => {
  function runSim(seconds: number, customize?: (ctx: SimContext) => void): { engine: HemodynamicEngine; ctx: SimContext } {
    const clock = new MasterPhysiologyClock();
    const params = defaultParams();
    const live = createLiveState();
    live.clock = clock.state;
    const ctx: SimContext = { clock: clock.state, live, params };
    customize?.(ctx);

    clock.reset({
      hr: params.ecg.heartRate,
      rhythm: params.ecg.rhythm,
      flutterConduction: params.ecg.flutterConduction,
      qtc: params.ecg.qtc,
      respRate: params.ventilation.respRate,
      inspFraction: 1 / 3,
    });

    const engine = new HemodynamicEngine();
    engine.reset(ctx);

    const steps = Math.round(seconds * 1000);
    for (let i = 0; i < steps; i++) {
      clock.step(0.001, {
        hr: live.hemo.hrCommand > 0 ? live.hemo.hrCommand : params.ecg.heartRate,
        rhythm: params.ecg.rhythm,
        flutterConduction: params.ecg.flutterConduction,
        qtc: params.ecg.qtc,
        respRate: params.ventilation.respRate,
        inspFraction: 1 / 3,
      });
      engine.step(0.001, ctx);
    }
    return { engine, ctx };
  }

  it('conserves total blood volume in the closed circuit, converges to target LVEF = 60% and yields physiological BP', () => {
    const { engine, ctx } = runSim(6);
    const totalVol =
      engine.y[0] + engine.y[1] + engine.y[2] + engine.y[3] +
      engine.y[4] + engine.y[5] + engine.y[6] + engine.y[7];
    expect(Math.abs(totalVol - 5000)).toBeLessThan(1.0);
    expect(ctx.live.hemo.sbp).toBeGreaterThan(95);
    expect(ctx.live.hemo.sbp).toBeLessThan(145);
    expect(ctx.live.hemo.dbp).toBeGreaterThan(55);
    expect(ctx.live.hemo.sv).toBeGreaterThan(45);
    expect(Math.abs(ctx.live.hemo.lvef - 60)).toBeLessThanOrEqual(2);
  });

  it('increases diastolic stiffness B and raises PD2 in concentric hypertrophy (HFpEF)', () => {
    const normal = runSim(4).ctx.live.hemo;
    const hfpef = runSim(4, (c) => {
      c.params.echo.septum = 16;
      c.params.echo.posteriorWall = 15;
    }).ctx.live.hemo;

    expect(hfpef.lvB).toBeGreaterThan(normal.lvB * 2.0);
    expect(hfpef.lvedp).toBeGreaterThan(normal.lvedp + 4);
  });
});

describe('ElectroEngine (17 AHA Dipoles + Dower Matrix + Injury Current)', () => {
  it('generates anterior ST elevation and inferior mirror image on LAD occlusion and zeroes ST when No Acute Ischemia', () => {
    const clock = new MasterPhysiologyClock();
    const params = defaultParams();
    params.ecg.ischemiaTerritory = 'lad';
    params.ecg.ischemiaTransmural = true;
    const live = createLiveState();
    live.clock = clock.state;
    const ctx: SimContext = { clock: clock.state, live, params };
    const electro = new ElectroEngine();
    electro.reset(ctx);

    // Positions the clock at the ST segment (130 ms after QRS onset)
    clock.state.tSinceQRS = 0.13;
    clock.state.qt = 0.40;
    electro.step(0.001, ctx);

    // LEAD_NAMES indices: 0=I, 1=II, 2=III, 3=aVR, 4=aVL, 5=aVF, 6=V1, 7=V2, 8=V3, 9=V4
    const v2 = live.electro.leads[7];
    const v3 = live.electro.leads[8];
    const leadIII = live.electro.leads[2];
    expect(v2).toBeGreaterThan(0.08);
    expect(v3).toBeGreaterThan(0.08);
    expect(leadIII).toBeLessThan(-0.02); // inferior mirror image

    // When "Sem Isquemia Aguda" (none) is selected, the ST segment returns to the isoelectric line even with residual akinesia
    params.ecg.ischemiaTerritory = 'none';
    params.echo.wallMotion[0] = 3;
    electro.step(0.001, ctx);
    expect(Math.abs(live.electro.leads[7])).toBeLessThan(0.05);
  });

  it('reproduces classic LBBB morphology (deep QS in V1 and broad R in V6) and RBBB (positive rsR\' in V1 and slurred S in I/V6)', () => {
    const clock = new MasterPhysiologyClock();
    const params = defaultParams();
    const live = createLiveState();
    live.clock = clock.state;
    const ctx: SimContext = { clock: clock.state, live, params };
    const electro = new ElectroEngine();

    // LBBB: at tSinceQRS = 95 ms (middle of the widened QRS), V1 is strongly negative and V6 strongly positive
    params.ecg.bundleBranchBlock = 'lbbb';
    clock.state.tSinceQRS = 0.095;
    clock.state.qt = 0.40;
    electro.step(0.001, ctx);
    expect(live.electro.leads[6]).toBeLessThan(-0.6); // V1 deeply negative (QS)
    expect(live.electro.leads[11]).toBeGreaterThan(0.6); // V6 positive tower

    // RBBB: triphasic rsR' in V1 (initial r at 14ms, negative S at 40ms, tall R' at 92ms) and slurred S in I/V6
    params.ecg.bundleBranchBlock = 'rbbb';
    clock.state.tSinceQRS = 0.040;
    electro.step(0.001, ctx);
    expect(live.electro.leads[6]).toBeLessThan(-0.15); // V1 intermediate S wave below the baseline

    clock.state.tSinceQRS = 0.092;
    electro.step(0.001, ctx);
    expect(live.electro.leads[6]).toBeGreaterThan(0.8); // V1 tall R' wave ("rabbit ears")
    expect(live.electro.leads[0]).toBeLessThan(-0.4); // lead I slurred terminal S wave
    expect(live.electro.leads[11]).toBeLessThan(-0.5); // V6 slurred terminal S wave
  });
});

