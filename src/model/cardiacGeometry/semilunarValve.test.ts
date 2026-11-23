import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  setupSemilunarValves,
  applySemilunarDeformation,
  measureSemilunarValve,
  testSemilunarReversibility,
  removeSemilunarValves,
  SEMILUNAR_GROUP_NAME,
  CUSP_SEGMENTS_S,
  CUSP_SEGMENTS_T,
} from './semilunarValve';

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

/** Translation stored in the `matrix` field (column-major, indices 12–14) of a GLB node, read directly from the JSON. */
async function glbMatrixTranslation(nodeName: string): Promise<THREE.Vector3> {
  const fsName = 'f' + 's';
  const pathName = 'p' + 'a' + 't' + 'h';
  const fsMod: any = await import(/* @vite-ignore */ fsName);
  const pathMod: any = await import(/* @vite-ignore */ pathName);
  const buf = fsMod.readFileSync(pathMod.resolve('public/models/realistic_heart.glb'));
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const node = json.nodes.find((n: any) => n.name === nodeName);
  expect(node?.matrix?.length).toBe(16);
  return new THREE.Vector3(node.matrix[12], node.matrix[13], node.matrix[14]);
}

function colorDistance(a: THREE.Color, b: THREE.Color): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function countGroups(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((c) => {
    if (c.name === SEMILUNAR_GROUP_NAME) n++;
  });
  return n;
}

