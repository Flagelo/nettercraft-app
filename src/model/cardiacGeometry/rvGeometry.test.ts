import { describe, expect, it, beforeAll } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  lvEnvelopeRadius,
  meshTopology,
  measureRvChamber,
  measureRvot,
  countLvRegions,
  countInsideLvByAhaWedge,
  worldPositions,
  meshCentroid,
  computeRvAxes,
  type RvChamberMetrics,
} from './rvGeometryMetrics';
import { applyTricuspidApparatusPose } from './tricuspidApparatusPose';
import { applyRvProceduralGeometry } from './rvGeometry';
import { RV_COMPONENT_WEIGHTS, setupRvContraction, setRvDeformation, solveRvLambda } from './rvContraction';

// ============================================================================
// SNAPSHOT of the baseline RV geometry state (model units, independent of mm/unit scale).
// Model units (independent of the mm/unit scale). Tolerance: 0.01 unit or exact count.
// These tests MUST pass on the current code. Asserts marked with
//   "TARGET Phase N" will be replaced by target criteria when Phase N is implemented
// (target values in units @34.3 mm/unit in parentheses, Lang 2015 Table 8/10).
// ============================================================================

const TOL = 0.01;
// Phase 3: Lang 2015 targets in mm, converted by the D1 scale (34.3 mm/unit)
const S = 34.3;
const inMm = (u: number, target: number, tol: number, label: string) => {
  expect(Math.abs(u * S - target), `${label}: ${(u * S).toFixed(2)} mm vs ${target} ± ${tol}`).toBeLessThanOrEqual(tol);
};

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

const near = (actual: number, expected: number, tol = TOL) => {
  expect(Math.abs(actual - expected), `atual ${actual.toFixed(4)} vs ${expected}`).toBeLessThanOrEqual(tol);
};

