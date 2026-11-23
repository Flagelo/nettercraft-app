import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getLive, usePhysiologyStore } from '../../controller/usePhysiologyStore';
import type { CoronaryTerritory } from '../../model/contracts/types';
import { AHA_SEGMENTS } from '../../model/electrophysiology/ElectroEngine';
import { attachProceduralMyocardiumShader } from './myocardialShader';
import {
  setupValvarKinematics,
  applyValvarDeformation,
  measureValvarChordae,
  measureValvarCoaptation,
  testValvarReversibility,
  type ValvarKinematicsData,
} from '../../model/cardiacGeometry/valvarKinematics';
import {
  setupSemilunarValves,
  applySemilunarDeformation,
  removeSemilunarValves,
  disposeSemilunarGpuResources,
  measureSemilunarValve,
  testSemilunarReversibility,
} from '../../model/cardiacGeometry/semilunarValve';
import { buildValveModeState, applyValveMode } from '../../model/cardiacGeometry/valveMode';
import {
  setupRvContraction,
  applyRvContraction,
  LV_CONTRACTION_SCALE,
  rvSeptalLvContraction,
  setRvLvContraction,
  measureRvMeshVolume,
  measureLvCavityVolume,
  computeLvBaseY,
  applyRvChamberEmissive,
  createRvWireframeDriver,
  updateRvWireframe,
  rvAnnulusReferenceField,
  linkRvLvEnvelope,
  type RvContractionRig,
  type RvWireframeDriver,
} from '../../model/cardiacGeometry/rvContraction';
import {
  LV_FIELD_ENABLED,
  setupLvContractionField,
  setLvSegmentMotion,
  applyLvContraction,
  createLvDriverSystem,
  applyLvChordTies,
  applyLvAtrium,
  applyLvRaPost,
  lvFieldInfo,
  RA_SKIN_PARAMS_LV,
  type LvFieldRig,
} from '../../model/cardiacGeometry/lvContractionField';
import { getSimulationLoop } from '../../controller/SimulationLoop';
import { setupAtrialSkinning, applyAtrialSkinning, atrialContractionScale, RA_SKINNING_ENABLED, RA_ANCHORS, type AtrialSkinRig } from '../../model/cardiacGeometry/atrialSkinning';
import { applyTricuspidApparatusPose, tricuspidFallbackRingPose } from '../../model/cardiacGeometry/tricuspidApparatusPose';
import { applyRvProceduralGeometry } from '../../model/cardiacGeometry/rvGeometry';
import { applyLvWatertightGeometry } from '../../model/cardiacGeometry/lvWatertightGeometry';

// Procedural tricuspid annulus of the wireframe: same rigid T_TV pose as the GLB apparatus
// (data in src/model/cardiacGeometry/data/tricuspidApparatusPose.json; module constants, stable props)
const TRICUSPID_RING_BASE_POSITION: [number, number, number] = [-0.55, 0.68, 0.22];
const TRICUSPID_RING_POSE = tricuspidFallbackRingPose(TRICUSPID_RING_BASE_POSITION);

export type HeartColorMode = 'depolarization' | 'coronary' | 'motility';

export interface HeartElectromechanicalSceneProps {
  colorMode: HeartColorMode;
  cutaway: boolean;
  cutDepth?: number;
  cutAngle?: number;
  showDipoles: boolean;
  showVcgLoop: boolean;
  /** VALVE MODE: semitransparent walls and highlighted valves. Off by default. */
  valveMode?: boolean;
  selectedSegment?: number | null;
  onSelectSegment?: (segId: number | null) => void;
}

// Default URL of the realistic anatomical model (external GLB)
export const REALISTIC_HEART_MODEL_URL = '/models/realistic_heart.glb';
export const HEART_SCENE_ROTATION: [number, number, number] = [0.12, -0.45, -0.18];

// In-memory cache for the anatomical model (avoids re-fetch and re-parse on every remount)
let cachedHeartScene: THREE.Group | null = null;
let heartLoadingPromise: Promise<THREE.Group> | null = null;

export function loadRealisticHeart(): Promise<THREE.Group> {
  if (cachedHeartScene) {
    return Promise.resolve(cachedHeartScene);
  }
  if (heartLoadingPromise) {
    return heartLoadingPromise;
  }
  const loader = new GLTFLoader();
  heartLoadingPromise = new Promise<THREE.Group>((resolve, reject) => {
    loader.load(
      REALISTIC_HEART_MODEL_URL,
      (gltf) => {
        if (gltf?.scene) {
          cachedHeartScene = gltf.scene;
          resolve(gltf.scene);
        } else {
          reject(new Error('GLTF carregado mas sem cena válida'));
        }
      },
      undefined,
      (error) => {
        heartLoadingPromise = null;
        reject(error);
      }
    );
  });
  return heartLoadingPromise;
}

// ============================================================================
// R1: ErrorBoundary for External Loader (GLTF/GLB) with Anatomical Fallback
// ============================================================================

interface HeartErrorBoundaryProps {
  fallback: React.ReactNode;
  children: React.ReactNode;
  onError?: (error: unknown) => void;
}

interface HeartErrorBoundaryState {
  hasError: boolean;
  error?: unknown;
}

export class HeartErrorBoundary extends React.Component<HeartErrorBoundaryProps, HeartErrorBoundaryState> {
  private static lastWarnTime = -Infinity;

