import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  setupValvarKinematics,
  applyValvarDeformation,
  measureValvarChordae,
  measureValvarCoaptation,
  measureValvarCoaptationLegacy,
  testValvarReversibility,
  VALVAR_OPEN_SCALE,
  GLTF_SCALE_MM_PER_UNIT,
  TRICUSPID_TENTING_TRANSFORM,
  setTricuspidTentingTransformEnabled
} from './valvarKinematics';

describe('Valvar Kinematics Integration in HeartMesh17 Component', () => {
  async function loadGlbScene(): Promise<THREE.Group> {
    const fsName = 'f' + 's';
    const pathName = 'p' + 'a' + 't' + 'h';
    const fsMod: any = await import(/* @vite-ignore */ fsName);
    const pathMod: any = await import(/* @vite-ignore */ pathName);
    const glbPath = pathMod.resolve('public/models/realistic_heart.glb');
    const buffer = fsMod.readFileSync(glbPath);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const loader = new GLTFLoader();
    return new Promise((resolve, reject) => {
      loader.parse(arrayBuffer, '', (gltf) => resolve(gltf.scene), reject);
    });
  }

  it('initializes setupValvarKinematics with 5 leaflets, 30 chordae, 2 annuli and 5 papillary muscles', async () => {
    const scene = await loadGlbScene();
    const valvarData = setupValvarKinematics(scene);

    expect(valvarData).not.toBeNull();
    if (!valvarData) return;

    expect(valvarData.leaflets.length).toBe(5);
    expect(valvarData.chordae.length).toBe(30);
    expect(valvarData.annuli.length).toBe(2);
    expect(valvarData.papillaries.length).toBe(5);

    // Leaflets must have isStatic: false and isProceduralValvar: true
    valvarData.leaflets.forEach(l => {
      expect(l.mesh.userData.isProceduralValvar).toBe(true);
      expect(l.mesh.userData.isStatic).toBe(false);
      expect(l.mesh.userData.restPositions).toBeDefined();
    });

    // Chordae must have isStatic: false and isProceduralValvar: true
    valvarData.chordae.forEach(c => {
      expect(c.chordaMesh.userData.isProceduralValvar).toBe(true);
      expect(c.chordaMesh.userData.isStatic).toBe(false);
      expect(c.chordaMesh.userData.restPositions).toBeDefined();
    });

    // Annuli and papillary muscles must remain static
    valvarData.annuli.forEach(a => {
      expect(a.userData.isStatic).toBe(true);
    });
    valvarData.papillaries.forEach(p => {
      expect(p.userData.isStatic).toBe(true);
    });
  });

  it('keeps locked-to-surface continuity (Delta G = 0.000 mm) in all 5 opening states', async () => {
    const scene = await loadGlbScene();
    const valvarData = setupValvarKinematics(scene);
    expect(valvarData).not.toBeNull();
    if (!valvarData) return;

    for (const z of [0.0, 0.25, 0.50, 0.75, 1.00]) {
      applyValvarDeformation(valvarData, z, z);
      const measurements = measureValvarChordae(valvarData);

      expect(measurements.length).toBe(30);
      measurements.forEach(m => {
        expect(m.gapDeltaTipMm).toBeLessThan(0.00001); // strictly 0.000 mm (< 10 nm)
        expect(m.baseShiftMm).toBeLessThan(0.00001);   // bases 100% static (< 10 nm)
        expect(m.constraintErrorMm).toBeLessThan(0.00001); // no residual error (< 10 nm)
      });
    }
  });

  it('normalizes the four short tricuspid chordae to elongation <= 15.13% at maximum opening', async () => {
    const scene = await loadGlbScene();
    const valvarData = setupValvarKinematics(scene);
    expect(valvarData).not.toBeNull();
    if (!valvarData) return;

    applyValvarDeformation(valvarData, 1.0, 1.0);
    const measurements = measureValvarChordae(valvarData);

    const targetNames = [
      'tricuspid_posterior_chorda_3',
      'tricuspid_anterior_chorda_3',
      'tricuspid_posterior_chorda_6',
      'tricuspid_anterior_chorda_6'
    ];

    const targetChordae = measurements.filter(m => targetNames.includes(m.chordaName));
    expect(targetChordae.length).toBe(4);

    targetChordae.forEach(m => {
      expect(m.pctDelta).toBeLessThanOrEqual(15.15); // max 15.13%
      expect(m.gapDeltaTipMm).toBeLessThan(0.000001);
    });

    // Mitral chorda 4 shows no avulsion (shortens smoothly in diastole)
    const chorda4Mitral = measurements.find(m => m.chordaName === 'mitral_anterolateral_chorda_4');
    expect(chorda4Mitral).toBeDefined();
    if (chorda4Mitral) {
      expect(chorda4Mitral.pctDelta).toBeLessThan(0); // shortening ~ -4.36%
      expect(chorda4Mitral.gapDeltaTipMm).toBeLessThan(0.000001);
    }
  });

  it('guarantees exact numerical reversibility with zero drift after 1,000 cycles', async () => {
    const scene = await loadGlbScene();
    const valvarData = setupValvarKinematics(scene);
    expect(valvarData).not.toBeNull();
    if (!valvarData) return;

    const driftMm = testValvarReversibility(valvarData, 1000);
    expect(driftMm).toBeLessThan(1e-9); // zero drift
  });

  it('D17: z = 1 exactly repeats the opening formula; z = 0 closes the orifice without crossing the same leaflet', async () => {
    const scene = await loadGlbScene();
    const valvarData = setupValvarKinematics(scene);
    expect(valvarData).not.toBeNull();
    if (!valvarData) return;

    expect(valvarData.leaflets.every((l) => l.closeField instanceof Float32Array)).toBe(true);

    applyValvarDeformation(valvarData, 1.0, 1.0);
    for (const l of valvarData.leaflets) {
      const rest = l.mesh.userData.restPositions as Float32Array;
      const cur = l.mesh.geometry.attributes.position.array as Float32Array;
      for (let i = 0; i < cur.length / 3; i++) {
        const ny = Math.max(0, Math.min(1, (l.maxY - rest[3 * i + 1]) / l.height));
        const d = l.openD * ny * ny;
        expect(Math.abs(cur[3 * i] - (rest[3 * i] + l.openDir.x * d))).toBeLessThan(1e-5);
        expect(Math.abs(cur[3 * i + 1] - (rest[3 * i + 1] + l.openDir.y * d))).toBeLessThan(1e-5);
      }
    }
    const open = measureValvarCoaptation(valvarData);
    expect(open.tricuspidOrificeMm2).toBeGreaterThan(100);
    expect(open.mitralOrificeMm2).toBeGreaterThan(100);

    applyValvarDeformation(valvarData, 0.0, 0.0);
    const closed = measureValvarCoaptation(valvarData);
    expect(closed.tricuspidOrificeMm2).toBeLessThanOrEqual(1.0);
    expect(closed.mitralOrificeMm2).toBeLessThanOrEqual(1.0);
    // the hinge does not move on closing
    for (const l of valvarData.leaflets) {
      const field = l.closeField as Float32Array;
      for (let col = 0; col < 54; col++) expect(Math.hypot(field[col * 48], field[col * 48 + 1], field[col * 48 + 2])).toBeLessThan(1e-5);
    }
  });

  it('D17: the old metric (smallest gap) remains available and is more optimistic than the largest gap', async () => {
    const scene = await loadGlbScene();
    const valvarData = setupValvarKinematics(scene);
    expect(valvarData).not.toBeNull();
    if (!valvarData) return;
    applyValvarDeformation(valvarData, 0.0, 0.0);
    const novo = measureValvarCoaptation(valvarData);
    const antigo = measureValvarCoaptationLegacy(valvarData);
    expect(antigo.tricuspidGapMm).toBeLessThan(novo.tricuspidGapMm);
    expect(antigo.mitralGapMm).toBeLessThan(novo.mitralGapMm);
  });

  it('demonstrates systolic closure with free-edge coaptation and diastolic opening', async () => {
    const scene = await loadGlbScene();
    const valvarData = setupValvarKinematics(scene);
    expect(valvarData).not.toBeNull();
    if (!valvarData) return;

    // Systolic state (z = 0.00): free-edge coaptation
    applyValvarDeformation(valvarData, 0.0, 0.0);
    const coaptClosed = measureValvarCoaptation(valvarData);
    expect(coaptClosed.mitralGapMm).toBeLessThan((2.0 / 55) * GLTF_SCALE_MM_PER_UNIT); // strict mitral coaptation
    expect(coaptClosed.tricuspidGapMm).toBeLessThan((3.5 / 55) * GLTF_SCALE_MM_PER_UNIT); // strict tricuspid coaptation
    expect(coaptClosed.isMitralClosed).toBe(true);
    expect(coaptClosed.isTricuspidClosed).toBe(true);

    // Diastolic state (z = 1.00): maximum opening
    applyValvarDeformation(valvarData, 1.0, 1.0);
    const coaptOpen = measureValvarCoaptation(valvarData);
    expect(coaptOpen.mitralGapMm).toBeGreaterThan((5.5 / 55) * GLTF_SCALE_MM_PER_UNIT); // mitral opening
    expect(coaptOpen.tricuspidGapMm).toBeGreaterThan((6.0 / 55) * GLTF_SCALE_MM_PER_UNIT); // tricuspid opening
    expect(coaptOpen.isMitralClosed).toBe(false);
    expect(coaptOpen.isTricuspidClosed).toBe(false);
  });

  it('D18: load-time transform reduces the tricuspid tenting to the Topilsky 2012 range (3.5 ± 1.0 mm) and is reversible/idempotent', async () => {
    expect(TRICUSPID_TENTING_TRANSFORM.version).toBe(1);
    expect(TRICUSPID_TENTING_TRANSFORM.leafletRadialScale).toEqual({
      tricuspid_anterior_leaflet: 1.11,
      tricuspid_posterior_leaflet: 1.14,
      tricuspid_septal_leaflet: 1.25,
    });
    expect(TRICUSPID_TENTING_TRANSFORM.chordRestLengthMmByLeaflet).toEqual({
      tricuspid_anterior_leaflet: 13.0,
      tricuspid_posterior_leaflet: 12.0,
      tricuspid_septal_leaflet: 10.5,
    });

    const scene = await loadGlbScene();
    const vd = setupValvarKinematics(scene)!;
    applyValvarDeformation(vd, 0, 0);

    const tInfo = vd.coaptation.find((c) => !c.isMitral)!;
    expect(tInfo).toBeDefined();
    expect(tInfo.chordExcessMm.length).toBe(0);

    // Measures the tenting height at the apex (coaptation point dMin on the central column g=13 at r < 2.5 mm) for each tricuspid leaflet
    const S = GLTF_SCALE_MM_PER_UNIT;
    const measureApexTenting = (info: typeof tInfo) =>
      info.leaflets.map((l) => {
        const pos = l.mesh.geometry.attributes.position as THREE.BufferAttribute;
        let dMin = Infinity;
        const p = new THREE.Vector3();
        for (let r = 0; r < 16; r++) {
          p.fromBufferAttribute(pos, 13 * 16 + r).sub(info.center);
          const u = p.dot(info.e1) * S;
          const v = p.dot(info.e2) * S;
          const d = -p.dot(info.normal) * S;
          if (Math.hypot(u, v) < 2.5 && d < dMin) dMin = d;
        }
        return dMin;
      });

    const tentByLeaflet = measureApexTenting(tInfo);
    for (const hMm of tentByLeaflet) {
      expect(hMm).toBeGreaterThanOrEqual(2.5);
      expect(hMm).toBeLessThanOrEqual(4.5);
    }
    const meanTentMm = (tentByLeaflet[0] + tentByLeaflet[1] + tentByLeaflet[2]) / 3;
    expect(meanTentMm).toBeCloseTo(3.95, 1);

    // Reversibility via setTricuspidTentingTransformEnabled(false) and idempotence on re-enabling
    setTricuspidTentingTransformEnabled(false);
    try {
      const vdLegacy = setupValvarKinematics(scene)!;
      applyValvarDeformation(vdLegacy, 0, 0);
      const tInfoLeg = vdLegacy.coaptation.find((c) => !c.isMitral)!;
      const legTent = measureApexTenting(tInfoLeg);
      const meanLegMm = (legTent[0] + legTent[1] + legTent[2]) / 3;
      expect(meanLegMm).toBeCloseTo(9.28, 1);
    } finally {
      setTricuspidTentingTransformEnabled(true);
    }

    const vdReapplied = setupValvarKinematics(scene)!;
    applyValvarDeformation(vdReapplied, 0, 0);
    const coaptReapplied = measureValvarCoaptation(vdReapplied);
    expect(coaptReapplied.tricuspidOrificeMm2).toBeLessThanOrEqual(1.0);
    expect(coaptReapplied.isTricuspidClosed).toBe(true);
  });
});
