import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RV_COMPONENT_WEIGHTS as W, RV_RIG_GAINS as G, setupRvContraction, setRvDeformation, rvLambdaFromQ, rvAnnulusReferenceField } from './rvContraction';
import { applyRvProceduralGeometry } from './rvGeometry';
import { applyTricuspidApparatusPose } from './tricuspidApparatusPose';
import { setupValvarKinematics, applyValvarDeformation } from './valvarKinematics';
import { pointToMeshDistance, worldPositions } from './rvGeometryMetrics';
import { RA_ANCHORS, setupAtrialSkinning, applyAtrialSkinning, atrialContractionScale } from './atrialSkinning';

const S = 34.3;

async function loadScene(): Promise<THREE.Group> {
  const fs: any = await import('f' + 's');
  const pa: any = await import('pa' + 'th');
  const b = fs.readFileSync(pa.resolve('public/models/realistic_heart.glb'));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Promise((res, rej) => new GLTFLoader().parse(ab, '', (g) => res(g.scene), rej));
}

async function build() {
  const scene = await loadScene();
  scene.updateMatrixWorld(true);
  applyRvProceduralGeometry(scene);
  const vd = setupValvarKinematics(scene as any)!;
  applyTricuspidApparatusPose(scene);
  scene.updateMatrixWorld(true);
  const named = (n: string) => scene.getObjectByName(n) as THREE.Mesh;
  const rv = named('right_ventricle');
  const ann = named('tricuspid_annulus');
  const ra = named('right_atrium');
  const la = named('left_atrium');
  const svc = named('organui_superior_vena_cava');
  const rig = setupRvContraction(rv, ann, new THREE.Vector3(), new THREE.Vector3(0, 1, 0), vd as any)!;
  const refS = new THREE.Matrix4();
  const refD = rvAnnulusReferenceField(rig, refS);
  const anchors = [
    { mesh: svc, d0: RA_ANCHORS.svc0, d1: RA_ANCHORS.svc1, pinScale: true },
    { mesh: la, d0: RA_ANCHORS.la0, d1: RA_ANCHORS.la1, pinScale: false },
  ];
  const skin = setupAtrialSkinning(ra, ann, rig.axisL, anchors, refS, refD)!;
  const set = (lam: number, a: number) => {
    const kL = W.longitudinal * G.longitudinal * lam;
    setRvDeformation(rig, kL, W.radial * G.radial * lam, W.anteroposterior * G.anteroposterior * lam);
    applyValvarDeformation(vd as any, 0, 0);
    applyAtrialSkinning(skin, rig.wall!.shear, kL * rig.wall!.lengthD, a);
    scene.updateMatrixWorld(true);
  };
  return { scene, rig, skin, ann, ra, la, svc, set, refS, refD, anchors, vd };
}

/** Annulus points (half), grouped by 15° sector around the L axis; returns the minimum distance to the RA per sector. */
function sectorDistances(b: Awaited<ReturnType<typeof build>>, annRest: THREE.Vector3[]): number[] {
  const c = annRest.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / annRest.length);
  const L = b.rig.axisL;
  const e1 = new THREE.Vector3(b.rig.wall!.hx, b.rig.wall!.hy, b.rig.wall!.hz).normalize();
  e1.addScaledVector(L, -e1.dot(L)).normalize();
  const e2 = new THREE.Vector3().crossVectors(L, e1);
  const pts = worldPositions(b.ann);
  const m = new Array(24).fill(Infinity) as number[];
  for (let i = 0; i < pts.length; i += 2) {
    const d0 = annRest[i].clone().sub(c);
    const k = Math.min(23, Math.floor((((Math.atan2(d0.dot(e2), d0.dot(e1)) * 180) / Math.PI + 360) % 360) / 15));
    const d = pointToMeshDistance(pts[i], b.ra) * S;
    if (d < m[k]) m[k] = d;
  }
  return m;
}

function invertedTriangles(mesh: THREE.Mesh, rest: THREE.Vector3[]): number {
  const cur = worldPositions(mesh);
  const idx = mesh.geometry.getIndex()!;
  let inv = 0;
  for (let t = 0; t < idx.count; t += 3) {
    const [i, j, k] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
    const n0 = new THREE.Vector3().crossVectors(rest[j].clone().sub(rest[i]), rest[k].clone().sub(rest[i]));
    const n1 = new THREE.Vector3().crossVectors(cur[j].clone().sub(cur[i]), cur[k].clone().sub(cur[i]));
    if (n0.dot(n1) <= 0) inv++;
  }
  return inv;
}