  constructor(props: HeartErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: unknown): HeartErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown) {
    const now = performance.now();
    // Prevents an infinite cascade of console logs during transient failures
    if (now - HeartErrorBoundary.lastWarnTime > 2500) {
      HeartErrorBoundary.lastWarnTime = now;
      console.warn(
        '[CardioCraft] Modelo realista /models/realistic_heart.glb não encontrado ou com erro. Renderizando wireframe anatômico de fallback estável.',
        error,
      );
    }
    this.props.onError?.(error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

// ============================================================================
// R2 & R3 & R4: Realistic GLTF Model with 17-AHA Mapping, Raycasting and Clipping
// ============================================================================

export interface RealisticHeartProps {
  scene?: THREE.Group | null;
  colorMode: HeartColorMode;
  cutaway: boolean;
  clipPlane: THREE.Plane;
  /** VALVE MODE (default: off). */
  valveMode?: boolean;
  selectedSegment: number | null;
  onSelectSegment: (segId: number | null) => void;
}

export function RealisticHeartGLB({
  scene,
  colorMode,
  cutaway,
  clipPlane,
  valveMode = false,
  selectedSegment,
  onSelectSegment,
}: RealisticHeartProps) {
  // Clone with scene.clone() before injecting into the scene to prevent conflicts in the global cache
  const sceneClone = useMemo(() => {
    if (!scene) return null;
    return scene.clone(true);
  }, [scene]);

  // Step 3: dedicated THREE.Timer for visual physics and animation (Three.js r182+ pattern)
  const visualTimer = useRef<THREE.Timer | null>(null);
  if (!visualTimer.current) {
    visualTimer.current = new THREE.Timer();
  }

  // R2: Traversal over the nodes of the loaded mesh to associate sub-meshes/materials
  const { segmentMeshes, vesselMeshes, chamberMeshes, valveMeshes, ventricularMeshes, allMaterials, normBox, ventBox, valvarData, semilunarData, valveModeState, rvRig, raSkin, lvBaseY, lvRig } = useMemo(() => {
    if (!sceneClone) {
      return {
        segmentMeshes: [],
        vesselMeshes: [],
        chamberMeshes: [],
        valveMeshes: [],
        ventricularMeshes: [],
        allMaterials: [],
        normBox: new THREE.Box3(),
        ventBox: new THREE.Box3(),
        valvarData: null,
        semilunarData: null,
        valveModeState: null,
        rvRig: null as RvContractionRig | null,
        raSkin: null as AtrialSkinRig | null,
        lvBaseY: 0,
        lvRig: null as LvFieldRig | null,
      };
    }

    // StrictMode idempotence: removes procedural semilunar valves from a previous run
    // before normalization and traversal (they must not enter the Box3 nor be reclassified)
    removeSemilunarValves(sceneClone);
    // Likewise for the T_TV pose of the tricuspid apparatus: back to the original GLB pose before
    // normalization (the Box3 and the RV rig use the original pose); reapplied below, after the rig
    applyTricuspidApparatusPose(sceneClone, false);
    // Likewise for the RV wall: back to the GLB spherical geometry before normalization (the Box3 and the
    // framing scale stay equal to the current ones); swapped below, right after normalization
    applyRvProceduralGeometry(sceneClone, false);
    // Likewise for the LV wedges: back to the GLB geometry (Box3, ventBox, LV axis and base stay as before)
    applyLvWatertightGeometry(sceneClone, false);

    // Spatial normalization of the mesh to fit the scene (~2.8 units)
    const box = new THREE.Box3().setFromObject(sceneClone);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const scaleFactor = maxDim > 0.001 ? 2.8 / maxDim : 1;
    sceneClone.position.set(-center.x * scaleFactor, -center.y * scaleFactor, -center.z * scaleFactor);
    sceneClone.scale.setScalar(scaleFactor);
    sceneClone.updateMatrixWorld(true);
    const normBox = new THREE.Box3().setFromObject(sceneClone);

    // RV Phase 3: in-memory swap of the `right_ventricle` node geometry for the procedural wall
    // (rvGeometryComponent.ts), built around the tricuspid apparatus ALREADY posed by T_TV. Same
    // node, same matrix and same material (cloned below, as before); the geometry is generated once and
    // reused (WeakMap). Revert: RV_PROCEDURAL_ENABLED = false.
    applyRvProceduralGeometry(sceneClone);

    const segmentMeshes: Array<{
      mesh: THREE.Mesh;
      segId: number;
      segIdx: number;
      territory: CoronaryTerritory;
      material: THREE.MeshStandardMaterial;
      initialScale: THREE.Vector3;
    }> = [];

    const vesselMeshes: Array<{
      mesh: THREE.Mesh;
      territory: CoronaryTerritory;
      material: THREE.MeshStandardMaterial;
    }> = [];

    const chamberMeshes: Array<{
      mesh: THREE.Mesh;
      chamber: 'rv' | 'la' | 'ra' | 'aorta' | 'pulmonary';
      material: THREE.MeshStandardMaterial;
      initialScale: THREE.Vector3;
    }> = [];

    const valveMeshes: Array<{
      mesh: THREE.Mesh;
      valveType?: 'mitral' | 'aortic' | 'tricuspid' | 'pulmonary';
      initialScale: THREE.Vector3;
    }> = [];

    const ventricularMeshes: Array<{
      mesh: THREE.Mesh;
      material: THREE.MeshStandardMaterial;
      initialScale: THREE.Vector3;
    }> = [];

    const allMaterials: THREE.MeshStandardMaterial[] = [];

    sceneClone.traverse((child: any) => {
      // Strict safety check: ensures the node is a 3D mesh before any operation
      if (!child || !child.isMesh) {
        return;
      }

      // Step 2: prevents the R3F reconciler from accidentally destroying the useGLTF geometry buffers
      child.dispose = null;

      // Robust material normalization, guarding against null or undefined materials
      const origMats = child.material
        ? (Array.isArray(child.material) ? child.material : [child.material])
        : [];
      const newMats: THREE.MeshStandardMaterial[] = [];

      if (origMats.length === 0) {
        const fallbackMat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.72, 0.22, 0.26),
          roughness: 0.38,
          metalness: 0.1,
          side: THREE.DoubleSide,
          clipShadows: true,
        });
        newMats.push(fallbackMat);
        allMaterials.push(fallbackMat);
      } else {
        for (let mIdx = 0; mIdx < origMats.length; mIdx++) {
          const orig = origMats[mIdx] as THREE.MeshStandardMaterial | undefined;
          let mat: THREE.MeshStandardMaterial;
          if (orig && (orig as any).isMeshStandardMaterial) {
            mat = orig.clone() as THREE.MeshStandardMaterial;
          } else {
            const origColor = orig?.color;
            const safeColor = origColor && typeof (origColor as any).clone === 'function'
              ? (origColor as any).clone()
              : new THREE.Color(0.72, 0.22, 0.26);
            mat = new THREE.MeshStandardMaterial({
              color: safeColor,
              roughness: (orig as any)?.roughness ?? 0.38,
              metalness: (orig as any)?.metalness ?? 0.1,
              map: (orig as any)?.map ?? null,
              normalMap: (orig as any)?.normalMap ?? null,
              roughnessMap: (orig as any)?.roughnessMap ?? null,
            });
          }

          // DoubleSide required for clean endocardial cut without backface culling
          mat.side = THREE.DoubleSide;
          mat.clipShadows = true;
          newMats.push(mat);
          allMaterials.push(mat);
        }
      }

      child.material = Array.isArray(child.material) ? newMats : newMats[0];
      const primaryMat = newMats[0];

      // Logical mapping evaluating child.userData.segId directly (telemetry embedded in the GLB extras)
      const uData = child.userData || {};
      const rawSegId = uData.segId;
      const segId = typeof rawSegId === 'number' && rawSegId >= 1 && rawSegId <= 17
        ? rawSegId
        : undefined;

      const initialScale = child.scale ? child.scale.clone() : new THREE.Vector3(1, 1, 1);

      // CASE 1: explicit AHA segment (child.userData.segId between 1 and 17)
      if (segId != null) {
        const territory: CoronaryTerritory =
          (uData.territory as CoronaryTerritory) ||
          AHA_SEGMENTS[segId - 1]?.territory ||
          'lad';

        child.userData.segId = segId;
        child.userData.territory = territory;
        child.userData.isExplicitSegment = true;
        child.userData.isVentricular = true;

        // Attaches a procedural myocardial extension without altering the GLB or UVs
        attachProceduralMyocardiumShader(primaryMat);

        segmentMeshes.push({
          mesh: child,
          segId,
          segIdx: segId - 1,
          territory,
          material: primaryMat,
          initialScale,
        });
        return;
      }

      // CASE 2: structural sub-meshes without segId (vessels, valves, chambers or composite myocardium)
      const nodeName = String(uData.name || child.name || '').toLowerCase();

      // Coronary vessels
      if (
        uData.isVessel ||
        uData.territory ||
        nodeName.includes('coronary') ||
        nodeName.includes('artery')
      ) {
        const territory: CoronaryTerritory =
          (uData.territory as CoronaryTerritory) ||
          (nodeName.includes('lad') || nodeName.includes('da') ? 'lad' :
           nodeName.includes('lcx') || nodeName.includes('cx') ? 'lcx' : 'rca');

        child.userData.isVessel = true;
        child.userData.territory = territory;

        vesselMeshes.push({
          mesh: child,
          territory,
          material: primaryMat,
        });
        return;
      }

      // Valvular apparatus
      if (
        uData.isValve ||
        nodeName.includes('valve') ||
        nodeName.includes('valva') ||
        nodeName.includes('cordoalha')
      ) {
        const valveType: 'mitral' | 'aortic' | 'tricuspid' | 'pulmonary' | undefined =
          uData.valveType ||
          (nodeName.includes('mitral') ? 'mitral' :
           nodeName.includes('aortic') || nodeName.includes('aortica') ? 'aortic' :
           nodeName.includes('tricuspid') ? 'tricuspid' :
           nodeName.includes('pulmon') ? 'pulmonary' : undefined);

        child.userData.isValve = true;
        child.userData.isStructure = true;
        child.userData.valveType = valveType;

        valveMeshes.push({
          mesh: child,
          valveType,
          initialScale,
        });
        return;
      }

      // Cardiac chambers and great vessels
      if (
        uData.chamber ||
        nodeName.includes('atrium') ||
        nodeName.includes('atrio') ||
        nodeName.includes('ventricle') ||
        nodeName.includes('ventriculo') ||
        nodeName.includes('aorta') ||
        nodeName.includes('pulmon')
      ) {
        const chamber: 'rv' | 'la' | 'ra' | 'aorta' | 'pulmonary' | undefined =
          uData.chamber ||
          (nodeName.includes('right_ventricle') || nodeName.includes('ventriculo_direito') ? 'rv' :
           nodeName.includes('left_atrium') || nodeName.includes('atrio_esquerdo') ? 'la' :
           nodeName.includes('right_atrium') || nodeName.includes('atrio_direito') ? 'ra' :
           nodeName.includes('aorta') ? 'aorta' :
           nodeName.includes('pulmon') ? 'pulmonary' : undefined);

        if (chamber) {
          child.userData.chamber = chamber;
          chamberMeshes.push({
            mesh: child,
            chamber,
            material: primaryMat,
            initialScale,
          });
          return;
        }
      }

      // Composite ventricular wall (no individual segId)
      if (uData.isVentricular || nodeName.includes('myocard') || nodeName.includes('ventric')) {
        child.userData.isVentricular = true;
        attachProceduralMyocardiumShader(primaryMat);
        ventricularMeshes.push({
          mesh: child,
          material: primaryMat,
          initialScale,
        });
        return;
      }

      // Generic structures without segId (render their base material safely without breaking the loop)
      child.userData.isStructure = true;
    });

    // Specific delimitation of the ventricular portion (prevents the aorta from stretching maxY and distorting nu)
    const ventBox = new THREE.Box3();
    let hasVent = false;
    for (let i = 0; i < segmentMeshes.length; i++) {
      ventBox.expandByObject(segmentMeshes[i].mesh);
      hasVent = true;
    }
    for (let i = 0; i < ventricularMeshes.length; i++) {
      ventBox.expandByObject(ventricularMeshes[i].mesh);
      hasVent = true;
    }
    if (!hasVent) {
      ventBox.copy(normBox);
      ventBox.max.y = normBox.min.y + (normBox.max.y - normBox.min.y) * 0.65;
    }

    const valvarData = setupValvarKinematics(sceneClone);

    // Semilunar valves: anchor at the GLB base position (matrix of the legacy discs), axis and radius
    // estimated from the vessel root, procedural cusps and semitransparent sinuses
    const semilunarData = setupSemilunarValves(sceneClone);
    if (semilunarData) {
      for (let i = 0; i < semilunarData.materials.length; i++) allMaterials.push(semilunarData.materials[i]);
      for (let i = 0; i < semilunarData.connectors.length; i++) {
        const c = semilunarData.connectors[i];
        if (c.territory) vesselMeshes.push({ mesh: c.mesh, territory: c.territory, material: c.material });
      }
      for (let i = 0; i < semilunarData.alignedDiscs.length; i++) {
        const disc = semilunarData.alignedDiscs[i].mesh;
        const item = valveMeshes.find((v) => v.mesh === disc);
        if (item) item.initialScale.copy(disc.scale);
      }
    }

    // VALVE MODE: captures wall and valve materials with their original values (setup, not per frame)
    const valveModeState = buildValveModeState(sceneClone);

    // RV: volume-driven contraction in 3 components (longitudinal, radial, anteroposterior),
    // referenced to the septum (LV axis) and the tricuspid annulus. See rvContractionComponent.ts.
    const rvItem = chamberMeshes.find((c) => c.chamber === 'rv');
    const lvAxisOrigin = new THREE.Vector3();
    let nLv = 0;
    const tmpBox = new THREE.Box3();
    const tmpCenter = new THREE.Vector3();
    for (let i = 0; i < segmentMeshes.length; i++) {
      const m = segmentMeshes[i].mesh;
      if (!m.geometry) continue;
      m.geometry.computeBoundingBox();
      if (!m.geometry.boundingBox) continue;
      m.updateMatrix();
      tmpBox.copy(m.geometry.boundingBox).applyMatrix4(m.matrix).getCenter(tmpCenter);
      lvAxisOrigin.add(tmpCenter);
      nLv++;
    }
    if (nLv > 0) lvAxisOrigin.multiplyScalar(1 / nLv);
    lvAxisOrigin.y = 0;
    const annulusObj = sceneClone.getObjectByName('tricuspid_annulus') as THREE.Mesh | undefined;
    const lvBaseY = computeLvBaseY(segmentMeshes.map((s) => s.mesh));

    // LV Phase 2 (D-VE1 = C): in-memory swap of the geometry of the 17 wedges for a common global theta grid, without
    // T-junction, with closed apex and the same analytic profile (lvWatertightGeometry.ts). Same nodes,
    // materials, segId and matrices; the per-node scale contraction does not change. Comes after the LV axis and base
    // so that the RV rig and the framing use the same values as before. Revert: LV_WATERTIGHT_ENABLED = false.
    applyLvWatertightGeometry(sceneClone);

    // RV Phase 2: moves the tricuspid apparatus (annulus, leaflets, papillary muscles, 18 chordae) out of the LV
    // with the rigid transform T_TV (tricuspidApparatusPose.json), applied to the node matrices.
    // The valvular kinematics (setupValvarKinematics) work in the local space of the nodes: restLen, axialT and
    // tipOffset do not depend on the pose. Revert: TRICUSPID_APPARATUS_POSE_ENABLED = false.
    applyTricuspidApparatusPose(sceneClone);

    // RV Phase 4: the rig uses the explicit wall apex and the ALREADY posed annulus, so it comes after T_TV
    const rvRig = setupRvContraction(rvItem?.mesh, annulusObj, lvAxisOrigin, new THREE.Vector3(0, 1, 0), valvarData);

    // Phase 4d: the RA follows the tricuspid annulus (Option B of the AV plan); annulus already posed and rig ready. Revert: RA_SKINNING_ENABLED = false.
    let raSkin: AtrialSkinRig | null = null;
    if (RA_SKINNING_ENABLED && rvRig?.wall && annulusObj) {
      const raMesh = chamberMeshes.find((c) => c.chamber === 'ra')?.mesh;
      const laMesh = sceneClone.getObjectByName('left_atrium') as THREE.Mesh | undefined;
      const svcMesh = sceneClone.getObjectByName('organui_superior_vena_cava') as THREE.Mesh | undefined;
      if (raMesh && laMesh?.isMesh && svcMesh?.isMesh) {
        const refField = new THREE.Matrix4();
        const refD = rvAnnulusReferenceField(rvRig, refField);
        raSkin = setupAtrialSkinning(raMesh, annulusObj, rvRig.axisL, [
          { mesh: svcMesh, d0: RA_ANCHORS.svc0, d1: RA_ANCHORS.svc1, pinScale: true },
          { mesh: laMesh, d0: RA_ANCHORS.la0, d1: RA_ANCHORS.la1, pinScale: false },
          // LV Phase 4d (user decision): RA floor pulled to the tricuspid plane on load
        ], refField, refD, RA_SKIN_PARAMS_LV);
      }
    }

    // LV Phase 3: radial contraction + per-vertex thickening on the 17 watertight wedges, calibrated by volume (lvContractionField.ts).
    // Replaces the per-node scale; the RV septum now reads the dynamic epicardial envelope of the LV. Without the field (non-watertight
    // geometry or LV_FIELD_ENABLED = false), the per-node scale remains. Revert: LV_FIELD_ENABLED = false.
    // LV Phase 4: the same rig lowers the AV plane (longitudinal component) and carries the mitral apparatus, the LA (skinning), the aortic valve
    // and the aortic root.
    const lvRig = LV_FIELD_ENABLED ? setupLvContractionField(segmentMeshes.map((s) => s.mesh), sceneClone, valvarData, { semilunar: semilunarData, rightAtriumSkin: raSkin }) : null;
    linkRvLvEnvelope(rvRig, lvRig ? lvRig.envelope : null);

    return { segmentMeshes, vesselMeshes, chamberMeshes, valveMeshes, ventricularMeshes, allMaterials, normBox, ventBox, valvarData, semilunarData, valveModeState, rvRig, raSkin, lvBaseY, lvRig };
  }, [sceneClone]);

  // VALVE MODE: on unmount (or scene change) restores the materials exactly and forces reapplication
  const lastValveModeRef = useRef<boolean | null>(null);
  // LV Phase 4d (A5): valvular kinematics diagnostic object created once per valvarData (before: object + 3 closures per frame)
  const valvarRuntimeRef = useRef<any>(null);
  useEffect(() => {
    return () => {
      applyValveMode(valveModeState, false);
      lastValveModeRef.current = null;
    };
  }, [valveModeState]);

  // GPU buffers of the procedural semilunar valves (three resends them if the object is rendered again)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__CARDIOCRAFT_SEMILUNAR_RUNTIME__ = {
        isInitialized: !!semilunarData,
        semilunarData,
        measureAortic: () => measureSemilunarValve(semilunarData?.valves.aortic),
        measurePulmonary: () => measureSemilunarValve(semilunarData?.valves.pulmonary),
        testReversibility: (cycles = 1000) => testSemilunarReversibility(semilunarData, cycles),
      };
    }
    return () => {
      disposeSemilunarGpuResources(semilunarData);
    };
  }, [semilunarData]);

  // LV Phase 5c (D-VE33): the LV driver (lambda and twist) runs at the engine's 1 ms step; useFrame only writes the geometry
  useEffect(() => {
    if (!lvRig) return;
    const loop = getSimulationLoop();
    const sys = createLvDriverSystem(lvRig);
    loop.register(sys);
    lvRig.driverInStep = true;
    return () => {
      lvRig.driverInStep = false;
      loop.unregister(sys.id);
    };
  }, [lvRig]);

  // RV contraction diagnostic (read-only): RV and LV mesh volumes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const lvMeshes = segmentMeshes.map((s) => s.mesh);
    (window as any).__CARDIOCRAFT_RV_RUNTIME__ = {
      isInitialized: !!rvRig,
      rvRig,
      raSkin,
      measureRv: () => (rvRig ? measureRvMeshVolume(rvRig) : NaN),
      measureLv: () => measureLvCavityVolume(lvMeshes, lvBaseY),
    };
    (window as any).__CARDIOCRAFT_LV_RUNTIME__ = {
      isInitialized: !!lvRig,
      lvRig,
      info: () => lvFieldInfo(lvRig),
    };
    return () => {
      if ((window as any).__CARDIOCRAFT_RV_RUNTIME__?.rvRig === rvRig) {
        delete (window as any).__CARDIOCRAFT_RV_RUNTIME__;
      }
      if ((window as any).__CARDIOCRAFT_LV_RUNTIME__?.lvRig === lvRig) {
        delete (window as any).__CARDIOCRAFT_LV_RUNTIME__;
      }
    };
  }, [rvRig, raSkin, segmentMeshes, lvBaseY, lvRig]);

  // Step 2: safe cleanup of clipping plane references on unmount
  useEffect(() => {
    return () => {
      for (let i = 0; i < allMaterials.length; i++) {
        const mat = allMaterials[i];
        if (mat) {
          mat.clippingPlanes = null;
        }
      }
      document.body.style.cursor = 'default';
      visualTimer.current?.dispose();
    };
  }, [allMaterials]);

  // Stable clipping arrays for useFrame (zero allocation in the hot path)
  const activePlanes = useMemo(() => [clipPlane], [clipPlane]);
  const emptyPlanes = useMemo(() => [], []);
  const lastCutawayRef = useRef<boolean | null>(null);

  // Stable scratch objects for useFrame (zero allocation in the hot path)
  const whiteColor = useMemo(() => new THREE.Color(1, 1, 1), []);
  const segContractions = useMemo(() => new Float32Array(17), []);
  const lvMotion = useMemo(() => new Float64Array(17).fill(1), []);
  const whiteEmissive = useMemo(() => new THREE.Color(0.25, 0.25, 0.25), []);

  useFrame(() => {
    visualTimer.current?.update();
    const live = getLive();
    const hemo = live?.hemo ?? ({} as any);
    const electro = live?.electro ?? ({} as any);
    const clock = live?.clock ?? ({} as any);
    const storeState = usePhysiologyStore.getState?.() ?? ({} as any);
    const echo = storeState?.params?.echo ?? ({} as any);
    const ecg = storeState?.params?.ecg ?? ({} as any);

    // R4: dynamic association of the clipping plane to materials only when cutaway changes
    if (lastCutawayRef.current !== cutaway) {
      lastCutawayRef.current = cutaway;
      const targetPlanes = cutaway ? activePlanes : emptyPlanes;
      for (let i = 0; i < allMaterials.length; i++) {
        const mat = allMaterials[i];
        if (mat) {
          mat.clippingPlanes = targetPlanes;
          mat.needsUpdate = true;
        }
      }
    }

    // VALVE MODE: applies or restores the materials only when the state changes
    if (lastValveModeRef.current !== valveMode) {
      lastValveModeRef.current = valveMode;
      applyValveMode(valveModeState, valveMode);
    }

    // R2: myocardial kinematics coupled to the RK4 solver
    const edv = Math.max(60, hemo?.edv || 120);
    const esv = Math.max(20, Math.min(edv - 10, hemo?.esv || 48));
    const vNorm = clamp((edv - (hemo?.vLV ?? 70)) / Math.max(15, edv - esv), 0, 1.15);

    // Update of color, perfusion and systolic thickening of the 17 AHA segments
    for (let i = 0; i < segmentMeshes.length; i++) {
      const item = segmentMeshes[i];
      if (!item) continue;
      const { mesh, segId, segIdx, territory, material, initialScale } = item;
      if (!mesh?.isMesh || !material?.color) continue;

      const wm = echo?.wallMotion?.[segIdx] ?? 1;
      const baseWMot = wm === 1 ? 1.0 : wm === 2 ? 0.45 : wm === 3 ? 0.0 : -0.32;
      const isIschemic =
        (ecg?.ischemiaTerritory && ecg.ischemiaTerritory !== 'none' && territory === ecg.ischemiaTerritory) || wm >= 3;
      const wMot = isIschemic ? Math.min(baseWMot, 0.35) : baseWMot;
      const dep = electro?.segmentDepol?.[segIdx] ?? 0;
      const isSelected = selectedSegment === segId;

      // Kinetics: normal systolic contraction (diameter decreases) or paradoxical bulging (aneurysm).
      // LV Phase 3: with the per-vertex field on (lvRig), c_i = wMot goes to the field (below) and the node scale does not change.
      if (segId >= 1 && segId <= 17) lvMotion[segId - 1] = wMot;
      if (!lvRig) {
        const segContraction = vNorm * wMot;
        const contract = 1 - LV_CONTRACTION_SCALE.xz * segContraction;
        if (mesh.scale && initialScale) {
          mesh.scale.set(
            initialScale.x * contract,
            initialScale.y * (1 - LV_CONTRACTION_SCALE.y * segContraction),
            initialScale.z * contract,
          );
        }
        if (segId >= 1 && segId <= 17) segContractions[segId - 1] = segContraction;
      }

      // Color and emissivity by mode
      if (colorMode === 'depolarization') {
        if (isIschemic) {
          // Ischemia: purplish/cyanotic hue of hypoperfusion with a lesion glow
          material.color.setRGB(0.35 + 0.45 * dep, 0.12 + 0.2 * dep, 0.45 + 0.35 * dep);
          material.emissive?.setRGB(0.2 * dep, 0.05, 0.25 * dep);
        } else {
          // Normal physiological depolarization
          material.color.setRGB(
            0.58 + 0.42 * dep,
            0.14 + 0.72 * dep,
            0.18 + 0.25 * Math.sin(dep * Math.PI),
          );
          material.emissive?.setRGB(0.35 * dep, 0.25 * dep, 0.06 * dep);
        }
      } else if (colorMode === 'coronary') {
        if (territory === 'lad') material.color.setRGB(0.94, 0.28, 0.31);
        else if (territory === 'lcx') material.color.setRGB(0.23, 0.62, 0.96);
        else material.color.setRGB(0.96, 0.72, 0.18);
        material.color.multiplyScalar(0.72 + 0.35 * dep);
        material.emissive?.setRGB(isIschemic ? 0.35 : 0.04, 0.04, 0.04);
      } else {
        // Motility: 1=Green, 2=Yellow, 3=Orange, 4=Purple dyskinetic
        if (wm === 1) material.color.setRGB(0.16, 0.78, 0.44);
        else if (wm === 2) material.color.setRGB(0.95, 0.72, 0.16);
        else if (wm === 3) material.color.setRGB(0.92, 0.35, 0.15);
        else material.color.setRGB(0.78, 0.18, 0.85);
        material.emissive?.setRGB(0, 0, 0);
      }

      if (isSelected) {
        material.color.lerp(whiteColor, 0.38);
        material.emissive?.add(whiteEmissive);
      }
    }

    // If the model is composite (without the 17 separate sub-segments), animates the global ventricular wall and reflects perfusion
    if (segmentMeshes.length === 0 && ventricularMeshes.length > 0) {
      const overallContraction = vNorm * ((echo?.lvef ?? 60) / 60);
      const contract = 1 - LV_CONTRACTION_SCALE.xz * overallContraction;
      segContractions.fill(overallContraction);
      const isIschemic = ecg?.ischemiaTerritory && ecg.ischemiaTerritory !== 'none';
      let sumDep = 0;
      for (let d = 0; d < 17; d++) sumDep += electro?.segmentDepol?.[d] ?? 0;
      const avgDep = sumDep / 17;

      for (let i = 0; i < ventricularMeshes.length; i++) {
        const item = ventricularMeshes[i];
        if (!item) continue;
        const { mesh, initialScale, material } = item;
        if (!mesh?.isMesh || !material?.color) continue;

        if (mesh.scale && initialScale) {
          mesh.scale.set(
            initialScale.x * contract,
            initialScale.y * (1 - LV_CONTRACTION_SCALE.y * overallContraction),
            initialScale.z * contract,
          );
        }

        if (colorMode === 'depolarization') {
          if (isIschemic) {
            material.color.setRGB(0.35 + 0.45 * avgDep, 0.12 + 0.2 * avgDep, 0.45 + 0.35 * avgDep);
            material.emissive?.setRGB(0.2 * avgDep, 0.05, 0.25 * avgDep);
          } else {
            material.color.setRGB(
              0.58 + 0.42 * avgDep,
              0.14 + 0.72 * avgDep,
              0.18 + 0.25 * Math.sin(avgDep * Math.PI),
            );
            material.emissive?.setRGB(0.35 * avgDep, 0.25 * avgDep, 0.06 * avgDep);
          }
        } else if (colorMode === 'coronary') {
          if (selectedSegment != null) {
            const terr = AHA_SEGMENTS[selectedSegment - 1]?.territory;
            if (terr === 'lad') material.color.setRGB(0.94, 0.28, 0.31);
            else if (terr === 'lcx') material.color.setRGB(0.23, 0.62, 0.96);
            else material.color.setRGB(0.96, 0.72, 0.18);
          } else {
            material.color.setRGB(0.72, 0.22, 0.26);
          }
          material.emissive?.setRGB(isIschemic ? 0.35 : 0.04, 0.04, 0.04);
        } else {
          let sumWm = 0;
          for (let w = 0; w < 17; w++) sumWm += echo?.wallMotion?.[w] ?? 1;
          const avgWm = sumWm / 17;
          if (avgWm < 1.5) material.color.setRGB(0.16, 0.78, 0.44);
          else if (avgWm < 2.5) material.color.setRGB(0.95, 0.72, 0.16);
          else if (avgWm < 3.5) material.color.setRGB(0.92, 0.35, 0.15);
          else material.color.setRGB(0.78, 0.18, 0.85);
          material.emissive?.setRGB(0, 0, 0);
        }

        if (selectedSegment != null) {
          material.color.lerp(whiteColor, 0.25);
          material.emissive?.add(whiteEmissive);
        }
      }
    }

    // LV Phase 3: per-vertex field calibrated by engine volume (vLV/V_ref); recomputes coefficients only when c_i changes
    if (lvRig) {
      setLvSegmentMotion(lvRig, lvMotion);
      // LV Phase 5b (D-VE28): the engine's zMitral and qMitral tie the untwisting to the RIV (isovolumetric relaxation) and to filling
      // LV Phase 5c (D-VE33): with the step system registered, only the geometry here (the driver runs at 1 ms with zAortic)
      applyLvContraction(lvRig, hemo?.vLV ?? NaN, clock?.beatIndex ?? 0, clock?.t ?? NaN, hemo?.zMitral ?? NaN, hemo?.qMitral ?? NaN, hemo?.zAortic ?? NaN);
      for (let s = 0; s < 17; s++) segContractions[s] = lvRig.lambda * lvMotion[s];
    }

    // Shared wall: the RV septum follows the LV epicardium of this frame (before solving lambda)
    if (rvRig) setRvLvContraction(rvRig, rvSeptalLvContraction(rvRig, segContractions));

    // Coronary vessels: ischemic highlight if occluded
    for (let i = 0; i < vesselMeshes.length; i++) {
      const item = vesselMeshes[i];
      if (!item) continue;
      const { territory, material } = item;
      if (!material?.color) continue;
      const isOccluded = ecg?.ischemiaTerritory === territory;
      if (isOccluded) {
        material.color.setRGB(0.98, 0.8, 0.1);
        material.emissive?.setRGB(0.79, 0.54, 0.02);
      } else {
        if (territory === 'lad') material.color.setRGB(0.93, 0.26, 0.26);
        else if (territory === 'lcx') material.color.setRGB(0.22, 0.74, 0.97);
        else material.color.setRGB(0.96, 0.62, 0.04);
        material.emissive?.setRGB(0.15, 0.03, 0.03);
      }
    }

    // Anatomical atrioventricular heart valves: procedural kinematic deformation
    const diag = typeof window !== 'undefined' ? (window as any).__CARDIOCRAFT_VALVAR_DIAGNOSTIC__ : null;
    const zMi = diag?.active ? diag.zMitral : (hemo?.zMitral ?? 0);
    const zTr = diag?.active ? diag.zTricuspid : (hemo?.zTricuspid ?? 0);

    if (valvarData) {
      applyValvarDeformation(valvarData, zMi, zTr);
      // LV Phase 4: mitral chordae as tie rods (papillary tip y from the frame's chordae)
      applyLvChordTies(lvRig);
    }

    if (typeof window !== 'undefined') {
      let rt = valvarRuntimeRef.current;
      if (!rt || rt.valvarData !== valvarData) {
        rt = {
          isInitialized: !!valvarData,
          valvarData,
          zMitral: zMi,
          zTricuspid: zTr,
          measureChordae: () => measureValvarChordae(valvarData),
          measureCoaptation: () => measureValvarCoaptation(valvarData),
          testReversibility: (cycles = 1000) => testValvarReversibility(valvarData, cycles),
        };
        valvarRuntimeRef.current = rt;
      }
      rt.zMitral = zMi;
      rt.zTricuspid = zTr;
      if ((window as any).__CARDIOCRAFT_VALVAR_RUNTIME__ !== rt) (window as any).__CARDIOCRAFT_VALVAR_RUNTIME__ = rt;
    }

    // Procedural semilunar valves: 3 cusps per valve, deformed by the engine's zeta
    const zAo = diag?.active && typeof diag.zAortic === 'number' ? diag.zAortic : (hemo?.zAortic ?? 0);
    const zPu = diag?.active && typeof diag.zPulmonary === 'number' ? diag.zPulmonary : (hemo?.zPulmonary ?? 0);
    applySemilunarDeformation(semilunarData, zAo, zPu);

    // Legacy semilunar discs (aortic and pulmonary): planar scale kept when not replaced
    for (let i = 0; i < valveMeshes.length; i++) {
      const item = valveMeshes[i];
      if (!item) continue;
      const { mesh, valveType, initialScale } = item;
      if (!mesh?.isMesh || !mesh.scale || !initialScale) continue;
      // Structures with a static guard or already procedurally deformed do not undergo planar scaling
      if ((mesh.userData as any)?.isStatic || (mesh.userData as any)?.isProceduralValvar) continue;
      const z = valveType === 'aortic'
        ? (hemo?.zAortic ?? 0)
        : valveType === 'pulmonary'
        ? (hemo?.zPulmonary ?? 0)
        : 0;
      mesh.scale.set(
        initialScale.x * (1 - 0.65 * z),
        initialScale.y * (1 - 0.65 * z),
        initialScale.z,
      );
    }

    // Cardiac chambers and great vessels
    for (let i = 0; i < chamberMeshes.length; i++) {
      const item = chamberMeshes[i];
      if (!item) continue;
      const { chamber, mesh, material, initialScale } = item;
      if (!mesh?.isMesh || !mesh.scale || !initialScale) continue;

      if (chamber === 'rv') {
        // Volume-based contraction (engine vRV, which already includes the RBBB delay), without movement in the isovolumetric phase
        if (rvRig && rvRig.mesh === mesh) {
          applyRvContraction(rvRig, hemo?.vRV ?? NaN, clock?.beatIndex ?? 0, clock?.t ?? NaN, clock?.tInBeat ?? NaN);
        }
        // Brightness by (1 − fill): still in the isovolumetric phases, minimum at EDV and maximum at ESV; zero without rig
        applyRvChamberEmissive(material?.emissive, rvRig);
      } else if (chamber === 'la' || chamber === 'ra') {
        // RA with skinning: the atrial scale goes to the vertices in applyAtrialSkinning (below)
        if (!(raSkin && raSkin.mesh === mesh) && !(lvRig?.laSkin && lvRig.laSkin.mesh === mesh)) {
          const aScale = atrialContractionScale(chamber, hemo);
          mesh.scale.set(initialScale.x * aScale, initialScale.y * aScale, initialScale.z * aScale);
        }
        if (ecg?.rhythm === 'af') {
          const fWave = 0.5 + 0.5 * Math.sin((clock?.t ?? 0) * 42);
          material?.emissive?.setRGB(0.4 * fWave, 0.1 * fWave, 0.5 * fWave);
        } else if (ecg?.rhythm === 'flutter') {
          const fl = 0.5 + 0.5 * Math.sin((clock?.atrialPhi ?? 0) * Math.PI * 2);
          material?.emissive?.setRGB(0.6 * fl, 0.35 * fl, 0.05);
        } else {
          const tSinceP = clock?.tSinceP ?? 1;
          const pGlow = tSinceP < 0.11 ? Math.sin((Math.PI * tSinceP) / 0.11) : 0;
          material?.emissive?.setRGB(0.3 * pGlow, 0.2 * pGlow, 0.06);
        }
      } else if (chamber === 'aorta') {
        const pAo = hemo?.pAo ?? 80;
        const aoP = 1 + 0.0016 * Math.max(0, pAo - 75);
        mesh.scale.set(initialScale.x * aoP, initialScale.y, initialScale.z * aoP);
      }
    }

    // Phase 4d: after the chamber loop, with the annulus field already updated in this frame
    if (raSkin && rvRig?.wall) {
      applyAtrialSkinning(raSkin, rvRig.wall.shear, rvRig.kL * rvRig.wall.lengthD, atrialContractionScale('ra', hemo));
      // LV Phase 4c (D-VE24): the RA exits the current LV (RA floor; smallest radial or vertical exit)
      applyLvRaPost(lvRig);
    }
    // LV Phase 4: the LA follows the mitral annulus (LV apparatus field)
    // LV Phase 4b: no anchor on the RA; post-step with floor at the current LV top and contact with the RA (applyLvAtrium)
    if (lvRig?.laSkin) {
      applyLvAtrium(lvRig, atrialContractionScale('la', hemo));
    }
  });

  if (!sceneClone) return null;

  // R3: 3D raycasting handlers on the realistic model
  return (
    <primitive
      object={sceneClone}
      dispose={null}
      onPointerOver={(e: any) => {
        e?.stopPropagation?.();
        if (cutaway && clipPlane && Array.isArray(e?.intersections)) {
          const hasVisible = e.intersections.some((hit: any) => hit?.point && clipPlane.distanceToPoint(hit.point) >= -1e-4);
          if (!hasVisible) {
            document.body.style.cursor = 'default';
            return;
          }
        }
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={(e: any) => {
        e?.stopPropagation?.();
        document.body.style.cursor = 'default';
      }}
      onClick={(e: any) => {
        e?.stopPropagation?.();
        const validHit = cutaway && clipPlane && Array.isArray(e?.intersections)
          ? e.intersections.find((hit: any) => hit?.point && clipPlane.distanceToPoint(hit.point) >= -1e-4)
          : (e?.intersections?.[0] ?? e);

        if (!validHit) return;

        const mesh = validHit?.object as THREE.Mesh | undefined;
        if (!mesh?.isMesh && !(mesh as any)?.userData) return;
        const userData = (mesh as any)?.userData ?? {};

        // 1. Coronary vessel clicked
        if (userData.isVessel && userData.territory) {
          const terr = userData.territory as CoronaryTerritory;
          const repSeg = terr === 'lad' ? 1 : terr === 'rca' ? 4 : 5;
          const nextSeg = repSeg === selectedSegment ? null : repSeg;
          onSelectSegment?.(nextSeg);
          usePhysiologyStore.getState?.()?.setSelectedSegment?.(nextSeg);
          return;
        }

        // 2. Chamber, valvular structure or great vessel clicked (ignored so as not to divert the 17 segments)
        if (userData.chamber || userData.isStructure || userData.isValve) {
          return;
        }

        // 3. Explicit segment or 3D spatial resolution by coordinates on the ventricular wall
        let segId = typeof userData.segId === 'number' ? userData.segId : undefined;

        // If it is a composite ventricular mesh or has no explicit segId, uses the real click coordinates converted to the cloned scene
        if ((!userData.isExplicitSegment || segId == null) && validHit.point && sceneClone) {
          const localPt = sceneClone.worldToLocal((validHit.point as THREE.Vector3).clone());
          if (localPt) {
            const minY = ventBox.min.y;
            const maxY = ventBox.max.y;
            const h = Math.max(0.001, maxY - minY);
            const nu = clamp((localPt.y - minY) / h, 0, 1);
            const theta = (Math.atan2(localPt.z, localPt.x) + Math.PI * 2) % (Math.PI * 2);
            segId = classifyAhaSegment(nu, theta) + 1;
          }
        }

        if (segId != null) {
          const nextSeg = segId === selectedSegment ? null : segId;
          onSelectSegment?.(nextSeg);
          usePhysiologyStore.getState?.()?.setSelectedSegment?.(nextSeg);
        }
      }}
    />
  );
}

// ============================================================================
// R1: Graceful Fallback with Anatomical Wireframe (17 Segments, Chambers and Vessels)
// ============================================================================

/** State of the GLB model while the wireframe shows: loading (normal, transient) or load failure (real fallback). */
export type HeartModelStatus = 'loading' | 'failed';

/**
 * Regression guard: the badge previously showed "Fallback Ativo" during normal GLB loading as well; it now distinguishes loading from failure.
 * Pure component (tested with react-dom/server in heartModelStatusBadge.test.ts).
 */
export function HeartModelStatusBadge({ status }: { status: HeartModelStatus }) {
  const failed = status === 'failed';
  return (
    <div
      style={{
        background: 'rgba(15, 23, 42, 0.88)',
        border: `1px solid ${failed ? '#38bdf8' : '#64748b'}`,
        borderRadius: 4,
        padding: '3px 8px',
        color: failed ? '#38bdf8' : '#94a3b8',
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        fontWeight: 700,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        letterSpacing: '0.04em',
        boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
      }}
    >
      {failed ? '⚡ CARDIOCRAFT · WIREFRAME ANATÔMICO (Fallback Ativo)' : 'CARDIOCRAFT · CARREGANDO MODELO ANATÔMICO…'}
    </div>
  );
}

export function HeartWireframeFallback({
  colorMode,
  cutaway,
  clipPlane,
  selectedSegment,
  onSelectSegment,
  status = 'failed',
}: RealisticHeartProps & { status?: HeartModelStatus }) {
  // Low-frequency selector for coronary ischemia coloring in the wireframe
  const ischemiaTerritory = usePhysiologyStore((s) => s.params.ecg.ischemiaTerritory);

  // Step 3: dedicated THREE.Timer for visual physics in the fallback
  const fallbackTimer = useRef<THREE.Timer | null>(null);
  if (!fallbackTimer.current) {
    fallbackTimer.current = new THREE.Timer();
  }

  const lvMeshData = useMemo(() => buildLv17Geometry(), []);
  const lvMeshRef = useRef<THREE.Mesh>(null);
  const rvMeshRef = useRef<THREE.Mesh>(null);
  // Wireframe's own EDV/ESV tracker (independent of the GLB rig)
  const rvWireframeDriver = useRef<RvWireframeDriver | null>(null);
  if (!rvWireframeDriver.current) {
    rvWireframeDriver.current = createRvWireframeDriver();
  }
  const laMeshRef = useRef<THREE.Mesh>(null);
  const raMeshRef = useRef<THREE.Mesh>(null);
  const aortaRef = useRef<THREE.Mesh>(null);
  const ivcRef = useRef<THREE.Mesh>(null);

  // Valve leaflets
  const mitralValveRef = useRef<THREE.Mesh>(null);
  const aorticValveRef = useRef<THREE.Mesh>(null);
  const tricuspidValveRef = useRef<THREE.Mesh>(null);
  const pulmonaryValveRef = useRef<THREE.Mesh>(null);

  const coronaryCurves = useMemo(() => buildCoronaryArteries(), []);
  const tmpColor = useMemo(() => new THREE.Color(), []);
  const whiteColor = useMemo(() => new THREE.Color(1, 1, 1), []);

  useEffect(() => {
    return () => {
      document.body.style.cursor = 'default';
      fallbackTimer.current?.dispose();
      lvMeshData.geometry.dispose();
      coronaryCurves.aortaGeom.dispose();
      coronaryCurves.pulmGeom.dispose();
      coronaryCurves.ladGeom.dispose();
      coronaryCurves.lcxGeom.dispose();
      coronaryCurves.rcaGeom.dispose();
    };
  }, [lvMeshData, coronaryCurves]);

  useFrame(() => {
    fallbackTimer.current?.update();
    const live = getLive();
    const hemo = live.hemo;
    const electro = live.electro;
    const clock = live.clock;
    // Transitive read in the hot path without forcing a React re-render (medical-sim-core-architecture)
    const echo = usePhysiologyStore.getState().params.echo;
    const ecg = usePhysiologyStore.getState().params.ecg;

    // 1. Kinetic deformation and electrical coloring of the 17 segments in the wireframe
    const geom = lvMeshData.geometry;
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = geom.getAttribute('color') as THREE.BufferAttribute;
    const posArr = posAttr.array as Float32Array;
    const colArr = colAttr.array as Float32Array;
    const { restNu, restTheta, restLayer, segIds, vCount } = lvMeshData;

    const edRadiusScale = echo.lvedd / 48.0;
    const esRadiusScale = echo.lvesd / 31.0;
    const septThickScale = echo.septum / 9.0;
    const pwThickScale = echo.posteriorWall / 9.0;

    const edv = Math.max(60, hemo.edv || 120);
    const esv = Math.max(20, Math.min(edv - 10, hemo.esv || 48));
    const vNorm = clamp((edv - hemo.vLV) / Math.max(15, edv - esv), 0, 1.15);

    for (let i = 0; i < vCount; i++) {
      const segIdx = segIds[i];
      const nu = restNu[i];
      const theta = restTheta[i];
      const layer = restLayer[i];

      const wm = echo.wallMotion[segIdx] ?? 1;
      const baseWMot = wm === 1 ? 1.0 : wm === 2 ? 0.45 : wm === 3 ? 0.0 : -0.32;
      const segSpec = AHA_SEGMENTS[segIdx];
      const isIschemic =
        (ecg.ischemiaTerritory !== 'none' && segSpec.territory === ecg.ischemiaTerritory) || wm >= 3;
      const wMot = isIschemic ? Math.min(baseWMot, 0.35) : baseWMot;

      let segContraction = vNorm * wMot;
      if (ecg.bundleBranchBlock === 'lbbb') {
        if (segSpec.nx > 0.3) {
          const tShift = clock.tSinceQRS - 0.055;
          const delayedE = tShift > 0 && tShift < clock.ts ? Math.sin((Math.PI * tShift) / clock.ts) ** 2 : 0;
          segContraction = delayedE * wMot;
        }
      }

      const sinProfile = Math.sin(Math.max(0.06, nu * 0.84 * Math.PI * 0.5 + 0.08));
      const baseEndoR = 0.78 * edRadiusScale * sinProfile;
      const targetSysDelta = (0.28 * edRadiusScale - 0.10 * (esRadiusScale - 1)) * sinProfile;
      const rEndo = Math.max(0.12, baseEndoR - segContraction * targetSysDelta);

      const isSeptal = segIdx === 1 || segIdx === 2 || segIdx === 7 || segIdx === 8 || segIdx === 13;
      const wallScale = isSeptal ? septThickScale : pwThickScale;
      const sysThickening = 1 + 0.36 * Math.max(-0.25, segContraction);
      const wallH = 0.24 * wallScale * sysThickening * (0.65 + 0.35 * sinProfile);

      const r = rEndo + layer * wallH;
      const mapse = 0.14 * Math.max(0, segContraction) * nu;
      const y = -1.42 + nu * 2.15 - mapse;
      const twist = (nu - 0.5) * -0.18 * Math.max(0, segContraction);
      const ang = theta + twist;

      posArr[i * 3] = r * Math.cos(ang);
      posArr[i * 3 + 1] = y;
      posArr[i * 3 + 2] = r * Math.sin(ang);

      const dep = electro.segmentDepol[segIdx];
      const isSelected = selectedSegment === segIdx + 1;

      if (colorMode === 'depolarization') {
        if (isIschemic) {
          tmpColor.setRGB(0.35 + 0.45 * dep, 0.12 + 0.2 * dep, 0.45 + 0.35 * dep);
        } else {
          tmpColor.setRGB(
            0.58 + 0.42 * dep,
            0.14 + 0.72 * dep,
            0.18 + 0.25 * Math.sin(dep * Math.PI),
          );
        }
      } else if (colorMode === 'coronary') {
        if (segSpec.territory === 'lad') tmpColor.setRGB(0.94, 0.28, 0.31);
        else if (segSpec.territory === 'lcx') tmpColor.setRGB(0.23, 0.62, 0.96);
        else tmpColor.setRGB(0.96, 0.72, 0.18);
        tmpColor.multiplyScalar(0.72 + 0.35 * dep);
      } else {
        if (wm === 1) tmpColor.setRGB(0.16, 0.78, 0.44);
        else if (wm === 2) tmpColor.setRGB(0.95, 0.72, 0.16);
        else if (wm === 3) tmpColor.setRGB(0.92, 0.35, 0.15);
        else tmpColor.setRGB(0.78, 0.18, 0.85);
      }

      if (isSelected) {
        tmpColor.lerp(whiteColor, 0.45);
      }

      colArr[i * 3] = tmpColor.r;
      colArr[i * 3 + 1] = tmpColor.g;
      colArr[i * 3 + 2] = tmpColor.b;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    geom.computeVertexNormals();

    // 2. Chamber kinetics in the wireframe
    if (rvMeshRef.current && rvWireframeDriver.current) {
      // RV by volume (own tracker, scale by 1 − fill), as in the realistic model
      // LV Phase 5c (D-VE34): time within the clock beat for the EDV reference of the current beat
      rvWireframeDriver.current.tInBeat = clock.tInBeat;
      updateRvWireframe(rvWireframeDriver.current, hemo.vRV, clock.beatIndex, rvMeshRef.current.scale);
    }
    if (laMeshRef.current && raMeshRef.current) {
      const laScale = 1 - 0.16 * hemo.eLA;
      const raScale = 1 - 0.16 * hemo.eRA;
      laMeshRef.current.scale.set(laScale, laScale, laScale);
      raMeshRef.current.scale.set(raScale, raScale, raScale);
    }
    if (aortaRef.current) {
      const aoPulse = 1 + 0.0018 * Math.max(0, hemo.pAo - 75);
      aortaRef.current.scale.set(aoPulse, 1, aoPulse);
    }
    if (ivcRef.current) {
      const ivcScale = clamp(hemo.ivcDiameter / 18.0, 0.35, 1.45);
      ivcRef.current.scale.set(ivcScale, 1, ivcScale);
    }
    if (mitralValveRef.current) mitralValveRef.current.scale.setScalar(1 - 0.65 * hemo.zMitral);
    if (aorticValveRef.current) aorticValveRef.current.scale.setScalar(1 - 0.65 * hemo.zAortic);
    if (tricuspidValveRef.current) tricuspidValveRef.current.scale.setScalar(1 - 0.65 * hemo.zTricuspid);
    if (pulmonaryValveRef.current) pulmonaryValveRef.current.scale.setScalar(1 - 0.65 * hemo.zPulmonary);
  });

  const activePlanes = useMemo(() => [clipPlane], [clipPlane]);
  const emptyPlanes = useMemo(() => [], []);
  const planes = cutaway ? activePlanes : emptyPlanes;

  const handleSelectLvSegment = (e: any) => {
    e.stopPropagation();
    const validHit = cutaway && clipPlane && Array.isArray(e.intersections)
      ? e.intersections.find((hit: any) => clipPlane.distanceToPoint(hit.point) >= -1e-4)
      : (e.intersections?.[0] ?? e);

    if (!validHit) return;

    let segId: number | null = null;
    if (validHit.faceIndex != null) {
      const vi = lvMeshData.geometry.index
        ? lvMeshData.geometry.index.getX(validHit.faceIndex * 3)
        : validHit.faceIndex * 3;
      segId = lvMeshData.segIds[vi] + 1;
    } else if (validHit.point) {
      const pt = lvMeshRef.current
        ? lvMeshRef.current.worldToLocal((validHit.point as THREE.Vector3).clone())
        : (validHit.point as THREE.Vector3);
      const nu = clamp((pt.y + 1.42) / 2.15, 0, 1);
      const theta = (Math.atan2(pt.z, pt.x) + Math.PI * 2) % (Math.PI * 2);
      segId = classifyAhaSegment(nu, theta) + 1;
    }
    if (segId != null) {
      const next = segId === selectedSegment ? null : segId;
      onSelectSegment(next);
      usePhysiologyStore.getState().setSelectedSegment(next);
    }
  };

  return (
    <group>
      {/* Left Ventricle: Anatomical Wireframe Mesh of the 17 Segments with Raycasting */}
      <mesh
        ref={lvMeshRef}
        dispose={null}
        geometry={lvMeshData.geometry}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (cutaway && clipPlane && Array.isArray(e.intersections)) {
            const hasVisible = e.intersections.some((hit: any) => clipPlane.distanceToPoint(hit.point) >= -1e-4);
            if (!hasVisible) {
              document.body.style.cursor = 'default';
              return;
            }
          }
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'default';
        }}
        onClick={handleSelectLvSegment}
      >
        <meshStandardMaterial
          wireframe
          vertexColors
          roughness={0.38}
          metalness={0.12}
          side={THREE.DoubleSide}
          clippingPlanes={planes}
          clipShadows
        />
      </mesh>

      {/* Subtle inner translucent layer to give a volumetric feel to the wireframe with direct Raycasting */}
      <mesh
        dispose={null}
        geometry={lvMeshData.geometry}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (cutaway && clipPlane && Array.isArray(e.intersections)) {
            const hasVisible = e.intersections.some((hit: any) => clipPlane.distanceToPoint(hit.point) >= -1e-4);
            if (!hasVisible) {
              document.body.style.cursor = 'default';
              return;
            }
          }
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'default';
        }}
        onClick={handleSelectLvSegment}
      >
        <meshStandardMaterial
          transparent
          opacity={0.14}
          vertexColors
          side={THREE.DoubleSide}
          clippingPlanes={planes}
          clipShadows
        />
      </mesh>

      {/* Right Ventricle (Wireframe) */}
      <mesh ref={rvMeshRef} dispose={null} position={[-0.62, -0.25, 0.38]} rotation={[0, 0.4, 0.12]}>
        <sphereGeometry args={[0.78, 20, 16, 0, Math.PI * 1.15, 0.2, Math.PI * 0.78]} />
        <meshStandardMaterial
          wireframe
          color="#ef4444"
          roughness={0.4}
          transparent
          opacity={0.65}
          side={THREE.DoubleSide}
          clippingPlanes={planes}
          clipShadows
        />
      </mesh>

      {/* Left Atrium (Wireframe) */}
      <mesh ref={laMeshRef} dispose={null} position={[0.42, 1.15, -0.32]}>
        <sphereGeometry args={[0.56, 18, 14]} />
        <meshStandardMaterial
          wireframe
          color="#ec4899"
          roughness={0.4}
          transparent
          opacity={0.65}
          side={THREE.DoubleSide}
          clippingPlanes={planes}
          clipShadows
        />
      </mesh>

      {/* Right Atrium (Wireframe) */}
      <mesh ref={raMeshRef} dispose={null} position={[-0.65, 1.05, 0.12]}>
        <sphereGeometry args={[0.58, 18, 14]} />
        <meshStandardMaterial
          wireframe
          color="#db2777"
          roughness={0.4}
          transparent
          opacity={0.65}
          side={THREE.DoubleSide}
          clippingPlanes={planes}
          clipShadows
        />
      </mesh>

      {/* 4 Dynamic Valvular Apparatuses */}
      <group position={[0.32, 0.72, -0.18]}>
        <mesh ref={mitralValveRef} dispose={null} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.04, 0.26, 20]} />
          <meshStandardMaterial color="#f8fafc" side={THREE.DoubleSide} clippingPlanes={planes} />
        </mesh>
      </group>
      <group position={[0.05, 0.78, 0.12]}>
        <mesh ref={aorticValveRef} dispose={null} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.03, 0.22, 20]} />
          <meshStandardMaterial color="#fde047" side={THREE.DoubleSide} clippingPlanes={planes} />
        </mesh>
      </group>
      <group position={TRICUSPID_RING_POSE.position} quaternion={TRICUSPID_RING_POSE.quaternion}>
        <mesh ref={tricuspidValveRef} dispose={null} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.04, 0.27, 20]} />
          <meshStandardMaterial color="#bae6fd" side={THREE.DoubleSide} clippingPlanes={planes} />
        </mesh>
      </group>
      <group position={[-0.35, 0.82, 0.45]}>
        <mesh ref={pulmonaryValveRef} dispose={null} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.03, 0.21, 20]} />
          <meshStandardMaterial color="#93c5fd" side={THREE.DoubleSide} clippingPlanes={planes} />
        </mesh>
      </group>

      {/* Great Vessels */}
      <mesh ref={aortaRef} dispose={null} geometry={coronaryCurves.aortaGeom}>
        <meshStandardMaterial wireframe color="#dc2626" side={THREE.DoubleSide} clippingPlanes={planes} />
      </mesh>
      <mesh dispose={null} geometry={coronaryCurves.pulmGeom}>
        <meshStandardMaterial wireframe color="#2563eb" side={THREE.DoubleSide} clippingPlanes={planes} />
      </mesh>
      <mesh ref={ivcRef} dispose={null} position={[-0.72, -0.15, -0.25]}>
        <cylinderGeometry args={[0.22, 0.22, 1.4, 14]} />
        <meshStandardMaterial wireframe color="#1d4ed8" transparent opacity={0.65} clippingPlanes={planes} />
      </mesh>

      {/* Epicardial Coronary Arteries with direct Raycasting */}
      <mesh
        dispose={null}
        geometry={coronaryCurves.ladGeom}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (cutaway && clipPlane && Array.isArray(e.intersections)) {
            const hasVisible = e.intersections.some((hit: any) => clipPlane.distanceToPoint(hit.point) >= -1e-4);
            if (!hasVisible) {
              document.body.style.cursor = 'default';
              return;
            }
          }
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'default';
        }}
        onClick={(e) => {
          e.stopPropagation();
          const validHit = cutaway && clipPlane && Array.isArray(e.intersections)
            ? e.intersections.find((hit: any) => clipPlane.distanceToPoint(hit.point) >= -1e-4)
            : (e.intersections?.[0] ?? e);
          if (!validHit) return;
          const next = selectedSegment === 1 ? null : 1;
          onSelectSegment(next);
          usePhysiologyStore.getState().setSelectedSegment(next);
        }}
      >
        <meshStandardMaterial
          color={ischemiaTerritory === 'lad' ? '#facc15' : '#ef4444'}
          emissive={ischemiaTerritory === 'lad' ? '#ca8a04' : '#3f0d12'}
          roughness={0.3}
          clippingPlanes={planes}
        />
      </mesh>
      <mesh
        dispose={null}
        geometry={coronaryCurves.lcxGeom}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (cutaway && clipPlane && Array.isArray(e.intersections)) {
            const hasVisible = e.intersections.some((hit: any) => clipPlane.distanceToPoint(hit.point) >= -1e-4);
            if (!hasVisible) {
              document.body.style.cursor = 'default';
              return;
            }
          }
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'default';
        }}
        onClick={(e) => {
          e.stopPropagation();
          const validHit = cutaway && clipPlane && Array.isArray(e.intersections)
            ? e.intersections.find((hit: any) => clipPlane.distanceToPoint(hit.point) >= -1e-4)
            : (e.intersections?.[0] ?? e);
          if (!validHit) return;
          const next = selectedSegment === 5 ? null : 5;
          onSelectSegment(next);
          usePhysiologyStore.getState().setSelectedSegment(next);
        }}
      >
        <meshStandardMaterial
          color={ischemiaTerritory === 'lcx' ? '#facc15' : '#38bdf8'}
          emissive={ischemiaTerritory === 'lcx' ? '#ca8a04' : '#082f49'}
          roughness={0.3}
          clippingPlanes={planes}
        />
      </mesh>
      <mesh
        dispose={null}
        geometry={coronaryCurves.rcaGeom}
        onPointerOver={(e) => {
          e.stopPropagation();
          if (cutaway && clipPlane && Array.isArray(e.intersections)) {
            const hasVisible = e.intersections.some((hit: any) => clipPlane.distanceToPoint(hit.point) >= -1e-4);
            if (!hasVisible) {
              document.body.style.cursor = 'default';
              return;
            }
          }
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'default';
        }}
        onClick={(e) => {
          e.stopPropagation();
          const validHit = cutaway && clipPlane && Array.isArray(e.intersections)
            ? e.intersections.find((hit: any) => clipPlane.distanceToPoint(hit.point) >= -1e-4)
            : (e.intersections?.[0] ?? e);
          if (!validHit) return;
          const next = selectedSegment === 4 ? null : 4;
          onSelectSegment(next);
          usePhysiologyStore.getState().setSelectedSegment(next);
        }}
      >
        <meshStandardMaterial
          color={ischemiaTerritory === 'rca' ? '#facc15' : '#f59e0b'}
          emissive={ischemiaTerritory === 'rca' ? '#ca8a04' : '#451a03'}
          roughness={0.3}
          clippingPlanes={planes}
        />
      </mesh>

      {/* Wireframe badge: loading the GLB or fallback on failure (LV Phase 4c) */}
      <Html position={[0, -2.15, 0]} center>
        <HeartModelStatusBadge status={status} />
      </Html>
    </group>
  );
}

