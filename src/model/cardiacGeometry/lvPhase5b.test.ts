import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MasterPhysiologyClock } from '../../controller/MasterPhysiologyClock';
import { defaultParams, createLiveState } from '../../controller/usePhysiologyStore';
import type { SimContext } from '../contracts/types';
import { HemodynamicEngine } from '../hemodynamics/HemodynamicEngine';
import { applyRvProceduralGeometry } from './rvGeometry';
import { setupValvarKinematics } from './valvarKinematics';
import { setupSemilunarValves } from './semilunarValve';
import { applyLvWatertightGeometry } from './lvWatertightGeometry';
import { lvClosedLayerVolume } from './lvMetrics';
import { LV_ANALYTIC_PROFILE } from './rvGeometryMetrics';
import {
  setupLvContractionField,
  setLvSegmentMotion,
  setLvLambda,
  flushLvField,
  updateLvDriver,
  resetLvDriver,
  lvTopNow,
  lvMeshExcessTh,
  LV_MESH_DIV_SLACK,
  LV_UNTWIST_VALVE_Z,
  type LvFieldRig,
} from './lvContractionField';

// LV untwisting tied to filling, negative λ handling, annulus normals, and regional path warm-up.

const Y_TOP = LV_ANALYTIC_PROFILE.y0 + LV_ANALYTIC_PROFILE.height;
const DEG = 180 / Math.PI;

async function loadGlbScene(): Promise<THREE.Group> {
  const fsMod: any = await import(/* @vite-ignore */ 'f' + 's');
  const pathMod: any = await import(/* @vite-ignore */ 'p' + 'a' + 't' + 'h');
  const buffer = fsMod.readFileSync(pathMod.resolve('public/models/realistic_heart.glb'));
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(arrayBuffer, '', (g) => resolve(g.scene), reject));
}

async function buildLv(warmRegional = true) {
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
  const lv = setupLvContractionField(ss, scene, valvar, { semilunar: semi, warmRegional } as any)!;
  return { scene, valvar, ss, lv };
}

/** Negative λ via the driver path (regression case): establishes the EDV and then a volume above it. */
function driveNegative(lv: LvFieldRig): void {
  resetLvDriver(lv);
  for (let k = 0; k < 5; k++) updateLvDriver(lv, 120 - 15 * k, 0, k * 0.001);
  updateLvDriver(lv, 200, 1, 0.005);
  flushLvField(lv);
}

const SCEN: Array<[string, number[]]> = [
  ['wm1', Array.from({ length: 17 }, () => 1)],
  ['seg 7 acinético', Array.from({ length: 17 }, (_, i) => (i === 6 ? 0 : 1))],
  ['seg 7 discinético', Array.from({ length: 17 }, (_, i) => (i === 6 ? -0.32 : 1))],
  ['isquemia 1/7/13', Array.from({ length: 17 }, (_, i) => (i === 0 || i === 6 || i === 12 ? 0.35 : 1))],
];

function bytesOf(scene: THREE.Object3D): Uint8Array {
  const parts: Uint8Array[] = [];
  scene.traverse((o: any) => {
    if (!o.isMesh) return;
    for (const key of ['position', 'normal']) {
      const a = o.geometry.getAttribute(key);
      if (a) parts.push(new Uint8Array(a.array.buffer, a.array.byteOffset, a.array.byteLength));
    }
    if (o.matrixAutoUpdate) o.updateMatrix();
    parts.push(new Uint8Array(Float64Array.from(o.matrix.elements).buffer));
  });
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}

