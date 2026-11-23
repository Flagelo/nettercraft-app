import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MasterPhysiologyClock } from '../../controller/MasterPhysiologyClock';
import { defaultParams, createLiveState } from '../../controller/usePhysiologyStore';
import type { SimContext, SimSystem } from '../contracts/types';
import { HemodynamicEngine } from '../hemodynamics/HemodynamicEngine';
import { applyRvProceduralGeometry } from './rvGeometry';
import { setupValvarKinematics } from './valvarKinematics';
import { setupSemilunarValves } from './semilunarValve';
import { applyLvWatertightGeometry } from './lvWatertightGeometry';
import {
  setupLvContractionField,
  createLvDriverSystem,
  applyLvContraction,
  resetLvDriver,
  LV_UNTWIST_MAX_RATE,
  LV_UNTWIST_VALVE_Z,
  type LvFieldRig,
} from './lvContractionField';
import { createRvVolumeTracker, createRvWireframeDriver, rvFillFraction, updateRvVolumeTracker, updateRvWireframe } from './rvContraction';

// LV Phase 5c — torsion driver at the engine 1 ms step (D-VE33), untwisting without a step, RV glow detector (D-VE34).
// VE_FASE5C_20261113.md; criteria in sandbox_nettercraft_ve_20261111\_evidencias\ve5c\CRITERIOS_VE5C.md.

async function loadGlbScene(): Promise<THREE.Group> {
  const fsMod: any = await import(/* @vite-ignore */ 'f' + 's');
  const pathMod: any = await import(/* @vite-ignore */ 'p' + 'a' + 't' + 'h');
  const buffer = fsMod.readFileSync(pathMod.resolve('public/models/realistic_heart.glb'));
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(arrayBuffer, '', (g) => resolve(g.scene), reject));
}

async function buildLv(): Promise<LvFieldRig> {
  const scene = await loadGlbScene();
  scene.updateMatrixWorld(true);
  applyRvProceduralGeometry(scene);
  const valvar = setupValvarKinematics(scene)!;
  const semi = setupSemilunarValves(scene);
  applyLvWatertightGeometry(scene);
  const ss: THREE.Mesh[] = [];
  scene.traverse((o: any) => {
    if (o.isMesh && typeof o.userData?.segId === 'number') ss.push(o);
  });
  ss.sort((a, b) => a.userData.segId - b.userData.segId);
  return setupLvContractionField(ss, scene, valvar, { semilunar: semi } as any)!;
}

interface Sim {
  clock: MasterPhysiologyClock;
  ctx: SimContext;
  engine: HemodynamicEngine;
  cmd: () => any;
}
function makeSim(hr: number | null, ef: number | null, mode: 'spontaneous' | 'mechanical' = 'spontaneous'): Sim {
  const clock = new MasterPhysiologyClock();
  const params = defaultParams();
  const live = createLiveState();
  if (hr !== null) params.ecg.heartRate = hr;
  if (ef !== null) params.echo.lvef = ef;
  params.ventilation.mode = mode;
  live.clock = clock.state;
  const ctx: SimContext = { clock: clock.state, live, params };
  const cmd = () => ({ hr: live.hemo.hrCommand > 0 ? live.hemo.hrCommand : params.ecg.heartRate, rhythm: params.ecg.rhythm, flutterConduction: params.ecg.flutterConduction, qtc: params.ecg.qtc, respRate: params.ventilation.respRate, inspFraction: 1 / 3 });
  clock.reset(cmd());
  const engine = new HemodynamicEngine();
  engine.reset(ctx);
  return { clock, ctx, engine, cmd };
}

/** Loop as in the product: every 1 ms engine + LV system; every `frameMs` the HeartMesh17 frame call. */
function runLoop(lv: LvFieldRig, sim: Sim, ms: number, frameMs: number, onStep?: (i: number) => void) {
  const sys: SimSystem = createLvDriverSystem(lv);
  sys.reset?.(sim.ctx);
  lv.driverInStep = true;
  const h = sim.ctx.live.hemo;
  for (let i = 0; i < ms; i++) {
    sim.clock.step(0.001, sim.cmd());
    sim.engine.step(0.001, sim.ctx);
    sys.step!(0.001, sim.ctx);
    if (i % frameMs === 0) applyLvContraction(lv, h.vLV, sim.clock.state.beatIndex, sim.clock.state.t, h.zMitral, h.qMitral, h.zAortic);
    onStep?.(i);
  }
  lv.driverInStep = false;
}

