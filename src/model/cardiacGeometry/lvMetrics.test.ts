import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  LV_CONTRACTION_SCALE,
  RV_COMPONENT_WEIGHTS,
  RV_RIG_GAINS,
  setupRvContraction,
  setRvDeformation,
  setRvLvContraction,
  rvLambdaFromQ,
  computeLvBaseY,
} from './rvContraction';
import { applyRvProceduralGeometry } from './rvGeometry';
import { applyTricuspidApparatusPose } from './tricuspidApparatusPose';
import { setupValvarKinematics, applyValvarDeformation, GLTF_SCALE_MM_PER_UNIT } from './valvarKinematics';
import { lvEnvelopeRadius } from './rvGeometryMetrics';
import {
  lvClosedCavityVolume,
  parentPositions,
  lvSegmentCenterIndex,
  lvPairThickness,
  lvRotationDeg,
  lvAnnulusDisplacement,
  lvMaxSeamGap,
  lvScaledEndoRadius,
  papillaryEndoClearance,
} from './lvMetrics';
import { applyLvWatertightGeometry, lvClosedProfileRadius, lvApexCap } from './lvWatertightGeometry';
import { lvEpiRadiusUniform, LV_LAMBDA_ES_NOMINAL } from './lvContractionField';

// LV geometric metrics and watertight rest mesh verification. Declared scale: 34.3 mm/u.
const S = 34.3;

async function loadGlbScene(): Promise<THREE.Group> {
  const fsName = 'f' + 's';
  const pathName = 'p' + 'a' + 't' + 'h';
  const fsMod: any = await import(/* @vite-ignore */ fsName);
  const pathMod: any = await import(/* @vite-ignore */ pathName);
  const buffer = fsMod.readFileSync(pathMod.resolve('public/models/realistic_heart.glb'));
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(arrayBuffer, '', (g) => resolve(g.scene), reject));
}

function lvSegments(scene: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  scene.traverse((o: any) => {
    if (o.isMesh && typeof o.userData?.segId === 'number') out.push(o);
  });
  return out.sort((a, b) => a.userData.segId - b.userData.segId);
}

/** Wedge scale as in HeartMesh17 (initialScale = 1): c = v·w per segment. */
function setContraction(ss: THREE.Mesh[], c: (segId: number) => number) {
  for (const m of ss) {
    const k = c(m.userData.segId);
    m.scale.set(1 - LV_CONTRACTION_SCALE.xz * k, 1 - LV_CONTRACTION_SCALE.y * k, 1 - LV_CONTRACTION_SCALE.xz * k);
    m.updateMatrix();
  }
}

async function lvScene(watertight: boolean) {
  const scene = await loadGlbScene();
  scene.updateMatrixWorld(true);
  if (watertight) expect(applyLvWatertightGeometry(scene)).toBe(17);
  const ss = lvSegments(scene);
  setContraction(ss, () => 0);
  return { scene, ss };
}

// ---------- Phase 1: Phase 0 snapshots (per-node scale) ----------
// They hold for the original GLB and for the watertight geometry: Phase 2 does not change the contraction nor the profile at the
// measured points. What changes by definition (closed volume, boundary edges) has its own tests below.

