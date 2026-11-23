import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  RV_COMPONENT_WEIGHTS,
  RV_RIG_GAINS,
  setupRvContraction,
  setRvDeformation,
  setRvLvContraction,
  rvLambdaFromQ,
  rvSeptalLvContraction,
  flushRvContraction,
  linkRvLvEnvelope,
  rvAnnulusReferenceField,
  type RvContractionRig,
} from './rvContraction';
import { applyRvProceduralGeometry } from './rvGeometry';
import { applyTricuspidApparatusPose } from './tricuspidApparatusPose';
import { setupValvarKinematics, applyValvarDeformation, type ValvarKinematicsData } from './valvarKinematics';
import { lvClosedCavityVolume, lvClosedLayerVolume, parentPositions, localMatrixOf } from './lvMetrics';
import { applyLvWatertightGeometry } from './lvWatertightGeometry';
import { lvEnvelopeRadius, LV_ANALYTIC_PROFILE } from './rvGeometryMetrics';
import {
  setupLvContractionField,
  setLvSegmentMotion,
  setLvLambda,
  flushLvField,
  lvLambdaFromQ,
  lvEndoRadiusNow,
  lvEpiRadiusNow,
  lvEnvelopeShrink,
  lvMeshExcessTh,
  applyLvChordTies,
  applyLvAtrium,
  applyLvRaPost,
  RA_SKIN_PARAMS_LV,
  type LvFieldRig,
} from './lvContractionField';
import { setupAtrialSkinning, applyAtrialSkinning, RA_ANCHORS, type AtrialSkinRig } from './atrialSkinning';

// LV Phase 4d — VE_FASE4D_20261112.md; pre-registered criteria in
// sandbox_nettercraft_ve_20261111\_evidencias\ve4d\CRITERIOS_VE4D.md. Scale: 34.3 mm/u.
const S = 34.3;
const Q_ES = 1 - 0.6234;
const SCEN: Array<[string, (i: number) => number]> = [
  ['wm1', () => 1],
  ['seg7 acinético', (i) => (i === 6 ? 0 : 1)],
  ['seg7 discinético', (i) => (i === 6 ? -0.32 : 1)],
  ['isquemia anterior 1/7/13', (i) => (i === 0 || i === 6 || i === 12 ? 0.35 : 1)],
];
const cOf = (f: (i: number) => number) => Array.from({ length: 17 }, (_, i) => f(i));
const setRvLambda = (rig: RvContractionRig, lam: number) =>
  setRvDeformation(rig, RV_COMPONENT_WEIGHTS.longitudinal * RV_RIG_GAINS.longitudinal * lam, RV_COMPONENT_WEIGHTS.radial * RV_RIG_GAINS.radial * lam, RV_COMPONENT_WEIGHTS.anteroposterior * RV_RIG_GAINS.anteroposterior * lam);

async function loadGlbScene(): Promise<THREE.Group> {
  const fsMod: any = await import(/* @vite-ignore */ 'f' + 's');
  const pathMod: any = await import(/* @vite-ignore */ 'p' + 'a' + 't' + 'h');
  const buffer = fsMod.readFileSync(pathMod.resolve('public/models/realistic_heart.glb'));
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(arrayBuffer, '', (g) => resolve(g.scene), reject));
}

interface World {
  scene: THREE.Group;
  rig: RvContractionRig;
  valvar: ValvarKinematicsData;
  ss: THREE.Mesh[];
  lv: LvFieldRig;
  raSkin: AtrialSkinRig;
  ra: THREE.Mesh;
  la: THREE.Mesh;
}

