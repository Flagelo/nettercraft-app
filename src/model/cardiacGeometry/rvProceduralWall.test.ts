import { describe, expect, it, beforeAll } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  lvEnvelopeRadius,
  meshTopology,
  meshOrientation,
  measureRvChamber,
  countLvRegions,
  countInsideLvByAhaWedge,
  worldPositions,
  pointToMeshDistance,
  pointInsideClosedMesh,
  papillaryBase,
  annulusWallGap,
  boundaryLoops,
  rvEndocardialSelector,
  measureRvCavityVolume,
  lvFaceCoverage,
  rvRoofMetrics,
  computeRvAxes,
  type RvChamberMetrics,
} from './rvGeometryMetrics';
import { applyTricuspidApparatusPose } from './tricuspidApparatusPose';
import {
  RV_PROCEDURAL_ENABLED,
  RV_WALL_PARAMS,
  PAPILLARY_STRETCH_FRACTION,
  applyRvProceduralGeometry,
  buildRvWallGeometry,
  rvPapillaryExtensions,
  rvWallInputsFromScene,
} from './rvGeometry';
import chordaMappingRaw from './chorda_topological_mapping.json';

// ============================================================================
// RV Phase 3: procedural wall (rvGeometryComponent.ts) over the T_TV pose of Phase 2.
// Criteria (Lang 2015, Table 8; scale D1 = 34.3 mm/unit), measured with rvGeometryMetrics.ts
// in the scene as in the app: geometry swapped on the `right_ventricle` node and tricuspid apparatus posed.
// Reports: VD_FASE3_20261108.md, VD_FASE3B_20261108.md and VD_FASE3C_20261108.md.
// ============================================================================

const S = 34.3;
const mm = (u: number) => u * S;

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

async function readSource(rel: string): Promise<string> {
  const fsName = 'f' + 's';
  const pathName = 'p' + 'a' + 't' + 'h';
  const fsMod: any = await import(/* @vite-ignore */ fsName);
  const pathMod: any = await import(/* @vite-ignore */ pathName);
  return fsMod.readFileSync(pathMod.resolve(rel), 'utf8');
}

function mesh(scene: THREE.Object3D, name: string): THREE.Mesh {
  const m = scene.getObjectByName(name) as THREE.Mesh | undefined;
  if (!m?.isMesh) throw new Error(`malha ausente: ${name}`);
  return m;
}

const within = (actual: number, target: number, tol: number, label: string) => {
  expect(Math.abs(actual - target), `${label}: ${actual.toFixed(3)} vs ${target} ± ${tol}`).toBeLessThanOrEqual(tol);
};