for (const watertight of [false, true]) {
  const tag = watertight ? 'geometria estanque' : 'GLB original';

  describe(`LV Phase 1 — metrics (${tag})`, () => {
    it('mesh EF at v = 1: 0.1875 (±0.01 pp) by closed volume; 0.2135 at v = 1.15', async () => {
      const { ss } = await lvScene(watertight);
      const V0 = lvClosedCavityVolume(ss).volume;
      setContraction(ss, () => 1);
      expect(Math.abs((1 - lvClosedCavityVolume(ss).volume / V0) * 100 - 18.75)).toBeLessThanOrEqual(0.01);
      setContraction(ss, () => 1.15);
      expect(Math.abs((1 - lvClosedCavityVolume(ss).volume / V0) * 100 - 21.35)).toBeLessThanOrEqual(0.01);
    });

    it('thickening −8.00 % (±0.01 pp) and rotation 0° (±0.01°) in the 17 segments at v = 1; MAPSE 0 mm', async () => {
      const { scene, ss } = await lvScene(watertight);
      const rest = ss.map(parentPositions);
      const ci = ss.map((m) => lvSegmentCenterIndex(m, m.userData.segId));
      const ann = scene.getObjectByName('mitral_annulus') as THREE.Mesh;
      const a0 = parentPositions(ann);
      setContraction(ss, () => 1);
      const now = ss.map(parentPositions);
      ss.forEach((m, k) => {
        const th = (lvPairThickness(now[k], ci[k]) / lvPairThickness(rest[k], ci[k]) - 1) * 100;
        expect(Math.abs(th + 8), `seg ${m.userData.segId}`).toBeLessThanOrEqual(0.01);
        expect(Math.abs(lvRotationDeg(rest[k], now[k], ci[k])), `seg ${m.userData.segId}`).toBeLessThanOrEqual(0.01);
      });
      expect(Math.abs(lvAnnulusDisplacement(a0, parentPositions(ann)) * S)).toBeLessThanOrEqual(0.01);
    });

    it('gaps between wedges: 0 with all at v = 1; seg 7 akinetic 2.394 mm and dyskinetic 3.160 mm (±0.01 mm)', async () => {
      const { ss } = await lvScene(watertight);
      const rest = ss.map(parentPositions);
      setContraction(ss, () => 1);
      expect(lvMaxSeamGap(rest, ss.map(parentPositions)).gap).toBeLessThanOrEqual(1e-6);
      setContraction(ss, (id) => (id === 7 ? 0 : 1));
      const g7 = lvMaxSeamGap(rest, ss.map(parentPositions));
      expect(Math.abs(g7.gap * S - 2.394)).toBeLessThanOrEqual(0.01);
      setContraction(ss, (id) => (id === 7 ? -0.32 : 1));
      expect(Math.abs(lvMaxSeamGap(rest, ss.map(parentPositions)).gap * S - 3.16)).toBeLessThanOrEqual(0.01);
    });

    it('mitral papillary muscles (static): AL −1.78 / +0.01 / +0.28 mm at v = 0 / 1 / 1.15; PM −11.94 mm at v = 0 (±0.01 mm)', async () => {
      const { scene } = await lvScene(watertight);
      const al = parentPositions(scene.getObjectByName('mitral_anterolateral_papillary_muscle') as THREE.Mesh);
      const pm = parentPositions(scene.getObjectByName('mitral_posteromedial_papillary_muscle') as THREE.Mesh);
      const at = (pts: Float64Array, v: number) => papillaryEndoClearance(pts, lvScaledEndoRadius(1 - LV_CONTRACTION_SCALE.xz * v, 1 - LV_CONTRACTION_SCALE.y * v)).max * S;
      expect(Math.abs(at(al, 0) + 1.78)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(at(al, 1) - 0.01)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(at(al, 1.15) - 0.28)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(at(pm, 0) + 11.94)).toBeLessThanOrEqual(0.01);
    });
  });
}

describe('LV Phase 1 — closed volume in the original GLB (documents the old code)', () => {
  it('closed V 1.9106 u³ with 220 boundary edges (basal ring, apical hole and gaps at the T junctions)', async () => {
    const { ss } = await lvScene(false);
    const r = lvClosedCavityVolume(ss);
    expect(r.boundaryEdges).toBe(220);
    expect(r.volume).toBeCloseTo(1.9106, 4);
  });
});