// ============================================================================
// Main Electromechanical Heart Scene
// ============================================================================

export function HeartElectromechanicalScene({
  colorMode,
  cutaway,
  cutDepth = 0.08,
  cutAngle = 0,
  showDipoles,
  showVcgLoop,
  valveMode = false,
  selectedSegment,
  onSelectSegment,
}: HeartElectromechanicalSceneProps) {
  const storeSelectedSegment = usePhysiologyStore((s) => s.selectedSegment);
  const activeSegment = selectedSegment !== undefined ? selectedSegment : storeSelectedSegment;
  // Surgical, atomic selector of the active segment's wall motility (avoids scene re-renders)
  const activeWallMotion = usePhysiologyStore((s) =>
    activeSegment != null ? s.params.echo.wallMotion[activeSegment - 1] ?? 1 : 1
  );

  const handleSelectSegment = (segId: number | null) => {
    onSelectSegment?.(segId);
    usePhysiologyStore.getState().setSelectedSegment(segId);
  };

  // Imperative loading of the GLB model without Drei Suspense (Vercel React Best Practices)
  const [gltfScene, setGltfScene] = useState<THREE.Group | null>(() => cachedHeartScene);
  // LV Phase 4c: the wireframe badge distinguishes normal loading (transient) from GLB failure
  const [gltfFailed, setGltfFailed] = useState(false);

  useEffect(() => {
    let isMounted = true;
    if (!gltfScene) {
      loadRealisticHeart()
        .then((scene) => {
          if (isMounted) {
            setGltfScene(scene);
          }
        })
        .catch((err) => {
          console.error('[CardioCraft] Falha no carregamento imperativo do GLB:', err);
          if (isMounted) setGltfFailed(true);
        });
    }
    return () => {
      isMounted = false;
    };
  }, [gltfScene]);

  // Step 3: dedicated THREE.Timer for the electromechanical scene
  const sceneTimer = useRef<THREE.Timer | null>(null);
  if (!sceneTimer.current) {
    sceneTimer.current = new THREE.Timer();
  }

  // R4: dynamic THREE.Plane clipping plane coupled to angle and depth
  const clipPlane = useMemo(() => new THREE.Plane(), []);

  useEffect(() => {
    computeClipPlane(clipPlane, cutAngle, cutDepth, HEART_SCENE_ROTATION);
  }, [cutDepth, cutAngle, clipPlane]);

  // Resulting 3D Cardiac Vector P(t)
  const mainVectorGroupRef = useRef<THREE.Group>(null);
  const mainShaftRef = useRef<THREE.Mesh>(null);
  const mainHeadRef = useRef<THREE.Mesh>(null);

  // 17 regional dipole arrows p_i(t)
  const regionalGroupRef = useRef<THREE.Group>(null);

  // 3D VCG loop (circular history of 240 points)
  const VCG_PTS = 240;
  const vcgPositions = useMemo(() => new Float32Array(VCG_PTS * 3), []);
  const vcgColors = useMemo(() => {
    const arr = new Float32Array(VCG_PTS * 3);
    for (let i = 0; i < VCG_PTS; i++) {
      arr[i * 3] = 0.0;
      arr[i * 3 + 1] = 1.0;
      arr[i * 3 + 2] = 0.55;
    }
    return arr;
  }, []);
  const vcgHead = useRef(0);
  const vcgGeomRef = useRef<THREE.BufferGeometry>(null);

  useEffect(() => {
    return () => {
      sceneTimer.current?.dispose();
      vcgGeomRef.current?.dispose();
    };
  }, []);

  // Scratch objects for useFrame
  const tmpDir = useMemo(() => new THREE.Vector3(), []);
  const upVec = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const tmpQuat = useMemo(() => new THREE.Quaternion(), []);

  useFrame(() => {
    sceneTimer.current?.update();
    const live = getLive();
    const electro = live.electro;

    // Updates the dynamic plane normal and constant at 60 FPS with zero allocations
    computeClipPlane(clipPlane, cutAngle, cutDepth, HEART_SCENE_ROTATION);

    // Arrow of the Resulting 3D Cardiac Vector P(t)
    const vx = electro.vector[0] * 1.35;
    const vy = -electro.vector[1] * 1.35;
    const vz = -electro.vector[2] * 1.35;
    const mag = Math.hypot(vx, vy, vz);

    if (mainVectorGroupRef.current && mainShaftRef.current && mainHeadRef.current) {
      if (mag > 0.015) {
        mainVectorGroupRef.current.visible = true;
        tmpDir.set(vx / mag, vy / mag, vz / mag);
        tmpQuat.setFromUnitVectors(upVec, tmpDir);
        mainVectorGroupRef.current.quaternion.copy(tmpQuat);
        const len = Math.min(2.2, mag * 1.4);
        mainShaftRef.current.scale.set(1, len, 1);
        mainShaftRef.current.position.set(0, len * 0.5, 0);
        mainHeadRef.current.position.set(0, len + 0.12, 0);
      } else {
        mainVectorGroupRef.current.visible = false;
      }
    }

    // Ring of the 3D VCG loop
    if (vcgGeomRef.current) {
      const hIdx = vcgHead.current;
      vcgPositions.copyWithin(0, 3);
      const last = (VCG_PTS - 1) * 3;
      vcgPositions[last] = vx;
      vcgPositions[last + 1] = vy - 0.15;
      vcgPositions[last + 2] = vz;
      vcgHead.current = (hIdx + 1) % VCG_PTS;
      const attr = vcgGeomRef.current.getAttribute('position') as THREE.BufferAttribute;
      attr.needsUpdate = true;
    }

    // 17 regional dipoles p_i(t)
    if (regionalGroupRef.current && showDipoles) {
      const children = regionalGroupRef.current.children;
      for (let i = 0; i < 17; i++) {
        const obj = children[i] as THREE.Group | undefined;
        if (!obj) continue;
        const seg = AHA_SEGMENTS[i];
        const nuMid = 0.5 * (seg.nu0 + seg.nu1);
        const thMid = 0.5 * (seg.theta0 + seg.theta1);
        const sinProf = Math.sin(Math.max(0.12, nuMid * 0.84 * Math.PI * 0.5 + 0.08));
        const rEpi = 1.25 * sinProf;
        obj.position.set(
          rEpi * Math.cos(thMid),
          -1.42 + nuMid * 2.15,
          rEpi * Math.sin(thMid),
        );

        const dx = electro.segmentDipoles[i * 3] * 9.5;
        const dy = -electro.segmentDipoles[i * 3 + 1] * 9.5;
        const dz = -electro.segmentDipoles[i * 3 + 2] * 9.5;
        const m = Math.hypot(dx, dy, dz);
        obj.visible = m > 0.012;
        if (m > 0.012) {
          tmpDir.set(dx / m, dy / m, dz / m);
          tmpQuat.setFromUnitVectors(upVec, tmpDir);
          obj.quaternion.copy(tmpQuat);
          const arrowScale = clamp(0.55 + m * 1.65, 0.55, 1.65);
          obj.scale.set(1.15, arrowScale, 1.15);
        }
      }
    }
  });

  return (
    <group rotation={HEART_SCENE_ROTATION}>
      {/* Direct imperative loading without Drei Suspense: Wireframe while gltfScene is null, realistic mesh immediately after GLTFLoader */}
      {gltfScene ? (
        <RealisticHeartGLB
          scene={gltfScene}
          colorMode={colorMode}
          cutaway={cutaway}
          clipPlane={clipPlane}
          valveMode={valveMode}
          selectedSegment={activeSegment ?? null}
          onSelectSegment={handleSelectSegment}
        />
      ) : (
        <HeartWireframeFallback
          colorMode={colorMode}
          cutaway={cutaway}
          clipPlane={clipPlane}
          selectedSegment={activeSegment ?? null}
          onSelectSegment={handleSelectSegment}
          status={gltfFailed ? 'failed' : 'loading'}
        />
      )}

      {/* Resulting 3D Cardiac Vector P(t) at the center of the heart */}
      <group ref={mainVectorGroupRef} position={[0, -0.15, 0]} renderOrder={16}>
        <mesh ref={mainShaftRef} dispose={null} renderOrder={16}>
          <cylinderGeometry args={[0.052, 0.052, 1, 16]} />
          <meshStandardMaterial
            color="#00ff6a"
            emissive="#00ff6a"
            emissiveIntensity={0.95}
            depthTest={false}
          />
        </mesh>
        <mesh ref={mainHeadRef} dispose={null} renderOrder={16}>
          <coneGeometry args={[0.135, 0.28, 18]} />
          <meshStandardMaterial
            color="#00ff6a"
            emissive="#00ff6a"
            emissiveIntensity={1.1}
            depthTest={false}
          />
        </mesh>
      </group>

      {/* 3D Spatial Vectorcardiographic Loop */}
      {showVcgLoop && (
        <group renderOrder={15}>
          <line>
            <bufferGeometry ref={vcgGeomRef}>
              <bufferAttribute
                attach="attributes-position"
                args={[vcgPositions, 3]}
                count={VCG_PTS}
              />
              <bufferAttribute
                attach="attributes-color"
                args={[vcgColors, 3]}
                count={VCG_PTS}
              />
            </bufferGeometry>
            <lineBasicMaterial
              vertexColors
              depthTest={false}
              transparent
              opacity={0.95}
            />
          </line>
          <Line
            points={[
              [-1.4, -0.15, 0],
              [1.4, -0.15, 0],
            ]}
            color="#38bdf8"
            lineWidth={1}
          />
          <Line
            points={[
              [0, -1.45, 0],
              [0, 1.15, 0],
            ]}
            color="#34d399"
            lineWidth={1}
          />
          <Line
            points={[
              [0, -0.15, -1.4],
              [0, -0.15, 1.4],
            ]}
            color="#f59e0b"
            lineWidth={1}
          />
        </group>
      )}

      {/* 17 Regional Electrical Dipoles p_i(t) */}
      <group ref={regionalGroupRef} visible={showDipoles} renderOrder={14}>
        {AHA_SEGMENTS.map((seg) => {
          const nuMid = 0.5 * (seg.nu0 + seg.nu1);
          const thMid = 0.5 * (seg.theta0 + seg.theta1);
          const r = 1.15 * Math.sin(Math.max(0.12, nuMid * 0.84 * Math.PI * 0.5 + 0.08));
          const x = r * Math.cos(thMid);
          const y = -1.42 + nuMid * 2.15;
          const z = r * Math.sin(thMid);
          return (
            <group key={seg.id} position={[x, y, z]} renderOrder={14}>
              <mesh dispose={null} position={[0, 0.22, 0]} renderOrder={14}>
                <cylinderGeometry args={[0.026, 0.026, 0.44, 10]} />
                <meshBasicMaterial color="#38bdf8" depthTest={false} />
              </mesh>
              <mesh dispose={null} position={[0, 0.48, 0]} renderOrder={14}>
                <coneGeometry args={[0.068, 0.16, 10]} />
                <meshBasicMaterial color="#7dd3fc" depthTest={false} />
              </mesh>
            </group>
          );
        })}
      </group>

      {/* 3D Orientation and Selected Segment Label */}
      {activeSegment != null && (
        <Html position={[0, 1.95, 0]} center>
          <div className="heart-3d-badge">
            <strong>
              Seg {activeSegment}: {AHA_SEGMENTS[activeSegment - 1]?.name}
            </strong>
            <span>
              Artéria: {AHA_SEGMENTS[activeSegment - 1]?.territory.toUpperCase()} · Motilidade:{' '}
              {activeWallMotion}
            </span>
          </div>
        </Html>
      )}

      <Line
        points={[
          [-1.8, -0.15, 0],
          [1.8, -0.15, 0],
        ]}
        color="#1e293b"
        lineWidth={1}
      />
    </group>
  );
}