/** World in the order of HeartMesh17, with the RA of RA_SKIN_PARAMS_LV (floor collapsed on load, Phase 4d). */
async function buildWorld(): Promise<World> {
  const scene = await loadGlbScene();
  scene.updateMatrixWorld(true);
  applyRvProceduralGeometry(scene);
  const valvar = setupValvarKinematics(scene)!;
  applyLvWatertightGeometry(scene);
  applyTricuspidApparatusPose(scene);
  const ann = scene.getObjectByName('tricuspid_annulus') as THREE.Mesh;
  const rig = setupRvContraction(scene.getObjectByName('right_ventricle') as THREE.Mesh, ann, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), valvar)!;
  const ra = scene.getObjectByName('right_atrium') as THREE.Mesh;
  const la = scene.getObjectByName('left_atrium') as THREE.Mesh;
  const refField = new THREE.Matrix4();
  const refD = rvAnnulusReferenceField(rig, refField);
  const raSkin = setupAtrialSkinning(ra, ann, rig.axisL, [
    { mesh: scene.getObjectByName('organui_superior_vena_cava') as THREE.Mesh, d0: RA_ANCHORS.svc0, d1: RA_ANCHORS.svc1, pinScale: true },
    { mesh: la, d0: RA_ANCHORS.la0, d1: RA_ANCHORS.la1, pinScale: false },
  ], refField, refD, RA_SKIN_PARAMS_LV)!;
  const ss: THREE.Mesh[] = [];
  scene.traverse((o: any) => { if (o.isMesh && typeof o.userData?.segId === 'number') ss.push(o); });
  ss.sort((a, b) => a.userData.segId - b.userData.segId);
  const lv = setupLvContractionField(ss, scene, valvar, { rightAtriumSkin: raSkin })!;
  linkRvLvEnvelope(rig, lv.envelope);
  return { scene, rig, valvar, ss, lv, raSkin, ra, la };
}

/** Pose in the order of HeartMesh17 (LV λ, septum, RV q; null = rest, valves z, chordae, RA + post-step, LA). */
function pose(w: World, lam: number, rvQ: number | null, z: number) {
  setLvLambda(w.lv, lam);
  flushLvField(w.lv);
  setRvLvContraction(w.rig, rvSeptalLvContraction(w.rig, Array.from(w.lv.cSeg, (c) => c * w.lv.lambda)));
  setRvLambda(w.rig, rvQ === null ? 0 : rvLambdaFromQ(w.rig, rvQ));
  flushRvContraction(w.rig);
  applyValvarDeformation(w.valvar, z, 0);
  applyLvChordTies(w.lv);
  w.raSkin.lastAmount = NaN;
  applyAtrialSkinning(w.raSkin, w.rig.wall!.shear, w.rig.kL * w.rig.wall!.lengthD, 1);
  applyLvRaPost(w.lv);
  applyLvAtrium(w.lv, 1);
}

// ---------- triangulated LV epicardial shell and inside test (+x ray and 3 directions; same definition as CRITERIOS_VE4D 4d.2) ----------

function epiShell(ss: THREE.Mesh[]): Float64Array {
  const out: number[] = [];
  const edges = new Map<string, { n: number; a: number[]; b: number[] }>();
  const key = (r: Float32Array, i: number) => `${Math.round(r[3 * i] * 1e6)},${Math.round(r[3 * i + 1] * 1e6)},${Math.round(r[3 * i + 2] * 1e6)}`;
  for (const m of ss) {
    const P = parentPositions(m);
    const rest = m.geometry.userData.lvFieldRest as Float32Array;
    const idx = m.geometry.getIndex()!;
    const half = P.length / 6;
    for (let t = 0; t < idx.count; t += 3) {
      const ids = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
      if (!ids.every((i) => i >= half)) continue;
      for (const i of ids) out.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
      for (let e = 0; e < 3; e++) {
        const a = ids[e], b = ids[(e + 1) % 3];
        const ka = key(rest, a), kb = key(rest, b);
        const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        const v = edges.get(k);
        if (v) v.n++;
        else edges.set(k, { n: 1, a: [P[3 * a], P[3 * a + 1], P[3 * a + 2]], b: [P[3 * b], P[3 * b + 1], P[3 * b + 2]] });
      }
    }
  }
  for (const v of edges.values()) if (v.n === 1) out.push(0, (v.a[1] + v.b[1]) / 2, 0, ...v.a, ...v.b);
  return Float64Array.from(out);
}
function rayTri(T: Float64Array, t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  const ax = T[t], ay = T[t + 1], az = T[t + 2];
  const e1x = T[t + 3] - ax, e1y = T[t + 4] - ay, e1z = T[t + 5] - az;
  const e2x = T[t + 6] - ax, e2y = T[t + 7] - ay, e2z = T[t + 8] - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-15) return -1;
  const inv = 1 / det;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}