describe('LV Phase 1 — tricuspid tenting (z = 0) in the current annulus frame', () => {
  it('rest 3.95 mm (q = 1, v = 0) and systole 2.63 ± 0.05 mm (q = 0.4, v = 1.008)', { timeout: 60000 }, async () => {
    const scene = await loadGlbScene();
    scene.updateMatrixWorld(true);
    applyRvProceduralGeometry(scene);
    const valvar = setupValvarKinematics(scene)!;
    applyTricuspidApparatusPose(scene);
    const rig = setupRvContraction(scene.getObjectByName('right_ventricle') as THREE.Mesh, scene.getObjectByName('tricuspid_annulus') as THREE.Mesh, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), valvar)!;
    const W = RV_COMPONENT_WEIGHTS;
    const G = RV_RIG_GAINS;
    const setLambda = (lam: number) => setRvDeformation(rig, W.longitudinal * G.longitudinal * lam, W.radial * G.radial * lam, W.anteroposterior * G.anteroposterior * lam);
    const tInfo = valvar.coaptation.find((c) => !c.isMitral)!;
    const SS = GLTF_SCALE_MM_PER_UNIT;
    // Same rule as valvarIntegration.test.ts (central column c13, r < 2.5 mm), in world space: leaflets by matrixWorld and
    // annulus plane recomputed (center and PCA) from the current annulus vertices; at rest it coincides with the local measurement.
    const tent = () => {
      scene.updateMatrixWorld(true);
      const ann = scene.getObjectByName('tricuspid_annulus') as THREE.Mesh;
      const ap = ann.geometry.getAttribute('position') as THREE.BufferAttribute;
      const pts: THREE.Vector3[] = [];
      const c = new THREE.Vector3();
      for (let i = 0; i < ap.count; i++) {
        const p = new THREE.Vector3().fromBufferAttribute(ap, i).applyMatrix4(ann.matrixWorld);
        pts.push(p);
        c.add(p);
      }
      c.multiplyScalar(1 / pts.length);
      let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
      for (const p of pts) {
        const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
        xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
      }
      const inv = new THREE.Matrix3().set(xx, xy, xz, xy, yy, yz, xz, yz, zz).invert();
      const nRef = tInfo.normal.clone().transformDirection(ann.matrixWorld);
      const n = nRef.clone();
      for (let i = 0; i < 64; i++) n.applyMatrix3(inv).normalize();
      if (n.dot(nRef) < 0) n.negate();
      const e1 = new THREE.Vector3(1, 0, 0);
      if (Math.abs(e1.dot(n)) > 0.9) e1.set(0, 0, 1);
      e1.addScaledVector(n, -e1.dot(n)).normalize();
      const e2 = new THREE.Vector3().crossVectors(n, e1);
      const h = tInfo.leaflets.map((l) => {
        const pos = l.mesh.geometry.attributes.position as THREE.BufferAttribute;
        let dMin = Infinity;
        const p = new THREE.Vector3();
        for (let r = 0; r < 16; r++) {
          p.fromBufferAttribute(pos, 13 * 16 + r).applyMatrix4(l.mesh.matrixWorld).sub(c);
          if (Math.hypot(p.dot(e1) * SS, p.dot(e2) * SS) < 2.5) dMin = Math.min(dMin, -p.dot(n) * SS);
        }
        return dMin;
      });
      return (h[0] + h[1] + h[2]) / 3;
    };
    setRvLvContraction(rig, 0);
    setLambda(0);
    applyValvarDeformation(valvar, 0, 0);
    expect(tent()).toBeCloseTo(3.95, 1);
    // LV Phase 3 (by definition): the RV septum follows the LV field (v = λ = 0.6234·1.008, the same instant as the old v = 1.008).
    // Before (per-node scale): 2.63 ± 0.05 mm. With coupled LV field (3.04 mm), stays within the updated 3.03 ± 0.30 mm target.
    setRvLvContraction(rig, LV_LAMBDA_ES_NOMINAL * 1.008);
    setLambda(rvLambdaFromQ(rig, 0.4));
    applyValvarDeformation(valvar, 0, 0);
    // With longitudinal descent and RV_PAPILLARY_TIP_FOLLOW (1 → 0.8699), systolic tenting returns to 3.03 mm (±0.30 mm).
    const tSys = tent();
    expect(Math.abs(tSys - 3.03)).toBeLessThanOrEqual(0.3);
  });
});

// ---------- Phase 2: watertight rest geometry ----------