// ============================================================================
// Segmentation and Anatomical Geometry Utilities
// ============================================================================

const scratchClipEuler = new THREE.Euler();

export function computeClipPlane(
  clipPlane: THREE.Plane,
  cutAngle: number,
  cutDepth: number,
  groupRotation?: [number, number, number],
): THREE.Plane {
  const rad = (cutAngle * Math.PI) / 180;
  // In the heart's local anatomical space (facing the camera along +Z),
  // to remove the anterior wall and expose the endocardial cavity, valves and chordae tendineae,
  // the plane normal points to -Z (discarding anterior fragments where n · p + d < 0).
  const nx = -Math.sin(rad);
  const ny = -0.05;
  const nz = -Math.cos(rad);
  clipPlane.normal.set(nx, ny, nz).normalize();

  if (groupRotation) {
    scratchClipEuler.set(groupRotation[0], groupRotation[1], groupRotation[2]);
    clipPlane.normal.applyEuler(scratchClipEuler).normalize();
  }
  clipPlane.constant = cutDepth;
  return clipPlane;
}

const AHA_DESCRIPTIVE_PATTERNS: Array<{ segId: number; regex: RegExp }> = [
  // Composite basal first (2, 3, 5, 6)
  { segId: 2, regex: /basal[_\-\s.]*antero[_\-\s.]*s{1,2}ep(?:tal|to)?/i },
  { segId: 3, regex: /basal[_\-\s.]*infero[_\-\s.]*s{1,2}ep(?:tal|to)?/i },
  { segId: 5, regex: /basal[_\-\s.]*infero[_\-\s.]*lat(?:eral)?/i },
  { segId: 6, regex: /basal[_\-\s.]*antero[_\-\s.]*lat(?:eral)?/i },
  // Simple basal (1, 4) with word boundary
  { segId: 1, regex: /basal[_\-\s.]*ant(?:erior)?(?:[_\-\s.]|$)/i },
  { segId: 4, regex: /basal[_\-\s.]*inf(?:erior)?(?:[_\-\s.]|$)/i },

  // Composite mid first (8, 9, 11, 12)
  { segId: 8, regex: /(?:mid(?:dle)?|m[eé]dio)[_\-\s.]*antero[_\-\s.]*s{1,2}ep(?:tal|to)?/i },
  { segId: 9, regex: /(?:mid(?:dle)?|m[eé]dio)[_\-\s.]*infero[_\-\s.]*s{1,2}ep(?:tal|to)?/i },
  { segId: 11, regex: /(?:mid(?:dle)?|m[eé]dio)[_\-\s.]*infero[_\-\s.]*lat(?:eral)?/i },
  { segId: 12, regex: /(?:mid(?:dle)?|m[eé]dio)[_\-\s.]*antero[_\-\s.]*lat(?:eral)?/i },
  // Simple mid (7, 10) with word boundary
  { segId: 7, regex: /(?:mid(?:dle)?|m[eé]dio)[_\-\s.]*ant(?:erior)?(?:[_\-\s.]|$)/i },
  { segId: 10, regex: /(?:mid(?:dle)?|m[eé]dio)[_\-\s.]*inf(?:erior)?(?:[_\-\s.]|$)/i },

  // Apical (13..16)
  { segId: 13, regex: /apical[_\-\s.]*ant(?:erior)?(?:[_\-\s.]|$)/i },
  { segId: 14, regex: /apical[_\-\s.]*s{1,2}ep(?:tal|to)?/i },
  { segId: 15, regex: /apical[_\-\s.]*inf(?:erior)?(?:[_\-\s.]|$)/i },
  { segId: 16, regex: /apical[_\-\s.]*lat(?:eral)?/i },

  // Apex (17)
  { segId: 17, regex: /(?:apex|[aá]pice|apical[_\-\s.]*cap)/i },
];