describe('LV Phase 5c — driver at the 1 ms step (D-VE33)', () => {
  it('the system is the minimum of SimSystem (order 15, after the engine) and applyLvContraction does not run the driver when it is on the step', { timeout: 120000 }, async () => {
    const lv = await buildLv();
    const sys: SimSystem = createLvDriverSystem(lv);
    expect(sys.order).toBeGreaterThan(10);
    expect(sys.order).toBeLessThan(20);
    expect(createLvDriverSystem(lv).id).not.toBe(sys.id);
    const sim = makeSim(null, null);
    runLoop(lv, sim, 3000, 17);
    const T = lv.tw.T, sw = lv.tw.switches, lam = lv.lambda, ref = lv.refVolume;
    lv.driverInStep = true;
    // frame with an arbitrary volume: with the driver on the step, nothing of the driver changes
    applyLvContraction(lv, 999, 12345, 99, 0.5, 100, 0);
    expect([lv.tw.T, lv.tw.switches, lv.lambda, lv.refVolume]).toEqual([T, sw, lam, ref]);
    lv.driverInStep = false;
  });

  it('5c.1/5c.2: swaps equal at 17 and 33 ms, one per aortic closure, and T never drops more than the ceiling per step (nominal and HR 150)', { timeout: 240000 }, async () => {
    const lv = await buildLv();
    for (const hr of [null, 150]) {
      const res: Record<number, number[]> = {};
      let closures = 0, maxDrop = 0;
      for (const frameMs of [17, 33]) {
        const sim = makeSim(hr, null);
        const h = sim.ctx.live.hemo;
        const sws: number[] = [];
        let sw = -1, zPrev = 0, Tprev = NaN;
        closures = 0;
        runLoop(lv, sim, 10000, frameMs, (i) => {
          if (sw < 0) sw = lv.tw.switches;
          if (lv.tw.switches !== sw) {
            sw = lv.tw.switches;
            if (i >= 4000) sws.push(lv.tw.tSw);
          }
          if (i >= 4000 && zPrev >= LV_UNTWIST_VALVE_Z && h.zAortic < LV_UNTWIST_VALVE_Z) closures++;
          zPrev = h.zAortic;
          if (i >= 1000 && Tprev === Tprev && Tprev - lv.tw.T > maxDrop) maxDrop = Tprev - lv.tw.T;
          Tprev = lv.tw.T;
        });
        res[frameMs] = sws;
      }
      expect(res[17].length, `FC ${hr ?? 'nominal'}: trocas na janela 4–10 s`).toBe(closures);
      expect(res[33]).toEqual(res[17]);
      expect(maxDrop, `FC ${hr ?? 'nominal'}: maior queda de T por passo`).toBeLessThanOrEqual(LV_UNTWIST_MAX_RATE * 0.001 + 1e-12);
    }
  });

  it('5c.3: swap before mitral opening in every cycle at EF 10 at HR 40 and 72; nominal with 20–64 % at opening', { timeout: 240000 }, async () => {
    const lv = await buildLv();
    for (const [hr, ef] of [[40, 10], [72, 10], [null, null]] as Array<[number | null, number | null]>) {
      const sim = makeSim(hr, ef);
      const h = sim.ctx.live.hemo;
      let sw = -1, zPrev = 0, zAoPrev = 0, Tsw = NaN, pendingOpen = false, checked = 0;
      runLoop(lv, sim, 10000, 17, (i) => {
        if (sw < 0) sw = lv.tw.switches;
        const switched = lv.tw.switches !== sw;
        if (switched) {
          sw = lv.tw.switches;
          Tsw = lv.tw.Tsw;
        }
        // each aortic closure of the window swaps in the same step (therefore before the next mitral opening)
        if (i >= 4000 && zAoPrev >= LV_UNTWIST_VALVE_Z && h.zAortic < LV_UNTWIST_VALVE_Z) {
          expect(switched, `FC ${hr} FEVE ${ef}, t = ${sim.clock.state.t.toFixed(3)}: troca no fechamento aórtico`).toBe(true);
          pendingOpen = true;
          checked++;
        }
        if (pendingOpen && zPrev < LV_UNTWIST_VALVE_Z && h.zMitral >= LV_UNTWIST_VALVE_Z) {
          pendingOpen = false;
          if (hr === null) {
            const frac = 1 - lv.tw.T / Tsw;
            expect(frac).toBeGreaterThanOrEqual(0.2);
            expect(frac).toBeLessThanOrEqual(0.64);
          }
        }
        zPrev = h.zMitral;
        zAoPrev = h.zAortic;
      });
      expect(checked, `FC ${hr} FEVE ${ef}: fechamentos aórticos verificados`).toBeGreaterThanOrEqual(hr === 40 ? 3 : 5);
    }
  });

  it('system reset restarts the driver (the clock returns to t = 0 on simulation restart)', { timeout: 120000 }, async () => {
    const lv = await buildLv();
    runLoop(lv, makeSim(null, null), 2000, 17);
    expect(lv.tw.switches).toBeGreaterThan(0);
    createLvDriverSystem(lv).reset();
    expect(lv.tw.switches).toBe(0);
    expect(lv.tw.init).toBe(false);
    resetLvDriver(lv);
  });
});

