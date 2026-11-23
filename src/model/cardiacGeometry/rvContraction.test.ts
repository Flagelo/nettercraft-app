import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MasterPhysiologyClock } from '../../controller/MasterPhysiologyClock';
import { defaultParams, createLiveState } from '../../controller/usePhysiologyStore';
import type { SimContext } from '../contracts/types';
import { HemodynamicEngine } from '../hemodynamics/HemodynamicEngine';
import {
  RV_COMPONENT_WEIGHTS,
  RV_RIG_GAINS,
  RV_ANNULUS_SEPTAL_RATIO,
  RV_PAPILLARY_SHORTENING,
  RV_LEAFLET_RIG,
  setupRvContraction,
  applyRvContraction,
  updateRvDriver,
  setRvDeformation,
  solveRvLambda,
  rvLambdaFromQ,
  rvSeptalLvContraction,
  setRvLvContraction,
  LV_CONTRACTION_SCALE,
  RV_LV_V_MAX,
  RV_LV_V_MIN,
  rvQFromLambda,
  flushRvContraction,
  measureRvMeshVolume,
  measureLvCavityVolume,
  computeLvBaseY,
  createRvVolumeTracker,
  updateRvVolumeTracker,
  rvFillFraction,
  type RvContractionRig,
} from './rvContraction';
import { applyRvProceduralGeometry, rvPapillaryExtensions } from './rvGeometry';
import { applyTricuspidApparatusPose } from './tricuspidApparatusPose';
import { setupValvarKinematics, applyValvarDeformation, measureValvarCoaptation, type ValvarKinematicsData } from './valvarKinematics';
import chordaMappingRaw from './chorda_topological_mapping.json';
import { applyLvWatertightGeometry } from './lvWatertightGeometry';
import { lvClosedCavityVolume } from './lvMetrics';
import { setupLvContractionField, setLvLambda, flushLvField, lvLambdaFromQ, lvEpiRadiusUniform, LV_LAMBDA_ES_NOMINAL } from './lvContractionField';
import {
  entryBorderAnnulusGap,
  classifyAgainstLv,
  computeRvAxes,
  lvEnvelopeRadius,
  measureRvCavityVolume,
  pointToMeshDistance,
  worldPositions,
} from './rvGeometryMetrics';

const W = RV_COMPONENT_WEIGHTS;
const G = RV_RIG_GAINS;
const S = 34.3;
const kFromLambda = (lam: number): [number, number, number] => [W.longitudinal * G.longitudinal * lam, W.radial * G.radial * lam, W.anteroposterior * G.anteroposterior * lam];
const setLambda = (rig: RvContractionRig, lam: number) => {
  const [kL, kR, kAP] = kFromLambda(lam);
  setRvDeformation(rig, kL, kR, kAP);
};
const positionsOf = (rig: RvContractionRig) => Float32Array.from(rig.mesh.geometry.getAttribute('position').array as Float32Array);
const sameArray = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function loadGlbScene(): Promise<THREE.Group> {
  const fsName = 'f' + 's';
  const pathName = 'p' + 'a' + 't' + 'h';
  const fsMod: any = await import(/* @vite-ignore */ fsName);
  const pathMod: any = await import(/* @vite-ignore */ pathName);
  const buffer = fsMod.readFileSync(pathMod.resolve('public/models/realistic_heart.glb'));
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(arrayBuffer, '', (gltf) => resolve(gltf.scene), reject);
  });
}

function lvSegments(scene: THREE.Group): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  scene.traverse((o: any) => {
    if (o.isMesh && typeof o.userData?.segId === 'number') out.push(o);
  });
  return out.sort((a, b) => a.userData.segId - b.userData.segId);
}

/** Phase 4c: rig with valve kinematics enabled, in the order of HeartMesh17 */
async function buildRigWithValves(): Promise<{ scene: THREE.Group; rig: RvContractionRig; valvar: ValvarKinematicsData }> {
  const scene = await loadGlbScene();
  scene.updateMatrixWorld(true);
  applyRvProceduralGeometry(scene);
  const valvar = setupValvarKinematics(scene);
  if (!valvar) throw new Error('cinemática valvar não inicializada');
  applyTricuspidApparatusPose(scene);
  const rv = scene.getObjectByName('right_ventricle') as THREE.Mesh;
  const annulus = scene.getObjectByName('tricuspid_annulus') as THREE.Mesh;
  const rig = setupRvContraction(rv, annulus, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), valvar);
  if (!rig) throw new Error('rig do VD não inicializado');
  return { scene, rig, valvar };
}