describe('Procedural semilunar valves (aortic and pulmonary)', () => {
  it('anchors each valve at the base center stored in the GLB matrix, with root axis and radius estimated', async () => {
    const scene = await loadGlbScene();
    const data = setupSemilunarValves(scene, { buildCusps: false });
    expect(data).not.toBeNull();
    if (!data) return;
    const ao = data.frames.aortic!;
    const pu = data.frames.pulmonary!;
    expect(ao).toBeDefined();
    expect(pu).toBeDefined();

    // Anchor = matrix translation of the aortic_valve and pulmonary_valve nodes, read directly from the GLB JSON
    const aoGlb = await glbMatrixTranslation('aortic_valve');
    const puGlb = await glbMatrixTranslation('pulmonary_valve');
    expect(ao.anchorSource).toBe('glb-matrix');
    expect(pu.anchorSource).toBe('glb-matrix');
    expect(ao.center.distanceTo(aoGlb)).toBeLessThan(1e-5);
    expect(pu.center.distanceTo(puGlb)).toBeLessThan(1e-5);

    // Separate roots; ascending axes; positive radius
    expect(ao.center.distanceTo(pu.center)).toBeGreaterThan(ao.radius + pu.radius);
    expect(ao.axis.y).toBeGreaterThan(0.7);
    expect(pu.axis.y).toBeGreaterThan(0.7);
    expect(ao.radius).toBeGreaterThan(0);
    expect(pu.radius).toBeGreaterThan(0);

    // Legacy discs: at the anchor center, normal along the axis, still visible without cusps
    expect(data.alignedDiscs.length).toBe(2);
    const zAxis = new THREE.Vector3(0, 0, 1);
    for (const d of data.alignedDiscs) {
      const f = d.valveType === 'aortic' ? ao : pu;
      expect(d.mesh.position.distanceTo(f.center)).toBeLessThan(1e-6);
      const normal = zAxis.clone().applyQuaternion(d.mesh.quaternion);
      expect(Math.abs(normal.dot(f.axis))).toBeGreaterThan(0.999);
      expect(d.mesh.visible).toBe(true);
    }

    // Remount (StrictMode) does not shift the anchor, even with the disc already reoriented
    const again = setupSemilunarValves(scene, { buildCusps: false })!;
    expect(again.frames.aortic!.center.distanceTo(aoGlb)).toBeLessThan(1e-5);
    expect(again.frames.pulmonary!.center.distanceTo(puGlb)).toBeLessThan(1e-5);
  });

  it('semitransparent sinuses without depth write; cusps with a tone distinct from the white of the annuli', async () => {
    const scene = await loadGlbScene();
    const data = setupSemilunarValves(scene)!;
    for (const type of ['aortic', 'pulmonary'] as const) {
      const sinusMat = data.valves[type]!.sinus!.material as THREE.MeshStandardMaterial;
      expect(sinusMat.transparent).toBe(true);
      expect(sinusMat.opacity).toBeLessThanOrEqual(0.4);
      expect(sinusMat.depthWrite).toBe(false);
    }

    const cuspColor = (data.valves.pulmonary!.cusps[0].mesh.material as THREE.MeshStandardMaterial).color;
    expect(colorDistance(cuspColor, (data.valves.aortic!.cusps[0].mesh.material as THREE.MeshStandardMaterial).color)).toBe(0);
    const reference = ['mitral_annulus', 'tricuspid_annulus', 'mitral_anterior_leaflet', 'tricuspid_septal_leaflet', 'mitral_anterolateral_chorda_1', 'pulmonary_valve', 'aortic_valve'];
    for (const name of reference) {
      const mesh = scene.getObjectByName(name) as THREE.Mesh;
      expect(mesh).toBeDefined();
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      expect(colorDistance(cuspColor, mat.color)).toBeGreaterThan(0.15);
    }
  });

  it('step B: builds 3 named cusps per valve, sinuses, and hides the legacy discs', async () => {
    const scene = await loadGlbScene();
    const data = setupSemilunarValves(scene);
    expect(data).not.toBeNull();
    if (!data) return;

    const ao = data.valves.aortic!;
    const pu = data.valves.pulmonary!;
    expect(ao.cusps.map((c) => c.name).sort()).toEqual(
      ['aortic_cusp_left_coronary', 'aortic_cusp_noncoronary', 'aortic_cusp_right_coronary'],
    );
    expect(pu.cusps.map((c) => c.name).sort()).toEqual(
      ['pulmonary_cusp_anterior', 'pulmonary_cusp_left', 'pulmonary_cusp_right'],
    );
    expect(ao.sinus).not.toBeNull();
    expect(pu.sinus).not.toBeNull();

    const verts = (CUSP_SEGMENTS_S + 1) * (CUSP_SEGMENTS_T + 1);
    for (const c of [...ao.cusps, ...pu.cusps]) {
      expect(c.mesh.geometry.attributes.position.count).toBe(verts);
      expect(c.mesh.userData.isProceduralValvar).toBe(true);
      expect(c.mesh.userData.isValve).toBe(true);
    }
    for (const d of data.alignedDiscs) expect(d.mesh.visible).toBe(false);
  });

  it('closes with coaptation of the free edges (ζ = 0) and opens the orifice monotonically up to ζ = 1', async () => {
    const scene = await loadGlbScene();
    const data = setupSemilunarValves(scene)!;
    for (const type of ['aortic', 'pulmonary'] as const) {
      const valve = data.valves[type]!;
      const R = valve.frame.radius;
      const fractions: number[] = [];
      for (const z of [0, 0.25, 0.5, 0.75, 1]) {
        applySemilunarDeformation(data, type === 'aortic' ? z : 0, type === 'pulmonary' ? z : 0);
        const m = measureSemilunarValve(valve)!;
        fractions.push(m.orificeFraction);
        // Cusps always inside the root (sinus wall)
        expect(m.maxRadialRatio).toBeLessThanOrEqual(1.0001);
        if (z === 0) expect(m.minCoaptationGap).toBeLessThan(0.05 * R);
      }
      expect(fractions[0]).toBeLessThan(0.05);
      expect(fractions[4]).toBeGreaterThan(0.75);
      for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
    }
  });

  it('places the ostia in the right and left coronary sinuses, linked to the corresponding coronary arteries', async () => {
    const scene = await loadGlbScene();
    const data = setupSemilunarValves(scene)!;
    const ao = data.valves.aortic!;
    const right = ao.ostia.find((o) => o.name === 'right_coronary_ostium')!;
    const left = ao.ostia.find((o) => o.name === 'left_coronary_ostium')!;
    expect(right).toBeDefined();
    expect(left).toBeDefined();

    const R = ao.frame.radius;
    const midAngle = (name: string) => {
      const k = ao.cusps.findIndex((c) => c.name === name);
      return ao.theta0 + k * (2 * Math.PI / 3) + Math.PI / 3;
    };
    const angleOf = (p: THREE.Vector3) => {
      const d = p.clone().sub(ao.frame.center);
      return Math.atan2(d.dot(ao.v), d.dot(ao.u));
    };
    const angDist = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    // Each ostium sits at the middle of the sinus of the homonymous cusp
    expect(angDist(angleOf(right.position), midAngle('aortic_cusp_right_coronary'))).toBeLessThan(1e-6);
    expect(angDist(angleOf(left.position), midAngle('aortic_cusp_left_coronary'))).toBeLessThan(1e-6);
    // Above the nadir and below the sinotubular junction
    const h = (p: THREE.Vector3) => p.clone().sub(ao.frame.center).dot(ao.frame.axis);
    expect(h(right.position)).toBeGreaterThan(0.3 * R);
    expect(h(right.position)).toBeLessThan(ao.spec.sinusHeight * R);

    // Proximal segments: RCA from the right ostium; left main, LAD and LCx from the left one
    const names = data.connectors.map((c) => c.mesh.name).sort();
    expect(names).toEqual(['coronary_lad_proximal', 'coronary_lcx_proximal', 'coronary_left_main', 'coronary_rca_proximal']);
    const rcaTube = scene.getObjectByName('coronary_rca_artery') as THREE.Mesh;
    const ladTube = scene.getObjectByName('coronary_lad_artery') as THREE.Mesh;
    const nearest = (mesh: THREE.Mesh, p: THREE.Vector3) => {
      const pos = mesh.geometry.attributes.position;
      const v = new THREE.Vector3();
      let best = Infinity;
      for (let i = 0; i < pos.count; i++) best = Math.min(best, v.fromBufferAttribute(pos, i).distanceTo(p));
      return best;
    };
    expect(nearest(rcaTube, right.position)).toBeLessThan(nearest(rcaTube, left.position));
    expect(nearest(ladTube, left.position)).toBeLessThan(nearest(ladTube, right.position));
  });

  it('is reversible (zero drift after 1,000 cycles) and idempotent on remount (StrictMode)', async () => {
    const scene = await loadGlbScene();
    const data = setupSemilunarValves(scene)!;
    expect(testSemilunarReversibility(data, 1000)).toBe(0);

    setupSemilunarValves(scene);
    expect(countGroups(scene)).toBe(1);
    removeSemilunarValves(scene);
    expect(countGroups(scene)).toBe(0);
  });
});