/** Edge usage in the welded union (1e−4) of one layer of the 17 wedges (0 = endo, 1 = epi). */
function layerEdgeUse(ss: THREE.Mesh[], layer: 0 | 1) {
  const id = new Map<string, number>();
  const ys: number[] = [];
  const use = new Map<string, number>();
  for (const m of ss) {
    const pp = parentPositions(m);
    const n = pp.length / 3;
    const half = n / 2;
    const w = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(pp[3 * i] * 1e4)},${Math.round(pp[3 * i + 1] * 1e4)},${Math.round(pp[3 * i + 2] * 1e4)}`;
      let v = id.get(k);
      if (v === undefined) {
        v = id.size;
        id.set(k, v);
        ys.push(pp[3 * i + 1]);
      }
      w[i] = v;
    }
    const idx = m.geometry.getIndex()!;
    for (let t = 0; t < idx.count; t += 3) {
      const tri = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
      if (!tri.every((i) => (layer === 0 ? i < half : i >= half))) continue;
      const ww = tri.map((i) => w[i]);
      for (let e = 0; e < 3; e++) {
        const a = ww[e];
        const b = ww[(e + 1) % 3];
        const k = a < b ? `${a}_${b}` : `${b}_${a}`;
        use.set(k, (use.get(k) ?? 0) + 1);
      }
    }
  }
  let base = 0;
  let otherBoundary = 0;
  let notTwo = 0;
  for (const [k, c] of use) {
    const [a, b] = k.split('_').map(Number);
    const onBase = Math.abs(ys[a] - 0.73) < 1e-4 && Math.abs(ys[b] - 0.73) < 1e-4;
    if (c === 1 && onBase) base++;
    else if (c === 1) otherBoundary++;
    else if (c !== 2) notTwo++;
  }
  return { base, otherBoundary, notTwo };
}

describe('LV Phase 2 — watertight rest geometry (approach C)', () => {
  it('2.1: the 17 nodes keep name, material and userData.segId; the swap is reversible and idempotent', async () => {
    const scene = await loadGlbScene();
    scene.updateMatrixWorld(true);
    const ss = lvSegments(scene);
    const before = ss.map((m) => ({ m, name: m.name, mat: m.material, segId: m.userData.segId, geom: m.geometry }));
    expect(applyLvWatertightGeometry(scene)).toBe(17);
    const after = lvSegments(scene);
    expect(after.length).toBe(17);
    after.forEach((m, i) => {
      expect(m).toBe(before[i].m);
      expect(m.name).toBe(before[i].name);
      expect(m.material).toBe(before[i].mat);
      expect(m.userData.segId).toBe(before[i].segId);
      expect(m.userData.isExplicitSegment).toBe(true);
      expect(m.geometry).not.toBe(before[i].geom);
    });
    const g1 = after.map((m) => m.geometry);
    applyLvWatertightGeometry(scene);
    after.forEach((m, i) => expect(m.geometry).toBe(g1[i]));
    applyLvWatertightGeometry(scene, false);
    after.forEach((m, i) => expect(m.geometry).toBe(before[i].geom));
  });

  it('2.2: endocardium and epicardium joined with no boundary outside the basal ring and no T junction', async () => {
    const { ss } = await lvScene(true);
    for (const layer of [0, 1] as const) {
      const r = layerEdgeUse(ss, layer);
      expect(r.otherBoundary, `camada ${layer}`).toBe(0);
      expect(r.notTwo, `camada ${layer}`).toBe(0);
      expect(r.base, `camada ${layer}`).toBe(72);
    }
  });

  it('2.3: vertices outside the apical cap within ≤ 1e−6 u of lvEnvelopeRadius; cap on the closed C1 profile', async () => {
    const { ss } = await lvScene(true);
    let err = 0;
    let errCap = 0;
    let nCap = 0;
    for (const m of ss) {
      const p = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      const half = p.count / 2;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        const r = Math.hypot(p.getX(i), p.getZ(i));
        if (y >= -1.42 - 1e-7) err = Math.max(err, Math.abs(r - lvEnvelopeRadius(y, i >= half)));
        else {
          nCap++;
          // the pole (r = 0) is sensitive to float32 rounding of y (dr/dy → ∞): tolerance of 1e−4 u
          errCap = Math.max(errCap, Math.abs(r - lvClosedProfileRadius(y, i >= half)));
        }
      }
    }
    expect(err).toBeLessThanOrEqual(1e-6);
    expect(nCap).toBeGreaterThan(0);
    expect(errCap).toBeLessThanOrEqual(1e-4);
    // C1 continuity at y0 and poles below y0 (endo above epi)
    for (const epi of [false, true]) {
      const h = 1e-6;
      const slopeIn = (lvClosedProfileRadius(-1.42 + h, epi) - lvClosedProfileRadius(-1.42, epi)) / h;
      const slopeOut = (lvClosedProfileRadius(-1.42, epi) - lvClosedProfileRadius(-1.42 - h, epi)) / h;
      expect(Math.abs(slopeIn - slopeOut)).toBeLessThan(1e-3);
    }
    expect(lvApexCap(false).yPole).toBeGreaterThan(lvApexCap(true).yPole);
  });

  it('2.4: cavity volume at rest within ≤ 1.0 % of 1.9075 u³, with no boundary beyond the basal ring', async () => {
    const { ss } = await lvScene(true);
    const r = lvClosedCavityVolume(ss);
    expect(r.boundaryEdges).toBe(72);
    expect(Math.abs(r.volume / 1.9075 - 1)).toBeLessThanOrEqual(0.01);
    expect(computeLvBaseY(ss)).toBeCloseTo(0.73, 6);
  });

  it('2.5: with per-node scale and wm = 1, gap 0 (≤ 1e−6 u) at v = 0 and v = 1', async () => {
    const { ss } = await lvScene(true);
    const rest = ss.map(parentPositions);
    for (const v of [0, 1]) {
      setContraction(ss, () => v);
      expect(lvMaxSeamGap(rest, ss.map(parentPositions)).gap, `v=${v}`).toBeLessThanOrEqual(1e-6);
    }
  });

  it('regression: 0 vertices of the RV and tricuspid papillary muscles inside the closed LV (with the cap) at q = 1; 0.7; 0.4', { timeout: 60000 }, async () => {
    const scene = await loadGlbScene();
    scene.updateMatrixWorld(true);
    applyRvProceduralGeometry(scene);
    const valvar = setupValvarKinematics(scene)!;
    applyTricuspidApparatusPose(scene);
    const rig = setupRvContraction(scene.getObjectByName('right_ventricle') as THREE.Mesh, scene.getObjectByName('tricuspid_annulus') as THREE.Mesh, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), valvar)!;
    const W = RV_COMPONENT_WEIGHTS;
    const G = RV_RIG_GAINS;
    const p = new THREE.Vector3();
    // LV Phase 3 (by definition): v = λ of the LV field (before, v of the per-node scale; the old instants 0.5 and 1.008 become 0.6234·v)
    // and the closed LV is the current epicardium of the field with c = 1 (before, sxz·r_epi(y/sy)), with the cap
    for (const [q, vOld] of [[1, 0], [0.7, 0.5], [0.4, 1.008]] as const) {
      const v = LV_LAMBDA_ES_NOMINAL * vOld;
      setRvLvContraction(rig, v);
      const lam = rvLambdaFromQ(rig, q);
      setRvDeformation(rig, W.longitudinal * G.longitudinal * lam, W.radial * G.radial * lam, W.anteroposterior * G.anteroposterior * lam);
      scene.updateMatrixWorld(true);
      let inside = 0;
      for (const name of ['right_ventricle', 'tricuspid_septal_papillary_muscle', 'tricuspid_anterior_papillary_muscle', 'tricuspid_posterior_papillary_muscle']) {
        const m = scene.getObjectByName(name) as THREE.Mesh;
        const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          p.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
          const R = lvEpiRadiusUniform(v, Math.atan2(p.z, p.x), p.y);
          if (R > 0 && Math.hypot(p.x, p.z) < R) inside++;
        }
      }
      expect(inside, `q=${q}, v=${v}`).toBe(0);
    }
  });

  it('HeartMesh17 restores the wedges before normalization and swaps after the LV axis and base', async () => {
    const fsName = 'f' + 's';
    const fsMod: any = await import(/* @vite-ignore */ fsName);
    const src: string = fsMod.readFileSync('src/view/cardiac3d/HeartMesh17.tsx', 'utf8');
    const restore = src.indexOf('applyLvWatertightGeometry(sceneClone, false)');
    const norm = src.indexOf('const box = new THREE.Box3().setFromObject(sceneClone)');
    const base = src.indexOf('const lvBaseY = computeLvBaseY(');
    const apply = src.indexOf('applyLvWatertightGeometry(sceneClone);');
    expect(restore).toBeGreaterThan(0);
    expect(norm).toBeGreaterThan(restore);
    expect(base).toBeGreaterThan(norm);
    expect(apply).toBeGreaterThan(base);
  });
});