export function parseNodeAnatomy(
  mesh: THREE.Mesh,
  modelBox: THREE.Box3,
): {
  segId?: number;
  territory?: CoronaryTerritory;
  isVessel?: boolean;
  isExplicitSegment?: boolean;
  isVentricular?: boolean;
  chamber?: 'rv' | 'la' | 'ra' | 'aorta' | 'pulmonary';
  isValve?: boolean;
  isStructure?: boolean;
  valveType?: 'mitral' | 'aortic' | 'tricuspid' | 'pulmonary';
} {
  // 0. Absolute priority for telemetry embedded in the GLTF extras (child.userData)
  const uData = (mesh as any)?.userData ?? {};
  if (typeof uData.segId === 'number' && uData.segId >= 1 && uData.segId <= 17) {
    return {
      segId: uData.segId,
      territory: (uData.territory as CoronaryTerritory) || AHA_SEGMENTS[uData.segId - 1]?.territory,
      isExplicitSegment: true,
      isVentricular: true,
    };
  }

  const name = (mesh?.name || '').toLowerCase();

  // 1. Names with an explicit AHA segment convention (e.g. segment_1..17, aha_1..17, seg_1..17)
  const segMatch = name.match(/(?:^|[_\-\s.])(?:seg(?:ment)?|aha)[_\-\s.]*0*(\d{1,2})(?:[_\-\s.]|$)/i);
  if (segMatch) {
    const num = parseInt(segMatch[1], 10);
    if (num >= 1 && num <= 17) {
      return {
        segId: num,
        territory: AHA_SEGMENTS[num - 1].territory,
        isExplicitSegment: true,
        isVentricular: true,
      };
    }
  }

  // 2. Official AHA descriptive names in Portuguese and English (e.g. mid_anterior, basal_anteroseptal, apex)
  for (let i = 0; i < AHA_DESCRIPTIVE_PATTERNS.length; i++) {
    const item = AHA_DESCRIPTIVE_PATTERNS[i];
    if (item.regex.test(name)) {
      return {
        segId: item.segId,
        territory: AHA_SEGMENTS[item.segId - 1].territory,
        isExplicitSegment: true,
        isVentricular: true,
      };
    }
  }

  // 3. Coronary vessels (LAD, LCX, RCA; DA/CX/CD in Portuguese) — uses word boundaries to avoid confusion with mesh_data, etc.
  if (
    /(?:^|[_\-\s.])(?:lad|da)(?:[_\-\s.]|$)/i.test(name) ||
    name.includes('anterior_interventricular') ||
    name.includes('descendente_anterior') ||
    name.includes('descending_artery')
  ) {
    return { isVessel: true, territory: 'lad' };
  }
  if (
    /(?:^|[_\-\s.])(?:lcx|cx)(?:[_\-\s.]|$)/i.test(name) ||
    name.includes('circumflex') ||
    name.includes('circunflexa')
  ) {
    return { isVessel: true, territory: 'lcx' };
  }
  if (
    /(?:^|[_\-\s.])(?:rca|cd)(?:[_\-\s.]|$)/i.test(name) ||
    name.includes('right_coronary') ||
    name.includes('coronaria_direita')
  ) {
    return { isVessel: true, territory: 'rca' };
  }

  // 4. Valvular structures and chordae tendineae (must not be associated with chambers or AHA segments)
  if (name.includes('mitral')) {
    return { isValve: true, isStructure: true, valveType: 'mitral' };
  }
  if (name.includes('aortic_valve') || name.includes('valva_aortica') || name.includes('valvula_aortica')) {
    return { isValve: true, isStructure: true, valveType: 'aortic' };
  }
  if (name.includes('tricuspid')) {
    return { isValve: true, isStructure: true, valveType: 'tricuspid' };
  }
  if (name.includes('pulmon') && (name.includes('valve') || name.includes('valva') || name.includes('valvula'))) {
    return { isValve: true, isStructure: true, valveType: 'pulmonary' };
  }
  if (
    name.includes('valve') ||
    name.includes('valva') ||
    name.includes('folheto') ||
    name.includes('cordoalha') ||
    name.includes('chordae')
  ) {
    return { isValve: true, isStructure: true };
  }

  // 5. Cardiac chambers, great vessels and ventricular myocardium
  if (name.includes('aorta') || name.includes('aortic')) return { chamber: 'aorta' };
  if (name.includes('pulmon')) return { chamber: 'pulmonary' };
  if (name.includes('cava') || name.includes('vcs') || name.includes('ivc') || uData.isStructure || uData.isGreatVessel) {
    return { isStructure: true };
  }
  if (
    name.includes('right_ventricle') ||
    /(?:^|[_\-\s.])rv(?:[_\-\s.]|$)/i.test(name) ||
    name.includes('ventriculo_direito')
  ) {
    return { chamber: 'rv' };
  }
  if (
    name.includes('left_atrium') ||
    /(?:^|[_\-\s.])la(?:[_\-\s.]|$)/i.test(name) ||
    name.includes('atrio_esquerdo')
  ) {
    return { chamber: 'la' };
  }
  if (
    name.includes('right_atrium') ||
    /(?:^|[_\-\s.])ra(?:[_\-\s.]|$)/i.test(name) ||
    name.includes('atrio_direito')
  ) {
    return { chamber: 'ra' };
  }
  if (
    name.includes('left_ventricle') ||
    /(?:^|[_\-\s.])lv(?:[_\-\s.]|$)/i.test(name) ||
    name.includes('ventriculo_esquerdo') ||
    name.includes('myocardi')
  ) {
    return { isVentricular: true };
  }

  // 5. 3D spatial classification in prolate spheroidal coordinates for ventricular sub-meshes
  mesh.geometry.computeBoundingBox();
  if (mesh.geometry.boundingBox) {
    const meshBox = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const meshH = meshBox.max.y - meshBox.min.y;
    const totalH = Math.max(0.001, modelBox.max.y - modelBox.min.y);

    // If the mesh occupies more than 45% of the total heart height, it is a composite ventricular wall (e.g. the whole LV)
    // We do not lock onto a single segId; per-point raycasting identifies the clicked segment.
    if (meshH > 0.45 * totalH) {
      return { isVentricular: true };
    }

    const center = new THREE.Vector3();
    meshBox.getCenter(center);
    const nu = clamp((center.y - modelBox.min.y) / totalH, 0, 1);
    const theta = (Math.atan2(center.z, center.x) + Math.PI * 2) % (Math.PI * 2);
    const segIdx = classifyAhaSegment(nu, theta);
    return {
      segId: segIdx + 1,
      territory: AHA_SEGMENTS[segIdx].territory,
      isExplicitSegment: false,
      isVentricular: true,
    };
  }

  return {};
}