describe('LV Phase 5c — RV glow detector (D-VE34)', () => {
  /** Triggers (definition of rvGlowWireframe.test.ts:280–286) per QRS in the window [4, 12) s. */
  function firing(mode: 'spontaneous' | 'mechanical', useWireframe: boolean) {
    const sim = makeSim(null, null, mode);
    const h = sim.ctx.live.hemo;
    const c = sim.clock.state;
    const tr = createRvVolumeTracker();
    const wf = createRvWireframeDriver();
    const s = new THREE.Vector3();
    let fPrev = NaN, qrs = 0, fired = 0, firedThis = false;
    let qPrev = c.tSinceQRS;
    for (let i = 0; i < 12000; i++) {
      sim.clock.step(0.001, sim.cmd());
      sim.engine.step(0.001, sim.ctx);
      let f: number;
      if (useWireframe) {
        updateRvWireframe(wf, h.vRV, c.beatIndex, s);
        f = wf.fill;
      } else {
        updateRvVolumeTracker(tr, h.vRV, c.beatIndex, c.tInBeat);
        f = rvFillFraction(tr, h.vRV);
      }
      if (i >= 4000) {
        if (c.tSinceQRS < qPrev) {
          if (qrs > 0 && firedThis) fired++;
          qrs++;
          firedThis = false;
        }
        if (fPrev >= 0.98 && f < 0.98 && c.tSinceQRS < 0.3) firedThis = true;
      }
      qPrev = c.tSinceQRS;
      fPrev = f;
    }
    // the last QRS of the window may not have finished: counts only the closed ones (next QRS seen)
    return { complete: qrs - 1, fired };
  }

  it('fires on every complete 8 s beat, with spontaneous breathing and with MV (rig tracker with τ and wireframe without τ)', () => {
    for (const mode of ['spontaneous', 'mechanical'] as const) {
      for (const wf of [false, true]) {
        const r = firing(mode, wf);
        expect(r.complete, `${mode} ${wf ? 'wireframe' : 'rig'}: batimentos`).toBeGreaterThanOrEqual(8);
        expect(r.fired, `${mode} ${wf ? 'wireframe' : 'rig'}: disparos`).toBe(r.complete);
      }
    }
  });

  it('exact periodic rhythm: the fill is that of the previous beat reference (difference ≤ 1e−12 at 1 ms)', () => {
    // a repeated synthetic beat: vRV(τ) = 60 + 90·(0.5 + 0.5·cos(2π·τ/RR)) starting in mid-diastole (phase 0.85)
    const RR = 830;
    const v = (k: number) => 60 + 90 * (0.5 + 0.5 * Math.cos(2 * Math.PI * ((k + 0.85 * RR) % RR) / RR));
    const tr = createRvVolumeTracker();
    let dmax = 0;
    for (let i = 0; i < RR * 8; i++) {
      const b = Math.floor(i / RR);
      updateRvVolumeTracker(tr, v(i), b, (i % RR) * 0.001);
      const f = rvFillFraction(tr, v(i));
      if (b >= 2) {
        const ref = Math.min(1, Math.max(0, (v(i) - tr.esv) / (tr.edv - tr.esv)));
        dmax = Math.max(dmax, Math.abs(f - ref));
      }
    }
    expect(dmax).toBeLessThanOrEqual(1e-12);
  });
});
