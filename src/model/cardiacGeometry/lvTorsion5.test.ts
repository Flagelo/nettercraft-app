import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MasterPhysiologyClock } from '../../controller/MasterPhysiologyClock';
import { defaultParams, createLiveState } from '../../controller/usePhysiologyStore';
import type { SimContext } from '../contracts/types';
import { HemodynamicEngine } from '../hemodynamics/HemodynamicEngine';
import { applyRvProceduralGeometry } from './rvGeometry';
import { setupValvarKinematics, applyValvarDeformation } from './valvarKinematics';
import { setupSemilunarValves } from './semilunarValve';
import { applyLvWatertightGeometry } from './lvWatertightGeometry';
import {
  setupLvContractionField,
  setLvSegmentMotion,
  setLvLambda,
  flushLvField,
  updateLvDriver,
  resetLvDriver,
  applyLvChordTies,
  lvLambdaFromQ,
  lvTwistAt,
  LV_LAMBDA_ES_NOMINAL,
  LV_TWIST_APEX_DEG,
  LV_TWIST_BASE_DEG,
  type LvFieldRig,
} from './lvContractionField';

// LV Phase 5 — torsion (Maharaj 2013, PMID 23053853). VE_FASE5_20261112.md; pre-registered criteria in
// sandbox_nettercraft_ve_20261111\_evidencias\ve5\CRITERIOS_VE5.md (definition of the measures copied from there unchanged).
// Convention: θ = atan2(z, x) in the LV parent space; rotation > 0 = increasing θ = counterclockwise seen from the apex (AR > 0, BR < 0).

const DEG = 180 / Math.PI;
/** Measurement levels (rest rings of the mesh): apical ν = 0.25 and basal ν = 0.84. */
const U_APICAL = -0.8825;
const U_BASAL = 0.386;

async function loadGlbScene(): Promise<THREE.Group> {
  const fsMod: any = await import(/* @vite-ignore */ 'f' + 's');
  const pathMod: any = await import(/* @vite-ignore */ 'p' + 'a' + 't' + 'h');
  const buffer = fsMod.readFileSync(pathMod.resolve('public/models/realistic_heart.glb'));
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(arrayBuffer, '', (g) => resolve(g.scene), reject));
}

async function buildLv() {
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
  const lv = setupLvContractionField(ss, scene, valvar, { semilunar: semi } as any)!;
  return { scene, valvar, ss, lv };
}

/** (endocardium, epicardium) pairs with the same rest (θ, u) on ring u, one per θ (CRITERIOS_VE5: "Pontos"). */
function ringPairs(ss: THREE.Mesh[], u: number): Array<[THREE.Mesh, number, number]> {
  const out: Array<[THREE.Mesh, number, number]> = [];
  const seen = new Set<number>();
  for (const m of ss) {
    const rest = m.geometry.userData.lvFieldRest as Float32Array;
    const n = rest.length / 3;
    const half = n / 2;
    const epi = new Map<string, number>();
    for (let i = half; i < n; i++) {
      const r = Math.hypot(rest[3 * i], rest[3 * i + 2]);
      if (r < 1e-9) continue;
      epi.set(`${Math.round(Math.atan2(rest[3 * i + 2], rest[3 * i]) * 1e6)}|${Math.round(rest[3 * i + 1] * 1e6)}`, i);
    }
    for (let i = 0; i < half; i++) {
      if (Math.abs(rest[3 * i + 1] - u) > 1e-7) continue;
      if (Math.hypot(rest[3 * i], rest[3 * i + 2]) < 1e-9) continue;
      const th = Math.round(Math.atan2(rest[3 * i + 2], rest[3 * i]) * 1e6);
      if (seen.has(th)) continue;
      const j = epi.get(`${th}|${Math.round(rest[3 * i + 1] * 1e6)}`);
      if (j === undefined) continue;
      seen.add(th);
      out.push([m, i, j]);
    }
  }
  return out;
}

/** Current angles (rad) of the mid-myocardial (mid = true) or endocardial points. The wedges have identity matrix (parent space). */
function ringAngles(pairs: Array<[THREE.Mesh, number, number]>, mid: boolean): Float64Array {
  const a = new Float64Array(pairs.length);
  pairs.forEach(([m, i, j], k) => {
    const p = m.geometry.getAttribute('position').array as Float32Array;
    const x = mid ? 0.5 * (p[3 * i] + p[3 * j]) : p[3 * i];
    const z = mid ? 0.5 * (p[3 * i + 2] + p[3 * j + 2]) : p[3 * i + 2];
    a[k] = Math.atan2(z, x);
  });
  return a;
}