function parity(T: Float64Array, list: number[] | null, ox: number, oy: number, oz: number, d: readonly number[]): number {
  const hits: number[] = [];
  const n = list ? list.length : T.length / 9;
  for (let q = 0; q < n; q++) {
    const h = rayTri(T, (list ? list[q] : q) * 9, ox, oy, oz, d[0], d[1], d[2]);
    if (h > 1e-10 && !hits.some((x) => Math.abs(x - h) < 1e-9)) hits.push(h);
  }
  return hits.length % 2;
}
const DIRS = [[0.2311, 0.8714, -0.4329], [-0.6602, -0.3017, 0.6878], [0.5525, -0.5126, -0.6572]].map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });

/** RV (wall + 3 tricuspid papillary muscles) inside the shell: odd +x and ≥ 2 of 3 confirmations; vertices < 3 mm from the analytic always checked. */
function rvInsideMesh(w: World): { inside: number; discord: number } {
  const T = epiShell(w.ss);
  const h = 0.05;
  const bins = new Map<string, number[]>();
  for (let t = 0; t < T.length / 9; t++) {
    const o = t * 9;
    const y0 = Math.floor(Math.min(T[o + 1], T[o + 4], T[o + 7]) / h), y1 = Math.floor(Math.max(T[o + 1], T[o + 4], T[o + 7]) / h);
    const z0 = Math.floor(Math.min(T[o + 2], T[o + 5], T[o + 8]) / h), z1 = Math.floor(Math.max(T[o + 2], T[o + 5], T[o + 8]) / h);
    for (let a = y0; a <= y1; a++) for (let b = z0; b <= z1; b++) { const k = a + ':' + b; let l = bins.get(k); if (!l) bins.set(k, (l = [])); l.push(t); }
  }
  let inside = 0, discord = 0;
  for (const name of ['right_ventricle', 'tricuspid_anterior_papillary_muscle', 'tricuspid_posterior_papillary_muscle', 'tricuspid_septal_papillary_muscle']) {
    const P = parentPositions(w.scene.getObjectByName(name) as THREE.Mesh);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1] + 1.37e-9, z = P[i + 2] + 2.91e-9;
      const l = bins.get(Math.floor(y / h) + ':' + Math.floor(z / h));
      const a = l ? parity(T, l, x, y, z, [1, 0, 0]) : 0;
      const rp = lvEpiRadiusNow(w.lv, Math.atan2(z, x), y);
      const near = rp > 0 && Math.abs(Math.hypot(x, z) - rp) * S < 3;
      if (a === 0 && !near) continue;
      let v = 0;
      for (const d of DIRS) v += parity(T, null, x, y, z, d);
      if (a === 1 && v >= 2) inside++;
      else if (a === 1 || v >= 2) { discord++; inside++; }
    }
  }
  return { inside, discord };
}