/** Closed cavity: endocardium + caps (centroid fan) over the two openings. For tests only. */
function closedCavity(rv: THREE.Mesh): THREE.Mesh {
  const pos = rv.geometry.getAttribute('position') as THREE.BufferAttribute;
  const idx = rv.geometry.getIndex()!;
  const tr = rv.geometry.getAttribute('transmural') as THREE.BufferAttribute;
  const out: number[] = [];
  const v = new THREE.Vector3();
  for (let t = 0; t < idx.count; t += 3) {
    const ii = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
    if (ii.some((k) => tr.getX(k) !== 0)) continue;
    for (const k of ii) {
      v.fromBufferAttribute(pos, k).applyMatrix4(rv.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  }
  for (const loop of boundaryLoops(rv, rvEndocardialSelector(rv))) {
    const m = loop.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / loop.length);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[(i + 1) % loop.length];
      const b = loop[i];
      out.push(m.x, m.y, m.z, a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  const c = new THREE.Mesh(g);
  c.updateMatrixWorld(true);
  return c;
}

describe('RV Phase 3: procedural wall (Lang 2015 @34.3 mm/unit)', () => {
  let scene: THREE.Group;
  let rv: THREE.Mesh;
  let annulus: THREE.Mesh;
  let chamber: RvChamberMetrics;

  beforeAll(async () => {
    scene = await loadGlbScene();
    scene.updateMatrixWorld(true);
    // same order as the app: swap the RV geometry; the tricuspid apparatus receives T_TV
    applyRvProceduralGeometry(scene);
    applyTricuspidApparatusPose(scene);
    scene.updateMatrixWorld(true);
    rv = mesh(scene, 'right_ventricle');
    annulus = mesh(scene, 'tricuspid_annulus');
    chamber = measureRvChamber(rv, annulus);
  });

  it('swaps the geometry of the right_ventricle node (same node, matrix and material); the reversal flag restores the GLB sphere', async () => {
    expect(RV_PROCEDURAL_ENABLED).toBe(true);
    const s = await loadGlbScene();
    s.updateMatrixWorld(true);
    const node = mesh(s, 'right_ventricle');
    const original = node.geometry;
    const material = node.material;
    const matrix = node.matrix.clone();
    const r1 = applyRvProceduralGeometry(s, true);
    expect(r1).not.toBeNull();
    expect(node.geometry).not.toBe(original);
    expect(node.geometry.userData.rvProcedural).toBe(true);
    expect(node.material).toBe(material);
    expect(node.matrix.equals(matrix)).toBe(true);
    expect(s.getObjectByName('right_ventricle')).toBe(node);
    const procedural = node.geometry;
    // reversal and idempotence: returns to the original object; reapplying reuses the same geometry
    applyRvProceduralGeometry(s, false);
    expect(node.geometry).toBe(original);
    expect(node.userData.rvProcedural).toBe(false);
    applyRvProceduralGeometry(s, true);
    expect(node.geometry).toBe(procedural);
    // determinism: two independent generations are bit-for-bit identical
    const inputs = rvWallInputsFromScene(s)!;
    const g1 = buildRvWallGeometry(inputs)!.geometry.getAttribute('position').array as Float32Array;
    const g2 = buildRvWallGeometry(rvWallInputsFromScene(s)!)!.geometry.getAttribute('position').array as Float32Array;
    expect(g1.length).toBe(g2.length);
    let diff = 0;
    for (let i = 0; i < g1.length; i++) if (g1[i] !== g2[i]) diff++;
    expect(diff).toBe(0);
  });

  it('closed solid: 0 boundary edges, consistent orientation; 2 endocardium openings closed by thickness rims', () => {
    const t = meshTopology(rv);
    expect(t.boundaryEdges).toBe(0);
    expect(t.nonManifoldEdges).toBe(0);
    const o = meshOrientation(rv);
    expect(o.inconsistentEdges).toBe(0);
    expect(o.signedVolume).toBeGreaterThan(0);
    // endocardium alone: exactly 2 boundary loops (inflow tract = annulus; provisional outflow tract)
    const loops = boundaryLoops(rv, rvEndocardialSelector(rv));
    expect(loops.length).toBe(2);
    const ac = new THREE.Box3().setFromObject(annulus).getCenter(new THREE.Vector3());
    const cen = (l: THREE.Vector3[]) => l.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / l.length);
    loops.sort((a, b) => cen(a).distanceTo(ac) - cen(b).distanceTo(ac));
    expect(loops[0].length).toBe(RV_WALL_PARAMS.segmentsU);
    expect(loops[1].length).toBeGreaterThanOrEqual(8);
    // the outflow opening is the stretch of the free wall closest to the pulmonary valve. Phase 3b: the criterion
    // old (closer to the valve than the annulus center) no longer applied, because the valve sits over the LV
    // and the free wall of the broad crescent passes farther from it; the infundibulum linking them is Phase 5.
    const pv = new THREE.Box3().setFromObject(mesh(scene, 'pulmonary_valve')).getCenter(new THREE.Vector3());
    const dOut = cen(loops[1]).distanceTo(pv);
    const pts = worldPositions(rv);
    const tr = rv.geometry.getAttribute('transmural') as THREE.BufferAttribute;
    const w = rv.geometry.getAttribute('septalWeight') as THREE.BufferAttribute;
    let free = 0;
    let nearer = 0;
    for (let i = 0; i < pts.length; i++) {
      if (tr.getX(i) !== 0 || w.getX(i) < 0.99) continue;
      free++;
      if (pts[i].distanceTo(pv) < dOut) nearer++;
    }
    expect(free).toBeGreaterThan(1000);
    // 10%: the opening is a block of 15×11 cells, and part of its neighborhood is closer to the valve than the block center
    expect(nearer / free).toBeLessThan(0.1);
  });

  it('annulus → RV apex length: 71 ± 6 mm', () => {
    within(mm(chamber.length), 71, 6, 'L (mm)');
  });

  it('diameters in the 4C plane: RVD1 33 ± 4 mm, RVD2 27 ± 4 mm, RVD1 > RVD2', () => {
    within(mm(chamber.rvd1), 33, 4, 'RVD1 (mm)');
    within(mm(chamber.rvd2), 27, 4, 'RVD2 (mm)');
    expect(chamber.rvd1).toBeGreaterThan(chamber.rvd2);
    // the largest diameter lies in the basal third (non-inverted shape)
    expect(chamber.maxWidthFrac).toBeLessThanOrEqual(1 / 3);
  });

  it('free wall thickness: 3 ± 0.5 mm', () => {
    within(mm(chamber.freeWallThickness), 3, 0.5, 'espessura (mm)');
  });

  it('interpenetration: 0 RV vertices inside the LV epicardium and 0 in all AHA wedges', () => {
    const pts = worldPositions(rv);
    const c = countLvRegions(pts);
    expect(c.cavity).toBe(0);
    expect(c.wall).toBe(0);
    expect(c.outside).toBe(pts.length);
    expect(countInsideLvByAhaWedge(pts)).toEqual({});
  });

  it('septum: endocardium = LV epicardium + ε (ε ≤ 0.5 mm) and LV-facing surface between 0 and ε, without penetrating the LV', () => {
    const pts = worldPositions(rv);
    const w = rv.geometry.getAttribute('septalWeight') as THREE.BufferAttribute;
    const tr = rv.geometry.getAttribute('transmural') as THREE.BufferAttribute;
    const septBase = papillaryBase(mesh(scene, 'tricuspid_septal_papillary_muscle'));
    // depression under the septal papillary muscle: outside 3σ (+ depth margin), the septum is epicardium + ε
    const dentRadius = 3 * RV_WALL_PARAMS.septalPapillarySigma + 2 / S;
    const epsEndo = mm(RV_WALL_PARAMS.septalEpsEndo);
    const epsEpi = mm(RV_WALL_PARAMS.septalEpsEpi);
    let nEndo = 0;
    let nEpi = 0;
    let maxDevEndo = 0;
    let maxDevEpi = 0;
    for (let i = 0; i < pts.length; i++) {
      if (w.getX(i) !== 0) continue;
      const p = pts[i];
      const off = mm(Math.hypot(p.x, p.z) - lvEnvelopeRadius(p.y, true));
      expect(off, `vértice ${i} dentro do VE`).toBeGreaterThan(0);
      if (tr.getX(i) === 0) {
        if (p.distanceTo(septBase) < dentRadius) continue; // depression under the septal papillary muscle
        nEndo++;
        maxDevEndo = Math.max(maxDevEndo, Math.abs(off - epsEndo));
      } else {
        nEpi++;
        maxDevEpi = Math.max(maxDevEpi, Math.abs(off - epsEpi));
      }
    }
    expect(epsEndo).toBeLessThanOrEqual(0.5);
    expect(epsEpi).toBeGreaterThan(0);
    expect(epsEpi).toBeLessThan(epsEndo);
    expect(nEndo).toBeGreaterThan(500);
    expect(nEpi).toBeGreaterThan(500);
    expect(maxDevEndo).toBeLessThan(1e-3);
    expect(maxDevEpi).toBeLessThan(1e-3);
  });

  it('papillary bases: anterior and posterior ≤ 0.5 mm from the free wall; septal ≤ 0.5 mm from the septum', () => {
    const w = rv.geometry.getAttribute('septalWeight') as THREE.BufferAttribute;
    const pts = worldPositions(rv);
    const nearestWeight = (p: THREE.Vector3) => {
      let best = Infinity;
      let k = -1;
      for (let i = 0; i < pts.length; i++) {
        const d = pts[i].distanceToSquared(p);
        if (d < best) {
          best = d;
          k = i;
        }
      }
      return w.getX(k);
    };
    for (const [name, free] of [
      ['anterior', true],
      ['posterior', true],
      ['septal', false],
    ] as const) {
      // D4: in anterior and posterior, the base is the vertex anchored to the wall (the shortest path is not vertical,
      // so the lowest vertex is no longer the base one); in septal, it follows the lowest vertex
      const m = mesh(scene, `tricuspid_${name}_papillary_muscle`);
      const e = rvPapillaryExtensions(scene).find((x) => x.name === m.name);
      const base = e
        ? new THREE.Vector3().fromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute, e.baseIndex).applyMatrix4(m.matrixWorld)
        : papillaryBase(m);
      const gap = mm(pointToMeshDistance(base, rv));
      expect(gap, `${name}: folga ${gap.toFixed(3)} mm`).toBeLessThanOrEqual(0.5);
      if (free) expect(nearestWeight(base), name).toBeGreaterThan(0.5);
      else expect(nearestWeight(base), name).toBeLessThan(0.5);
    }
  });

  it('inflow tract: annulus–wall gap = 0 mm; the rim endocardium consists of vertices of the posed annulus', () => {
    const g = annulusWallGap(rv, annulus);
    expect(g.perSector.every((d) => Number.isFinite(d))).toBe(true);
    expect(mm(g.gap)).toBeLessThan(1e-4);
    const loops = boundaryLoops(rv, rvEndocardialSelector(rv));
    const annPts = worldPositions(annulus);
    const ac = new THREE.Box3().setFromObject(annulus).getCenter(new THREE.Vector3());
    const inlet = loops.reduce((a, b) => {
      const ca = a.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / a.length);
      const cb = b.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / b.length);
      return ca.distanceTo(ac) <= cb.distanceTo(ac) ? a : b;
    });
    let worst = 0;
    for (const p of inlet) {
      let best = Infinity;
      for (const q of annPts) best = Math.min(best, q.distanceTo(p));
      worst = Math.max(worst, best);
    }
    expect(mm(worst)).toBeLessThan(1e-4);
  });

  it('attributes: uv (u, v), septalWeight (0 in the septum, 1 in the free wall) and transmural (0 endo, 1 epi)', () => {
    const g = rv.geometry;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const w = g.getAttribute('septalWeight') as THREE.BufferAttribute;
    const tr = g.getAttribute('transmural') as THREE.BufferAttribute;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    expect(uv.count).toBe(pos.count);
    expect(w.count).toBe(pos.count);
    expect(tr.count).toBe(pos.count);
    let n0 = 0;
    let n1 = 0;
    for (let i = 0; i < pos.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(i)).toBeLessThanOrEqual(1);
      expect(w.getX(i)).toBeGreaterThanOrEqual(0);
      expect(w.getX(i)).toBeLessThanOrEqual(1);
      expect([0, 1]).toContain(tr.getX(i));
      if (w.getX(i) === 0) n0++;
      if (w.getX(i) === 1) n1++;
    }
    expect(n0).toBeGreaterThan(1000);
    expect(n1).toBeGreaterThan(1000);
    // the vertex farthest from the LV is free wall (weight 1)
    const pts = worldPositions(rv);
    let far = 0;
    let best = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const off = Math.hypot(pts[i].x, pts[i].z) - lvEnvelopeRadius(pts[i].y, true);
      if (off > best) {
        best = off;
        far = i;
      }
    }
    expect(w.getX(far)).toBe(1);
  });

  // ---------- Phase 3b ----------

  it('resting cavity volume = engine EDV −20%/+15% (D3) and within the Lang 2015 range', () => {
    // Engine EDV measured in rvContraction.test.ts (150.8 mL, VERIFIED FACT in Phase 3).
    // D3 (user decision): with the rim set back to the LAD, the floor goes from −15% to −20%.
    const VDF_MOTOR_ML = 150.8;
    const vol = measureRvCavityVolume(rv);
    const mL = (vol.volume * S ** 3) / 1000;
    expect(vol.openings).toBe(2);
    expect(mL, `${mL.toFixed(1)} mL`).toBeGreaterThanOrEqual(0.8 * VDF_MOTOR_ML);
    expect(mL, `${mL.toFixed(1)} mL`).toBeLessThanOrEqual(1.15 * VDF_MOTOR_ML);
    // Lang 2015, Table 8: indexed EDV, men, 35–87 mL/m². The engine has no BSA: the range is checked
    // for the smallest BSA that accommodates the engine EDV (150.8 / 87 = 1.73 m²), the most restrictive case at the ceiling
    const BSA_MIN = VDF_MOTOR_ML / 87;
    expect(mL).toBeLessThanOrEqual(87 * BSA_MIN);
    expect(mL).toBeGreaterThanOrEqual(35 * BSA_MIN);
  });

  it('anterior coverage (D3): the RV covers ≥ 95% of the LV to the right of the LAD (θ 80–120°) and ≤ 5% to its left (θ 30–62°)', { timeout: 60000 }, () => {
    // The LAD (θ ≈ 68–75° in the mid third) is the anterior anatomical limit of the RV: to its right lies the anterior
    // septum, covered by the RV; to its left, the anterior wall of the LV, which is exposed. The Phase 3b criterion
    // (θ 30–120°, ≥ 95%) required covering the LAD and contradicts D3. Mid-ventricular y band, below the annulus.
    const direita = lvFaceCoverage(rv, 80, 120, -0.6, 0.1);
    expect(direita.total).toBeGreaterThan(500);
    expect(direita.fraction, `direita ${(direita.fraction * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.95);
    const esquerda = lvFaceCoverage(rv, 30, 62, -0.6, 0.1);
    expect(esquerda.fraction, `esquerda ${(esquerda.fraction * 100).toFixed(1)}%`).toBeLessThanOrEqual(0.05);
  });

  it('LAD (D3): 0/40 points of coronary_lad_artery in the cavity, no vertex in the myocardium and LAD–rim ≤ 2 mm in the mid third', { timeout: 60000 }, () => {
    const ladMesh = mesh(scene, 'coronary_lad_artery');
    const lad = worldPositions(ladMesh);
    const cav = closedCavity(rv);
    let in40 = 0;
    let n40 = 0;
    for (let i = 0; i < lad.length; i += 8) {
      n40++;
      if (pointInsideClosedMesh(cav, lad[i])) in40++;
    }
    expect(n40).toBe(40);
    expect(in40).toBe(0);
    // all tube vertices: outside the cavity and outside the wall solid (the LAD is not swallowed)
    for (const p of lad) {
      expect(pointInsideClosedMesh(cav, p)).toBe(false);
      expect(pointInsideClosedMesh(rv, p)).toBe(false);
    }
    // mid third in LAD height: centerline (tube centroid per y band) → RV mesh
    const box = new THREE.Box3().setFromPoints(lad);
    const third = (box.max.y - box.min.y) / 3;
    const yTop = box.max.y - third;
    const yBot = box.min.y + third;
    const N = 15;
    for (let k = 0; k < N; k++) {
      const y = yTop + ((yBot - yTop) * k) / (N - 1);
      const near = lad.filter((p) => Math.abs(p.y - y) < 0.04);
      expect(near.length).toBeGreaterThan(0);
      const c = near.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / near.length);
      expect(mm(pointToMeshDistance(c, rv)), `y=${y.toFixed(2)}`).toBeLessThanOrEqual(2);
    }
  });

  it('roof without plateau: ≤ 3% of the area facing the annulus and crease p99 ≤ 30°', () => {
    // Limits chosen between the values measured in Phase 3 (5.7% and 36.6°) and in 3b (1.0% and 27.6°)
    const m = rvRoofMetrics(rv, computeRvAxes(rv, annulus).L, 0.45, 25);
    expect(m.platformFraction, `${(m.platformFraction * 100).toFixed(2)}%`).toBeLessThanOrEqual(0.03);
    expect(m.p99CreaseDeg, `${m.p99CreaseDeg.toFixed(1)}°`).toBeLessThanOrEqual(30);
  });

  it('explicit apex: the L axis ends at the generator pole, above the LV apex', () => {
    const apex = computeRvAxes(rv, annulus).apex;
    const res = rv.geometry.userData.rvApex as [number, number, number];
    expect(apex.distanceTo(new THREE.Vector3(res[0], res[1], res[2]).applyMatrix4(rv.matrixWorld))).toBeLessThan(1e-9);
    expect(apex.y).toBeCloseTo(RV_WALL_PARAMS.apexY, 6);
    // RV apex higher than the LV apex (y0 of the analytic profile = −1.42)
    expect(apex.y).toBeGreaterThan(-1.42);
  });

  it('papillary muscles (D4 + D5): base at the closest point of the free wall with y_anchor ≤ y_base, no inverted papillary muscle; chordae and insertions fixed (ΔG = 0); flag restores', async () => {
    const ref = await loadGlbScene();
    applyTricuspidApparatusPose(ref);
    ref.updateMatrixWorld(true);
    const mapping = chordaMappingRaw as Array<{ chordaName: string; papillaryName: string; baseIdx: number; tipIdx: number }>;
    const chords = mapping.filter((c) => /tricuspid_(anterior|posterior)_chorda/.test(c.chordaName));
    expect(chords.length).toBe(12);
    const vertex = (m: THREE.Mesh, i: number) =>
      new THREE.Vector3().fromBufferAttribute(m.geometry.getAttribute('position') as THREE.BufferAttribute, i).applyMatrix4(m.matrixWorld);
    const nearest = (p: THREE.Vector3, m: THREE.Mesh) => {
      let best = Infinity;
      let at = new THREE.Vector3();
      for (const q of worldPositions(m)) {
        const d = q.distanceTo(p);
        if (d < best) {
          best = d;
          at = q;
        }
      }
      return { d: best, at };
    };
    for (const c of chords) {
      const a = mesh(scene, c.chordaName);
      const b = mesh(ref, c.chordaName);
      const lenA = vertex(a, c.baseIdx).distanceTo(vertex(a, c.tipIdx));
      const lenB = vertex(b, c.baseIdx).distanceTo(vertex(b, c.tipIdx));
      expect(Math.abs(lenA - lenB) / lenB, c.chordaName).toBeLessThanOrEqual(1e-6);
      const baseA = vertex(a, c.baseIdx);
      const na = nearest(baseA, mesh(scene, c.papillaryName));
      const nb = nearest(vertex(b, c.baseIdx), mesh(ref, c.papillaryName));
      expect(Math.abs(na.d - nb.d) * S, `ΔG ${c.chordaName}`).toBeLessThan(1e-6);
      expect(na.at.distanceTo(nb.at) * S, `inserção ${c.chordaName}`).toBeLessThan(1e-6);
    }
    const ext = rvPapillaryExtensions(scene);
    expect(ext.map((e) => e.name).sort()).toEqual(['tricuspid_anterior_papillary_muscle', 'tricuspid_posterior_papillary_muscle']);
    // shortest path with the height constraint (D5): the anchor is the free endocardium point closest to the
    // original posed base, among points with y ≤ y_base
    const pp = rv.geometry.getAttribute('position') as THREE.BufferAttribute;
    const tt = rv.geometry.getAttribute('transmural') as THREE.BufferAttribute;
    const ww = rv.geometry.getAttribute('septalWeight') as THREE.BufferAttribute;
    const ii = rv.geometry.getIndex()!;
    const tri = new THREE.Triangle();
    const cp = new THREE.Vector3();
    const minToFreeEndo = (p: THREE.Vector3, yMax = Infinity) => {
      let best = Infinity;
      for (let t = 0; t < ii.count; t += 3) {
        const [a0, b0, c0] = [ii.getX(t), ii.getX(t + 1), ii.getX(t + 2)];
        if (tt.getX(a0) !== 0 || tt.getX(b0) !== 0 || tt.getX(c0) !== 0) continue;
        if (ww.getX(a0) <= 0.5 || ww.getX(b0) <= 0.5 || ww.getX(c0) <= 0.5) continue;
        tri.a.fromBufferAttribute(pp, a0).applyMatrix4(rv.matrixWorld);
        tri.b.fromBufferAttribute(pp, b0).applyMatrix4(rv.matrixWorld);
        tri.c.fromBufferAttribute(pp, c0).applyMatrix4(rv.matrixWorld);
        tri.closestPointToPoint(p, cp);
        if (cp.y > yMax) continue;
        best = Math.min(best, cp.distanceTo(p));
      }
      return best;
    };
    for (const e of ext) {
      const base0 = papillaryBase(mesh(ref, e.name));
      expect(Math.abs(minToFreeEndo(base0, base0.y) - base0.distanceTo(e.anchor)) * S, `menor caminho ${e.name}`).toBeLessThan(1e-4);
      // D5: anchor at or below the base height, and below the tip (no inverted papillary muscle)
      expect(e.anchor.y, `y âncora ≤ y base ${e.name}`).toBeLessThanOrEqual(base0.y + 1e-9);
      expect(e.anchor.y, `âncora abaixo da ponta ${e.name}`).toBeLessThan(e.tip.y);
      expect(minToFreeEndo(e.anchor) * S, `âncora no endocárdio ${e.name}`).toBeLessThan(1e-4);
      expect(e.lengthAfter).toBeGreaterThan(e.lengthBefore);
      // only the basal portion moves: the tip vertices (above the stretched fraction) stay the same
      const m0 = mesh(ref, e.name);
      const p0 = m0.geometry.getAttribute('position') as THREE.BufferAttribute;
      const p1 = e.geometry.getAttribute('position') as THREE.BufferAttribute;
      expect(p1.count).toBe(p0.count);
      const axis = e.axisLocal;
      const hs: number[] = [];
      for (let i = 0; i < p0.count; i++) hs.push(new THREE.Vector3().fromBufferAttribute(p0, i).dot(axis));
      const zMax = Math.max(...hs);
      const zMin = Math.min(...hs);
      let fixed = 0;
      for (let i = 0; i < p0.count; i++) {
        if ((zMax - hs[i]) / (zMax - zMin) < PAPILLARY_STRETCH_FRACTION + 1e-6) continue;
        expect(Math.hypot(p1.getX(i) - p0.getX(i), p1.getY(i) - p0.getY(i), p1.getZ(i) - p0.getZ(i))).toBeLessThan(1e-6);
        fixed++;
      }
      expect(fixed).toBeGreaterThan(0);
    }
    // the septal papillary muscle is not extended; the flag restores the original geometries
    const s = await loadGlbScene();
    s.updateMatrixWorld(true);
    const ant = mesh(s, 'tricuspid_anterior_papillary_muscle');
    const sep = mesh(s, 'tricuspid_septal_papillary_muscle');
    const g0 = ant.geometry;
    const gs = sep.geometry;
    applyRvProceduralGeometry(s, true);
    expect(ant.geometry).not.toBe(g0);
    expect(sep.geometry).toBe(gs);
    applyRvProceduralGeometry(s, false);
    expect(ant.geometry).toBe(g0);
  });

  it('no per-frame allocation: the swap is done only in the HeartMesh17 setup (useMemo), outside useFrame', async () => {
    const src = await readSource('src/view/cardiac3d/HeartMesh17.tsx');
    const calls = src.split('applyRvProceduralGeometry(sceneClone').length - 1;
    expect(calls).toBe(2);
    const setupEnd = src.indexOf('}, [sceneClone]);');
    expect(setupEnd).toBeGreaterThan(0);
    let at = src.indexOf('applyRvProceduralGeometry(sceneClone');
    while (at >= 0) {
      expect(at).toBeLessThan(setupEnd);
      at = src.indexOf('applyRvProceduralGeometry(sceneClone', at + 1);
    }
    expect(src.includes('buildRvWallGeometry')).toBe(false);
  });
});