export interface LvMeshData {
  geometry: THREE.BufferGeometry;
  restNu: Float32Array;
  restTheta: Float32Array;
  restLayer: Float32Array;
  segIds: Uint8Array;
  vCount: number;
}

export function buildLv17Geometry(): LvMeshData {
  const nNu = 36;
  const nTheta = 60;
  const ringVerts = (nNu + 1) * (nTheta + 1);
  const vCount = ringVerts * 2;

  const positions = new Float32Array(vCount * 3);
  const colors = new Float32Array(vCount * 3);
  const restNu = new Float32Array(vCount);
  const restTheta = new Float32Array(vCount);
  const restLayer = new Float32Array(vCount);
  const segIds = new Uint8Array(vCount);

  let ptr = 0;
  for (let layer = 0; layer < 2; layer++) {
    for (let i = 0; i <= nNu; i++) {
      const nu = i / nNu;
      for (let j = 0; j <= nTheta; j++) {
        const theta = (j / nTheta) * Math.PI * 2;
        restNu[ptr] = nu;
        restTheta[ptr] = theta;
        restLayer[ptr] = layer;
        segIds[ptr] = classifyAhaSegment(nu, theta);
        colors[ptr * 3] = 0.75;
        colors[ptr * 3 + 1] = 0.2;
        colors[ptr * 3 + 2] = 0.25;

        // Initial rest geometry so that boundingSphere and raycast work immediately
        const sinProfile = Math.sin(Math.max(0.06, nu * 0.84 * Math.PI * 0.5 + 0.08));
        const baseEndoR = 0.78 * sinProfile;
        const wallH = 0.24 * (0.65 + 0.35 * sinProfile);
        const r = baseEndoR + layer * wallH;
        const y = -1.42 + nu * 2.15;
        positions[ptr * 3] = r * Math.cos(theta);
        positions[ptr * 3 + 1] = y;
        positions[ptr * 3 + 2] = r * Math.sin(theta);

        ptr++;
      }
    }
  }

  const indices: number[] = [];
  const stride = nTheta + 1;
  for (let layer = 0; layer < 2; layer++) {
    const offset = layer * ringVerts;
    for (let i = 0; i < nNu; i++) {
      for (let j = 0; j < nTheta; j++) {
        const a = offset + i * stride + j;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        if (layer === 0) {
          indices.push(a, b, c, b, d, c);
        } else {
          indices.push(a, c, b, b, c, d);
        }
      }
    }
  }

  const iBase = nNu;
  for (let j = 0; j < nTheta; j++) {
    const endoA = iBase * stride + j;
    const endoB = endoA + 1;
    const epiA = ringVerts + endoA;
    const epiB = ringVerts + endoB;
    indices.push(endoA, epiA, endoB, endoB, epiA, epiB);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return { geometry, restNu, restTheta, restLayer, segIds, vCount };
}

/** Returns the index (0..16) of the AHA/ASE segment for (ν, θ). */
export function classifyAhaSegment(nu: number, theta: number): number {
  if (nu < 0.14) return 16; // 17: Apex
  const deg = ((theta * 180) / Math.PI + 360) % 360;
  if (nu < 0.36) {
    // Apical: 13..16 (4 × 90°)
    const k = Math.floor(((deg + 15) % 360) / 90);
    return 12 + (k % 4);
  }
  const k = Math.floor(deg / 60) % 6;
  if (nu < 0.68) {
    return 6 + k; // Mid: 7..12
  }
  return k; // Basal: 1..6
}

export function buildCoronaryArteries() {
  const aortaCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.05, 0.75, 0.1),
    new THREE.Vector3(0.08, 1.55, 0.12),
    new THREE.Vector3(0.0, 2.02, -0.08),
    new THREE.Vector3(-0.35, 1.85, -0.38),
  ]);
  const pulmCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.35, 0.8, 0.45),
    new THREE.Vector3(-0.22, 1.45, 0.35),
    new THREE.Vector3(0.25, 1.62, 0.15),
  ]);
  const ladCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.22, 0.72, 0.45),
    new THREE.Vector3(0.32, 0.15, 0.88),
    new THREE.Vector3(0.25, -0.62, 0.74),
    new THREE.Vector3(0.08, -1.35, 0.25),
  ]);
  const lcxCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.25, 0.72, 0.35),
    new THREE.Vector3(0.85, 0.48, -0.15),
    new THREE.Vector3(0.78, -0.22, -0.68),
    new THREE.Vector3(0.45, -0.78, -0.52),
  ]);
  const rcaCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.18, 0.72, 0.35),
    new THREE.Vector3(-0.78, 0.25, -0.15),
    new THREE.Vector3(-0.42, -0.45, -0.78),
    new THREE.Vector3(0.02, -1.05, -0.58),
  ]);

  return {
    aortaGeom: new THREE.TubeGeometry(aortaCurve, 28, 0.22, 16, false),
    pulmGeom: new THREE.TubeGeometry(pulmCurve, 22, 0.19, 14, false),
    ladGeom: new THREE.TubeGeometry(ladCurve, 24, 0.038, 10, false),
    lcxGeom: new THREE.TubeGeometry(lcxCurve, 24, 0.035, 10, false),
    rcaGeom: new THREE.TubeGeometry(rcaCurve, 24, 0.036, 10, false),
  };
}

export function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