/** Minimum clearance of the AL tip (DIAGNOSTICO_VE4C.md §5): axis = rest PCA, 10 slices, min(ρ_n − r) at the last (mm). */
function alFrame(rest: Float64Array): Int32Array {
  const n = rest.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += rest[3 * i]; cy += rest[3 * i + 1]; cz += rest[3 * i + 2]; }
  cx /= n; cy /= n; cz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i++) { const x = rest[3 * i] - cx, y = rest[3 * i + 1] - cy, z = rest[3 * i + 2] - cz; xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z; }
  const M = new THREE.Matrix3().set(xx, xy, xz, xy, yy, yz, xz, yz, zz);
  const a = new THREE.Vector3(0.1, 1, 0.1).normalize();
  for (let k = 0; k < 200; k++) a.applyMatrix3(M).normalize();
  if (a.y < 0) a.negate();
  const t = new Float64Array(n);
  let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < n; i++) { t[i] = (rest[3 * i] - cx) * a.x + (rest[3 * i + 1] - cy) * a.y + (rest[3 * i + 2] - cz) * a.z; tmin = Math.min(tmin, t[i]); tmax = Math.max(tmax, t[i]); }
  const bin = new Int32Array(n);
  for (let i = 0; i < n; i++) bin[i] = Math.min(9, Math.floor(((t[i] - tmin) / (tmax - tmin)) * 10));
  return bin;
}
function alTipClearanceMm(lv: LvFieldRig, now: Float64Array, bin: Int32Array): number {
  let m = Infinity;
  for (let i = 0; i < now.length / 3; i++) {
    if (bin[i] !== 9) continue;
    const re = lvEndoRadiusNow(lv, Math.atan2(now[3 * i + 2], now[3 * i]), now[3 * i + 1]);
    if (re > 0) m = Math.min(m, (re - Math.hypot(now[3 * i], now[3 * i + 2])) * S);
  }
  return m;
}
function papillaryInWall(lv: LvFieldRig, m: THREE.Mesh): number {
  const P = parentPositions(m);
  let n = 0;
  for (let i = 0; i < P.length; i += 3) {
    const re = lvEndoRadiusNow(lv, Math.atan2(P[i + 2], P[i]), P[i + 1]);
    if (re > 0 && Math.hypot(P[i], P[i + 2]) > re) n++;
  }
  return n;
}
function mitralChordLengths(valvar: ValvarKinematicsData): number[] {
  return valvar.chordae.filter((b) => b.papillaryName.startsWith('mitral_')).map((b) => {
    const pp = parentPositions(b.chordaMesh);
    return Math.hypot(pp[3 * b.baseIdx] - pp[3 * b.tipIdx], pp[3 * b.baseIdx + 1] - pp[3 * b.tipIdx + 1], pp[3 * b.baseIdx + 2] - pp[3 * b.tipIdx + 2]);
  });
}
/** LA–annulus gap (Phase 4b/4c method): smallest distance from mitral annulus vertices to the LA mesh per 15° sector (mm). */
function laAnnulusSectors(w: World): number[] {
  const ap = parentPositions(w.scene.getObjectByName('mitral_annulus') as THREE.Mesh);
  const M = localMatrixOf(w.la, new THREE.Matrix4());
  const g = w.la.geometry;
  const a = g.getAttribute('position') as THREE.BufferAttribute;
  const idx = g.getIndex();
  const nT = (idx ? idx.count : a.count) / 3;
  const tris: THREE.Triangle[] = [];
  for (let t = 0; t < nT; t++) {
    const tr = new THREE.Triangle();
    tr.a.fromBufferAttribute(a, idx ? idx.getX(3 * t) : 3 * t).applyMatrix4(M);
    tr.b.fromBufferAttribute(a, idx ? idx.getX(3 * t + 1) : 3 * t + 1).applyMatrix4(M);
    tr.c.fromBufferAttribute(a, idx ? idx.getX(3 * t + 2) : 3 * t + 2).applyMatrix4(M);
    tris.push(tr);
  }
  const n = ap.length / 3;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += ap[3 * i]; cz += ap[3 * i + 2]; }
  cx /= n; cz /= n;
  const sec = new Array(24).fill(Infinity);
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < n; i += 2) {
    p.set(ap[3 * i], ap[3 * i + 1], ap[3 * i + 2]);
    let best = Infinity;
    for (const t of tris) { t.closestPointToPoint(p, q); best = Math.min(best, q.distanceToSquared(p)); }
    // LV Phase 5 (declared change): sector in the non-rotated frame (the annulus rotates φ_top with the torsion; the distance does not change)
    const k = Math.floor((((((Math.atan2(p.z - cz, p.x - cx) - w.lv.twistTop) * 180) / Math.PI + 720) % 360) / 15)) % 24;
    sec[k] = Math.min(sec[k], Math.sqrt(best) * S);
  }
  return sec;
}