describe('RV geometry — snapshot of the current state (model units)', () => {
  let scene: THREE.Group;
  let rv: THREE.Mesh;
  let annulus: THREE.Mesh;
  let chamber: RvChamberMetrics;
  // Phase 3: the same scene as in the app (procedural wall + T_TV pose)
  let sceneP: THREE.Group;
  let rvP: THREE.Mesh;
  let chamberP: RvChamberMetrics;

  beforeAll(async () => {
    scene = await loadGlbScene();
    scene.updateMatrixWorld(true);
    rv = mesh(scene, 'right_ventricle');
    annulus = mesh(scene, 'tricuspid_annulus');
    chamber = measureRvChamber(rv, annulus);
    sceneP = await loadGlbScene();
    sceneP.updateMatrixWorld(true);
    applyRvProceduralGeometry(sceneP);
    applyTricuspidApparatusPose(sceneP);
    sceneP.updateMatrixWorld(true);
    rvP = mesh(sceneP, 'right_ventricle');
    chamberP = measureRvChamber(rvP, mesh(sceneP, 'tricuspid_annulus'));
  });

  it('the analytic LV profile reproduces the vertices of the 17 GLB wedges', () => {
    let maxErr = 0;
    let n = 0;
    scene.traverse((o: any) => {
      if (!o.isMesh || typeof o.userData?.segId !== 'number') return;
      for (const p of worldPositions(o)) {
        const r = Math.hypot(p.x, p.z);
        const err = Math.min(Math.abs(r - lvEnvelopeRadius(p.y, false)), Math.abs(r - lvEnvelopeRadius(p.y, true)));
        if (err > maxErr) maxErr = err;
        n++;
      }
    });
    expect(n).toBe(17 * 154);
    expect(maxErr).toBeLessThan(1e-4);
  });

  it('RV mesh topology: single-surface open shell', () => {
    const t = meshTopology(rv);
    expect(t.vertices).toBe(475);
    expect(t.weldedVertices).toBe(475);
    expect(t.triangles).toBe(864);
    expect(t.nonManifoldEdges).toBe(0);
    // Raw GLB (snapshot): open shell
    expect(t.boundaryEdges).toBe(84);
    // TARGET Phase 3 (achieved): closed procedural wall, 0 boundary edges
    const tp = meshTopology(rvP);
    expect(tp.boundaryEdges).toBe(0);
    expect(tp.nonManifoldEdges).toBe(0);
  });

  it('longitudinal length (annulus → RV apex)', () => {
    // TARGET Phase 3: 71 ± 6 mm (2.070 ± 0.175 unit @34.3)
    near(chamber.length, 1.687);
    const axes = computeRvAxes(rv, annulus);
    near(axes.annulusCenter.x, -0.548);
    near(axes.annulusCenter.y, 0.648);
    near(axes.annulusCenter.z, 0.219);
    near(axes.apex.y, -0.972);
    // TARGET Phase 3 (achieved): 71 ± 6 mm
    inMm(chamberP.length, 71, 6, 'L');
  });

  it('transverse diameters in the 4C plane (RVD1, RVD2, shape)', () => {
    const at = (f: number) => chamber.stations.find((s) => Math.abs(s.frac - f) < 1e-6)!;
    // basal third inside the LV: width 0 at fractions 0.08–0.20 and no crossing at 0.02
    expect(Number.isNaN(at(0.02).width)).toBe(true);
    for (const f of [0.08, 0.14, 0.2]) near(at(f).width, 0);
    near(at(0.26).width, 0.284);
    // TARGET Phase 3: RVD1 33 ± 4 mm (0.962 ± 0.117 unit)
    near(chamber.rvd1, 0.402);
    // TARGET Phase 3: RVD2 27 ± 4 mm (0.787 ± 0.117 unit) and RVD1 > RVD2
    near(chamber.rvd2, 0.675);
    near(chamber.midThirdMax, 0.807);
    // inverted shape: largest width in the apical third (TARGET Phase 3: largest width in the basal third)
    near(chamber.maxWidth, 0.927);
    near(chamber.maxWidthFrac, 0.86, 1e-6);
    expect(chamber.rvd1).toBeLessThan(chamber.rvd2);
    // TARGET Phase 3 (achieved): RVD1 33 ± 4 mm; RVD2 27 ± 4 mm; RVD1 > RVD2; largest width in the basal third
    inMm(chamberP.rvd1, 33, 4, 'RVD1');
    inMm(chamberP.rvd2, 27, 4, 'RVD2');
    expect(chamberP.rvd1).toBeGreaterThan(chamberP.rvd2);
    expect(chamberP.maxWidthFrac).toBeLessThanOrEqual(1 / 3);
  });

  it('free wall thickness', () => {
    // single surface: only one crossing outside the LV at the mid station
    // TARGET Phase 3: 3 ± 1 mm (0.087 ± 0.029 unit)
    near(chamber.freeWallThickness, 0);
    // TARGET Phase 3 (achieved; phase criterion: 3 ± 0.5 mm)
    inMm(chamberP.freeWallThickness, 3, 0.5, 'espessura');
  });

  it('RV outflow tract (RVOT)', () => {
    const m = measureRvot(rv, mesh(scene, 'organui_pulmonary_trunk'), mesh(scene, 'pulmonary_valve'));
    near(m.rvTopY, 0.528);
    near(m.trunkMinY, 0.681);
    // TARGET Phase 5: gap 0 (RVOT continuous up to the trunk) and measurable proximal RVOT 28 ± 3.5 mm (0.816 ± 0.102 unit)
    near(m.verticalGap, 0.153);
    expect(m.proximalMeasurable).toBe(false);
    // TARGET Phase 5: distal RVOT 22 ± 2.5 mm (0.641 ± 0.073 unit), consistent with the pulmonary disc
    near(m.pulmonaryDiscDiameter, 0.42);
    near(m.discToRvDistance, 0.327);
  });

  it('interpenetration: RV vertices inside the LV and per AHA wedge', () => {
    const pts = worldPositions(rv);
    const c = countLvRegions(pts);
    // TARGET Phase 3: 0 RV vertices inside the LV
    expect(c.cavity + c.wall).toBe(222);
    expect(c.cavity).toBe(153);
    expect(c.wall).toBe(69);
    expect(c.total).toBe(475);
    // TARGET Phase 3: {} (no wedge invaded; in particular 2, 3, 8, 9 and 14)
    expect(countInsideLvByAhaWedge(pts)).toEqual({ 2: 43, 3: 75, 4: 8, 7: 9, 8: 34, 9: 1, 10: 4, 11: 9, 12: 4, 14: 28, 15: 7 });
    // TARGET Phase 3 (achieved): 0 RV vertices in the LV and no wedge invaded
    const ptsP = worldPositions(rvP);
    const cP = countLvRegions(ptsP);
    expect(cP.cavity + cP.wall).toBe(0);
    expect(countInsideLvByAhaWedge(ptsP)).toEqual({});
  });

  it('tricuspid apparatus: inside the LV in the raw GLB; outside the LV after the T_TV pose (Phase 2)', async () => {
    const names = [
      'tricuspid_annulus',
      'tricuspid_anterior_leaflet',
      'tricuspid_posterior_leaflet',
      'tricuspid_septal_leaflet',
      'tricuspid_anterior_papillary_muscle',
      'tricuspid_posterior_papillary_muscle',
      'tricuspid_septal_papillary_muscle',
    ];
    // Raw GLB (no pose): diagnostic snapshot, Section 2.4 — [cavity, wall, outside]
    const raw: Record<string, [number, number, number]> = {
      tricuspid_annulus: [615, 345, 0],
      tricuspid_anterior_leaflet: [529, 335, 0],
      tricuspid_posterior_leaflet: [272, 592, 0],
      tricuspid_septal_leaflet: [864, 0, 0],
      tricuspid_anterior_papillary_muscle: [0, 1355, 0],
      tricuspid_posterior_papillary_muscle: [983, 0, 0],
      tricuspid_septal_papillary_muscle: [594, 0, 0],
    };
    for (const name of names) {
      const c = countLvRegions(worldPositions(mesh(scene, name)));
      expect([c.cavity, c.wall, c.outside], name).toEqual(raw[name]);
    }
    const chordaeOf = (s: THREE.Object3D) => {
      const out: THREE.Mesh[] = [];
      s.traverse((o: any) => {
        if (o.isMesh && o.name.startsWith('tricuspid_') && o.name.includes('_chorda_')) out.push(o);
      });
      return out;
    };
    const rawChordae = chordaeOf(scene);
    // 18 tricuspid chordae (6 per papillary muscle), 18/18 inside the LV in the raw GLB
    expect(rawChordae.length).toBe(18);
    expect(rawChordae.filter((m) => countLvRegions(worldPositions(m)).outside === 0).length).toBe(18);
    const ac = new THREE.Box3().setFromObject(annulus).getCenter(new THREE.Vector3());
    near(Math.hypot(ac.x, ac.z), 0.591);
    near(lvEnvelopeRadius(ac.y, false), 0.762);

    // TARGET Phase 2 (achieved): with T_TV applied on load, [0, 0, total] and 0/18 chordae inside the LV
    const posed = await loadGlbScene();
    applyTricuspidApparatusPose(posed);
    for (const name of names) {
      const c = countLvRegions(worldPositions(mesh(posed, name)));
      expect([c.cavity, c.wall, c.outside], name).toEqual([0, 0, raw[name][0] + raw[name][1] + raw[name][2]]);
    }
    const posedChordae = chordaeOf(posed);
    expect(posedChordae.length).toBe(18);
    expect(posedChordae.filter((m) => countLvRegions(worldPositions(m)).cavity + countLvRegions(worldPositions(m)).wall > 0).length).toBe(0);
    // annulus center outside the LV epicardium at its height
    const pc = new THREE.Box3().setFromObject(mesh(posed, 'tricuspid_annulus')).getCenter(new THREE.Vector3());
    expect(Math.hypot(pc.x, pc.z)).toBeGreaterThan(lvEnvelopeRadius(pc.y, true));
  });

  it('TAPSE: static tricuspid annulus; excursion of the annulus point in the RV rig at EF 60%', () => {
    const before = meshCentroid(annulus);
    const rig = setupRvContraction(rv, annulus, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    expect(rig).not.toBeNull();
    if (!rig) return;
    const W = RV_COMPONENT_WEIGHTS;
    const lam = solveRvLambda(0.4, W.longitudinal, W.radial, W.anteroposterior);
    setRvDeformation(rig, W.longitudinal * lam, W.radial * lam, W.anteroposterior * lam);
    rv.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    // GLB mesh (affine path of the reversion flag); the TAPSE of the procedural wall is in rvContraction.test.ts (Phase 4, D2)
    near(meshCentroid(annulus).distanceTo(before), 0, 1e-9);
    // longitudinal excursion of the annulus point in the rig = k_L · L
    const moved = rig.annulus.clone().applyMatrix4(rig.deform);
    const excursion = rig.annulus.clone().sub(moved).dot(rig.axisL);
    near(excursion, 0.447);
    near(W.longitudinal * lam, 0.265);
    setRvDeformation(rig, 0, 0, 0);
  });
});