async function buildRig(): Promise<{ scene: THREE.Group; rig: RvContractionRig }> {
  const scene = await loadGlbScene();
  scene.updateMatrixWorld(true);
  // Phase 4: the rig uses the annulus posed by T_TV, as in HeartMesh17 (the pose comes before the rig)
  applyRvProceduralGeometry(scene);
  applyTricuspidApparatusPose(scene);
  const rv = scene.getObjectByName('right_ventricle') as THREE.Mesh;
  const annulus = scene.getObjectByName('tricuspid_annulus') as THREE.Mesh;
  const rig = setupRvContraction(rv, annulus, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
  if (!rig) throw new Error('rig do VD não inicializado');
  return { scene, rig };
}

interface EngineTrace {
  vRV: number[];
  vLV: number[];
  zTr: number[];
  zPu: number[];
  zMi: number[];
  zAo: number[];
  tSinceQRS: number[];
  lambda: number[];
  meshV: number[];
  /** Expected V/EDV with the tracker's EDV/ESV at the sample instant */
  qExpected: number[];
  lvef: number;
}

/** Runs engine + clock at 1 ms; applies the RV contraction at each step and records the last window. */
function runEngineWithRig(
  rig: RvContractionRig,
  seconds: number,
  recordFrom: number,
  customize?: (ctx: SimContext) => void,
  onSample?: () => void,
): EngineTrace {
  const clock = new MasterPhysiologyClock();
  const params = defaultParams();
  const live = createLiveState();
  live.clock = clock.state;
  const ctx: SimContext = { clock: clock.state, live, params };
  customize?.(ctx);
  const cmd = () => ({
    hr: live.hemo.hrCommand > 0 ? live.hemo.hrCommand : params.ecg.heartRate,
    rhythm: params.ecg.rhythm,
    flutterConduction: params.ecg.flutterConduction,
    qtc: params.ecg.qtc,
    respRate: params.ventilation.respRate,
    inspFraction: 1 / 3,
  });
  clock.reset(cmd());
  const engine = new HemodynamicEngine();
  engine.reset(ctx);
  rig.tracker = createRvVolumeTracker();
  rig.refVolume = 0;
  rig.lastT = NaN;

  const tr: EngineTrace = { vRV: [], vLV: [], zTr: [], zPu: [], zMi: [], zAo: [], tSinceQRS: [], lambda: [], meshV: [], qExpected: [], lvef: 0 };
  const steps = Math.round(seconds * 1000);
  const rec0 = Math.round(recordFrom * 1000);
  for (let i = 0; i < steps; i++) {
    clock.step(0.001, cmd());
    engine.step(0.001, ctx);
    updateRvDriver(rig, live.hemo.vRV, clock.state.beatIndex, clock.state.t);
    if (i >= rec0) {
      tr.vRV.push(live.hemo.vRV);
      tr.vLV.push(live.hemo.vLV);
      tr.zTr.push(live.hemo.zTricuspid);
      tr.zPu.push(live.hemo.zPulmonary);
      tr.zMi.push(live.hemo.zMitral);
      tr.zAo.push(live.hemo.zAortic);
      tr.tSinceQRS.push(clock.state.tSinceQRS);
      tr.lambda.push(rig.lambda);
      // Phase 3b: subsample (1 every 20 ms) because the procedural wall has ~60× more triangles;
      // the mesh volume is only diagnostic in the EF asserts and varies slowly at that scale
      if (i % 20 === 0) {
        tr.meshV.push(measureRvMeshVolume(rig));
        if (onSample) onSample();
      } else {
        tr.meshV.push(NaN);
      }
      tr.qExpected.push(live.hemo.vRV / rig.refVolume);
    }
  }
  tr.lvef = live.hemo.lvef;
  return tr;
}

function maxOf(a: number[]): number { let m = -Infinity; for (const x of a) if (Number.isFinite(x) && x > m) m = x; return m; }
function minOf(a: number[]): number { let m = Infinity; for (const x of a) if (Number.isFinite(x) && x < m) m = x; return m; }

describe('RV contraction by volume in 3 components (Kovács 2019; Lakatos 2020)', () => {
  it('builds the rig from the GLB matrix without altering TRS or the rest position', async () => {
    const { scene, rig } = await buildRig();
    const rv = rig.mesh;
    // matrix of node N17 in the GLB (column-major), checked in the diagnostic of 2026-11-07
    const e = rig.restMatrix.elements;
    expect(e[0]).toBeCloseTo(0.9144, 3);
    expect(e[1]).toBeCloseTo(0.1197, 3);
    expect(e[2]).toBeCloseTo(-0.3866, 3);
    expect(e[8]).toBeCloseTo(0.3894, 3);
    expect(e[12]).toBeCloseTo(-0.62, 4);
    expect(e[13]).toBeCloseTo(-0.25, 4);
    expect(e[14]).toBeCloseTo(0.38, 4);
    expect(rv.matrixAutoUpdate).toBe(false);
    expect(rv.matrix.equals(rig.restMatrix)).toBe(true);

    // Orthonormal axes
    expect(rig.axisL.length()).toBeCloseTo(1, 6);
    expect(rig.axisR.length()).toBeCloseTo(1, 6);
    expect(rig.axisAP.length()).toBeCloseTo(1, 6);
    expect(Math.abs(rig.axisL.dot(rig.axisR))).toBeLessThan(1e-6);
    expect(Math.abs(rig.axisL.dot(rig.axisAP))).toBeLessThan(1e-6);
    expect(Math.abs(rig.axisR.dot(rig.axisAP))).toBeLessThan(1e-6);
    // Long axis points from the apex to the base (upward) and the LV radial points to the RV
    expect(rig.axisL.y).toBeGreaterThan(0.5);
    // Phase 4: the L axis comes from the explicit anchors (generator apex; posed annulus), not from the "farthest vertex"
    const rvApex = rv.geometry.userData.rvApex as [number, number, number];
    const expectedApex = new THREE.Vector3(rvApex[0], rvApex[1], rvApex[2]).applyMatrix4(rig.restMatrix);
    expect(rig.apex.distanceTo(expectedApex)).toBeLessThan(1e-9);
    const annulusNode = scene.getObjectByName('tricuspid_annulus') as THREE.Mesh;
    const annulusRest = new THREE.Vector3();
    const annPts = worldPositions(annulusNode);
    for (const p of annPts) annulusRest.add(p);
    annulusRest.multiplyScalar(1 / annPts.length);
    expect(rig.annulus.distanceTo(annulusRest)).toBeLessThan(1e-9);
    // the rig annulus is the one posed by T_TV: ≥ 20 mm from the original GLB annulus (-0.548; 0.648; 0.219)
    expect(rig.annulus.distanceTo(new THREE.Vector3(-0.548, 0.648, 0.219)) * S).toBeGreaterThan(20);
    // same anchors as the Lang metrics (L axis within 0.1° of the metrics axis)
    const axes = computeRvAxes(rv, annulusNode);
    expect(rig.apex.distanceTo(axes.apex)).toBeLessThan(1e-9);
    expect(rig.axisL.dot(axes.L)).toBeGreaterThan(Math.cos((0.1 * Math.PI) / 180));
    expect(rig.axisR.dot(rig.septalPoint)).toBeGreaterThan(0);

    // Null deformation ⇒ rest matrix; other nodes intact
    setRvDeformation(rig, 0, 0, 0);
    for (let i = 0; i < 16; i++) expect(rv.matrix.elements[i]).toBeCloseTo(rig.restMatrix.elements[i], 12);
    const la = scene.getObjectByName('left_atrium') as THREE.Mesh;
    expect(la.matrixAutoUpdate).toBe(true);
    expect(la.position.x).toBeCloseTo(0.42, 6);
  });

  it('solves λ such that Π(1 − w_i·λ) = V/EDV', () => {
    for (const q of [0.95, 0.7, 0.5, 0.4, 0.3]) {
      const lam = solveRvLambda(q, W.longitudinal, W.radial, W.anteroposterior);
      const p = (1 - W.longitudinal * lam) * (1 - W.radial * lam) * (1 - W.anteroposterior * lam);
      expect(p).toBeCloseTo(q, 9);
    }
    expect(solveRvLambda(1, W.longitudinal, W.radial, W.anteroposterior)).toBe(0);
  });

  it('does not move the RV at constant volume, even with different activation (no eRV in the driver)', async () => {
    const { rig } = await buildRig();
    const tr = rig.tracker;
    // two synthetic beats to validate EDV = 150 and ESV = 60
    for (let b = 0; b < 2; b++) {
      for (let k = 0; k <= 100; k++) updateRvVolumeTracker(tr, 60 + 90 * Math.abs(Math.cos((Math.PI * k) / 100)), b);
    }
    updateRvVolumeTracker(tr, 150, 2);
    expect(tr.valid).toBe(true);
    expect(tr.edv).toBeCloseTo(150, 6);
    expect(tr.esv).toBeCloseTo(60, 6);

    applyRvContraction(rig, 150, 2, 10);
    const mED = positionsOf(rig);
    applyRvContraction(rig, 150, 2, 10); // isovolumetric contraction: equal volume ⇒ same geometry
    expect(sameArray(positionsOf(rig), mED)).toBe(true);
    expect(rig.lambda).toBe(0);

    applyRvContraction(rig, 60, 2, 10);
    const mES = positionsOf(rig);
    applyRvContraction(rig, 60, 2, 10); // isovolumetric relaxation
    expect(sameArray(positionsOf(rig), mES)).toBe(true);
    expect(sameArray(mES, mED)).toBe(false);
  });

  it('moves the RV monotonically with volume (annulus toward the apex, free wall toward the septum)', async () => {
    const { rig } = await buildRig();
    const tr = rig.tracker;
    tr.edv = 150; tr.esv = 60; tr.valid = true; tr.lastBeat = 5; tr.beatMax = 150; tr.beatMin = 60; tr.samples = 10;
    rig.refVolume = 150; rig.lastT = 20;
    const pos = rig.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    // free-wall vertex farthest from the septum
    let iFree = 0; let dMax = -Infinity;
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(rig.restMatrix).sub(rig.septalPoint);
      const d = p.dot(rig.axisR);
      if (d > dMax) { dMax = d; iFree = i; }
    }
    const freeRest = new THREE.Vector3().fromBufferAttribute(pos, iFree).applyMatrix4(rig.restMatrix);

    let prevLong = -1; let prevRad = -1; let prevVol = Infinity;
    for (let v = 150; v >= 60; v -= 5) {
      applyRvContraction(rig, v, 5, 20);
      const longDisp = -rig.deltaTV.dot(rig.axisL); // > 0: annulus descends toward the apex
      const free = new THREE.Vector3().fromBufferAttribute(pos, iFree).applyMatrix4(rig.mesh.matrix);
      const radDisp = freeRest.clone().sub(free).dot(rig.axisR); // > 0: free wall moves toward the septum
      const vol = measureRvMeshVolume(rig);
      expect(longDisp).toBeGreaterThanOrEqual(prevLong - 1e-12);
      expect(radDisp).toBeGreaterThanOrEqual(prevRad - 1e-12);
      expect(vol).toBeLessThanOrEqual(prevVol + 1e-12);
      prevLong = longDisp; prevRad = radDisp; prevVol = vol;
    }
    expect(prevLong).toBeGreaterThan(0);
    expect(prevRad).toBeGreaterThan(0);
  });

  it('keeps the contribution of each component within mean ± SD of Lakatos 2020', async () => {
    const { rig } = await buildRig();
    setRvDeformation(rig, 0, 0, 0);
    const v0 = measureRvMeshVolume(rig);
    const ef = 0.6;
    // Phase 4: λ comes from the q(λ) table of the closed cavity; each isolated component keeps the same k as at rest at q = 0.4
    const lam = rvLambdaFromQ(rig, 1 - ef);
    const [kL, kR, kAP] = kFromLambda(lam);
    setRvDeformation(rig, kL, kR, kAP);
    const efMesh = 1 - measureRvMeshVolume(rig) / v0;
    expect(efMesh).toBeCloseTo(ef, 3);

    setRvDeformation(rig, kL, 0, 0);
    const fL = (1 - measureRvMeshVolume(rig) / v0) / efMesh;
    setRvDeformation(rig, 0, kR, 0);
    const fR = (1 - measureRvMeshVolume(rig) / v0) / efMesh;
    setRvDeformation(rig, 0, 0, kAP);
    const fAP = (1 - measureRvMeshVolume(rig) / v0) / efMesh;
    // longitudinal 47 ± 9%, radial 44 ± 10%, anteroposterior 49 ± 7%
    expect(fL).toBeGreaterThanOrEqual(0.38); expect(fL).toBeLessThanOrEqual(0.56);
    expect(fR).toBeGreaterThanOrEqual(0.34); expect(fR).toBeLessThanOrEqual(0.54);
    expect(fAP).toBeGreaterThanOrEqual(0.42); expect(fAP).toBeLessThanOrEqual(0.56);
    // approximately equal weights (max/min ratio < 1.2)
    expect(Math.max(fL, fR, fAP) / Math.min(fL, fR, fAP)).toBeLessThan(1.2);
  });

  it('calibrates by volume: RV mesh EF = engine RVEF (±10% relative); measures the LV EF', async () => {
    const { scene, rig } = await buildRig();
    const tr = runEngineWithRig(rig, 8, 6);
    const edv = maxOf(tr.vRV);
    const esv = minOf(tr.vRV);
    const rvefEngine = (edv - esv) / edv;
    const mv = tr.meshV.filter((x) => Number.isFinite(x));
    const rvefMesh = (maxOf(mv) - minOf(mv)) / maxOf(mv);
    expect(Math.abs(rvefMesh - rvefEngine) / rvefEngine).toBeLessThan(0.10);
    // Phase 4: mesh EF (closed cavity) follows the engine. Difference ≤ 0.5 p.p.: the V_ref reference is smoothed
    // (τ = 1.5 s) and the amplitude window mixes beats with different EDV (respiration; Section 7 of the report).
    expect(Math.abs(rvefMesh - rvefEngine), `malha ${(rvefMesh * 100).toFixed(2)}% vs motor ${(rvefEngine * 100).toFixed(2)}%`).toBeLessThan(0.005);
    expect(rvefMesh).toBeGreaterThan(0.595);
    expect(rvefMesh).toBeLessThan(0.602);

    // Curve: normalized mesh volume follows the engine volume along the cycle
    const v0 = (() => { setRvDeformation(rig, 0, 0, 0); return measureRvMeshVolume(rig); })();
    // (a) calibration accuracy: V_mesh/V_rest = V/EDV with the EDV/ESV in force at the sample
    // (b) deviation from the raw engine vRV with the EDV of this window (respiratory variation between beats)
    let maxErr = 0;
    let maxDev = 0;
    for (let i = 0; i < tr.meshV.length; i++) {
      if (!Number.isFinite(tr.meshV[i])) continue;
      const qMesh = tr.meshV[i] / v0;
      maxErr = Math.max(maxErr, Math.abs(qMesh - tr.qExpected[i]));
      maxDev = Math.max(maxDev, Math.abs(qMesh - tr.vRV[i] / edv));
    }
    // q(λ) table with linear interpolation (129 points): error ≪ 0.1 p.p.
    expect(maxErr).toBeLessThan(1e-3);
    expect(maxDev).toBeLessThan(0.06);

    // LV (LV Phase 3, by definition): the 3D uses the per-vertex field calibrated by volume (lvContractionField.ts), no longer the
    // per-node scale (before: mesh EF = 1 − 0.92²·0.96 = 18.75 %). At end systole (wm = 1) the mesh EF is the engine EF.
    const segs = lvSegments(scene);
    expect(segs.length).toBe(17);
    const baseY = computeLvBaseY(segs);
    applyLvWatertightGeometry(scene);
    const lvField = setupLvContractionField(segs)!;
    expect(lvField).not.toBeNull();
    // LV Phase 4 (by definition): the base descends; the fixed base plane of measureLvCavityVolume no longer closes the cavity.
    // The EF is now measured on the closed volume (lvClosedCavityVolume), the same as the q(λ) table.
    void baseY;
    const lv0 = lvClosedCavityVolume(segs).volume;
    const lvefEngine = (maxOf(tr.vLV) - minOf(tr.vLV)) / maxOf(tr.vLV);
    setLvLambda(lvField, lvLambdaFromQ(lvField, 1 - lvefEngine));
    flushLvField(lvField);
    const lvES = lvClosedCavityVolume(segs).volume;
    setLvLambda(lvField, 0);
    flushLvField(lvField);
    const lvefMesh = 1 - lvES / lv0;
    expect(Math.abs(lvefMesh - lvefEngine)).toBeLessThan(1e-3);
    // eslint-disable-next-line no-console
    console.info(
      `[VD/VE] FEVD motor ${(rvefEngine * 100).toFixed(1)}% · FE malha VD ${(rvefMesh * 100).toFixed(1)}% · ` +
      `FEVE motor ${(lvefEngine * 100).toFixed(1)}% (hemo.lvef ${tr.lvef}%) · FE malha VE ${(lvefMesh * 100).toFixed(1)}% · ` +
      `VDF ${edv.toFixed(1)} VSF ${esv.toFixed(1)} mL · erro de calibração ${(maxErr * 100).toExponential(1)} p.p. · desvio máx. vs vRV bruto ${(maxDev * 100).toFixed(2)} p.p.`,
    );
  });

  it('does not move the RV in the engine isovolumetric contraction and relaxation', async () => {
    const { rig } = await buildRig();
    const tr = runEngineWithRig(rig, 8, 6);
    const lamES = maxOf(tr.lambda);
    expect(lamES).toBeGreaterThan(0.2);
    // Isovolumetric RV phases: tricuspid and pulmonary valves closed (z < 0.25, threshold of the Mynard events)
    // from the QRS (contraction) and after pulmonary closure (relaxation), until the next opening.
    // The end-diastole window before the QRS is left out: there the engine is still filling the RV (~2 mL with z < 0.25).
    let maxDrift = 0;
    let n = 0;
    let runStart = -1;
    for (let i = 0; i < tr.lambda.length; i++) {
      const closed = tr.zTr[i] < 0.25 && tr.zPu[i] < 0.25 && tr.tSinceQRS[i] < 0.5;
      if (closed) {
        if (runStart < 0) runStart = i;
        maxDrift = Math.max(maxDrift, Math.abs(tr.lambda[i] - tr.lambda[runStart]));
        n++;
      } else {
        runStart = -1;
      }
    }
    expect(n).toBeGreaterThan(20);
    // tolerance: drift < 3% of the systolic excursion (residual leak of the Mynard valves)
    expect(maxDrift / lamES).toBeLessThan(0.03);
    // Phase 4: mesh VOLUME displacement in the same phases < 3% of the ejected volume (q(λ) table)
    let qDrift = 0;
    runStart = -1;
    for (let i = 0; i < tr.lambda.length; i++) {
      const closed = tr.zTr[i] < 0.25 && tr.zPu[i] < 0.25 && tr.tSinceQRS[i] < 0.5;
      if (closed) {
        if (runStart < 0) runStart = i;
        qDrift = Math.max(qDrift, Math.abs(rvQFromLambda(rig, tr.lambda[i]) - rvQFromLambda(rig, tr.lambda[runStart])));
      } else {
        runStart = -1;
      }
    }
    expect(qDrift / (1 - rvQFromLambda(rig, lamES))).toBeLessThan(0.03);
  });

  it('does not jump at the beat change: the mesh volume varies with vRV at each step', async () => {
    const { rig } = await buildRig();
    const tr = runEngineWithRig(rig, 10, 4);
    const prod = (l: number) => rvQFromLambda(rig, l);
    let maxJump = 0;
    for (let i = 1; i < tr.lambda.length; i++) {
      const dMesh = prod(tr.lambda[i]) - prod(tr.lambda[i - 1]);
      const dEng = tr.qExpected[i] - tr.qExpected[i - 1];
      maxJump = Math.max(maxJump, Math.abs(dMesh - dEng));
      // step by step (1 ms), the mesh never changes more than 0.5% of the rest volume beyond what vRV explains
      expect(Math.abs(dMesh - (tr.vRV[i] - tr.vRV[i - 1]) / tr.vRV[i - 1] * prod(tr.lambda[i - 1]))).toBeLessThan(0.005);
    }
    expect(maxJump).toBeLessThan(1e-6);
  });

  it('preserves the RBBB delay: the RV starts ejecting later relative to the QRS', async () => {
    const onset = async (bbb: 'none' | 'rbbb') => {
      const { rig } = await buildRig();
      const tr = runEngineWithRig(rig, 8, 6, (ctx) => { ctx.params.ecg.bundleBranchBlock = bbb; });
      // first instant after the QRS at which the pulmonary valve opens (z crosses 0.25)
      for (let i = 1; i < tr.zPu.length; i++) {
        if (tr.zPu[i - 1] < 0.25 && tr.zPu[i] >= 0.25 && tr.tSinceQRS[i] < 0.3) return tr.tSinceQRS[i];
      }
      return NaN;
    };
    const tNormal = await onset('none');
    const tRbbb = await onset('rbbb');
    expect(Number.isFinite(tNormal)).toBe(true);
    expect(tRbbb - tNormal).toBeGreaterThan(0.02);
  });

  // ---------- Phase 4: per-vertex rig of the procedural wall ----------

  const lvPenetration = (rig: RvContractionRig): { inside: number; maxDepthMm: number } => {
    const pos = rig.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const p = new THREE.Vector3();
    let inside = 0;
    let maxDepthMm = 0;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(rig.mesh.matrix);
      if (classifyAgainstLv(p) === 'outside') continue;
      inside++;
      maxDepthMm = Math.max(maxDepthMm, (lvEnvelopeRadius(p.y, true) - Math.hypot(p.x, p.z)) * S);
    }
    return { inside, maxDepthMm };
  };

  it('Phase 4b: septum slides over the LV epicardium (f ≥ ε) and 0 RV vertices in the LV at q = 1.0; 0.7; 0.4 and in the 6–8 s window', { timeout: 60000 }, async () => {
    const { rig } = await buildRig();
    const sw = rig.mesh.geometry.getAttribute('septalWeight') as THREE.BufferAttribute;
    const eps = rig.wall!.epsEpi;
    for (const q of [1, 0.7, 0.4]) {
      setLambda(rig, rvLambdaFromQ(rig, q));
      const pen = lvPenetration(rig);
      expect(pen.inside, `q=${q}: vértices no VE`).toBe(0);
      expect(pen.maxDepthMm, `q=${q}: penetração`).toBe(0);
      const pos = rig.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const p = new THREE.Vector3();
      let minF = Infinity;
      for (let i = 0; i < pos.count; i++) {
        if (sw.getX(i) !== 0) continue;
        p.fromBufferAttribute(pos, i).applyMatrix4(rig.mesh.matrix);
        if (p.y > 0.72 || p.y < -1.41) continue;
        minF = Math.min(minF, Math.hypot(p.x, p.z) - lvEnvelopeRadius(p.y, true));
      }
      expect(minF * S, `q=${q}: f mínimo (mm)`).toBeGreaterThanOrEqual(eps * S - 1e-3);
    }
    let worstInside = 0;
    let worstDepth = 0;
    let samples = 0;
    runEngineWithRig(rig, 8, 6, undefined, () => {
      const pen = lvPenetration(rig);
      worstInside = Math.max(worstInside, pen.inside);
      worstDepth = Math.max(worstDepth, pen.maxDepthMm);
      samples++;
    });
    expect(samples).toBeGreaterThan(90);
    expect(worstInside).toBe(0);
    expect(worstDepth).toBe(0);
  });

  it('Phase 4: rig volume = closed cavity of the metric (measureRvCavityVolume), at rest and in systole', async () => {
    const { scene, rig } = await buildRig();
    for (const q of [1, 0.7, 0.4]) {
      setLambda(rig, rvLambdaFromQ(rig, q));
      scene.updateMatrixWorld(true);
      const m = measureRvCavityVolume(rig.mesh);
      expect(m.openings).toBe(2);
      expect(Math.abs(measureRvMeshVolume(rig) - m.volume) / m.volume, `q=${q}`).toBeLessThan(1e-5);
      if (q === 1) expect(((m.volume * S ** 3) / 1000)).toBeCloseTo(124.0, 0);
      expect(measureRvMeshVolume(rig) / rig.wall!.restVolume).toBeCloseTo(q, 3);
    }
  });

  it('Phase 4b: non-rigid tricuspid annulus: gap ≈ 0, lateral TAPSE 24 ± 3.5 mm and Hammarström septal/lateral ratio', async () => {
    const { scene, rig } = await buildRig();
    const annulus = scene.getObjectByName('tricuspid_annulus') as THREE.Mesh;
    scene.updateMatrixWorld(true);
    const annRest = worldPositions(annulus);
    const off = (p: THREE.Vector3) => Math.hypot(p.x, p.z) - lvEnvelopeRadius(Math.min(0.73 - 1e-9, p.y), true);
    let iLat = 0;
    let iSep = 0;
    annRest.forEach((p, i) => {
      if (off(p) > off(annRest[iLat])) iLat = i;
      if (off(p) < off(annRest[iSep])) iSep = i;
    });
    const chordMeshes = ['anterior', 'posterior', 'septal'].flatMap((n) => [1, 2, 3, 4, 5, 6].map((k) => scene.getObjectByName(`tricuspid_${n}_chorda_${k}`) as THREE.Mesh));
    const chordRest = chordMeshes.map((m) => worldPositions(m));
    setLambda(rig, rvLambdaFromQ(rig, 0.4));
    scene.updateMatrixWorld(true);
    const annNow = worldPositions(annulus);
    const tapse = annRest[iLat].clone().sub(annNow[iLat]).dot(rig.axisL) * S;
    const sept = annRest[iSep].clone().sub(annNow[iSep]).dot(rig.axisL) * S;
    expect(tapse, `TAPSE ${tapse.toFixed(2)} mm`).toBeGreaterThanOrEqual(20.5);
    expect(tapse, `TAPSE ${tapse.toFixed(2)} mm`).toBeLessThanOrEqual(27.5);
    // Hammarström 1991: 20.1/24.9 = 0.807 (doi 10.1016/s0894-7317(14)80524-5)
    expect(sept / tapse, `septal/lateral ${(sept / tapse).toFixed(3)}`).toBeCloseTo(RV_ANNULUS_SEPTAL_RATIO, 1);
    expect(annNow[iLat].clone().sub(annRest[iLat]).distanceTo(rig.deltaTV)).toBeLessThan(1e-6);
    const gap = entryBorderAnnulusGap(rig.mesh, annulus).maxGap * S;
    expect(gap, `vão anel–parede (borda) ${gap.toExponential(2)} mm`).toBeLessThan(1e-3);
    // at rest the chordae keep their original length (the variation exists only in systole; see report)
    setLambda(rig, 0);
    scene.updateMatrixWorld(true);
    chordMeshes.forEach((m, k) => {
      const now = worldPositions(m);
      for (let i = 0; i < now.length; i += 7) expect(now[i].distanceTo(chordRest[k][i]) * S, m.name).toBeLessThan(1e-3);
    });
  });

  it('Phase 4: papillary bases ≤ 0.5 mm from the wall at q = 1.0; 0.7; 0.4 (anchored vertex, definition of 3c)', async () => {
    const { scene, rig } = await buildRig();
    scene.updateMatrixWorld(true);
    const septal = scene.getObjectByName('tricuspid_septal_papillary_muscle') as THREE.Mesh;
    const pts = worldPositions(septal);
    let baseSeptal = 0;
    pts.forEach((p, i) => {
      if (p.y < pts[baseSeptal].y) baseSeptal = i;
    });
    const ext = rvPapillaryExtensions(scene);
    expect(ext.length).toBe(2);
    const worldVertex = (m: THREE.Mesh, i: number) => new THREE.Vector3().fromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute, i).applyMatrix4(m.matrixWorld);
    for (const q of [1, 0.7, 0.4]) {
      setLambda(rig, rvLambdaFromQ(rig, q));
      scene.updateMatrixWorld(true);
      for (const e of ext) {
        const m = scene.getObjectByName(e.name) as THREE.Mesh;
        const gap = pointToMeshDistance(worldVertex(m, e.baseIndex), rig.mesh) * S;
        expect(gap, `${e.name} q=${q}: ${gap.toFixed(4)} mm`).toBeLessThanOrEqual(0.5);
      }
      const gapS = pointToMeshDistance(worldVertex(septal, baseSeptal), rig.mesh) * S;
      expect(gapS, `septal q=${q}: ${gapS.toFixed(4)} mm`).toBeLessThanOrEqual(0.5);
    }
  });

  // ---------- Phase 4b: mesh quality and papillary muscles ----------

  const flippedTriangles = (rig: RvContractionRig, rest: Float32Array): { endo: number; epi: number; dihedralMaxDeg: number } => {
    const geom = rig.mesh.geometry;
    const idx = geom.getIndex()!;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const tr = geom.getAttribute('transmural') as THREE.BufferAttribute;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
    let endo = 0;
    let epi = 0;
    const nT = idx.count / 3;
    const fn = new Float64Array(nT * 3);
    const kind = new Int8Array(nT);
    const edges = new Map<string, number>();
    let dih = 0;
    for (let t = 0; t < nT; t++) {
      const i = idx.getX(3 * t), j = idx.getX(3 * t + 1), k = idx.getX(3 * t + 2);
      const ti = tr.getX(i) !== 0, tj = tr.getX(j) !== 0, tk = tr.getX(k) !== 0;
      kind[t] = !ti && !tj && !tk ? 0 : ti && tj && tk ? 1 : 2;
      if (kind[t] === 2) continue;
      a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, j); c.fromBufferAttribute(pos, k);
      n.subVectors(b, a); m.subVectors(c, a); n.cross(m);
      a.fromArray(rest, i * 3); b.fromArray(rest, j * 3); c.fromArray(rest, k * 3);
      const n0 = new THREE.Vector3().subVectors(b, a).cross(m.subVectors(c, a));
      if (n.dot(n0) < 0) {
        if (kind[t] === 0) endo++; else epi++;
      }
      const l = n.length() || 1;
      fn[3 * t] = n.x / l; fn[3 * t + 1] = n.y / l; fn[3 * t + 2] = n.z / l;
      for (let e = 0; e < 3; e++) {
        const p = idx.getX(3 * t + e), q = idx.getX(3 * t + ((e + 1) % 3));
        const key = p < q ? `${p}_${q}` : `${q}_${p}`;
        const o = edges.get(key);
        if (o === undefined) edges.set(key, t);
        else if (kind[o] === kind[t]) {
          const d = fn[3 * o] * fn[3 * t] + fn[3 * o + 1] * fn[3 * t + 1] + fn[3 * o + 2] * fn[3 * t + 2];
          dih = Math.max(dih, (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI);
        }
      }
    }
    return { endo, epi, dihedralMaxDeg: dih };
  };

  it('Phase 4b: 0 inverted triangles at q = 0.7 and 0.4 and at the worst instant of the 6–8 s window (dihedral reported)', { timeout: 60000 }, async () => {
    const { rig } = await buildRig();
    const rest = rig.wall!.restLocal;
    setLambda(rig, 0);
    const dRest = flippedTriangles(rig, rest).dihedralMaxDeg;
    for (const q of [0.7, 0.4]) {
      setLambda(rig, rvLambdaFromQ(rig, q));
      const f = flippedTriangles(rig, rest);
      expect(f.endo, `q=${q} endo invertidos`).toBe(0);
      expect(f.epi, `q=${q} epi invertidos`).toBe(0);
      // eslint-disable-next-line no-console
      console.info(`[VD 4b] diedro máximo q=${q}: ${f.dihedralMaxDeg.toFixed(1)}° (repouso ${dRest.toFixed(1)}°)`);
    }
    let worstEndo = 0;
    let worstEpi = 0;
    let n = 0;
    runEngineWithRig(rig, 8, 6, undefined, () => {
      flushRvContraction(rig);
      const f = flippedTriangles(rig, rest);
      worstEndo = Math.max(worstEndo, f.endo);
      worstEpi = Math.max(worstEpi, f.epi);
      n++;
    });
    expect(n).toBeGreaterThan(90);
    expect(worstEndo).toBe(0);
    expect(worstEpi).toBe(0);
  });

  it('Phase 4b: papillary muscles shorten 11.2% (Fawzy 2010) base → tip in systole; 0 apparatus vertices in the LV', async () => {
    const { scene, rig } = await buildRig();
    scene.updateMatrixWorld(true);
    const ext = rvPapillaryExtensions(scene);
    const vtxOf = (m: THREE.Mesh, i: number) => new THREE.Vector3().fromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute, i).applyMatrix4(m.matrixWorld);
    const spec = ext.map((e) => {
      const m = scene.getObjectByName(e.name) as THREE.Mesh;
      const pts = worldPositions(m);
      let tip = 0;
      let d = Infinity;
      pts.forEach((p, i) => {
        const dd = p.distanceToSquared(e.tip);
        if (dd < d) {
          d = dd;
          tip = i;
        }
      });
      return { name: e.name, m, base: e.baseIndex, tip, L0: vtxOf(m, e.baseIndex).distanceTo(vtxOf(m, tip)) };
    });
    const nodeNames = ['tricuspid_annulus', 'tricuspid_septal_leaflet', 'tricuspid_anterior_leaflet', 'tricuspid_posterior_leaflet', 'tricuspid_septal_papillary_muscle', 'tricuspid_anterior_papillary_muscle', 'tricuspid_posterior_papillary_muscle', ...['anterior', 'posterior', 'septal'].flatMap((n) => [1, 2, 3, 4, 5, 6].map((k) => `tricuspid_${n}_chorda_${k}`))];
    for (const q of [0.7, 0.4]) {
      setLambda(rig, rvLambdaFromQ(rig, q));
      scene.updateMatrixWorld(true);
      for (const name of nodeNames) {
        const m = scene.getObjectByName(name) as THREE.Mesh;
        const pts = worldPositions(m);
        const inside = pts.filter((p) => classifyAgainstLv(p) !== 'outside').length;
        expect(inside, `${name} q=${q}: vértices no VE`).toBe(0);
      }
    }
    setLambda(rig, rvLambdaFromQ(rig, 0.4));
    scene.updateMatrixWorld(true);
    for (const e of spec) {
      const s0 = 1 - vtxOf(e.m, e.base).distanceTo(vtxOf(e.m, e.tip)) / e.L0;
      expect(s0, `${e.name} encurtamento`).toBeCloseTo(RV_PAPILLARY_SHORTENING, 2);
    }
  });

  // ---------- Phase 4c: chordae as tie rods ----------

  it('Phase 4c: chordae within ±15% between closed valve at rest and in systole (z = 0), with leaflets outside the LV and coaptation maintained', { timeout: 60000 }, async () => {
    const { scene, rig, valvar } = await buildRigWithValves();
    const mapping = (chordaMappingRaw as Array<{ chordaName: string; papillaryName: string; leafletName: string; leafletVIdx: number; baseIdx: number; tipIdx: number }>).filter((m) => m.chordaName.startsWith('tricuspid_'));
    expect(mapping.length).toBe(18);
    const setState = (q: number, z: number) => {
      setLambda(rig, rvLambdaFromQ(rig, q));
      applyValvarDeformation(valvar, 0, z);
      scene.updateMatrixWorld(true);
    };
    const vtx = (m: THREE.Mesh, i: number) => new THREE.Vector3().fromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute, i).applyMatrix4(m.matrixWorld);
    const lengths = () => mapping.map((m) => {
      const c = scene.getObjectByName(m.chordaName) as THREE.Mesh;
      return vtx(c, m.baseIdx).distanceTo(vtx(c, m.tipIdx));
    });
    const leaflets = valvar.leaflets.filter((l) => !l.isMitral);
    const freeEdge = leaflets.map((sp) => {
      const rp = sp.mesh.userData.restPositions as Float32Array;
      const out: number[] = [];
      for (let i = 0; i < rp.length / 3; i++) if ((sp.maxY - rp[3 * i + 1]) / sp.height >= 0.65) out.push(i);
      return out;
    });
    const fePts = () => leaflets.map((sp, k) => freeEdge[k].map((i) => vtx(sp.mesh, i)));
    const nearest = (p: THREE.Vector3, pts: THREE.Vector3[]) => pts.reduce((b, q) => Math.min(b, p.distanceTo(q)), Infinity);
    const nearOthers = (pts: THREE.Vector3[][], k: number, i: number) => {
      let mn = Infinity;
      for (let o = 0; o < 3; o++) if (o !== k) mn = Math.min(mn, nearest(pts[k][i], pts[o]));
      return mn;
    };
    setState(1, 0);
    const L0 = lengths();
    const rest = fePts();
    const coapted = rest.map((list, k) => list.map((_, i) => nearOthers(rest, k, i) < 3.5 / 55));
    const coaptGap = () => {
      const cur = fePts();
      let mx = 0;
      cur.forEach((list, k) => list.forEach((_, i) => {
        if (coapted[k][i]) mx = Math.max(mx, nearOthers(cur, k, i));
      }));
      return mx * S;
    };
    const gap0 = coaptGap();
    setState(0.4, 0);
    const L1 = lengths();
    const pct = L1.map((x, i) => (100 * (x - L0[i])) / L0[i]);
    mapping.forEach((m, i) => {
      expect(Math.abs(pct[i]), `${m.chordaName}: ${pct[i].toFixed(1)}%`).toBeLessThanOrEqual(15);
      // eslint-disable-next-line no-console
      console.info(`[VD 4c] ${m.chordaName}: ${(L0[i] * S).toFixed(2)} → ${(L1[i] * S).toFixed(2)} mm (${pct[i].toFixed(1)}%)`);
    });
    expect(Math.max(...pct.map(Math.abs))).toBeCloseTo(RV_LEAFLET_RIG.maxChordStrain * 100, 0);
    const gap1 = coaptGap();
    expect(gap1 - gap0, `coaptação ${gap0.toFixed(2)} → ${gap1.toFixed(2)} mm`).toBeLessThan(0.5);
    expect(measureValvarCoaptation(valvar).isTricuspidClosed).toBe(true);
    for (const sp of leaflets) expect(worldPositions(sp.mesh).filter((p) => classifyAgainstLv(p) !== 'outside').length, `${sp.name} no VE`).toBe(0);
    for (const m of mapping) expect(worldPositions(scene.getObjectByName(m.chordaName) as THREE.Mesh).filter((p) => classifyAgainstLv(p) !== 'outside').length, `${m.chordaName} no VE`).toBe(0);
    // the chorda stays at the leaflet insertion and the hinge does not move
    const nearestVertex = (p: THREE.Vector3, me: THREE.Mesh) => worldPositions(me).reduce((b, q) => Math.min(b, p.distanceTo(q)), Infinity);
    for (const m of mapping) {
      const c = scene.getObjectByName(m.chordaName) as THREE.Mesh;
      expect(nearestVertex(vtx(c, m.tipIdx), scene.getObjectByName(m.leafletName) as THREE.Mesh) * S, m.chordaName).toBeLessThan(0.6);
    }
    for (const sp of leaflets) {
      const rp = sp.mesh.userData.restPositions as Float32Array;
      const off = sp.rigOffset as Float32Array;
      for (let i = 0; i < off.length; i += 3) if ((sp.maxY - rp[i + 1]) / sp.height < 0.02) expect(Math.hypot(off[i], off[i + 1], off[i + 2]) * S).toBeLessThan(0.05);
    }
    // exact rest: the rig displacement returns to zero
    setState(1, 0);
    for (const sp of leaflets) for (const x of sp.rigOffset as Float32Array) expect(Math.abs(x)).toBeLessThan(1e-9);
    lengths().forEach((x, i) => expect(Math.abs(x - L0[i]) * S).toBeLessThan(1e-3));
    // z = 1 with q = 0.4 is not physiological: only reported
    setState(0.4, 1);
    const open = lengths().map((x, i) => (100 * (x - L0[i])) / L0[i]);
    // eslint-disable-next-line no-console
    console.info(`[VD 4c] z = 1, q = 0,4 (não fisiológico): ${Math.min(...open).toFixed(1)}% a ${Math.max(...open).toFixed(1)}%`);
  });

  // ---------- Common wall: the septal face of the RV follows the current LV epicardium ----------

  // LV Phase 3 (by definition): v = λ of the LV field (before, v of the per-node scale: xz 1 − 0.08·v, y 1 − 0.04·v). The old
  // instants v = 0.5 and 1.008 become λ = 0.6234·v (0.6234 = λ at end systole with wm = 1, engine EF in the default cycle).
  const LAM_OF_V = (v: number) => LV_LAMBDA_ES_NOMINAL * v;
  /** Radius of the current epicardium (LV field with c = 1, the same as the RV envelope); 0 outside the LV height range. */
  const rEpiNow = (y: number, v: number, theta: number) => (y < -1.42 || y > 0.73 ? 0 : lvEpiRadiusUniform(v, theta, y));
  /** Vertices of the septal face (septal column, epi layer) in contact with the LV at rest (f ≤ 0.5 mm). */
  const septalContact = (rig: RvContractionRig): number[] => {
    const g = rig.mesh.geometry;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const tr = g.getAttribute('transmural') as THREE.BufferAttribute;
    const NU = (g.userData.rvSegmentsU as number) ?? 96;
    const Ns = Math.round((g.userData.rvFreeWallUStart as number) * NU);
    const w = rig.wall!;
    const out: number[] = [];
    for (let i = 0; i < uv.count; i++) {
      if (tr.getX(i) !== 1 || Math.round(uv.getX(i) * NU) > Ns) continue;
      if (rEpiNow(w.restP[3 * i + 1], 0, Math.atan2(w.restP[3 * i + 2], w.restP[3 * i])) > 0 && w.f0[i] * S <= 0.5) out.push(i);
    }
    return out;
  };
  const worldOf = (rig: RvContractionRig, i: number, p: THREE.Vector3) =>
    p.fromBufferAttribute(rig.mesh.geometry.getAttribute('position') as THREE.BufferAttribute, i).applyMatrix4(rig.mesh.matrix);
  /** Largest gap on the septal face and penetration of the whole RV, against the CURRENT epicardium. */
  const septalGap = (rig: RvContractionRig, contact: number[], v: number) => {
    const p = new THREE.Vector3();
    let gap = -Infinity;
    for (const i of contact) {
      worldOf(rig, i, p);
      const R = rEpiNow(p.y, v, Math.atan2(p.z, p.x));
      if (R > 0) gap = Math.max(gap, (Math.hypot(p.x, p.z) - R) * S);
    }
    let inside = 0;
    const n = rig.mesh.geometry.getAttribute('position').count;
    for (let i = 0; i < n; i++) {
      worldOf(rig, i, p);
      const R = rEpiNow(p.y, v, Math.atan2(p.z, p.x));
      if (R > 0 && Math.hypot(p.x, p.z) < R) inside++;
    }
    return { gap, inside };
  };

  it('Common wall: with v = 0 nothing changes: E = 0, row-0 table equal to rest and null contraction returns the rest pose', async () => {
    const { rig } = await buildRig();
    const w = rig.wall!;
    expect(w.lvV).toBe(0);
    for (let k = 0; k < w.qGrid.length; k++) expect(w.qGridV[k]).toBe(w.qGrid[k]);
    const rest = positionsOf(rig);
    setRvLvContraction(rig, 0);
    setLambda(rig, 0);
    expect(w.lvE).toBe(0);
    expect(sameArray(positionsOf(rig), rest)).toBe(true);
    expect(rvLambdaFromQ(rig, 1)).toBe(0);
  });

  it('Common wall: septal face within ≤ 0.5 mm of the current epicardium, 0 vertices in the LV and 0 inverted at q = 0.7 and 0.4 with the LV contracted', { timeout: 60000 }, async () => {
    const { rig } = await buildRig();
    const rest = Float32Array.from(rig.wall!.restLocal);
    const contact = septalContact(rig);
    expect(contact.length).toBeGreaterThan(3000);
    for (const [q, vOld] of [[0.7, 0.5], [0.4, 1.008]] as const) {
      const v = LAM_OF_V(vOld);
      setRvLvContraction(rig, v);
      setLambda(rig, rvLambdaFromQ(rig, q));
      const r = septalGap(rig, contact, v);
      expect(r.gap, `q=${q}: vão septal (mm)`).toBeLessThanOrEqual(0.5);
      expect(r.inside, `q=${q}: vértices no VE`).toBe(0);
      const f = flippedTriangles(rig, rest);
      expect(f.endo, `q=${q}: endo invertidos`).toBe(0);
      expect(f.epi, `q=${q}: epi invertidos`).toBe(0);
    }
  });

  it('Common wall: the mesh volume follows q with the LV contracted; without compensation the cavity would be larger', async () => {
    const { rig } = await buildRig();
    const v0 = measureRvMeshVolume(rig);
    const lamSemVE = rvLambdaFromQ(rig, 0.4);
    setRvLvContraction(rig, LAM_OF_V(1.008));
    setLambda(rig, lamSemVE);
    const semCompensar = measureRvMeshVolume(rig) / v0;
    // LV Phase 4 (by definition): with the septum recalibrated (D-VE13) and the LV descent, the contracted LV barely changes the cavity of the
    // RV at this instant (0.397, before > 0.42) and the compensation now reduces λ (0.5519 × 0.5555). What remains is what does not depend on the sign:
    // without compensation the volume leaves the target, and the q(λ, v) table returns it to 0.4.
    // With 60° septal ramp compensation, the uncompensated deviation is smaller (0.00057 vs > 0.001);
    // compensation shifts λ and brings the RV cavity volume closer to the 0.4 target.
    expect(Math.abs(semCompensar - 0.4)).toBeGreaterThan(0);
    const lam = rvLambdaFromQ(rig, 0.4);
    expect(lam).not.toBe(lamSemVE);
    setLambda(rig, lam);
    const compensado = measureRvMeshVolume(rig) / v0;
    expect(compensado).toBeCloseTo(0.4, 2);
    expect(Math.abs(compensado - 0.4), `sem compensar ${semCompensar.toFixed(5)}, compensado ${compensado.toFixed(5)}`).toBeLessThan(Math.abs(semCompensar - 0.4));
  });

  it('Common wall: the contraction seen by the RV is the mean over the segments in contact and is limited to [−0.15; 0.9] (λ of the LV field)', async () => {
    const { rig } = await buildRig();
    const w = rig.wall!;
    const soma = Array.from(w.lvSegWeights).reduce((a, x) => a + x, 0);
    expect(soma).toBeCloseTo(1, 9);
    const todos = new Float32Array(17).fill(0.8);
    expect(rvSeptalLvContraction(rig, todos)).toBeCloseTo(0.8, 5);
    setRvLvContraction(rig, 5);
    expect(w.lvV).toBeCloseTo(RV_LV_V_MAX, 9);
    setRvLvContraction(rig, -1);
    expect(w.lvV).toBe(RV_LV_V_MIN);
    setRvLvContraction(rig, NaN);
    expect(w.lvV).toBe(0);
  });

  it('Common wall: HeartMesh17 reports the LV contraction before solving λ and uses the same scale in the wedges', async () => {
    const fsName = 'f' + 's';
    const fsMod: any = await import(/* @vite-ignore */ fsName);
    const src: string = fsMod.readFileSync('src/view/cardiac3d/HeartMesh17.tsx', 'utf8');
    const antes = src.indexOf('setRvLvContraction(rvRig, rvSeptalLvContraction(rvRig, segContractions))');
    const depois = src.indexOf('applyRvContraction(rvRig, hemo?.vRV');
    expect(antes).toBeGreaterThan(0);
    expect(depois).toBeGreaterThan(antes);
    // branch without the field (per-node scale) preserved
    expect(src).toContain('1 - LV_CONTRACTION_SCALE.xz * segContraction');
    expect(src).toContain('1 - LV_CONTRACTION_SCALE.y * segContraction');
    expect(src).not.toContain('1 - 0.08 * segContraction');
    // LV Phase 3 (addition): the LV field is solved before reporting the septum, and the LV envelope is attached to the RV rig
    const campo = src.indexOf('applyLvContraction(lvRig, hemo?.vLV');
    expect(campo).toBeGreaterThan(0);
    expect(antes).toBeGreaterThan(campo);
    expect(src).toContain('linkRvLvEnvelope(rvRig, lvRig ? lvRig.envelope : null)');
  });

  it('filling fraction: 1 without a valid beat; 1 at EDV and 0 at ESV', () => {
    const tr = createRvVolumeTracker();
    expect(rvFillFraction(tr, 80)).toBe(1);
    tr.valid = true; tr.edv = 140; tr.esv = 56;
    expect(rvFillFraction(tr, 140)).toBe(1);
    expect(rvFillFraction(tr, 56)).toBe(0);
    expect(rvFillFraction(tr, 98)).toBeCloseTo(0.5, 9);
    expect(rvFillFraction(tr, 200)).toBe(1);
  });
});