describe('LV Phase 4d — findings A1–A3, RA, AL papillary muscle and accepted limitation of 4c.4', () => {
  it('4d.2 (A1): 0 RV vertices inside the triangulated LV mesh in the 4 scenarios (z = 0 and 1); the guard margin covers the mesh excess', { timeout: 300000 }, async () => {
    const w = await buildWorld();
    const Y0 = LV_ANALYTIC_PROFILE.y0, YTOP = LV_ANALYTIC_PROFILE.y0 + LV_ANALYTIC_PROFILE.height;
    for (const [name, f] of SCEN) {
      setLvSegmentMotion(w.lv, cOf(f));
      for (const z of [0, 1]) {
        pose(w, lvLambdaFromQ(w.lv, Q_ES), 0.4, z);
        const r = rvInsideMesh(w);
        expect(r.inside, `${name} z=${z}: VD dentro da malha do VE (discordâncias ${r.discord})`).toBe(0);
      }
      // guard premise: at λ_ES (between table nodes) and at λmax, every point of the epicardial mesh (21 per triangle) lies within
      // grid + margin
      for (const lam of [lvLambdaFromQ(w.lv, Q_ES), w.lv.lambdaMax]) {
        setLvLambda(w.lv, lam);
        flushLvField(w.lv);
        let worst = -Infinity;
        for (const m of w.ss) {
          const P = parentPositions(m);
          const idx = m.geometry.getIndex()!;
          const half = P.length / 6;
          for (let t = 0; t < idx.count; t += 3) {
            const ids = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
            if (!ids.every((i) => i >= half)) continue;
            for (let a = 0; a <= 5; a++) for (let b = 0; a + b <= 5; b++) {
              const l1 = a / 5, l2 = b / 5, l0 = 1 - l1 - l2;
              const x = l0 * P[3 * ids[0]] + l1 * P[3 * ids[1]] + l2 * P[3 * ids[2]];
              const y = l0 * P[3 * ids[0] + 1] + l1 * P[3 * ids[1] + 1] + l2 * P[3 * ids[2] + 1];
              const zz = l0 * P[3 * ids[0] + 2] + l1 * P[3 * ids[1] + 2] + l2 * P[3 * ids[2] + 2];
              if (y < Y0 || y > YTOP - 1e-9) continue;
              const rr = Math.hypot(x, zz);
              if (rr < 1e-6) continue;
              const th = Math.atan2(zz, x);
              const g = lvEnvelopeRadius(y, true) - lvEnvelopeShrink(w.lv.envelope, x, zz, y);
              worst = Math.max(worst, (rr - g - lvMeshExcessTh(w.lv.envelope, th, y)) * S);
            }
          }
        }
        expect(worst, `${name} λ=${lam.toFixed(4)}: malha − (grade + margem) (mm)`).toBeLessThanOrEqual(0);
      }
    }
  });

  it('4d.3 (A2): setLvLambda clamps to [0, λmax] and ignores non-finite; setLvSegmentMotion ignores short or non-finite vector; no NaN; mass ≤ 0.1 % at λmax', { timeout: 240000 }, async () => {
    const w = await buildWorld();
    const lv = w.lv;
    const mass = () => lvClosedLayerVolume(w.ss, true).volume - lvClosedLayerVolume(w.ss, false).volume;
    pose(w, 0, null, 0);
    const m0 = mass();
    setLvLambda(lv, 0.5);
    for (const bad of [NaN, Infinity, -Infinity]) {
      setLvLambda(lv, bad);
      expect(lv.lambda, `λ após ${bad}`).toBe(0.5);
    }
    setLvLambda(lv, 1);
    expect(lv.lambda).toBe(lv.lambdaMax);
    setLvLambda(lv, -0.3);
    expect(lv.lambda).toBe(0);
    const c0 = Array.from(lv.cSeg);
    setLvSegmentMotion(lv, [1, 1, 1]);
    expect(Array.from(lv.cSeg)).toEqual(c0);
    setLvSegmentMotion(lv, cOf((i) => (i === 3 ? NaN : 1)));
    expect(Array.from(lv.cSeg)).toEqual(c0);
    setLvSegmentMotion(lv, cOf((i) => (i === 5 ? Infinity : 0.5)));
    expect(Array.from(lv.cSeg)).toEqual(c0);
    for (const [name, f] of SCEN) {
      setLvSegmentMotion(lv, cOf(f));
      expect(lv.lambdaMax, name).toBeCloseTo(0.9, 9);
      pose(w, 1, 0.4, 0);
      expect(lv.lambda, `${name}: λ = 1 vira λmax`).toBe(lv.lambdaMax);
      expect(Math.abs(mass() / m0 - 1) * 100, `${name}: massa em λmax (%)`).toBeLessThanOrEqual(0.1);
      let nonFinite = 0;
      for (const m of w.ss) for (const v of m.geometry.getAttribute('position').array as Float32Array) if (!Number.isFinite(v)) nonFinite++;
      expect(nonFinite, `${name}: posições não finitas`).toBe(0);
    }
  });

  it('4d.4 (A3): parentPositions, lvClosedLayerVolume and lvClosedCavityVolume do not alter any matrix (rest and end-systole, z = 0 and 1)', { timeout: 240000 }, async () => {
    const w = await buildWorld();
    const meshes: THREE.Mesh[] = [];
    w.scene.traverse((o: any) => { if (o.isMesh) meshes.push(o); });
    const tri = w.scene.getObjectByName('tricuspid_annulus') as THREE.Mesh;
    expect(tri.matrixAutoUpdate).toBe(false);
    for (const [lam, rvQ, z] of [[0, null, 0], [lvLambdaFromQ(w.lv, Q_ES), 0.4, 0], [lvLambdaFromQ(w.lv, Q_ES), 0.4, 1]] as const) {
      pose(w, lam, rvQ, z);
      const saved = meshes.map((m) => m.matrix.elements.slice());
      for (const m of meshes) parentPositions(m);
      lvClosedLayerVolume(w.ss, true);
      lvClosedLayerVolume(w.ss, false);
      lvClosedCavityVolume(w.ss);
      let changed = 0;
      meshes.forEach((m, k) => { for (let e = 0; e < 16; e++) if (m.matrix.elements[e] !== saved[k][e]) changed++; });
      expect(changed, `λ=${lam.toFixed(3)} z=${z}: entradas de matriz alteradas`).toBe(0);
      // the tricuspid apparatus reading uses the rig matrix (with the annulus field), not the static TRS
      const p = parentPositions(tri);
      const q = new THREE.Vector3().fromBufferAttribute(tri.geometry.getAttribute('position') as THREE.BufferAttribute, 0).applyMatrix4(tri.matrix);
      expect(Math.hypot(p[0] - q.x, p[1] - q.y, p[2] - q.z)).toBeLessThan(1e-12);
    }
  });

  it('4d.7 (D-VE25): AL tip with clearance ≥ 0.30 mm at end-systole (wm1, z = 0); papillary muscles outside the wall, chordae ±2 % and slip ≤ 0.5 mm in the 4 scenarios', { timeout: 240000 }, async () => {
    const w = await buildWorld();
    const al = w.scene.getObjectByName('mitral_anterolateral_papillary_muscle') as THREE.Mesh;
    const pm = w.scene.getObjectByName('mitral_posteromedial_papillary_muscle') as THREE.Mesh;
    pose(w, 0, null, 0);
    const bin = alFrame(parentPositions(al));
    for (const [name, f] of SCEN) {
      setLvSegmentMotion(w.lv, cOf(f));
      const lam = lvLambdaFromQ(w.lv, Q_ES);
      for (const z of [0, 1]) {
        pose(w, 0, null, z);
        const Lref = mitralChordLengths(w.valvar);
        pose(w, lam, 0.4, z);
        if (name === 'wm1' && z === 0) expect(alTipClearanceMm(w.lv, parentPositions(al), bin), 'folga da ponta do AL (mm)').toBeGreaterThanOrEqual(0.3);
        mitralChordLengths(w.valvar).forEach((L, i) => expect(Math.abs(L / Lref[i] - 1), `${name} z=${z} corda ${i}`).toBeLessThanOrEqual(0.02));
        for (const p of w.lv.papillaries) for (const c of p.chords) expect(Math.abs(c.slide) * S, `${name} z=${z} deslize`).toBeLessThanOrEqual(0.5);
        expect(papillaryInWall(w.lv, al) + papillaryInWall(w.lv, pm), `${name} z=${z} papilares na parede`).toBe(0);
      }
    }
  });

  // ACCEPTED LIMITATION test (user decision of 12/11/2026): the regional LA–annulus gap of 0.68–0.94 mm (criterion 4c.4 of 0.5 mm, which failed)
  // is accepted; this test only prevents it from worsening beyond 1.0 mm in the 4 scenarios.
  it('4c.4 (accepted limitation): LA–annulus gap ≤ 1.0 mm in the rest contact sectors, in the 4 scenarios', { timeout: 300000 }, async () => {
    const w = await buildWorld();
    pose(w, 0, null, 0);
    const sec0 = laAnnulusSectors(w);
    const contact = sec0.map((d, k) => (d <= 0.5 ? k : -1)).filter((k) => k >= 0);
    expect(contact.length).toBeGreaterThan(0);
    for (const [name, f] of SCEN) {
      setLvSegmentMotion(w.lv, cOf(f));
      pose(w, lvLambdaFromQ(w.lv, Q_ES), 0.4, 0);
      const sec = laAnnulusSectors(w);
      for (const k of contact) expect(sec[k], `vão AE–anel ${name} setor ${k}`).toBeLessThanOrEqual(1.0);
    }
  });
});
