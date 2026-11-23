import { describe, expect, it, beforeAll } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import chordaMappingRaw from './chorda_topological_mapping.json';
import { countLvRegions, worldPositions, lvEpicardialClearance } from './rvGeometryMetrics';
import {
  setupValvarKinematics,
  applyValvarDeformation,
  measureValvarChordae,
  measureValvarCoaptation,
  measureValvarCoaptationLegacy,
  GLTF_SCALE_MM_PER_UNIT,
  type ValvarKinematicsData,
} from './valvarKinematics';
import {
  applyTricuspidApparatusPose,
  tricuspidPoseMatrix,
  tricuspidFallbackRingPose,
  TRICUSPID_APPARATUS_POSE,
  TRICUSPID_APPARATUS_NODE_NAMES,
} from './tricuspidApparatusPose';

// ============================================================================
// Rigid T_TV pose of the tricuspid apparatus.
// Criteria: 0 apparatus vertices inside the LV epicardium (clearance >= 1 mm @34.3 mm/unit),
// chordae with unchanged length (<= 1e-6 relative), chorda–papillary ΔG = 0, chorda–leaflet gap and
// coaptation unchanged, valvar kinematics unchanged in local space, exact reversion flag.
// ============================================================================

const FOLGA_MIN = 1 / GLTF_SCALE_MM_PER_UNIT; // 1 mm in model units
const STRUCTURES = [
  'tricuspid_annulus',
  'tricuspid_anterior_leaflet',
  'tricuspid_posterior_leaflet',
  'tricuspid_septal_leaflet',
  'tricuspid_anterior_papillary_muscle',
  'tricuspid_posterior_papillary_muscle',
  'tricuspid_septal_papillary_muscle',
];
const TRICUSPID_LEAFLETS = STRUCTURES.slice(1, 4);
const mapping = (chordaMappingRaw as any[]).filter((m) => String(m.chordaName).startsWith('tricuspid_'));

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

function mesh(scene: THREE.Object3D, name: string): THREE.Mesh {
  const m = scene.getObjectByName(name) as THREE.Mesh | undefined;
  if (!m?.isMesh) throw new Error(`malha ausente: ${name}`);
  return m;
}

function worldVertex(m: THREE.Mesh, idx: number): THREE.Vector3 {
  return new THREE.Vector3().fromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute, idx).applyMatrix4(m.matrixWorld);
}

function nearestDistance(p: THREE.Vector3, m: THREE.Mesh): number {
  let best = Infinity;
  for (const q of worldPositions(m)) best = Math.min(best, q.distanceTo(p));
  return best;
}

/** Tricuspid anterior–posterior gap measured in WORLD space (same cut as measureValvarCoaptation). */
function worldTricuspidGap(v: ValvarKinematicsData): number {
  const a = v.leaflets.find((l) => l.name === 'tricuspid_anterior_leaflet')!;
  const p = v.leaflets.find((l) => l.name === 'tricuspid_posterior_leaflet')!;
  const sel = (l: typeof a) => {
    const pos = l.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const cut = l.minY + 0.35 * l.height;
    const out: THREE.Vector3[] = [];
    const rest = (l.mesh.userData.restPositions as Float32Array | undefined) ?? (pos.array as Float32Array);
    for (let i = 0; i < pos.count; i++) if (rest[i * 3 + 1] <= cut) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(l.mesh.matrixWorld));
    return out;
  };
  const A = sel(a);
  const B = sel(p);
  let best = Infinity;
  for (const x of A) for (const y of B) best = Math.min(best, x.distanceTo(y));
  return best;
}

/** New pair (original, posed): setupValvarKinematics captures the rest of the current scene state. */
async function freshPair(): Promise<[THREE.Group, THREE.Group]> {
  const a = await loadGlbScene();
  a.updateMatrixWorld(true);
  const b = await loadGlbScene();
  applyTricuspidApparatusPose(b);
  return [a, b];
}