describe('Phase 4d: right atrium skinning', () => {
  it('stays exactly at rest with no field and no atrial contraction', async () => {
    const b = await build();
    const orig = b.skin.restLocal;
    b.set(0, 1);
    const arr = b.ra.geometry.getAttribute('position').array as Float32Array;
    for (let i = 0; i < arr.length; i++) expect(Math.abs(arr[i] - orig[i])).toBeLessThan(1e-5);
  });

  it('follows the annulus along the contour that touches at rest, without flipping triangles and without detaching the SVC', async () => {
    const b = await build();
    b.set(0, 1);
    const annRest = worldPositions(b.ann);
    const rest = worldPositions(b.ra);
    const d0 = sectorDistances(b, annRest);
    const contact = d0.map((x, i) => (x <= 0.5 ? i : -1)).filter((i) => i >= 0);
    expect(contact.length).toBeGreaterThanOrEqual(3);
    const svcPts = worldPositions(b.svc);
    const yMin = Math.min(...svcPts.map((p) => p.y));
    const svcBase = svcPts.filter((p) => p.y < yMin + 0.1);
    const svc0 = svcBase.map((p) => pointToMeshDistance(p, b.ra) * S);
    for (const q of [0.7, 0.4]) {
      b.set(rvLambdaFromQ(b.rig, q), 1);
      const d = sectorDistances(b, annRest);
      for (const k of contact) expect(d[k]).toBeLessThanOrEqual(0.5);
      expect(invertedTriangles(b.ra, rest)).toBe(0);
      svcBase.forEach((p, i) => {
        if (svc0[i] <= 0.5) expect(pointToMeshDistance(p, b.ra) * S).toBeLessThanOrEqual(0.5);
      });
    }
    // Full atrial contraction: keeps contact (attenuated scale at the seams)
    b.set(0, 0.86);
    const dA = sectorDistances(b, annRest);
    for (const k of contact) expect(dA[k]).toBeLessThanOrEqual(0.5);
  });

  it('repeated setup (StrictMode) starts from the rest pose and reapplying the same state changes nothing', async () => {
    const b = await build();
    b.set(rvLambdaFromQ(b.rig, 0.4), 0.9);
    const s2 = setupAtrialSkinning(b.ra, b.ann, b.rig.axisL, b.anchors, b.refS, b.refD)!;
    expect(s2.mesh.geometry).toBe(b.skin.mesh.geometry);
    expect(s2.restLocal).toBe(b.skin.restLocal);
    for (let i = 0; i < s2.wA.length; i++) expect(s2.wA[i]).toBeCloseTo(b.skin.wA[i], 6);
    const lam = rvLambdaFromQ(b.rig, 0.4);
    b.set(lam, 0.9);
    const a = Array.from(b.ra.geometry.getAttribute('position').array as Float32Array);
    applyAtrialSkinning(b.skin, b.rig.wall!.shear, b.rig.kL * b.rig.wall!.lengthD, 0.9);
    expect(Array.from(b.ra.geometry.getAttribute('position').array as Float32Array)).toEqual(a);
  });

  describe('Phase 4e: RA follows eRA and LA follows eLA (D13)', () => {
    it('the scale of each atrium depends only on its own elastance, with eLA ≠ eRA', () => {
      const soAD = { eLA: 0, eRA: 1 };
      const soAE = { eLA: 1, eRA: 0 };
      const dissociado = { eLA: 0.25, eRA: 0.75 };
      expect(atrialContractionScale('ra', soAD)).toBeCloseTo(0.86, 12);
      expect(atrialContractionScale('la', soAD)).toBe(1);
      expect(atrialContractionScale('ra', soAE)).toBe(1);
      expect(atrialContractionScale('la', soAE)).toBeCloseTo(0.86, 12);
      expect(atrialContractionScale('ra', dissociado)).toBeCloseTo(1 - 0.14 * 0.75, 12);
      expect(atrialContractionScale('la', dissociado)).toBeCloseTo(1 - 0.14 * 0.25, 12);
      expect(atrialContractionScale('ra', null)).toBe(1);
      expect(atrialContractionScale('la', undefined)).toBe(1);
    });

    it('on RA vertices, only eRA contracts: eLA alone leaves the RA at rest', async () => {
      const b = await build();
      const positions = () => Array.from(b.ra.geometry.getAttribute('position').array as Float32Array);
      const skinWith = (hemo: { eLA: number; eRA: number }) => applyAtrialSkinning(b.skin, null, 0, atrialContractionScale('ra', hemo));
      skinWith({ eLA: 0, eRA: 0 });
      const repouso = positions();
      skinWith({ eLA: 1, eRA: 0 });
      expect(positions()).toEqual(repouso);
      skinWith({ eLA: 0, eRA: 1 });
      const contraido = positions();
      expect(contraido.some((v, i) => Math.abs(v - repouso[i]) > 1e-4)).toBe(true);
      // eLA does not change the pose when eRA is already set
      skinWith({ eLA: 1, eRA: 1 });
      expect(positions()).toEqual(contraido);
    });

    it('HeartMesh17 passes eRA to the RA and eLA to the LA, in the realistic model and in the wireframe', async () => {
      const fs: any = await import('f' + 's');
      const pa: any = await import('pa' + 'th');
      const src: string = fs.readFileSync(pa.resolve('src/view/cardiac3d/HeartMesh17.tsx'), 'utf8');
      expect(src).toContain('const aScale = atrialContractionScale(chamber, hemo);');
      expect(src).toMatch(/applyAtrialSkinning\(raSkin,[^;]*atrialContractionScale\('ra', hemo\)\);/);
      expect(src).toContain('const laScale = 1 - 0.16 * hemo.eLA;');
      expect(src).toContain('const raScale = 1 - 0.16 * hemo.eRA;');
      expect(src).toContain('raMeshRef.current.scale.set(raScale, raScale, raScale);');
      expect(src).toContain('laMeshRef.current.scale.set(laScale, laScale, laScale);');
    });
  });
});
