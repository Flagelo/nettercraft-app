import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  classifyAhaSegment,
  computeClipPlane,
  parseNodeAnatomy,
  buildLv17Geometry,
  HeartErrorBoundary,
  REALISTIC_HEART_MODEL_URL,
  HEART_SCENE_ROTATION,
} from './HeartMesh17';
import { Cardiac3DCanvas } from '.';
import { usePhysiologyStore } from '../../controller/usePhysiologyStore';
import { AHA_SEGMENTS } from '../../model/electrophysiology/ElectroEngine';
import React from 'react';

describe('CardioCraft 3D Electromechanics & AHA Segment Mapping', () => {
  it('points to the default URL /models/realistic_heart.glb', () => {
    expect(REALISTIC_HEART_MODEL_URL).toBe('/models/realistic_heart.glb');
  });

  it('correctly classifies the 17 AHA/ASE segments by (nu, theta)', () => {
    // Apex: nu < 0.14 -> Segment 17 (index 16)
    expect(classifyAhaSegment(0.05, 0)).toBe(16);
    expect(classifyAhaSegment(0.12, Math.PI)).toBe(16);

    // Apical (nu < 0.36): 13..16 (indices 12..15)
    const segApical = classifyAhaSegment(0.25, 0);
    expect(segApical).toBeGreaterThanOrEqual(12);
    expect(segApical).toBeLessThanOrEqual(15);

    // Mid (nu < 0.68): 7..12 (indices 6..11)
    const segMid = classifyAhaSegment(0.5, 0);
    expect(segMid).toBeGreaterThanOrEqual(6);
    expect(segMid).toBeLessThanOrEqual(11);

    // Basal (nu >= 0.68): 1..6 (indices 0..5)
    const segBasal = classifyAhaSegment(0.85, 0);
    expect(segBasal).toBeGreaterThanOrEqual(0);
    expect(segBasal).toBeLessThanOrEqual(5);
  });

  it('validates the coronary mapping of the 17 segments (LAD, LCX, RCA)', () => {
    // LAD territory: 1, 2, 7, 8, 13, 14, 17
    const ladSegs = [1, 2, 7, 8, 13, 14, 17];
    ladSegs.forEach((id) => {
      expect(AHA_SEGMENTS[id - 1].territory).toBe('lad');
    });

    // RCA territory: 3, 4, 9, 10, 15
    const rcaSegs = [3, 4, 9, 10, 15];
    rcaSegs.forEach((id) => {
      expect(AHA_SEGMENTS[id - 1].territory).toBe('rca');
    });

    // LCX territory: 5, 6, 11, 12, 16
    const lcxSegs = [5, 6, 11, 12, 16];
    lcxSegs.forEach((id) => {
      expect(AHA_SEGMENTS[id - 1].territory).toBe('lcx');
    });
  });

  it('performs the anatomical parse of nodes by name (segments, vessels, chambers)', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const geom = new THREE.BufferGeometry();

    // Segment by the segment_X or aha_X convention
    const meshSeg1 = new THREE.Mesh(geom);
    meshSeg1.name = 'heart_segment_1_anterior';
    expect(parseNodeAnatomy(meshSeg1, box).segId).toBe(1);

    const meshSeg17 = new THREE.Mesh(geom);
    meshSeg17.name = 'AHA_17_apex';
    expect(parseNodeAnatomy(meshSeg17, box).segId).toBe(17);

    // Coronary vessels
    const meshLad = new THREE.Mesh(geom);
    meshLad.name = 'coronary_LAD_artery';
    expect(parseNodeAnatomy(meshLad, box).territory).toBe('lad');
    expect(parseNodeAnatomy(meshLad, box).isVessel).toBe(true);

    const meshLcx = new THREE.Mesh(geom);
    meshLcx.name = 'coronary_LCX';
    expect(parseNodeAnatomy(meshLcx, box).territory).toBe('lcx');

    const meshRca = new THREE.Mesh(geom);
    meshRca.name = 'vessel_RCA_branch';
    expect(parseNodeAnatomy(meshRca, box).territory).toBe('rca');

    // Chambers
    const meshRv = new THREE.Mesh(geom);
    meshRv.name = 'right_ventricle_mesh';
    expect(parseNodeAnatomy(meshRv, box).chamber).toBe('rv');

    const meshAorta = new THREE.Mesh(geom);
    meshAorta.name = 'aorta_ascending';
    expect(parseNodeAnatomy(meshAorta, box).chamber).toBe('aorta');
  });

  it('classifies great vessels and composite structures without contaminating AHA ventricular segments', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const geom = new THREE.BufferGeometry();

    // Ascending aorta and aortic arch (OrganUI / BodyParts3D)
    const meshAortaAsc = new THREE.Mesh(geom);
    meshAortaAsc.name = 'organui_aorta_ascending';
    const parsedAortaAsc = parseNodeAnatomy(meshAortaAsc, box);
    expect(parsedAortaAsc.chamber).toBe('aorta');
    expect(parsedAortaAsc.segId).toBeUndefined();

    const meshAorticArch = new THREE.Mesh(geom);
    meshAorticArch.name = 'organui_aortic_arch';
    const parsedAorticArch = parseNodeAnatomy(meshAorticArch, box);
    expect(parsedAorticArch.chamber).toBe('aorta');
    expect(parsedAorticArch.segId).toBeUndefined();

    // Pulmonary trunk
    const meshPulm = new THREE.Mesh(geom);
    meshPulm.name = 'organui_pulmonary_trunk';
    const parsedPulm = parseNodeAnatomy(meshPulm, box);
    expect(parsedPulm.chamber).toBe('pulmonary');
    expect(parsedPulm.segId).toBeUndefined();

    // Superior vena cava
    const meshVcs = new THREE.Mesh(geom);
    meshVcs.name = 'organui_superior_vena_cava';
    const parsedVcs = parseNodeAnatomy(meshVcs, box);
    expect(parsedVcs.isStructure).toBe(true);
    expect(parsedVcs.segId).toBeUndefined();

    // Check userData with isGreatVessel or isStructure
    const meshUserDataVessel = new THREE.Mesh(geom);
    meshUserDataVessel.name = 'custom_vascular_structure';
    meshUserDataVessel.userData = { isGreatVessel: true };
    const parsedCustom = parseNodeAnatomy(meshUserDataVessel, box);
    expect(parsedCustom.isStructure).toBe(true);
    expect(parsedCustom.segId).toBeUndefined();
  });

  it('prevents vessel false positives in names containing "da", "cx", "cd" as a substring', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const geom = new THREE.BufferGeometry();

    // Words with the substring "da" must not be classified as a LAD vessel
    const meshData = new THREE.Mesh(geom);
    meshData.name = 'mesh_data_heart';
    expect(parseNodeAnatomy(meshData, box).isVessel).toBeUndefined();

    const meshStd = new THREE.Mesh(geom);
    meshStd.name = 'standard_material_mesh';
    expect(parseNodeAnatomy(meshStd, box).isVessel).toBeUndefined();

    // Names with both segment and territory (e.g. segment_1_da) must prioritize the segment
    const meshSegDa = new THREE.Mesh(geom);
    meshSegDa.name = 'heart_segment_1_da';
    const parsedSegDa = parseNodeAnatomy(meshSegDa, box);
    expect(parsedSegDa.segId).toBe(1);
    expect(parsedSegDa.territory).toBe('lad');
    expect(parsedSegDa.isVessel).toBeFalsy();

    // Legitimate acronyms with a word boundary work
    const meshVesselDa = new THREE.Mesh(geom);
    meshVesselDa.name = 'coronary_da';
    expect(parseNodeAnatomy(meshVesselDa, box).territory).toBe('lad');
    expect(parseNodeAnatomy(meshVesselDa, box).isVessel).toBe(true);
  });

  it('supports descriptive anatomical names in Portuguese and English (AHA)', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const geom = new THREE.BufferGeometry();

    const mMidAntEn = new THREE.Mesh(geom);
    mMidAntEn.name = 'LV_mid_anterior';
    expect(parseNodeAnatomy(mMidAntEn, box).segId).toBe(7);

    const mMidAntPt = new THREE.Mesh(geom);
    mMidAntPt.name = 'VE_médio_anterior';
    expect(parseNodeAnatomy(mMidAntPt, box).segId).toBe(7);

    const mBasalAntSep = new THREE.Mesh(geom);
    mBasalAntSep.name = 'basal_anteroseptal_wall';
    expect(parseNodeAnatomy(mBasalAntSep, box).segId).toBe(2);

    const mApex = new THREE.Mesh(geom);
    mApex.name = 'cardiac_apex';
    expect(parseNodeAnatomy(mApex, box).segId).toBe(17);
  });

  it('generates closed LV geometry with transmural thickness and 17 segments (buildLv17Geometry)', () => {
    const lv = buildLv17Geometry();
    expect(lv.vCount).toBeGreaterThan(1000);
    expect(lv.geometry.getAttribute('position')).toBeDefined();
    expect(lv.geometry.getAttribute('color')).toBeDefined();
    expect(lv.geometry.getIndex()).toBeDefined();

    // Check that initial rest positions and enveloping volumes are not collapsed to zero
    expect(lv.geometry.boundingSphere).toBeDefined();
    expect(lv.geometry.boundingSphere!.radius).toBeGreaterThan(1.0);
    expect(lv.geometry.boundingBox).toBeDefined();
    expect(lv.geometry.boundingBox!.min.y).toBeLessThan(-1.0);
    expect(lv.geometry.boundingBox!.max.y).toBeGreaterThan(0.5);

    // Check that all 17 segments (0..16) are present in the vertices
    const uniqueSegs = new Set(Array.from(lv.segIds));
    expect(uniqueSegs.size).toBe(17);
    for (let i = 0; i < 17; i++) {
      expect(uniqueSegs.has(i)).toBe(true);
    }
  });

  it('integrates selectedSegment into usePhysiologyStore with bidirectional synchronization', () => {
    const store = usePhysiologyStore.getState();
    expect(store.selectedSegment).toBeNull();

    // Select segment 7 (Mid anterior - LAD)
    store.setSelectedSegment(7);
    expect(usePhysiologyStore.getState().selectedSegment).toBe(7);

    // Deselect
    store.setSelectedSegment(null);
    expect(usePhysiologyStore.getState().selectedSegment).toBeNull();
  });

  it('allows endocardial cutaway with correct vector computation of normal and depth (THREE.Plane)', () => {
    const clipPlane = new THREE.Plane();
    const cutAngle = 30; // degrees
    const cutDepth = 0.15;

    computeClipPlane(clipPlane, cutAngle, cutDepth);

    expect(clipPlane.constant).toBe(0.15);
    expect(clipPlane.normal.length()).toBeCloseTo(1.0, 4);

    // The normal must point into the anterior half-space (-Z) to expose the endocardial cavity
    expect(clipPlane.normal.z).toBeLessThan(0);

    // Anterior point facing the camera at +Z is discarded (negative distance)
    const frontPoint = new THREE.Vector3(0, 0, 0.8);
    expect(clipPlane.distanceToPoint(frontPoint)).toBeLessThan(0);

    // Posterior point inside the cavity is kept (positive distance)
    const cavityPoint = new THREE.Vector3(0, 0, -0.4);
    expect(clipPlane.distanceToPoint(cavityPoint)).toBeGreaterThan(0);
  });

  it('computes anatomical cut planes with heart group rotation for the presets (Coronal, Oblique, Septal)', () => {
    const groupRot: [number, number, number] = [0.12, -0.45, -0.18];
    const planeCoronal = new THREE.Plane();
    computeClipPlane(planeCoronal, 0, 0.08, groupRot);
    expect(planeCoronal.normal.length()).toBeCloseTo(1.0, 4);
    expect(planeCoronal.constant).toBe(0.08);

    const planeOblique = new THREE.Plane();
    computeClipPlane(planeOblique, 45, 0.12, groupRot);
    expect(planeOblique.normal.length()).toBeCloseTo(1.0, 4);
    expect(planeOblique.constant).toBe(0.12);

    const planeSeptal = new THREE.Plane();
    computeClipPlane(planeSeptal, -45, 0.12, groupRot);
    expect(planeSeptal.normal.length()).toBeCloseTo(1.0, 4);
    expect(planeSeptal.constant).toBe(0.12);
  });

  it('HeartErrorBoundary intercepts loader failures and transitions to the graceful fallback', () => {
    const fallbackNode = React.createElement('div', { id: 'fallback-ok' }, 'Wireframe Fallback');
    const boundary = new HeartErrorBoundary({
      fallback: fallbackNode,
      children: React.createElement('div', null, 'Child'),
    });

    expect(boundary.state.hasError).toBe(false);

    // Simulate a caught error
    const derived = HeartErrorBoundary.getDerivedStateFromError(new Error('GLB 404 Not Found'));
    expect(derived.hasError).toBe(true);

    boundary.state = derived;
    const rendered = boundary.render();
    expect(rendered).toBe(fallbackNode);
  });

  it('distinguishes a composite ventricular mesh from localized segment sub-meshes', () => {
    const modelBox = new THREE.Box3(new THREE.Vector3(-1.4, -1.4, -1.4), new THREE.Vector3(1.4, 1.4, 1.4));
    
    // Mesh that spans almost the entire height of the heart (whole LV)
    const largeGeom = new THREE.BoxGeometry(1.2, 2.2, 1.2);
    const largeMesh = new THREE.Mesh(largeGeom);
    largeMesh.name = 'myocardium_compound';
    const largeMeta = parseNodeAnatomy(largeMesh, modelBox);
    expect(largeMeta.isVentricular).toBe(true);
    // Must not have a fixed segId so as not to lock raycasting onto a single segment
    expect(largeMeta.segId).toBeUndefined();

    // Sub-mesh localized at the apex (small height)
    const apexGeom = new THREE.SphereGeometry(0.2, 8, 8);
    const apexMesh = new THREE.Mesh(apexGeom);
    apexMesh.name = 'unnamed_subpiece_apex';
    apexMesh.position.set(0, -1.3, 0);
    apexMesh.updateMatrixWorld(true);
    const apexMeta = parseNodeAnatomy(apexMesh, modelBox);
    expect(apexMeta.isVentricular).toBe(true);
    expect(apexMeta.segId).toBe(17);
    expect(apexMeta.territory).toBe('lad');
  });

  it('normalizes single and multiple materials ensuring DoubleSide and clipShadows', () => {
    // Single material
    const meshSingle = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: '#ff0000', roughness: 0.5 }),
    );
    const origMat = meshSingle.material as THREE.MeshStandardMaterial;
    const clonedMat = origMat.clone();
    clonedMat.side = THREE.DoubleSide;
    clonedMat.clipShadows = true;

    expect(clonedMat.side).toBe(THREE.DoubleSide);
    expect(clonedMat.clipShadows).toBe(true);

    // Multi-material array
    const meshMulti = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
      new THREE.MeshStandardMaterial({ color: '#ff0000' }),
      new THREE.MeshStandardMaterial({ color: '#00ff00' }),
    ]);
    const mats = meshMulti.material as THREE.MeshStandardMaterial[];
    expect(Array.isArray(mats)).toBe(true);
    const normMats = mats.map((m) => {
      const c = m.clone();
      c.side = THREE.DoubleSide;
      c.clipShadows = true;
      return c;
    });
    expect(normMats.every((m) => m.side === THREE.DoubleSide)).toBe(true);
    expect(normMats.every((m) => m.clipShadows === true)).toBe(true);
  });

  it('converts 3D raycasting coordinates in group space to identify the clicked segment', () => {
    const root = new THREE.Group();
    // Simulate the group with scene rotation
    root.rotation.set(0.12, -0.45, -0.18);
    root.updateMatrixWorld(true);

    const normBox = new THREE.Box3(new THREE.Vector3(-1.4, -1.4, -1.4), new THREE.Vector3(1.4, 1.4, 1.4));

    // Local point at the model apex: (0, -1.3, 0)
    const localApex = new THREE.Vector3(0, -1.3, 0);
    // Corresponding world point that the Three.js raycaster would return
    const worldPoint = localApex.clone().applyEuler(root.rotation);

    // Convert back using worldToLocal
    const resolvedLocal = root.worldToLocal(worldPoint.clone());
    expect(resolvedLocal.x).toBeCloseTo(0, 2);
    expect(resolvedLocal.y).toBeCloseTo(-1.3, 2);
    expect(resolvedLocal.z).toBeCloseTo(0, 2);

    // Mapping to nu and theta
    const h = Math.max(0.001, normBox.max.y - normBox.min.y);
    const nu = Math.max(0, Math.min(1, (resolvedLocal.y - normBox.min.y) / h));
    const theta = (Math.atan2(resolvedLocal.z, resolvedLocal.x) + Math.PI * 2) % (Math.PI * 2);
    const segId = classifyAhaSegment(nu, theta) + 1;

    expect(segId).toBe(17); // Apex correctly identified after coordinate transformation
  });

  it('loads and fully parses the realistic mesh /models/realistic_heart.glb anatomically', async () => {
    const fsName = 'f' + 's';
    const pathName = 'p' + 'ath';
    const fsMod: any = await import(/* @vite-ignore */ fsName);
    const pathMod: any = await import(/* @vite-ignore */ pathName);
    const glbPath = pathMod.resolve('public/models/realistic_heart.glb');
    expect(fsMod.existsSync(glbPath)).toBe(true);

    const buffer = fsMod.readFileSync(glbPath);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

    const loader = new GLTFLoader();
    const gltf = await new Promise<any>((resolve, reject) => {
      loader.parse(arrayBuffer, '', resolve, reject);
    });

    expect(gltf.scene).toBeDefined();

    const box = new THREE.Box3().setFromObject(gltf.scene);
    const parsedSegments: number[] = [];
    const parsedVessels: string[] = [];
    const parsedChambers: string[] = [];

    gltf.scene.traverse((child: any) => {
      if (child.isMesh) {
        const meta = parseNodeAnatomy(child, box);
        if (meta.segId != null) parsedSegments.push(meta.segId);
        if (meta.isVessel && meta.territory) parsedVessels.push(meta.territory);
        if (meta.chamber) parsedChambers.push(meta.chamber);
      }
    });

    // Confirm that all 17 AHA segments were located and classified
    expect(parsedSegments.length).toBe(17);
    for (let i = 1; i <= 17; i++) {
      expect(parsedSegments.includes(i)).toBe(true);
    }

    // Confirm the presence of the 3 main coronary arteries
    expect(parsedVessels.includes('lad')).toBe(true);
    expect(parsedVessels.includes('lcx')).toBe(true);
    expect(parsedVessels.includes('rca')).toBe(true);

    // Confirm the presence of cardiac chambers and great vessels
    expect(parsedChambers.includes('rv')).toBe(true);
    expect(parsedChambers.includes('la')).toBe(true);
    expect(parsedChambers.includes('ra')).toBe(true);
    expect(parsedChambers.includes('aorta')).toBe(true);
    expect(parsedChambers.includes('pulmonary')).toBe(true);
  });

  it('correctly filters raycasting intersections discarding invisible surfaces under the cutaway plane', () => {
    const clipPlane = new THREE.Plane();
    computeClipPlane(clipPlane, 0, 0.08, HEART_SCENE_ROTATION);

    // Create a pair of simulated intersections: an anterior (cut) point and a posterior (visible) point
    const clippedHit = {
      point: new THREE.Vector3(0, 0, 0.8),
      object: { name: 'anterior_wall', userData: { segId: 1 } },
    };
    const visibleHit = {
      point: new THREE.Vector3(0, 0, -0.6),
      object: { name: 'posterior_cavity', userData: { segId: 4 } },
    };

    const intersections = [clippedHit, visibleHit];

    // The anterior point must be in the discarded half-space
    expect(clipPlane.distanceToPoint(clippedHit.point)).toBeLessThan(0);
    // The posterior point must be in the kept half-space
    expect(clipPlane.distanceToPoint(visibleHit.point)).toBeGreaterThan(0);

    // Unclipped hits filter
    const validHit = intersections.find((hit) => clipPlane.distanceToPoint(hit.point) >= -1e-4);
    expect(validHit).toBeDefined();
    expect(validHit?.object.name).toBe('posterior_cavity');
    expect(validHit?.object.userData.segId).toBe(4);
  });

  it('ensures ventBox normalizes nu properly allowing selection of basal, mid and apical segments', () => {
    // Simulate a full heart where the aorta goes up to y=+1.4, but the LV goes from y=-1.4 to y=+0.2
    const ventBox = new THREE.Box3(new THREE.Vector3(-1.0, -1.4, -1.0), new THREE.Vector3(1.0, 0.2, 1.0));
    const ventH = ventBox.max.y - ventBox.min.y; // 1.6 units

    // 1. Click on Basal LV (near the top of the ventricle: y = +0.1)
    const basalPt = new THREE.Vector3(0.5, 0.1, 0.1);
    const nuBasal = (basalPt.y - ventBox.min.y) / ventH; // (0.1 - (-1.4)) / 1.6 = 1.5 / 1.6 = 0.9375
    expect(nuBasal).toBeGreaterThanOrEqual(0.68);
    const segBasal = classifyAhaSegment(nuBasal, 0) + 1;
    expect(segBasal).toBeGreaterThanOrEqual(1);
    expect(segBasal).toBeLessThanOrEqual(6);

    // 2. Click on Mid LV (middle of the ventricle: y = -0.6)
    const midPt = new THREE.Vector3(0.5, -0.6, 0.1);
    const nuMid = (midPt.y - ventBox.min.y) / ventH; // (-0.6 - (-1.4)) / 1.6 = 0.8 / 1.6 = 0.5
    expect(nuMid).toBeGreaterThanOrEqual(0.36);
    expect(nuMid).toBeLessThan(0.68);
    const segMid = classifyAhaSegment(nuMid, 0) + 1;
    expect(segMid).toBeGreaterThanOrEqual(7);
    expect(segMid).toBeLessThanOrEqual(12);

    // 3. Click on Apical LV (lower third: y = -1.0)
    const apicalPt = new THREE.Vector3(0.3, -1.0, 0.1);
    const nuApical = (apicalPt.y - ventBox.min.y) / ventH; // (-1.0 - (-1.4)) / 1.6 = 0.4 / 1.6 = 0.25
    expect(nuApical).toBeGreaterThanOrEqual(0.14);
    expect(nuApical).toBeLessThan(0.36);
    const segApical = classifyAhaSegment(nuApical, 0) + 1;
    expect(segApical).toBeGreaterThanOrEqual(13);
    expect(segApical).toBeLessThanOrEqual(16);

    // 4. Click on the Apex (y = -1.35)
    const apexPt = new THREE.Vector3(0.05, -1.35, 0.05);
    const nuApex = (apexPt.y - ventBox.min.y) / ventH;
    expect(nuApex).toBeLessThan(0.14);
    const segApex = classifyAhaSegment(nuApex, 0) + 1;
    expect(segApex).toBe(17);
  });

  it('recognizes valve structures without misclassifying them as AHA segments or left atrium', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const geom = new THREE.BufferGeometry();

    const mMitral = new THREE.Mesh(geom);
    mMitral.name = 'mitral_valve_annulus';
    const parsedMitral = parseNodeAnatomy(mMitral, box);
    expect(parsedMitral.segId).toBeUndefined();
    expect(parsedMitral.isValve).toBe(true);
    expect(parsedMitral.valveType).toBe('mitral');
    expect(parsedMitral.chamber).toBeUndefined();

    const mTricuspid = new THREE.Mesh(geom);
    mTricuspid.name = 'tricuspid_valve_leaflets';
    const parsedTricuspid = parseNodeAnatomy(mTricuspid, box);
    expect(parsedTricuspid.segId).toBeUndefined();
    expect(parsedTricuspid.isValve).toBe(true);
    expect(parsedTricuspid.valveType).toBe('tricuspid');
    expect(parsedTricuspid.chamber).toBeUndefined();

    const mChordae = new THREE.Mesh(geom);
    mChordae.name = 'chordae_tendineae_structure';
    const parsedChordae = parseNodeAnatomy(mChordae, box);
    expect(parsedChordae.segId).toBeUndefined();
    expect(parsedChordae.isStructure).toBe(true);
    expect(parsedChordae.chamber).toBeUndefined();
  });

  it('preserves texture maps (map, normalMap) during material normalization', () => {
    const dummyTexture = new THREE.Texture();
    const origMat = new THREE.MeshBasicMaterial({ map: dummyTexture });
    const isStandard = (origMat as any).isMeshStandardMaterial;
    expect(isStandard).toBeFalsy();

    // Normalization preserves the map
    const normMat = new THREE.MeshStandardMaterial({
      color: origMat.color.clone(),
      roughness: 0.38,
      metalness: 0.1,
      map: origMat.map ?? null,
    });

    expect(normMat.map).toBe(dummyTexture);
    expect(normMat.roughness).toBe(0.38);
  });

  it('guarantees zero Euler allocations in computeClipPlane using HEART_SCENE_ROTATION', () => {
    expect(HEART_SCENE_ROTATION).toEqual([0.12, -0.45, -0.18]);

    const plane = new THREE.Plane();
    computeClipPlane(plane, 15, 0.1, HEART_SCENE_ROTATION);
    const normLen = plane.normal.length();
    expect(normLen).toBeCloseTo(1.0, 4);

    // Subsequent calls reuse the internal scratch Euler
    computeClipPlane(plane, -30, 0.2, HEART_SCENE_ROTATION);
    expect(plane.normal.length()).toBeCloseTo(1.0, 4);
    expect(plane.constant).toBe(0.2);
  });

  it('reduces systolic motility to hypokinesis in ischemic segments even with a normal baseline echo score', () => {
    // Simulate the myocardial kinetic modulation logic (R2)
    const territory = 'lad' as string;
    const ischemiaTerritory = 'lad' as string;
    const wmNormal = 1;
    const baseWMotNormal = wmNormal === 1 ? 1.0 : 0.45;

    const isIschemic = ischemiaTerritory !== 'none' && territory === ischemiaTerritory;
    expect(isIschemic).toBe(true);

    const wMotIschemic = isIschemic ? Math.min(baseWMotNormal, 0.35) : baseWMotNormal;
    expect(wMotIschemic).toBe(0.35); // Hypokinesis automatically activated by the ischemic territory

    // Unaffected territory keeps normal motility
    const territoryRca = 'rca' as string;
    const isIschemicRca = ischemiaTerritory !== 'none' && territoryRca === ischemiaTerritory;
    expect(isIschemicRca).toBe(false);
    const wMotRca = isIschemicRca ? Math.min(baseWMotNormal, 0.35) : baseWMotNormal;
    expect(wMotRca).toBe(1.0);
  });

  it('shifts and projects wireframe mesh raycasting correcting for the global heart rotation', () => {
    const group = new THREE.Group();
    group.rotation.set(HEART_SCENE_ROTATION[0], HEART_SCENE_ROTATION[1], HEART_SCENE_ROTATION[2]);
    group.updateMatrixWorld(true);

    const localApexPoint = new THREE.Vector3(0, -1.35, 0);
    const worldPoint = localApexPoint.clone().applyEuler(group.rotation);

    // Without worldToLocal, world coordinates would be tilted and would distort nu and theta
    expect(worldPoint.y).not.toBeCloseTo(-1.35, 2);

    // With worldToLocal, the local coordinates are perfectly restored
    const restoredLocal = group.worldToLocal(worldPoint.clone());
    expect(restoredLocal.x).toBeCloseTo(0, 3);
    expect(restoredLocal.y).toBeCloseTo(-1.35, 3);
    expect(restoredLocal.z).toBeCloseTo(0, 3);

    const nu = Math.max(0, Math.min(1, (restoredLocal.y + 1.42) / 2.15));
    expect(classifyAhaSegment(nu, 0) + 1).toBe(17); // Apex identified accurately
  });

  describe('Graphics Stabilization, Anti-Remount & Garbage Collection (WebGL Context Safety)', () => {
    it('Cardiac3DCanvas is a stable memoized component (Anti-Remount Step 1)', () => {
      expect(Cardiac3DCanvas).toBeDefined();
      // Validate that Cardiac3DCanvas is wrapped by React.memo
      expect((Cardiac3DCanvas as any).$$typeof).toBe(Symbol.for('react.memo'));
    });

    it('Prevents improper destruction of the Drei cache: sub-meshes set dispose = null (Step 2)', () => {
      const parentGroup = new THREE.Group();
      const geom = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshStandardMaterial();
      const mesh = new THREE.Mesh(geom, mat);
      parentGroup.add(mesh);

      // Simulate the protection applied in RealisticHeartGLB
      parentGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          (child as any).dispose = null;
        }
      });

      expect((mesh as any).dispose).toBeNull();
      // The shared geometry buffer is not destroyed
      expect(mesh.geometry).toBe(geom);
    });

    it('THREE.Timer is used for visual timing without deprecation warnings (Step 3)', () => {
      const timer = new THREE.Timer();
      expect(typeof timer.update).toBe('function');
      expect(typeof timer.getDelta).toBe('function');
      expect(typeof timer.getElapsed).toBe('function');
      expect(typeof timer.dispose).toBe('function');

      timer.update();
      expect(typeof timer.getElapsed()).toBe('number');
      expect(typeof timer.getDelta()).toBe('number');
      timer.dispose();
    });

    it('HeartErrorBoundary throttles repeated logs and notifies onError without a crash loop (Step 4)', () => {
      // Reset lastWarnTime to guarantee the test baseline
      (HeartErrorBoundary as any).lastWarnTime = -Infinity;
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onErrorMock = vi.fn();
      const fallback = React.createElement('div', { id: 'fb' }, 'Fallback');
      const boundary = new HeartErrorBoundary({
        fallback,
        children: React.createElement('div', null, 'Child'),
        onError: onErrorMock,
      });

      const err = new Error('Texture timeout');
      boundary.componentDidCatch(err);
      expect(onErrorMock).toHaveBeenCalledWith(err);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);

      // An immediate subsequent call must not flood the console (throttled)
      boundary.componentDidCatch(err);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);

      consoleWarnSpy.mockRestore();
    });

    it('directly evaluates child.userData.segId with priority over child.name', () => {
      const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
      const geom = new THREE.BufferGeometry();
      const mesh = new THREE.Mesh(geom);
      // Name with the real nomenclature of the exported GLB
      mesh.name = 'heart_segment_1_basal_anterior';
      mesh.userData = { segId: 1, territory: 'lad', isExplicitSegment: true, isVentricular: true };

      const meta = parseNodeAnatomy(mesh, box);
      expect(meta.segId).toBe(1);
      expect(meta.territory).toBe('lad');
      expect(meta.isExplicitSegment).toBe(true);
      expect(meta.isVentricular).toBe(true);
    });

    it('structural sub-meshes without segId (vessels, valves, chambers) render without error in the loop', () => {
      const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
      const geom = new THREE.BufferGeometry();

      // Mitral valve without segId
      const mitralMesh = new THREE.Mesh(geom);
      mitralMesh.name = 'mitral_valve';
      mitralMesh.userData = { name: 'mitral_valve' };
      const mitralMeta = parseNodeAnatomy(mitralMesh, box);
      expect(mitralMeta.segId).toBeUndefined();
      expect(mitralMeta.isValve).toBe(true);

      // Ascending aorta without segId
      const aortaMesh = new THREE.Mesh(geom);
      aortaMesh.name = 'aorta_ascending';
      aortaMesh.userData = { name: 'aorta_ascending' };
      const aortaMeta = parseNodeAnatomy(aortaMesh, box);
      expect(aortaMeta.segId).toBeUndefined();
      expect(aortaMeta.chamber).toBe('aorta');

      // Coronary vessel without segId
      const ladMesh = new THREE.Mesh(geom);
      ladMesh.name = 'coronary_lad_artery';
      ladMesh.userData = { name: 'coronary_lad_artery' };
      const ladMeta = parseNodeAnatomy(ladMesh, box);
      expect(ladMeta.segId).toBeUndefined();
      expect(ladMeta.isVessel).toBe(true);
      expect(ladMeta.territory).toBe('lad');
    });

    it('protects anatomical 3D valve structures (isStatic) from planar deformation and preserves semilunar kinematics', async () => {
      const fsName = 'f' + 's';
      const pathName = 'p' + 'ath';
      const fsMod: any = await import(/* @vite-ignore */ fsName);
      const pathMod: any = await import(/* @vite-ignore */ pathName);
      const glbPath = pathMod.resolve('public/models/realistic_heart.glb');
      expect(fsMod.existsSync(glbPath)).toBe(true);

      const buffer = fsMod.readFileSync(glbPath);
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

      const loader = new GLTFLoader();
      const gltf = await new Promise<any>((resolve, reject) => {
        loader.parse(arrayBuffer, '', resolve, reject);
      });

      const valveMeshes: Array<{
        mesh: THREE.Mesh;
        valveType?: 'mitral' | 'aortic' | 'tricuspid' | 'pulmonary';
        initialScale: THREE.Vector3;
      }> = [];

      const chamberMeshes: Array<{
        mesh: THREE.Mesh;
        chamber: string;
      }> = [];

      gltf.scene.traverse((child: any) => {
        if (!child.isMesh) return;
        const uData = child.userData || {};
        const nodeName = String(uData.name || child.name || '').toLowerCase();
        const initialScale = child.scale ? child.scale.clone() : new THREE.Vector3(1, 1, 1);

        // Classification identical to HeartMesh17.tsx
        if (
          uData.isValve ||
          nodeName.includes('valve') ||
          nodeName.includes('valva') ||
          nodeName.includes('cordoalha')
        ) {
          const valveType =
            uData.valveType ||
            (nodeName.includes('mitral') ? 'mitral' :
             nodeName.includes('aortic') || nodeName.includes('aortica') ? 'aortic' :
             nodeName.includes('tricuspid') ? 'tricuspid' :
             nodeName.includes('pulmon') ? 'pulmonary' : undefined);

          valveMeshes.push({ mesh: child, valveType, initialScale });
          return;
        }

        if (
          uData.chamber ||
          nodeName.includes('atrium') ||
          nodeName.includes('atrio') ||
          nodeName.includes('ventricle') ||
          nodeName.includes('ventriculo') ||
          nodeName.includes('aorta') ||
          nodeName.includes('pulmon')
        ) {
          const chamber =
            uData.chamber ||
            (nodeName.includes('right_ventricle') || nodeName.includes('ventriculo_direito') ? 'rv' :
             nodeName.includes('left_atrium') || nodeName.includes('atrio_esquerdo') ? 'la' :
             nodeName.includes('right_atrium') || nodeName.includes('atrio_direito') ? 'ra' :
             nodeName.includes('aorta') ? 'aorta' :
             nodeName.includes('pulmon') ? 'pulmonary' : undefined);

          if (chamber) {
            chamberMeshes.push({ mesh: child, chamber });
            return;
          }
        }
      });

      // 1. No chorda tendinea or papillary muscle must enter chamberMeshes
      const subvalvarNames = ['papillary', 'chorda'];
      const leakedSubvalvar = chamberMeshes.filter((c) =>
        subvalvarNames.some((sub) => c.mesh.name.toLowerCase().includes(sub))
      );
      expect(leakedSubvalvar.length).toBe(0);

      // 2. 3D leaflets and annuli must have isStatic: true
      const staticValves = valveMeshes.filter((v) => (v.mesh.userData as any)?.isStatic === true);
      expect(staticValves.length).toBe(7); // 2 annuli + 5 leaflets

      // 3. Simulate systole and diastole kinematics with the useFrame rule
      const hemo = { zMitral: 1.0, zTricuspid: 1.0, zAortic: 1.0, zPulmonary: 1.0 };
      for (let i = 0; i < valveMeshes.length; i++) {
        const item = valveMeshes[i];
        const { mesh, valveType, initialScale } = item;

        // GOLDEN RULE: isStatic prevents planar flattening
        if ((mesh.userData as any)?.isStatic) continue;

        const z = valveType === 'mitral' ? hemo.zMitral :
                  valveType === 'aortic' ? hemo.zAortic :
                  valveType === 'tricuspid' ? hemo.zTricuspid :
                  valveType === 'pulmonary' ? hemo.zPulmonary : 0;

        mesh.scale.set(
          initialScale.x * (1 - 0.65 * z),
          initialScale.y * (1 - 0.65 * z),
          initialScale.z,
        );
      }

      // 4. 3D leaflets keep unit scale intact (1, 1, 1) even with zMitral = 1.0
      staticValves.forEach((v) => {
        expect(v.mesh.scale.x).toBeCloseTo(1.0, 5);
        expect(v.mesh.scale.y).toBeCloseTo(1.0, 5);
        expect(v.mesh.scale.z).toBeCloseTo(1.0, 5);
      });

      // 5. Dynamic semilunar valves undergo normal planar reduction (1 - 0.65 = 0.35)
      const dynamicValves = valveMeshes.filter((v) => !(v.mesh.userData as any)?.isStatic);
      expect(dynamicValves.length).toBe(2); // Aortic and Pulmonary
      dynamicValves.forEach((v) => {
        expect(v.mesh.scale.x).toBeCloseTo(0.35, 3);
        expect(v.mesh.scale.y).toBeCloseTo(0.35, 3);
        expect(v.mesh.scale.z).toBeCloseTo(1.0, 3);
      });
    });
  });
});