describe('RV Phase 2 — rigid T_TV pose of the tricuspid apparatus', () => {
  let orig: THREE.Group;
  let posed: THREE.Group;

  beforeAll(async () => {
    orig = await loadGlbScene();
    orig.updateMatrixWorld(true);
    posed = await loadGlbScene();
    expect(applyTricuspidApparatusPose(posed)).toBe(25);
  });

  it('T_TV is rigid (proper rotation + translation, no scale) and covers the 25 apparatus nodes', () => {
    expect(TRICUSPID_APPARATUS_NODE_NAMES.length).toBe(25);
    const q = TRICUSPID_APPARATUS_POSE.quaternion;
    expect(Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1)).toBeLessThan(1e-9);
    const M = tricuspidPoseMatrix();
    const e = M.elements;
    const cols = [0, 4, 8].map((o) => new THREE.Vector3(e[o], e[o + 1], e[o + 2]));
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(cols[i].length() - 1)).toBeLessThan(1e-9);
      for (let j = i + 1; j < 3; j++) expect(Math.abs(cols[i].dot(cols[j]))).toBeLessThan(1e-9);
    }
    expect(Math.abs(M.determinant() - 1)).toBeLessThan(1e-9);
    // the translation is non-null: the apparatus moves away from its place
    const t = TRICUSPID_APPARATUS_POSE.translation;
    expect(Math.hypot(t[0], t[1], t[2])).toBeGreaterThan(0.1);
  });

  it('0 apparatus vertices inside the LV epicardium: 3/3 leaflets, 3/3 papillary muscles, annulus and 18/18 chordae outside, clearance ≥ 1 mm', () => {
    for (const name of STRUCTURES) {
      const c = countLvRegions(worldPositions(mesh(posed, name)));
      expect([c.cavity, c.wall, c.outside], name).toEqual([0, 0, c.total]);
    }
    const chordae = mapping.map((m) => mesh(posed, m.chordaName));
    expect(chordae.length).toBe(18);
    const fora = chordae.filter((m) => {
      const c = countLvRegions(worldPositions(m));
      return c.cavity + c.wall === 0;
    }).length;
    expect(fora).toBe(18);
    let minFolga = Infinity;
    for (const name of TRICUSPID_APPARATUS_NODE_NAMES) {
      for (const p of worldPositions(mesh(posed, name))) minFolga = Math.min(minFolga, lvEpicardialClearance(p));
    }
    expect(minFolga, `folga mínima ${(minFolga * GLTF_SCALE_MM_PER_UNIT).toFixed(3)} mm`).toBeGreaterThanOrEqual(FOLGA_MIN);
  });

  it('length of the 18 chordae unchanged (relative variation ≤ 1e-6), also in the setup restLen', async () => {
    for (const m of mapping) {
      const a = mesh(orig, m.chordaName);
      const b = mesh(posed, m.chordaName);
      const l0 = worldVertex(a, m.baseIdx).distanceTo(worldVertex(a, m.tipIdx));
      const l1 = worldVertex(b, m.baseIdx).distanceTo(worldVertex(b, m.tipIdx));
      expect(Math.abs(l1 / l0 - 1), m.chordaName).toBeLessThanOrEqual(1e-6);
    }
    const [o2, p2] = await freshPair();
    const v0 = setupValvarKinematics(o2)!;
    const v1 = setupValvarKinematics(p2)!;
    const tc0 = v0.chordae.filter((c) => c.chordaName.startsWith('tricuspid_'));
    const tc1 = v1.chordae.filter((c) => c.chordaName.startsWith('tricuspid_'));
    expect(tc1.length).toBe(18);
    for (let i = 0; i < 18; i++) expect(Math.abs(tc1[i].restLen / tc0[i].restLen - 1)).toBeLessThanOrEqual(1e-6);
  });

  it('chorda–papillary ΔG = 0 and chorda–leaflet gap unchanged (world space)', () => {
    for (const m of mapping) {
      const ca = mesh(orig, m.chordaName);
      const cb = mesh(posed, m.chordaName);
      const g0 = nearestDistance(worldVertex(ca, m.baseIdx), mesh(orig, m.papillaryName));
      const g1 = nearestDistance(worldVertex(cb, m.baseIdx), mesh(posed, m.papillaryName));
      expect(Math.abs(g1 - g0) * GLTF_SCALE_MM_PER_UNIT, `ΔG ${m.chordaName}`).toBeLessThan(1e-5);
      const t0 = worldVertex(ca, m.tipIdx).distanceTo(worldVertex(mesh(orig, m.leafletName), m.leafletVIdx));
      const t1 = worldVertex(cb, m.tipIdx).distanceTo(worldVertex(mesh(posed, m.leafletName), m.leafletVIdx));
      expect(Math.abs(t1 - t0) * GLTF_SCALE_MM_PER_UNIT, `gap folheto ${m.chordaName}`).toBeLessThan(1e-5);
    }
  });

  it('tricuspid coaptation at closure (z = 0) equal to the current one (±0.01 mm), in local and world space', async () => {
    const [orig, posed] = await freshPair();
    const v0 = setupValvarKinematics(orig)!;
    const v1 = setupValvarKinematics(posed)!;
    applyValvarDeformation(v0, 0, 0);
    applyValvarDeformation(v1, 0, 0);
    const c0 = measureValvarCoaptation(v0);
    const c1 = measureValvarCoaptation(v1);
    expect(Math.abs(c1.tricuspidGapMm - c0.tricuspidGapMm)).toBeLessThanOrEqual(0.01);
    expect(c1.isTricuspidClosed).toBe(c0.isTricuspidClosed);
    const w0 = worldTricuspidGap(v0) * GLTF_SCALE_MM_PER_UNIT;
    const w1 = worldTricuspidGap(v1) * GLTF_SCALE_MM_PER_UNIT;
    expect(Math.abs(w1 - w0)).toBeLessThanOrEqual(0.01);
    // worldTricuspidGap is the SMALLEST A-P gap: compares with the old metric (D17: measureValvarCoaptation now uses the largest free-edge gap)
    expect(Math.abs(w1 - measureValvarCoaptationLegacy(v0).tricuspidGapMm)).toBeLessThanOrEqual(0.01);
  });

  it('opening/closing kinematics (zTricuspid) unchanged in local space; ΔG = 0 in all states', async () => {
    const [orig, posed] = await freshPair();
    const v0 = setupValvarKinematics(orig)!;
    const v1 = setupValvarKinematics(posed)!;
    for (const name of TRICUSPID_LEAFLETS) {
      const s0 = v0.leaflets.find((l) => l.name === name)!;
      const s1 = v1.leaflets.find((l) => l.name === name)!;
      expect(s1.openDir.distanceTo(s0.openDir)).toBeLessThan(1e-12);
      expect(s1.closeDir.distanceTo(s0.closeDir)).toBeLessThan(1e-12);
    }
    const M = tricuspidPoseMatrix();
    const meshes0 = [...v0.leaflets.filter((l) => !l.isMitral).map((l) => l.mesh), ...v0.chordae.filter((c) => c.chordaName.startsWith('tricuspid_')).map((c) => c.chordaMesh)];
    const meshes1 = [...v1.leaflets.filter((l) => !l.isMitral).map((l) => l.mesh), ...v1.chordae.filter((c) => c.chordaName.startsWith('tricuspid_')).map((c) => c.chordaMesh)];
    expect(meshes1.length).toBe(21);
    const p = new THREE.Vector3();
    for (const z of [0, 0.25, 0.5, 0.75, 1]) {
      applyValvarDeformation(v0, 0.3, z);
      applyValvarDeformation(v1, 0.3, z);
      let maxLocal = 0;
      let maxWorld = 0;
      for (let k = 0; k < meshes0.length; k++) {
        const a = meshes0[k].geometry.getAttribute('position').array as Float32Array;
        const b = meshes1[k].geometry.getAttribute('position').array as Float32Array;
        for (let i = 0; i < a.length; i++) maxLocal = Math.max(maxLocal, Math.abs(a[i] - b[i]));
        // world: posed = T_TV · original
        const w1 = worldPositions(meshes1[k]);
        for (let i = 0; i < w1.length; i++) {
          p.set(a[3 * i], a[3 * i + 1], a[3 * i + 2]).applyMatrix4(meshes0[k].matrixWorld).applyMatrix4(M);
          maxWorld = Math.max(maxWorld, p.distanceTo(w1[i]));
        }
      }
      expect(maxLocal, `local z=${z}`).toBe(0);
      expect(maxWorld, `mundo z=${z}`).toBeLessThan(1e-6);
      // valvar setup measures (local space) identical to those of the original apparatus in each state
      const m0 = measureValvarChordae(v0).filter((c) => String(c.chordaName).startsWith('tricuspid_'));
      const m1 = measureValvarChordae(v1).filter((c) => String(c.chordaName).startsWith('tricuspid_'));
      expect(m1.length).toBe(18);
      for (let i = 0; i < m1.length; i++) {
        expect(Math.abs(m1[i].curLenMm - m0[i].curLenMm)).toBeLessThan(1e-9);
        expect(Math.abs(m1[i].gapDeltaTipMm - m0[i].gapDeltaTipMm)).toBeLessThan(1e-9);
        expect(m1[i].baseShiftMm).toBeLessThan(1e-5);
        expect(m1[i].constraintErrorMm).toBeLessThan(1e-5);
      }
    }
  });

  it('reversion flag restores the original pose exactly; reapplying is idempotent; mitral untouched', async () => {
    const s = await loadGlbScene();
    s.updateMatrixWorld(true);
    const before = TRICUSPID_APPARATUS_NODE_NAMES.map((n) => mesh(s, n).matrixWorld.clone());
    applyTricuspidApparatusPose(s);
    const once = TRICUSPID_APPARATUS_NODE_NAMES.map((n) => mesh(s, n).matrixWorld.clone());
    applyTricuspidApparatusPose(s);
    TRICUSPID_APPARATUS_NODE_NAMES.forEach((n, i) => {
      const e1 = mesh(s, n).matrixWorld.elements;
      for (let k = 0; k < 16; k++) expect(Math.abs(e1[k] - once[i].elements[k])).toBeLessThan(1e-12);
    });
    applyTricuspidApparatusPose(s, false);
    TRICUSPID_APPARATUS_NODE_NAMES.forEach((n, i) => {
      const e1 = mesh(s, n).matrixWorld.elements;
      for (let k = 0; k < 16; k++) expect(Math.abs(e1[k] - before[i].elements[k]), n).toBeLessThan(1e-12);
    });
    for (const n of ['mitral_annulus', 'mitral_anterior_leaflet', 'right_ventricle', 'right_atrium']) {
      expect(mesh(posed, n).matrixWorld.equals(mesh(orig, n).matrixWorld), n).toBe(true);
    }
  });

  it('procedural annulus tricuspidValveRef receives the same T_TV', () => {
    const base: [number, number, number] = [-0.55, 0.68, 0.22];
    const r = tricuspidFallbackRingPose(base);
    const expected = new THREE.Vector3(...base).applyMatrix4(tricuspidPoseMatrix());
    expect(new THREE.Vector3(...r.position).distanceTo(expected)).toBeLessThan(1e-12);
    const q = TRICUSPID_APPARATUS_POSE.quaternion;
    for (let i = 0; i < 4; i++) expect(Math.abs(r.quaternion[i] - q[i])).toBeLessThan(1e-9);
    const off = tricuspidFallbackRingPose(base, false);
    expect(off.position).toEqual(base);
    expect(off.quaternion).toEqual([0, 0, 0, 1]);
  });
});