describe('LV Phase 5b', () => {
  it('5b.1 (B1): with driver λ = −0.15 the base does not rise above the rest top, mass is conserved and table D covers λ < 0', { timeout: 240000 }, async () => {
    const { ss, lv } = await buildLv();
    setLvLambda(lv, 0);
    flushLvField(lv);
    const mass0 = lvClosedLayerVolume(ss, true).volume - lvClosedLayerVolume(ss, false).volume;
    for (const [name, c] of SCEN) {
      setLvSegmentMotion(lv, c);
      driveNegative(lv);
      expect(lv.lambda, `${name}: λ do driver`).toBe(-0.15);
      let yMax = -Infinity;
      for (const m of ss) {
        const p = m.geometry.getAttribute('position').array as Float32Array;
        for (let i = 1; i < p.length; i += 3) if (p[i] > yMax) yMax = p[i];
      }
      expect(yMax, `${name}: maior y da malha do VE`).toBeLessThanOrEqual(Y_TOP + 1e-6);
      for (let k = 0; k < 72; k++) expect(lvTopNow(lv, (k * Math.PI) / 36)).toBeLessThanOrEqual(Y_TOP + 1e-12);
      expect(lv.envelope.topMin).toBeLessThanOrEqual(Y_TOP + 1e-12);
      const mass = lvClosedLayerVolume(ss, true).volume - lvClosedLayerVolume(ss, false).volume;
      expect(Math.abs(mass / mass0 - 1) * 100, `${name}: massa (%)`).toBeLessThanOrEqual(0.1);
      // the guard margin exists at λ < 0 (slice = maximum of the nodes −0.15 and 0) and the largest margin of the frame is the ceiling of all
      let worst = 0;
      for (let j = 0; j < 72; j++) for (let q = 0; q < 44; q++) {
        const e = lvMeshExcessTh(lv.envelope, ((j + 0.5) * Math.PI) / 36, LV_ANALYTIC_PROFILE.y0 + ((q + 0.5) * LV_ANALYTIC_PROFILE.height) / 44);
        expect(e).toBeGreaterThanOrEqual(LV_MESH_DIV_SLACK);
        if (e > worst) worst = e;
      }
      expect(worst).toBeLessThanOrEqual(lv.envelope.divMaxSlack);
      for (const m of ss) for (const v of m.geometry.getAttribute('position').array as Float32Array) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('5b.2 (N1): published mitral annulus normals within ≤ 1° of those recomputed by computeVertexNormals; at rest the GLB ones return', { timeout: 240000 }, async () => {
    const { scene, lv } = await buildLv();
    const ann = scene.getObjectByName('mitral_annulus') as THREE.Mesh;
    const g = ann.geometry;
    setLvLambda(lv, 0);
    flushLvField(lv);
    const restN = Float32Array.from(g.getAttribute('normal').array as Float32Array);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const maxAngle = () => {
      const ref = g.clone();
      ref.computeVertexNormals();
      const n = g.getAttribute('normal'), r = ref.getAttribute('normal');
      let worst = 0;
      for (let i = 0; i < n.count; i++) {
        a.fromBufferAttribute(n, i);
        b.fromBufferAttribute(r, i);
        worst = Math.max(worst, a.angleTo(b) * DEG);
      }
      ref.dispose();
      return worst;
    };
    for (const [name, c] of SCEN) {
      setLvSegmentMotion(lv, c);
      for (const which of ['neg', 'zero', 'max'] as const) {
        if (which === 'neg') driveNegative(lv);
        else {
          setLvLambda(lv, which === 'zero' ? 0 : lv.lambdaMax);
          flushLvField(lv);
        }
        expect(maxAngle(), `${name} / ${which}: normal publicada × recalculada (°)`).toBeLessThanOrEqual(1);
      }
      if (name !== 'wm1') {
        // at λmax the local top deformed the annulus: the normals changed
        let changed = 0;
        const n = g.getAttribute('normal').array as Float32Array;
        for (let i = 0; i < n.length; i++) if (n[i] !== restN[i]) changed++;
        expect(changed, `${name}: componentes de normal mudados em λmax`).toBeGreaterThan(0);
      }
      setLvLambda(lv, 0);
      flushLvField(lv);
      expect(Array.from(g.getAttribute('normal').array as Float32Array), `${name}: normais de repouso`).toEqual(Array.from(restN));
    }
  });

  it('5b.3 (D-VE27): warm-up of the regional path does not change the rig state (rest and regional pose byte-identical)', { timeout: 240000 }, async () => {
    const warm = await buildLv(true);
    const cold = await buildLv(false);
    expect(warm.lv.warmupMs).toBeGreaterThan(0);
    expect(cold.lv.warmupMs).toBe(0);
    const same = (label: string) => {
      const x = bytesOf(warm.scene), y = bytesOf(cold.scene);
      expect(x.length, label).toBe(y.length);
      let d = 0;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) d++;
      expect(d, `${label}: bytes diferentes`).toBe(0);
    };
    same('repouso depois da carga');
    expect(Array.from(warm.lv.qGrid)).toEqual(Array.from(cold.lv.qGrid));
    expect(Array.from(warm.lv.appTabDx)).toEqual(Array.from(cold.lv.appTabDx));
    expect(Array.from(warm.lv.envelope.divTab!)).toEqual(Array.from(cold.lv.envelope.divTab!));
    for (const w of [warm, cold]) {
      setLvLambda(w.lv, 0.6);
      flushLvField(w.lv);
    }
    same('wm1, λ = 0,6');
    for (const w of [warm, cold]) {
      setLvSegmentMotion(w.lv, SCEN[2][1]);
      setLvLambda(w.lv, 0.8);
      flushLvField(w.lv);
    }
    same('seg 7 discinético, λ = 0,8');
  });

  it('5b.4 (D-VE28): untwisting tied to filling: 20–64 % at mitral opening and ≤ 10 % at the end of rapid filling (nominal and EF 10 at HR 72; driver at 1 ms and 17 ms)', { timeout: 240000 }, async () => {
    const { lv } = await buildLv();
    const run = (hr: number | null, ef: number | null, every: number) => {
      const clock = new MasterPhysiologyClock();
      const params = defaultParams();
      const live = createLiveState();
      if (hr !== null) params.ecg.heartRate = hr;
      if (ef !== null) params.echo.lvef = ef;
      live.clock = clock.state;
      const ctx: SimContext = { clock: clock.state, live, params };
      const cmd = () => ({ hr: live.hemo.hrCommand > 0 ? live.hemo.hrCommand : params.ecg.heartRate, rhythm: params.ecg.rhythm, flutterConduction: params.ecg.flutterConduction, qtc: params.ecg.qtc, respRate: params.ventilation.respRate, inspFraction: 1 / 3 });
      clock.reset(cmd());
      const engine = new HemodynamicEngine();
      engine.reset(ctx);
      setLvSegmentMotion(lv, SCEN[0][1]);
      resetLvDriver(lv);
      const cycles: Array<{ t: number; peak: number; open: number; er: number; evt: boolean }> = [];
      let sw = lv.tw.switches, phase = 0, zPrev = 0, eMax = 0;
      let cur: { t: number; peak: number; open: number; er: number; evt: boolean } | null = null;
      for (let i = 0; i < 10000; i++) {
        clock.step(0.001, cmd());
        engine.step(0.001, ctx);
        if (i % every === 0) updateLvDriver(lv, live.hemo.vLV, clock.state.beatIndex, clock.state.t, live.hemo.zMitral, live.hemo.qMitral);
        const z = live.hemo.zMitral, q = live.hemo.qMitral;
        if (lv.tw.switches !== sw) {
          sw = lv.tw.switches;
          cur = { t: clock.state.t, peak: lv.tw.Tsw, open: NaN, er: NaN, evt: lv.tw.evt };
          if (clock.state.t >= 4) cycles.push(cur);
          phase = 1;
          eMax = 0;
        } else if (phase === 1 && zPrev < LV_UNTWIST_VALVE_Z && z >= LV_UNTWIST_VALVE_Z) {
          phase = 2;
          if (cur) cur.open = lv.tw.T;
        } else if (phase === 2) {
          if (q > eMax) eMax = q;
          else if (q <= 0.1 * eMax) {
            phase = 0;
            if (cur) cur.er = lv.tw.T;
          }
        }
        zPrev = z;
      }
      return cycles;
    };
    for (const every of [1, 17]) {
      const nominal = run(null, null, every).filter((c) => Number.isFinite(c.er));
      expect(nominal.length, `nominal (${every} ms): ciclos com fim do enchimento rápido`).toBeGreaterThanOrEqual(4);
      for (const c of nominal) {
        expect(c.evt, 'perfil por eventos em uso').toBe(true);
        const frac = 1 - c.open / c.peak;
        expect(frac, `nominal (${every} ms), t = ${c.t.toFixed(3)}: fração destorcida na abertura mitral`).toBeGreaterThanOrEqual(0.2);
        expect(frac, `nominal (${every} ms), t = ${c.t.toFixed(3)}: fração destorcida na abertura mitral`).toBeLessThanOrEqual(0.64);
        expect(c.er / c.peak, `nominal (${every} ms), t = ${c.t.toFixed(3)}: resíduo no fim do enchimento rápido`).toBeLessThanOrEqual(0.1);
      }
      const low = run(72, 10, every).filter((c) => Number.isFinite(c.er) && c.peak > 0);
      expect(low.length, `FEVE 10 a FC 72 (${every} ms): ciclos`).toBeGreaterThanOrEqual(4);
      for (const c of low) expect(c.er / c.peak, `FEVE 10 a FC 72 (${every} ms), t = ${c.t.toFixed(3)}: resíduo`).toBeLessThanOrEqual(0.1);
    }
  });

  it('5b.4: without the engine signals (old driver call) the Phase 5 time profile applies', { timeout: 120000 }, async () => {
    const { lv } = await buildLv();
    resetLvDriver(lv);
    let t = 0;
    for (let k = 0; k < 3000; k++) {
      t += 0.001;
      const f = 0.5 - 0.5 * Math.cos(2 * Math.PI * ((t * 72) / 60));
      updateLvDriver(lv, 120 * (1 - 0.6 * f), Math.floor((t * 72) / 60), t);
    }
    expect(lv.tw.switches).toBeGreaterThan(0);
    expect(lv.tw.evt).toBe(false);
    expect(Number.isNaN(lv.tw.dvE)).toBe(true);
  });
});