/** Differing bytes between two Float32Arrays of the same size. */
function differentBytes(a: Float32Array, b: Float32Array): number {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (x.length !== y.length) return Infinity;
  let d = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) d++;
  return d;
}

/** Mean rotation (degrees) of `now` against `ref`, with each difference brought to (−π, π]. */
function meanRotation(now: Float64Array, ref: Float64Array): number {
  let s = 0;
  for (let k = 0; k < now.length; k++) {
    let d = now[k] - ref[k];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    s += d;
  }
  return (s / now.length) * DEG;
}

describe('LV Phase 5 — torsion (Maharaj 2013) and untwisting', () => {
  it('5.1–5.3 static (wm1, nominal λ_ES): AR, BR and torsion within the intervals; sign (apex counterclockwise seen from the apex); λ = 0 without rotation; repeated pose identical', { timeout: 120000 }, async () => {
    const { ss, lv } = await buildLv();
    const pa = ringPairs(ss, U_APICAL);
    const pb = ringPairs(ss, U_BASAL);
    expect(pa.length).toBeGreaterThan(20);
    expect(pb.length).toBeGreaterThan(20);
    setLvLambda(lv, 0);
    flushLvField(lv);
    expect(lv.twistOn, 'λ = 0: sem torção').toBe(false);
    const restA = ringAngles(pa, true), restB = ringAngles(pb, true);
    const restAe = ringAngles(pa, false), restBe = ringAngles(pb, false);
    const pos0 = ss.map((m) => Float32Array.from(m.geometry.getAttribute('position').array as Float32Array));
    setLvLambda(lv, LV_LAMBDA_ES_NOMINAL);
    flushLvField(lv);
    const AR = meanRotation(ringAngles(pa, true), restA);
    const BR = meanRotation(ringAngles(pb, true), restB);
    expect(AR, 'AR (°)').toBeGreaterThanOrEqual(3.58);
    expect(AR, 'AR (°)').toBeLessThanOrEqual(7.54);
    expect(BR, 'BR (°)').toBeGreaterThanOrEqual(-4.23);
    expect(BR, 'BR (°)').toBeLessThanOrEqual(-2.39);
    expect(AR - BR, 'torção (°)').toBeGreaterThanOrEqual(6.66);
    expect(AR - BR, 'torção (°)').toBeLessThanOrEqual(11.08);
    // by construction (gains = Maharaj means at nominal λ_ES): checks the implementation
    expect(Math.abs(AR - LV_TWIST_APEX_DEG), 'AR − 5,56°').toBeLessThan(0.05);
    expect(Math.abs(BR - LV_TWIST_BASE_DEG), 'BR + 3,31°').toBeLessThan(0.05);
    // endocardium and mid-myocardium have the same y at the same (θ, u): same rotation
    expect(Math.abs(meanRotation(ringAngles(pa, false), restAe) - AR)).toBeLessThan(0.01);
    expect(Math.abs(meanRotation(ringAngles(pb, false), restBe) - BR)).toBeLessThan(0.01);
    // lvTwistAt (current y) returns the same φ as the rings
    const [m0, i0] = pa[0];
    const yA = (m0.geometry.getAttribute('position').array as Float32Array)[3 * i0 + 1];
    expect(Math.abs(lvTwistAt(lv, yA) * DEG - LV_TWIST_APEX_DEG)).toBeLessThan(0.05);
    // repeated pose (λ → 0 → λ) byte-identical; λ = 0 returns exactly to rest
    const snap = ss.map((m) => Float32Array.from(m.geometry.getAttribute('position').array as Float32Array));
    setLvLambda(lv, 0);
    flushLvField(lv);
    ss.forEach((m, k) => expect(differentBytes(m.geometry.getAttribute('position').array as Float32Array, pos0[k])).toBe(0));
    setLvLambda(lv, LV_LAMBDA_ES_NOMINAL);
    flushLvField(lv);
    ss.forEach((m, k) => expect(differentBytes(m.geometry.getAttribute('position').array as Float32Array, snap[k])).toBe(0));
  });

  it('5.4 engine cycle (HR 72, 4–10 s): net torsion of each beat within 6.66–11.08° and ≤ 10 % of peak at the end of rapid filling (q_mitral ≤ 10 % of E)', { timeout: 240000 }, async () => {
    const { ss, lv, valvar } = await buildLv();
    const pa = ringPairs(ss, U_APICAL);
    const pb = ringPairs(ss, U_BASAL);
    const clock = new MasterPhysiologyClock();
    const params = defaultParams();
    const live = createLiveState();
    live.clock = clock.state;
    const ctx: SimContext = { clock: clock.state, live, params };
    const cmd = () => ({ hr: live.hemo.hrCommand > 0 ? live.hemo.hrCommand : params.ecg.heartRate, rhythm: params.ecg.rhythm, flutterConduction: params.ecg.flutterConduction, qtc: params.ecg.qtc, respRate: params.ventilation.respRate, inspFraction: 1 / 3 });
    clock.reset(cmd());
    const engine = new HemodynamicEngine();
    engine.reset(ctx);
    setLvSegmentMotion(lv, new Float64Array(17).fill(1));
    resetLvDriver(lv);
    type Sample = { t: number; beat: number; lam: number; a: Float64Array; b: Float64Array; kind: 'grade' | 'troca' | 'fimER' };
    const samples: Sample[] = [];
    const take = (kind: Sample['kind'], lvRig: LvFieldRig) => {
      flushLvField(lvRig);
      applyValvarDeformation(valvar, live.hemo.zMitral, live.hemo.zTricuspid);
      applyLvChordTies(lvRig);
      samples.push({ t: clock.state.t, beat: clock.state.beatIndex, lam: lvRig.lambda, a: ringAngles(pa, true), b: ringAngles(pb, true), kind });
    };
    // end of rapid filling per beat (CRITERIOS_VE5 §5.4): after the swap, mitral opening (z crosses 0.25 upward), E peak, q ≤ 10 % of E
    let sw = lv.tw.switches, phase = 0, zPrev = 0, eMax = 0, beatEr = -1;
    for (let i = 0; i < 10000; i++) {
      clock.step(0.001, cmd());
      engine.step(0.001, ctx);
      // LV Phase 5b (D-VE28): the driver receives zMitral and qMitral from the engine (without them the 200 ms time profile would apply)
      updateLvDriver(lv, live.hemo.vLV, clock.state.beatIndex, clock.state.t, live.hemo.zMitral, live.hemo.qMitral);
      const z = live.hemo.zMitral, q = live.hemo.qMitral;
      let forced: Sample['kind'] | null = null;
      if (lv.tw.switches !== sw) {
        sw = lv.tw.switches;
        phase = 1;
        eMax = 0;
        beatEr = clock.state.beatIndex;
        forced = 'troca';
      } else if (phase === 1 && zPrev < 0.25 && z >= 0.25) phase = 2;
      else if (phase === 2) {
        if (q > eMax) eMax = q;
        else if (q <= 0.1 * eMax && clock.state.beatIndex === beatEr) {
          phase = 0;
          forced = 'fimER';
        }
      }
      zPrev = z;
      if (i >= 4000 && (forced || i % 20 === 0)) take(forced ?? 'grade', lv);
    }
    const beats = [...new Set(samples.map((s) => s.beat))];
    let checked = 0;
    for (const b of beats) {
      const S = samples.filter((s) => s.beat === b);
      const iPk = S.reduce((k, s, j) => (s.lam > S[k].lam ? j : k), 0);
      const pre = S.slice(0, iPk + 1);
      const er = S.find((s) => s.kind === 'fimER');
      // complete beat: start observed in the window (not the 1st beat of the samples), reference before the peak and end of rapid filling
      if (b === samples[0].beat || !pre.length || !er) continue;
      const ref = pre.reduce((m, s) => (s.lam < m.lam ? s : m), pre[0]);
      if (ref === S[iPk]) continue;
      const tors = S.map((s) => meanRotation(s.a, ref.a) - meanRotation(s.b, ref.b));
      const peak = Math.max(...tors);
      const atEr = tors[S.indexOf(er)];
      expect(peak, `batida ${b}: torção líquida (°)`).toBeGreaterThanOrEqual(6.66);
      expect(peak, `batida ${b}: torção líquida (°)`).toBeLessThanOrEqual(11.08);
      expect(atEr / peak, `batida ${b}: torção no fim do enchimento rápido / pico`).toBeLessThanOrEqual(0.1);
      checked++;
    }
    expect(checked, 'batidas completas conferidas').toBeGreaterThanOrEqual(4);
  });

  it('static regionals (seg 7 akinetic and dyskinetic, scenario λ_ES): torsion active, finite positions and normals', { timeout: 120000 }, async () => {
    const { lv, ss } = await buildLv();
    for (const c of [[...Array(17)].map((_, i) => (i === 6 ? 0 : 1)), [...Array(17)].map((_, i) => (i === 6 ? -0.32 : 1))]) {
      setLvSegmentMotion(lv, c);
      setLvLambda(lv, lvLambdaFromQ(lv, 1 - 0.6234));
      flushLvField(lv);
      expect(lv.twistOn).toBe(true);
      for (const m of ss) for (const v of m.geometry.getAttribute('position').array as Float32Array) expect(Number.isFinite(v)).toBe(true);
      for (const m of ss) for (const v of m.geometry.getAttribute('normal').array as Float32Array) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
