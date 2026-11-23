import * as THREE from 'three';
import { ahaWedgeOf, lvEnvelopeRadius, LV_ANALYTIC_PROFILE } from './rvGeometryMetrics';
import { RV_WALL_PARAMS, rvPapillaryExtensions, papillaryBasalWeights } from './rvGeometry';
import { TRICUSPID_APPARATUS_NODE_NAMES } from './tricuspidApparatusPose';
import chordaMappingRaw from './chorda_topological_mapping.json';
import { GLTF_SCALE_MM_PER_UNIT, applyValvarDeformation, type LeafletSpec, type ValvarKinematicsData } from './valvarKinematics';
import { createLvEpiEnvelope, fillLvEpiEnvelopeUniform, lvEnvelopeShrink, lvEnvelopeShrinkTh, lvMeshExcessTh, lvLocalTopTh, LV_LAMBDA_ES_NOMINAL, type LvEpiEnvelope } from './lvContractionField';

// ============================================================================
// Right ventricle (RV) contraction driven by volume, in 3 components
// ----------------------------------------------------------------------------
// Literature (abstracts verified on PubMed):
//  - Kovács A et al. Heart Fail Rev 2019, doi 10.1007/s10741-019-09778-1: the RV contracts by
//    longitudinal shortening (tricuspid annulus toward the apex), radial motion of the free wall
//    ("bellows") and anteroposterior shortening (free wall stretched over the septum).
//  - Lakatos BK et al. J Am Soc Echocardiogr 2020, doi 10.1016/j.echo.2020.04.002: relative
//    contribution to RVEF in 300 healthy adults: longitudinal 47 ± 9%, radial 44 ± 10%,
//    anteroposterior 49 ± 7%.
//  - RVEF of healthy controls: 61 ± 5% (Lakatos 2018, doi 10.1152/ajpheart.00304.2018) and
//    60 ± 5% (Ujvári 2024, doi 10.1055/a-2259-2203).
//
// Model:
//  - Driver: vRV from the engine. Fill fraction f = (vRV − ESV)/(EDV − ESV) ∈ [0, 1] (1 at EDV,
//    0 at ESV), with EDV/ESV of the previous beat (max/min of vRV), for diagnostics.
//    Since the deformation depends only on volume, the RV stays still while the volume does not change
//    (isovolumetric contraction and relaxation). The RBBB delay is already built into vRV
//    (rvDelay in the engine elastance).
//  - Affine deformation along three orthogonal RV axes, in the mesh parent space:
//      L  (longitudinal): from the RV apex to the tricuspid annulus center; pivot at the apex.
//      R  (radial): perpendicular to the septum (from the LV axis toward the RV); pivot at the septal plane.
//      AP (anteroposterior): L × R, parallel to the septum; pivot at the mid-septal plane.
//    Each axis shortens by the factor (1 − k_i), with k_i = w_i·λ and w = (0.47; 0.44; 0.49).
//  - λ is solved every frame so that the mesh volume follows the engine volume:
//      Π(1 − w_i·λ) = vRV(t)/V_ref  ⇒  mesh EF = engine RVEF,
//    with V_ref following the EDV with τ = 1.5 s (no jump at beat change with respiration).
//    Since the transform is affine and the septal plane is invariant, the mesh cavity volume
//    scales exactly by the determinant Π(1 − k_i).
//
// Procedural RV wall coupling:
//  - explicit references: apex = geometry.userData.rvApex; annulus = center of the annulus ALREADY posed by T_TV;
//  - per-vertex weights from `septalWeight`: the free wall receives the 3 components in cylindrical
//    coordinates (θ, y, f) around the LV axis, with f ≥ ε: no vertex enters the LV, by construction;
//  - the wall entry edge is the annulus's own edge and follows the annulus field exactly;
//  - volume: CLOSED cavity (same definition as measureRvCavityVolume) and precomputed q(λ) table;
//  - papillary bases: local skinning (they follow the wall or, for the septal one, the sliding septum).
//  Revert: RV_PROCEDURAL_ENABLED = false returns the GLB mesh, which uses the affine deformation below.
//
// Non-rigid annulus, sliding septum, and papillary kinematics (literature values with DOIs in constants):
//  - NON-rigid annulus: affine field Δ(x) along the septal → lateral chord (ρ at the septal point, 1 at the lateral), with deviation α only
//    on the septal side. Applied to the node MATRIX (annulus, leaflets, chordae), because valvarKinematicsComponent rewrites the local
//    positions of leaflets and chordae every frame; the wall edge uses the same Δ(x), so the annulus–wall gap stays ≈ 0;
//  - septum: slides over the LV epicardium (y changes, resting f preserved, f ≥ ε), profile 1 − v^p, no folding;
//  - papillary muscles: base attached to the wall (skinning); tip = base + (1 − s)·L0 in the direction that follows the annulus; body interpolated;
//  - chordae: the leaflet end follows Δ(x), the papillary end follows the tip; length varies only in systole.
//
// Chordal tie-rod constraints:
//  - chordae as tie rods: interval constraints (±RV_LEAFLET_RIG.maxChordStrain of the length with the valve closed), solved by
//    iterative projection over a single continuous Gaussian field across the three leaflets (zero at the hinge, same weight as the valvar kinematics).
//    A chorda within range needs no correction; the smooth field carries the neighboring leaflet along, which avoids crumpling the coaptation edge;
//  - chordae: the leaflet end receives the displacement of its own insertion vertex, without opening a gap.
// ============================================================================

/** Relative weights of the components (Lakatos 2020 means). */
export const RV_COMPONENT_WEIGHTS = {
  longitudinal: 0.47,
  radial: 0.44,
  anteroposterior: 0.49,
} as const;

/** Minimum excursion volume (mL) for considering the beat valid. */
const RV_MIN_STROKE_ML = 2;

/**
 * Capacity of the running-maximum RV volume trace per beat (samples). At 1 ms it covers an RR of 4 s;
 * after that the trace stops growing and the query uses the last sample.
 */
const RV_TRACE_N = 4096;

export interface RvVolumeTracker {
  /** RV EDV of the last complete beat (mL) */
  edv: number;
  /** RV ESV of the last complete beat (mL) */
  esv: number;
  beatMax: number;
  beatMin: number;
  lastBeat: number;
  samples: number;
  valid: boolean;
  /**
   * LV Phase 5c (D-VE34): reference EDV for the fill in the current beat (Infinity = no correction). It only decreases, and only at samples where
   * vRV is a new running maximum and M_{k−1}(τ) < EDV_prev: min of [EDV_prev + M_k(τ) − M_{k−1}(τ)], M = running maximum since the start of the
   * beat, τ = time in the beat (clock; without it, sample count). In periodic rhythm M_k = M_{k−1} and the reference is the previous
   * EDV. Does not change edv (which feeds the geometry V_ref).
   */
  edvRef: number;
  /** traces (τ, M) of the current and previous beats, preallocated; prvOk = the previous one closed valid */
  curTau: Float64Array;
  curM: Float64Array;
  curN: number;
  prvTau: Float64Array;
  prvM: Float64Array;
  prvN: number;
  prvOk: boolean;
  /** query pointer in the previous trace (τ grows within the beat) */
  prvJ: number;
}

export function createRvVolumeTracker(): RvVolumeTracker {
  return {
    edv: 0, esv: 0, beatMax: -Infinity, beatMin: Infinity, lastBeat: -1, samples: 0, valid: false,
    edvRef: Infinity, curTau: new Float64Array(RV_TRACE_N), curM: new Float64Array(RV_TRACE_N), curN: 0,
    prvTau: new Float64Array(RV_TRACE_N), prvM: new Float64Array(RV_TRACE_N), prvN: 0, prvOk: false, prvJ: 0,
  };
}

/**
 * Accumulates max/min of vRV per beat; closes the beat when beatIndex changes.
 * LV Phase 5c (D-VE34): also the EDV reference of the current beat (edvRef), aligned by the time in the beat `tInBeat`
 * (clock.tInBeat; NaN = sample count). No allocation.
 */
export function updateRvVolumeTracker(tr: RvVolumeTracker, vRV: number, beatIndex: number, tInBeat = NaN): void {
  if (!Number.isFinite(vRV)) return;
  if (beatIndex !== tr.lastBeat) {
    const ok = tr.lastBeat >= 0 && tr.samples > 3 && tr.beatMax - tr.beatMin > RV_MIN_STROKE_ML;
    if (ok) {
      tr.edv = tr.beatMax;
      tr.esv = tr.beatMin;
      tr.valid = true;
      // the trace of the beat that closed becomes the previous one (reference swap, no copy)
      const ta = tr.prvTau;
      const ma = tr.prvM;
      tr.prvTau = tr.curTau;
      tr.prvM = tr.curM;
      tr.curTau = ta;
      tr.curM = ma;
      tr.prvN = tr.curN;
      tr.prvOk = true;
    } else tr.prvOk = false;
    tr.curN = 0;
    tr.prvJ = 0;
    tr.edvRef = Infinity;
    tr.lastBeat = beatIndex;
    tr.beatMax = vRV;
    tr.beatMin = vRV;
    tr.samples = 0;
  }
  const tau = Number.isFinite(tInBeat) ? tInBeat : tr.samples;
  const newMax = vRV >= tr.beatMax;
  if (vRV > tr.beatMax) tr.beatMax = vRV;
  if (vRV < tr.beatMin) tr.beatMin = vRV;
  if (tr.curN < RV_TRACE_N) {
    tr.curTau[tr.curN] = tau;
    tr.curM[tr.curN] = tr.beatMax;
    tr.curN++;
  }
  if (newMax && tr.valid && tr.prvOk && tr.prvN > 0) {
    const T = tr.prvTau;
    const M = tr.prvM;
    const n = tr.prvN;
    let j = tr.prvJ;
    while (j + 1 < n && T[j + 1] <= tau) j++;
    tr.prvJ = j;
    let mp = M[j];
    if (j + 1 < n && tau > T[j] && T[j + 1] > T[j]) mp = M[j] + ((M[j + 1] - M[j]) * (tau - T[j])) / (T[j + 1] - T[j]);
    // declared deviations (VE5C §3.2): only while the previous beat, at the same τ, had not yet reached its own EDV; the difference
    // M_k − M_{k−1} enters weighted by the filling progress w of the previous beat (0 at its start, 1 at EDV), with no step at the start
    if (mp < tr.edv) {
      const m0 = M[0];
      const span = tr.edv - m0;
      let w = span > 1e-9 ? (mp - m0) / span : 1;
      if (w < 0) w = 0;
      else if (w > 1) w = 1;
      const e = tr.edv + w * (tr.beatMax - mp);
      if (e < tr.edvRef) tr.edvRef = e;
    }
  }
  tr.samples++;
}

/** Fill fraction: 1 at EDV, 0 at ESV (limited to [0, 1]). LV Phase 5c: EDV = min(previous EDV, edvRef of the current beat). */
export function rvFillFraction(tr: RvVolumeTracker, vRV: number): number {
  if (!tr.valid) return 1;
  const top = tr.edvRef < tr.edv ? tr.edvRef : tr.edv;
  const sv = top - tr.esv;
  if (sv <= 0) return 1;
  const f = (vRV - tr.esv) / sv;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Lower limit of λ (q > 1: slight expansion when the beat EDV exceeds the smoothed reference). */
const RV_LAMBDA_MIN = -0.5;

/** Gains over the Lakatos weights in the per-vertex rig (calibration: Phase 4 and 4b reports). */
export const RV_RIG_GAINS = {
  longitudinal: 1.1,
  radial: 0.9,
  anteroposterior: 0.9,
} as const;

/**
 * Per-vertex field shape (Section 4 of the report): longitudinal profile 1 − v^p (p = 1: uniform
 * shortening; p = 2, adopted: larger displacement in the basal and mid portions, which reduces papillary collapse)
 * and v up to which the lateral annulus deviation dissipates.
 */
export const RV_RIG_SHAPE = {
  longitudinalPower: 2,
  ringBlendV: 0.25,
  /** Phase 4b: exponent of the septum sliding profile (1 − v^p; p = 1: uniform shortening) */
  septalSlidePower: 2,
  /** Phase 4b: fraction of the septum (from each horn) over which the anteroposterior contraction decays to zero, over the LV epicardium */
  septalApDecay: 0.5,
} as const;

/**
 * Phase 4b: septal/lateral displacement ratio of the tricuspid annulus in normal adults.
 * Hammarström 1991 (n = 10), doi 10.1016/s0894-7317(14)80524-5: lateral 24.9 ± 3.5 mm; medial 20.1 ± 2.5 mm.
 */
export const RV_ANNULUS_SEPTAL_RATIO = 20.1 / 24.9;

/**
 * Phase 4b: systolic shortening of the RV papillary muscles.
 * Fawzy 2010 (sonomicrometry, 5 pigs), doi 10.1016/j.jtcvs.2010.05.039: 0.8–1.5 mm (11.2%).
 */
export const RV_PAPILLARY_SHORTENING = 0.112;

/** Phase 4b: minimum clearance of the papillary tip to the LV epicardium (mm/unit), so the chordae do not enter the LV. */
const RV_PAPILLARY_TIP_LV_MARGIN = 2 / GLTF_SCALE_MM_PER_UNIT;

/** Phase 4b: distance to the horn (septum fraction) until sliding over the LV becomes full. */
const RV_SLIDE_HORN_RAMP = 0.25;

/**
 * Fraction of the relative annulus − base displacement that orients the papillary tip (small rotation). Design parameter, no
 * reference. Calibrated to 0.8699 by bisection for systolic tenting = 3.03 mm (q = 0.4; v = λ_ES·1.008) with LV
 * descent (Topilsky 2012 reports 3.5 ± 1.0 mm). Does not change rest (3.951 mm).
 */
export const RV_PAPILLARY_TIP_FOLLOW = 0.8699;

/** Phase 4b: maximum rotation of the base → tip direction relative to rest (cone, avoids an inverted papillary muscle). */
export const RV_PAPILLARY_TIP_MAX_ANGLE_DEG = 45;

/**
 * Phase 4c: chordae as tie rods. `maxChordStrain`: maximum length change in systole; adopted the chordal straightening from
 * Fawzy 2010 (sonomicrometry, 5 pigs, RV: 11.4%), doi 10.1016/j.jtcvs.2010.05.039. `kernelSigmaMm`: width of the Gaussian field; `iterations`: projection passes.
 */
export const RV_LEAFLET_RIG = {
  maxChordStrain: 0.114,
  kernelSigmaMm: 9,
  iterations: 32,
};

/**
 * Solves λ in Π(1 − w_i·λ) = q by bisection (monotonically decreasing function of λ).
 * q = 1 ⇒ λ = 0; q < 1 ⇒ λ > 0 (contraction); q > 1 ⇒ λ < 0 (expansion).
 * No allocation; 48 iterations give machine precision for λ ∈ [λmin, λmax].
 */
export function solveRvLambda(q: number, wL: number, wR: number, wAP: number): number {
  if (q === 1 || !Number.isFinite(q)) return 0;
  const wMax = Math.max(wL, wR, wAP);
  let lo = RV_LAMBDA_MIN;
  let hi = 0.95 / wMax;
  const qMin = (1 - wL * hi) * (1 - wR * hi) * (1 - wAP * hi);
  const qMax = (1 - wL * lo) * (1 - wR * lo) * (1 - wAP * lo);
  if (q <= qMin) return hi;
  if (q >= qMax) return lo;
  for (let it = 0; it < 48; it++) {
    const mid = 0.5 * (lo + hi);
    const p = (1 - wL * mid) * (1 - wR * mid) * (1 - wAP * mid);
    if (p > q) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export interface RvContractionRig {
  mesh: THREE.Mesh;
  /** local rest matrix (EDV), composed of the original position/quaternion/scale */
  restMatrix: THREE.Matrix4;
  /** references in the mesh parent space */
  apex: THREE.Vector3;
  annulus: THREE.Vector3;
  septalPoint: THREE.Vector3;
  axisL: THREE.Vector3;
  axisR: THREE.Vector3;
  axisAP: THREE.Vector3;
  /** vertex indices of the free-wall triangles (RV side of the septal plane) */
  freeWallIndex: Uint32Array;
  tracker: RvVolumeTracker;
  /** reference volume (mL) corresponding to the rest geometry; follows the EDV with τ = RV_REF_TAU_S */
  refVolume: number;
  /** time of the last update (s, physiological clock) */
  lastT: number;
  /** state of the last frame (diagnostics) */
  fill: number;
  lambda: number;
  kL: number;
  kR: number;
  kAP: number;
  /** scratch */
  deform: THREE.Matrix4;
  /** Phase 4: per-vertex rig of the procedural wall (null: GLB mesh, affine deformation) */
  wall: RvWallRig | null;
  /** current tricuspid annulus displacement (parent space) */
  deltaTV: THREE.Vector3;
}

/**
 * Prepares the RV deformation. Uses the node's original matrix (does not change position/quaternion/scale)
 * and sets the mesh to matrixAutoUpdate = false; the local matrix becomes A·M0.
 *
 * @param rvMesh  `right_ventricle` mesh
 * @param annulusMesh  `tricuspid_annulus` mesh (annulus reference); if absent, uses the highest RV vertex
 * @param lvAxisOrigin  point on the LV long axis in the RV mesh parent space
 * @param lvAxisDir  direction of the LV long axis in the parent space (unit)
 */
export function setupRvContraction(
  rvMesh: THREE.Mesh | null | undefined,
  annulusMesh: THREE.Mesh | null | undefined,
  lvAxisOrigin: THREE.Vector3,
  lvAxisDir: THREE.Vector3,
  valvarData: ValvarKinematicsData | null = null,
): RvContractionRig | null {
  if (!rvMesh?.isMesh || !rvMesh.geometry) return null;
  const geom = rvMesh.geometry;
  const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < 4) return null;

  // Rest matrix from the original TRS (idempotent under StrictMode)
  const restMatrix = new THREE.Matrix4().compose(rvMesh.position, rvMesh.quaternion, rvMesh.scale);
  const parent = rvMesh.parent;

  // Phase 4: procedural wall = per-vertex rig; GLB mesh (revert flag) = affine below
  if (geom.userData?.rvProcedural && geom.getAttribute('septalWeight') && geom.getAttribute('transmural')) {
    return setupProceduralRig(rvMesh, annulusMesh, lvAxisOrigin, lvAxisDir, restMatrix, valvarData);
  }

  // Tricuspid annulus center in the RV parent space
  const annulus = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let hasAnnulus = false;
  if (annulusMesh?.isMesh && annulusMesh.geometry) {
    annulusMesh.geometry.computeBoundingBox();
    const bb = annulusMesh.geometry.boundingBox;
    if (bb) {
      bb.getCenter(annulus);
      annulusMesh.updateWorldMatrix(true, false);
      annulus.applyMatrix4(annulusMesh.matrixWorld);
      if (parent) {
        parent.updateWorldMatrix(true, false);
        parent.worldToLocal(annulus);
      }
      hasAnnulus = true;
    }
  }
  if (!hasAnnulus) {
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i).applyMatrix4(restMatrix);
      if (tmp.y > maxY) {
        maxY = tmp.y;
        annulus.copy(tmp);
      }
    }
  }

  // RV apex: vertex farthest from the annulus center
  const apex = new THREE.Vector3();
  let maxD = -1;
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i).applyMatrix4(restMatrix);
    const d = tmp.distanceToSquared(annulus);
    if (d > maxD) {
      maxD = d;
      apex.copy(tmp);
    }
  }

  const axisL = new THREE.Vector3().subVectors(annulus, apex);
  if (axisL.lengthSq() < 1e-8) return null;
  axisL.normalize();

  // Septal point: local RV origin (center of the spherical shell), which lies on the septal epicardium
  const septalPoint = new THREE.Vector3().setFromMatrixPosition(restMatrix);

  // Radial axis: from the LV axis to the RV, perpendicular to the LV axis and orthogonalized against L
  const axisR = new THREE.Vector3().subVectors(septalPoint, lvAxisOrigin);
  axisR.addScaledVector(lvAxisDir, -axisR.dot(lvAxisDir));
  axisR.addScaledVector(axisL, -axisR.dot(axisL));
  if (axisR.lengthSq() < 1e-8) return null;
  axisR.normalize();
  const axisAP = new THREE.Vector3().crossVectors(axisL, axisR).normalize();

  // Free-wall triangles: centroid of the RV side of the septal plane (n = axisR)
  const index = geom.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const sel: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, ia).applyMatrix4(restMatrix);
    b.fromBufferAttribute(pos, ib).applyMatrix4(restMatrix);
    c.fromBufferAttribute(pos, ic).applyMatrix4(restMatrix);
    tmp.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(septalPoint);
    if (tmp.dot(axisR) > 0) sel.push(ia, ib, ic);
  }
  if (sel.length === 0) return null;

  rvMesh.matrixAutoUpdate = false;
  rvMesh.matrix.copy(restMatrix);
  rvMesh.matrixWorldNeedsUpdate = true;
  rvMesh.userData.rvContraction = true;

  return {
    mesh: rvMesh,
    restMatrix,
    apex,
    annulus,
    septalPoint,
    axisL,
    axisR,
    axisAP,
    freeWallIndex: new Uint32Array(sel),
    tracker: createRvVolumeTracker(),
    refVolume: 0,
    lastT: NaN,
    fill: 1,
    lambda: 0,
    kL: 0,
    kR: 0,
    kAP: 0,
    deform: new THREE.Matrix4(),
    wall: null,
    deltaTV: new THREE.Vector3(),
  };
}

/**
 * Affine matrix A (parent space): p' = p − Σ k_i·((p − pivot_i)·a_i)·a_i.
 * Pivots: apex for L; septal point for R and AP. No allocation.
 */
export function computeRvDeformMatrix(
  rig: RvContractionRig,
  kL: number,
  kR: number,
  kAP: number,
  out: THREE.Matrix4,
): THREE.Matrix4 {
  const L = rig.axisL;
  const R = rig.axisR;
  const P = rig.axisAP;
  // Linear part: I − Σ k_i a_i a_iᵀ
  const m00 = 1 - kL * L.x * L.x - kR * R.x * R.x - kAP * P.x * P.x;
  const m01 = -kL * L.x * L.y - kR * R.x * R.y - kAP * P.x * P.y;
  const m02 = -kL * L.x * L.z - kR * R.x * R.z - kAP * P.x * P.z;
  const m11 = 1 - kL * L.y * L.y - kR * R.y * R.y - kAP * P.y * P.y;
  const m12 = -kL * L.y * L.z - kR * R.y * R.z - kAP * P.y * P.z;
  const m22 = 1 - kL * L.z * L.z - kR * R.z * R.z - kAP * P.z * P.z;
  // Translation: Σ k_i (pivot_i · a_i) a_i
  const sL = kL * rig.apex.dot(L);
  const sR = kR * rig.septalPoint.dot(R);
  const sP = kAP * rig.septalPoint.dot(P);
  const tx = sL * L.x + sR * R.x + sP * P.x;
  const ty = sL * L.y + sR * R.y + sP * P.y;
  const tz = sL * L.z + sR * R.z + sP * P.z;
  out.set(
    m00, m01, m02, tx,
    m01, m11, m12, ty,
    m02, m12, m22, tz,
    0, 0, 0, 1,
  );
  return out;
}

/** Applies the deformation for a set of coefficients (k_L, k_R, k_AP). */
export function setRvDeformation(rig: RvContractionRig, kL: number, kR: number, kAP: number): void {
  rig.kL = kL;
  rig.kR = kR;
  rig.kAP = kAP;
  if (rig.wall) {
    rig.deltaTV.copy(rig.wall.dirTV).multiplyScalar(kL * rig.wall.lengthD);
    rig.wall.dirty = true;
    flushRvContraction(rig);
    return;
  }
  computeRvDeformMatrix(rig, kL, kR, kAP, rig.deform);
  rig.mesh.matrix.multiplyMatrices(rig.deform, rig.restMatrix);
  rig.mesh.matrixWorldNeedsUpdate = true;
}

/**
 * Time constant (s) with which the reference volume follows the EDV beat by beat.
 * Avoids the mesh jump at beat change when the EDV varies with respiration.
 */
export const RV_REF_TAU_S = 1.5;

/**
 * Per frame: tracks EDV/ESV, updates the reference and deforms the RV. No allocation.
 * The mesh volume follows V_mesh/V_rest = vRV/V_ref; within a beat V_ref is practically
 * constant, so the mesh EF is the engine RVEF and the RV stays still while vRV does not change.
 *
 * @param t physiological clock time (s), used only to smooth the reference
 */
export function applyRvContraction(rig: RvContractionRig | null, vRV: number, beatIndex: number, t: number, tInBeat = NaN): void {
  if (!rig) return;
  updateRvDriver(rig, vRV, beatIndex, t, tInBeat);
  flushRvContraction(rig);
}

// ----------------------------------------------------------------------------
// Emissive glow of the RV and wireframe RV, driven by the same fill fraction
// (1 − fill: 0 at EDV, 1 at ESV). Since fill depends only on vRV, they stay still in the
// isovolumetric phases and inherit the RBBB delay already built into vRV.
// ----------------------------------------------------------------------------

/** Coefficients of the RV emissive glow (the same as before, now by 1 − fill in place of eRV). */
export const RV_GLOW_R = 0.28;
export const RV_GLOW_G = 0.14;
export const RV_GLOW_B = 0.04;

/**
 * RV emissive glow by (1 − rig.fill). Without a rig, the glow term is zero (only the 0.04 blue base,
 * same as the previous diastolic rest). No allocation; returns the color itself.
 */
export function applyRvChamberEmissive(
  emissive: THREE.Color | null | undefined,
  rig: RvContractionRig | null | undefined,
): THREE.Color | null | undefined {
  if (!emissive) return emissive;
  const a = rig ? 1 - rig.fill : 0;
  emissive.setRGB(RV_GLOW_R * a, RV_GLOW_G * a, RV_GLOW_B);
  return emissive;
}

/** RV wireframe shortening at ESV (fill = 0): x/z axes and y axis. */
export const RV_WIREFRAME_CONTRACTION_XZ = 0.18;
export const RV_WIREFRAME_CONTRACTION_Y = 0.08;

export interface RvWireframeDriver {
  tracker: RvVolumeTracker;
  /** fill fraction of the last frame (1 at EDV, 0 at ESV) */
  fill: number;
  /** LV Phase 5c (D-VE34): time in the beat (clock.tInBeat) written by the caller before updateRvWireframe; NaN = sample count */
  tInBeat: number;
}

export function createRvWireframeDriver(): RvWireframeDriver {
  return { tracker: createRvVolumeTracker(), fill: 1, tInBeat: NaN };
}

/**
 * Per frame, in the wireframe: tracks EDV/ESV of vRV and scales the RV by (1 − fill). No allocation.
 * Invalid vRV keeps the last fill.
 */
export function updateRvWireframe(
  driver: RvWireframeDriver,
  vRV: number,
  beatIndex: number,
  scale: THREE.Vector3,
): void {
  if (Number.isFinite(vRV) && vRV > 0) {
    updateRvVolumeTracker(driver.tracker, vRV, beatIndex, driver.tInBeat);
    driver.fill = rvFillFraction(driver.tracker, vRV);
  }
  const a = 1 - driver.fill;
  const sXZ = 1 - RV_WIREFRAME_CONTRACTION_XZ * a;
  scale.set(sXZ, 1 - RV_WIREFRAME_CONTRACTION_Y * a, sXZ);
}

const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _vo = new THREE.Vector3();

/**
 * RV cavity volume in the current mesh (GLB³ units). Procedural wall: closed cavity (same
 * definition as measureRvCavityVolume). GLB mesh: cone from the septal point (transformed by the
 * same deformation) over the free-wall triangles. Diagnostics and tests; do not use per frame.
 */
export function measureRvMeshVolume(rig: RvContractionRig): number {
  if (rig.wall) {
    flushRvContraction(rig);
    return wallCavityVolume(rig.wall);
  }
  const pos = rig.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const m = rig.mesh.matrix;
  _vo.copy(rig.septalPoint).applyMatrix4(rig.deform);
  const idx = rig.freeWallIndex;
  let v6 = 0;
  for (let t = 0; t < idx.length; t += 3) {
    _va.fromBufferAttribute(pos, idx[t]).applyMatrix4(m).sub(_vo);
    _vb.fromBufferAttribute(pos, idx[t + 1]).applyMatrix4(m).sub(_vo);
    _vc.fromBufferAttribute(pos, idx[t + 2]).applyMatrix4(m).sub(_vo);
    v6 += _va.x * (_vb.y * _vc.z - _vb.z * _vc.y) - _va.y * (_vb.x * _vc.z - _vb.z * _vc.x) + _va.z * (_vb.x * _vc.y - _vb.y * _vc.x);
  }
  return Math.abs(v6) / 6;
}

/** Height of the LV basal plane: highest y of the endocardial vertices (first half of each wedge), in the parent space. */
export function computeLvBaseY(segmentMeshes: ReadonlyArray<THREE.Mesh>): number {
  let maxY = -Infinity;
  for (let s = 0; s < segmentMeshes.length; s++) {
    const mesh = segmentMeshes[s];
    const pos = mesh.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    mesh.updateMatrix();
    const half = pos.count / 2;
    for (let i = 0; i < half; i++) {
      _va.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrix);
      if (_va.y > maxY) maxY = _va.y;
    }
  }
  return Number.isFinite(maxY) ? maxY : 0;
}

/**
 * LV cavity volume in the current mesh: cone from the axis point on the basal plane
 * (transformed by the scale of each segment) over the endocardial triangles (first half
 * of the vertices of each wedge, per the generator). Diagnostics and tests; do not use per frame.
 */
export function measureLvCavityVolume(segmentMeshes: ReadonlyArray<THREE.Mesh>, baseY: number): number {
  let v6 = 0;
  for (let s = 0; s < segmentMeshes.length; s++) {
    const mesh = segmentMeshes[s];
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const index = geom.getIndex();
    if (!pos || !index) continue;
    const half = pos.count / 2;
    mesh.updateMatrix();
    const m = mesh.matrix;
    _vo.set(0, baseY, 0).applyMatrix4(m);
    for (let t = 0; t < index.count; t += 3) {
      const ia = index.getX(t);
      const ib = index.getX(t + 1);
      const ic = index.getX(t + 2);
      if (ia >= half || ib >= half || ic >= half) continue;
      _va.fromBufferAttribute(pos, ia).applyMatrix4(m).sub(_vo);
      _vb.fromBufferAttribute(pos, ib).applyMatrix4(m).sub(_vo);
      _vc.fromBufferAttribute(pos, ic).applyMatrix4(m).sub(_vo);
      v6 += _va.x * (_vb.y * _vc.z - _vb.z * _vc.y) - _va.y * (_vb.x * _vc.z - _vb.z * _vc.x) + _va.z * (_vb.x * _vc.y - _vb.y * _vc.x);
    }
  }
  return Math.abs(v6) / 6;
}

// ----------------------------------------------------------------------------
// Phase 4: per-vertex rig of the procedural wall
// ----------------------------------------------------------------------------

/** Range of the q(λ) table; the maximum λ corresponds to a TAPSE of RV_TAPSE_MAX_MM. */
const RV_LAMBDA_TABLE_MIN = -0.25;
const RV_LAMBDA_TABLE_N = 129;
const RV_TAPSE_MAX_MM = 30;
/** Minimum clearance of the translated annulus to the LV epicardium (mm). */
const RV_ANNULUS_LV_MARGIN_MM = 0.3;
/** Step of the lateral deviation search α (the annulus descends along −L deviating in the LV radial direction). */
const RV_ALPHA_GRID_STEP = 0.01;
/** v below which the radial and anteroposterior components do not yet act (rigid entry edge). */
const RV_RADIAL_RAMP_V = 0.2;

const LV_TOP_Y = LV_ANALYTIC_PROFILE.y0 + LV_ANALYTIC_PROFILE.height;

/**
 * Per-frame scale of the LV wedges around the origin: xz 1 − xz·v; y 1 − y·v. Since LV Phase 3 only in the branch without the per-vertex
 * field (composite model, LV_FIELD_ENABLED = false or without the watertight geometry) in HeartMesh17.
 */
export const LV_CONTRACTION_SCALE = { xz: 0.08, y: 0.04 } as const;
/**
 * LV Phase 3: v = λ of the LV field as seen by the septum (mean of λ·c_i over the segments in contact). Range followed by the RV septum
 * and nodes of the q(λ, v) table: [0; 0.9] (λ·c ≤ 1 − LV_G_MIN with c = 1), 4 nodes.
 */
export const RV_LV_V_MAX = 0.9;
/** v < 0 (LV slightly above the reference, negative field λ): linear extrapolation of nodes 0 and 1, down to the minimum λ of the LV table. */
export const RV_LV_V_MIN = -0.15;
const RV_LV_V_NODES = 4;
/** Common wall: follows the LV entirely with rest clearance up to FULL and stops following at ZERO (mm). */
const RV_LV_FOLLOW_FULL_MM = 0.6;
const RV_LV_FOLLOW_ZERO_MM = 4;
/** v of the wall up to which whatever is in contact still obeys the annulus; beyond that, the current LV epicardium. */
const RV_LV_RING_RAMP_V = 0.05;
/** Columns from the horn until full sliding of whatever touches the LV (at the horn the free wall rules). */
const RV_LV_HORN_RAMP_COLS = 12;
/** Fraction of the leftover deviation α returned to the annulus with the contracted LV (< 1: clearance so as not to invade the LV). */
const RV_LV_EXCESS_GAIN = 0.74;
/** LV Phase 4: no-penetration guard against the current LV: vertices at a < 1 mm from the LV at rest; minimum clearance (u ≈ 0.017 mm). */
const RV_LV_GUARD_MM = 1.0;
const RV_LV_GUARD_MARGIN = 0.0005;
/**
 * LV Phase 5d (A1): upper bound of |d rEpiExt/dy| (u/u). Profile r = R·s + w·(0.65 + 0.35·s), s = sin(0.84·(π/2)·ν + 0.08), ν = (y − y0)/H
 * (lvEnvelopeRadius; the argument never falls below 0.06); |dr/dy| ≤ (R + 0.35·w)·0.84·(π/2)/H. rEpiExt bounds y, which does not increase the derivative.
 */
const RV_LV_EPI_LIP =
  ((LV_ANALYTIC_PROFILE.endoRadius + 0.35 * LV_ANALYTIC_PROFILE.wallBase) * 0.84 * Math.PI * 0.5) / LV_ANALYTIC_PROFILE.height;
/** LV Phase 5d (A1): numerical slack added to the early-exit bound (u ≈ 3.4e−11 mm; covers only rounding). */
const RV_LV_GUARD_BOUND_EPS = 1e-12;

function rEpiExt(y: number): number {
  return lvEnvelopeRadius(Math.max(LV_ANALYTIC_PROFILE.y0, Math.min(LV_TOP_Y - 1e-9, y)), true);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * LV Phase 3: how far the LV epicardium has receded at point (x, y, z) relative to rest (units), per the tabulated dynamic
 * envelope (that of the LV rig when on; otherwise that of the field with c = 1 at the current v). No allocation.
 */
function lvShrinkAt(wall: RvWallRig, x: number, z: number, y: number): number {
  if (!wall.lvOn) return 0;
  return lvEnvelopeShrink(wall.lvEnvExt ?? wall.lvEnv, x, z, Math.max(LV_ANALYTIC_PROFILE.y0, Math.min(LV_TOP_Y - 1e-9, y)));
}

/** LV Phase 4d (A1): the same recession with θ already computed. No allocation. */
function lvShrinkAtTh(wall: RvWallRig, th: number, y: number): number {
  if (!wall.lvOn) return 0;
  return lvEnvelopeShrinkTh(wall.lvEnvExt ?? wall.lvEnv, th, Math.max(LV_ANALYTIC_PROFILE.y0, Math.min(LV_TOP_Y - 1e-9, y)));
}

/** Radius of the current LV epicardium at point (x, y, z) (units). No allocation. */
function lvEpiNow(wall: RvWallRig, x: number, z: number, y: number): number {
  if (!wall.lvOn) return lvEnvelopeRadius(y, true);
  return rEpiExt(y) - lvShrinkAt(wall, x, z, y);
}

interface PapillaryDrive {
  mesh: THREE.Mesh;
  /** rest position of each vertex in the parent space */
  restP: Float64Array;
  /** base weight per vertex (1 at the base, 0 in the apical third of the papillary muscle) */
  ratio: Float32Array;
  /** matrix (parent space → local) */
  invE: Float64Array;
  /** endocardial point that anchors the base (triangle and barycentric coordinates) */
  ia: number;
  ib: number;
  ic: number;
  ba: number;
  bb: number;
  bc: number;
  /** base and tip at rest (parent space), distance and current displacements (parent space) */
  bx: number;
  by: number;
  bz: number;
  tx: number;
  ty: number;
  tz: number;
  L0: number;
  dBx: number;
  dBy: number;
  dBz: number;
  dTx: number;
  dTy: number;
  dTz: number;
}

interface ChordDrive {
  obj: THREE.Object3D;
  rest: THREE.Matrix4;
  drive: PapillaryDrive | null;
  /** base weight of the papillary muscle at the chorda insertion point */
  wP: number;
  /** papillary end at rest and e = (t0 − b0)/|t0 − b0|² (parent space) */
  bx: number;
  by: number;
  bz: number;
  ex: number;
  ey: number;
  ez: number;
  /** Phase 4c: length with the valve closed, leaflet end (parent space) and its current extra displacement */
  len0: number;
  tx: number;
  ty: number;
  tz: number;
  dLx: number;
  dLy: number;
  dLz: number;
  /** Phase 4c: table row at the insertion vertex (insertion weights) */
  row: Float32Array;
}

/** Phase 4c: per-vertex displacement of a leaflet, added to the valvar kinematics. */
interface LeafletDrive {
  spec: LeafletSpec;
  n: number;
  /** n × insertions: Shepard weight × hinge limiting */
  table: Float32Array;
  /** inverse of the linear part of the node's rest matrix (by columns) */
  inv: Float64Array;
  /** current local displacement (the same array as spec.rigOffset) */
  offset: Float32Array;
}

export interface RvWallRig {
  n: number;
  /** rest positions in local space (backup) and in the parent space */
  restLocal: Float32Array;
  restP: Float64Array;
  cur: Float64Array;
  /** current cylindrical state: cos θ, sin θ, y, f */
  cosT: Float64Array;
  sinT: Float64Array;
  yy: Float64Array;
  ff: Float64Array;
  transmural: Uint8Array;
  W: Float64Array;
  hL: Float64Array;
  hR: Float64Array;
  gAP: Float64Array;
  /** band next to the annulus where the lateral deviation α acts (1 at the annulus, 0 from RV_RING_BLEND_V on) */
  ringB: Float64Array;
  /** Phase 4b: per-vertex longitudinal weight (free 1 − v²; septum 1 − v^p), annular gain ρ…1 and deviation gain (1 − τ) per column */
  wL: Float64Array;
  gCol: Float64Array;
  devCol: Float64Array;
  /** Phase 4b: 1 = pure sliding over the LV epicardium (rest f in `f0`) */
  slide: Float64Array;
  f0: Float64Array;
  partner: Int32Array;
  dY: Float64Array;
  dF: Float64Array;
  cosD: Float64Array;
  sinD: Float64Array;
  endoTri: Uint32Array;
  loops: Uint32Array[];
  /** direction of Δ_TV per unit of TAPSE at the lateral annulus point (= −L; the septal one follows the affine field) */
  dirTV: THREE.Vector3;
  /** Phase 4b: affine annulus field: Δ(x) = kL·D·(v0 + v1·((x − pS)·h)), with h = â/|septal→lateral chord| */
  v0x: number;
  v0y: number;
  v0z: number;
  v1x: number;
  v1y: number;
  v1z: number;
  hx: number;
  hy: number;
  hz: number;
  /** p_s · h, for the constant term of the field */
  hPs: number;
  shear: THREE.Matrix4;
  apparatusMat: Array<{ obj: THREE.Object3D; rest: THREE.Matrix4 }>;
  chords: ChordDrive[];
  /** Phase 4c: leaflets and displacement of each insertion (3 per chorda) */
  leaflets: LeafletDrive[];
  anchorD: Float64Array;
  /** longitudinal axis (−L), annulus deviation (α·ê) and AP axis, with the AP pivot (septal point) */
  dlx: number;
  dly: number;
  dlz: number;
  dex: number;
  dey: number;
  dez: number;
  ax: number;
  ay: number;
  az: number;
  px: number;
  py: number;
  pz: number;
  alpha: number;
  /** annulus → apex distance along L */
  lengthD: number;
  lambdaMax: number;
  lamGrid: Float64Array;
  qGrid: Float64Array;
  restVolume: number;
  /** rest normals and at the systolic reference (visual interpolation) */
  nRest: Float32Array;
  nRef: Float32Array;
  kLref: number;
  invM: THREE.Matrix4;
  papillaries: PapillaryDrive[];
  epsEndo: number;
  epsEpi: number;
  dirty: boolean;
  /** Common wall: weight of following the current LV epicardium per vertex (1 in contact, 0 on the free wall) */
  lvFollow: Float64Array;
  /** LV Phase 4: vertices near the LV at rest (< 1 mm) that never end up inside the current epicardium (no-penetration guard) */
  lvGuard: Uint8Array;
  /** 0 at the edge (the annulus rules), 1 from RV_LV_RING_RAMP_V on (the current epicardium rules) */
  lvRing: Float64Array;
  /** current LV contraction as seen by the septum (v = λ of the field), recession at the septal point of the annulus (units) */
  lvV: number;
  lvE: number;
  /** LV Phase 3: own dynamic epicardial envelope (field with c = 1 at v), that of the LV rig (if on) and whether there is recession */
  lvEnv: LvEpiEnvelope;
  lvEnvExt: LvEpiEnvelope | null;
  lvOn: boolean;
  /** radial direction of the septal side of the annulus and height of the septal point at rest */
  eux: number;
  euy: number;
  euz: number;
  annSepX: number;
  annSepY: number;
  annSepZ: number;
  annSepF0: number;
  /** q(λ, v): RV_LV_V_NODES rows of RV_LAMBDA_TABLE_N values; row 0 equals qGrid */
  qGridV: Float64Array;
  /**
   * LV Phase 5b (consequence of B1): q(λ) with the LV at v = RV_LV_V_MIN (negative field λ: radial only, the base does not rise). For v < 0 the
   * table interpolates between v = 0 and this node (before: linear extrapolation of nodes 0 and 1, which assumed the base rising with λ < 0).
   */
  qGridNeg: Float64Array;
  /** reference k_L (q = 0.4) at each v node */
  kLrefV: Float64Array;
  /** weight of each AHA segment on the LV face touching the RV (sums to 1) */
  lvSegWeights: Float64Array;
}

/** Rest copies per geometry (StrictMode: repeated setup does not capture the deformed pose). */
const wallRestCache = new WeakMap<THREE.BufferGeometry, Float32Array>();
const papRestCache = new WeakMap<THREE.BufferGeometry, Float32Array>();

function rigGains(lambda: number, out: [number, number, number]): [number, number, number] {
  out[0] = RV_COMPONENT_WEIGHTS.longitudinal * RV_RIG_GAINS.longitudinal * lambda;
  out[1] = RV_COMPONENT_WEIGHTS.radial * RV_RIG_GAINS.radial * lambda;
  out[2] = RV_COMPONENT_WEIGHTS.anteroposterior * RV_RIG_GAINS.anteroposterior * lambda;
  return out;
}

/**
 * Evaluates the wall at (kL, kR, kAP) into the array `cur` (parent space). No allocation.
 * Longitudinal: descends along −L, with weight (1 − v); the lateral deviation α acts only next to the annulus.
 * Anteroposterior: Cartesian contraction along the AP axis, pivot at the septal point.
 * Radial: shortens the distance f to the septum. f ≥ ε_endo: no moving vertex enters the LV.
 */
function evaluateWall(wall: RvWallRig, kL: number, kR: number, kAP: number): void {
  // LV Phase 3: the LV envelope may have been rewritten after setRvLvContraction in this frame
  if (wall.lvEnvExt) wall.lvOn = wall.lvEnvExt.active;
  const { n, restP, cur, cosT, sinT, yy, ff, transmural: tr, W, hR, gAP, ringB, wL, gCol, devCol, slide, f0, partner, dY, dF, cosD, sinD, epsEndo, epsEpi } = wall;
  const { dlx, dly, dlz, dex, dey, dez, ax, ay, az, px, py, pz, lvFollow, lvRing, lvV, lvOn, eux, euy, euz, lvGuard } = wall;
  // Common wall: recession of the septal side of the annulus so the septal point keeps the rest clearance to the current epicardium.
  // With the LV contracted, the deviation α (sized against the resting LV) is in excess; the excess enters gradually, with v
  // (LV Phase 3: v normalized by the nominal end-systole λ, which plays the role of the former v = 1).
  let lvE = 0;
  if (lvOn) {
    const D = kL * wall.lengthD;
    const sx = wall.annSepX + D * wall.v0x;
    const sy = wall.annSepY + D * wall.v0y;
    const sz = wall.annSepZ + D * wall.v0z;
    const shrink = lvShrinkAt(wall, sx, sz, sy);
    const excess = Math.max(0, Math.hypot(sx, sz) - rEpiExt(sy) - wall.annSepF0);
    lvE = shrink + RV_LV_EXCESS_GAIN * Math.max(0, Math.min(1, lvV / LV_LAMBDA_ES_NOMINAL)) * excess;
  }
  wall.lvE = lvE;
  // LV Phase 5d (A1, D-VE35): the guard applies to EVERY RV vertex, not only to lvGuard ones (those at a < 1 mm from the LV at rest). Exact
  // early exit for the others: the guard only pushes up to rMin = rEpiExt(y) − recession + clearance + margin ≤ rEpiExt(y) + gSlack (recession ≥ −outMax,
  // margin ≤ divMaxSlack). With u_Lv ≠ 0 the final position comes from (rr, y) by −u_Lv·ê: r' ≥ rr − |u_Lv|·|ê_xz| and
  // rEpiExt(y') ≤ rEpiExt(y) + |u_Lv·ê_y|·Lip. Whoever stays outside this bound cannot be changed by the guard and does not query it.
  const envG = wall.lvEnvExt ?? wall.lvEnv;
  const gSlack = lvOn ? RV_LV_GUARD_MARGIN + envG.divMaxSlack + envG.outMax + RV_LV_GUARD_BOUND_EPS : 0;
  const eH = Math.hypot(eux, euz);
  const eV = Math.abs(euy) * RV_LV_EPI_LIP;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    // Part of the recession from the annulus field (next to the annulus) and part from the current epicardium (below it)
    const lvW = lvFollow[i];
    const lvR = lvRing[i];
    const uLv = lvE === 0 ? 0 : lvE * devCol[i] * (ringB[i] * (1 - lvW) + lvW * (1 - lvR));
    const wLv = lvOn ? lvW * lvR : 0;
    if (tr[i] === 0) {
      const wi = W[i];
      // Longitudinal (annular gain ρ…1 of the column) + septal-side deviation
      const uL = kL * gCol[i] * wL[i];
      const uE = kL * devCol[i] * ringB[i];
      let x = restP[i3] + uL * dlx + uE * dex;
      let y = restP[i3 + 1] + uL * dly + uE * dey;
      let z = restP[i3 + 2] + uL * dlz + uE * dez;
      const hr = hR[i];
      const sl = slide[i];
      if (hr === 0 && sl === 0) {
        // entry edge: exact translation (the edge stays with the annulus)
        // LV Phase 5b (performance, P2; identical result): the radius is only used in this branch
        const r0 = Math.hypot(x, z);
        cosT[i] = x / r0;
        sinT[i] = z / r0;
        yy[i] = y;
        ff[i] = r0 - rEpiExt(y);
        cur[i3] = x - uLv * eux;
        cur[i3 + 1] = y - uLv * euy;
        cur[i3 + 2] = z - uLv * euz;
        // LV Phase 5d (A1): rr = r0 and rEpiExt(y) = r0 − ff ⇒ the bound becomes ff < |u_Lv|·(|ê_xz| + |ê_y|·Lip) + gSlack
        if (lvOn && (lvGuard[i] === 1 || ff[i] < Math.abs(uLv) * (eH + eV) + gSlack)) guardLv(wall, cur, i3);
        continue;
      }
      // Anteroposterior: contraction along â, pivot at the septal point
      const wAP = kAP * hr * gAP[i];
      if (wAP !== 0) {
        const d = (x - px) * ax + (y - py) * ay + (z - pz) * az;
        x -= wAP * d * ax;
        y -= wAP * d * ay;
        z -= wAP * d * az;
      }
      const r = Math.hypot(x, z);
      const c = x / r;
      const s = z / r;
      const rE = rEpiExt(y);
      let f = r - rE;
      // Septum and transition zone: slides over the LV epicardium keeping the rest offset
      if (sl > 0) f += sl * (f0[i] - f);
      // Radial: shortens the distance to the septum
      if (f > epsEndo) f = epsEndo + (f - epsEndo) * (1 - kR * wi * hr);
      if (f < epsEndo) f = epsEndo;
      cosT[i] = c;
      sinT[i] = s;
      yy[i] = y;
      ff[i] = f;
      const g0 = lvOn && lvGuard[i] === 1;
      // LV Phase 4d (A1): θ computed once for the recession, the mesh margin and the local top
      const th = wLv !== 0 || g0 ? Math.atan2(z, x) : 0;
      const sh = wLv === 0 ? 0 : lvShrinkAtTh(wall, th, y);
      const rr = rE + f - wLv * sh;
      cur[i3] = rr * c - uLv * eux;
      cur[i3 + 1] = y - uLv * euy;
      cur[i3 + 2] = rr * s - uLv * euz;
      // LV Phase 5d (A1): the other vertices enter the guard only if the exact early exit does not exclude them (θ is only used in the fast branch,
      // which requires wLv ≠ 0 and so has already been computed)
      const g = g0 || (lvOn && rr - rE < Math.abs(uLv) * (eH + eV) + gSlack);
      if (g) {
        // LV Phase 4b (performance, same result): far from the annulus (u_Lv = 0) the final position has the same θ and the same y as the query
        // above and r = rr; the guard becomes rr < rE − recession + clearance, without a new grid query or new rEpiExt
        if (uLv === 0 && wLv !== 0) guardLvFast(wall, cur, i3, y, rr, c, s, rE - sh + RV_LV_GUARD_MARGIN, th);
        else guardLv(wall, cur, i3);
      }
    } else {
      // Epicardium: displaces like the corresponding endocardium, keeping the rest offsets in (θ, y, f)
      const k = partner[i];
      const c0 = cosT[k];
      const s0 = sinT[k];
      const c = c0 * cosD[i] - s0 * sinD[i];
      const s = s0 * cosD[i] + c0 * sinD[i];
      const y = yy[k] + dY[i];
      let f = ff[k] + dF[i];
      if (f < epsEpi) f = epsEpi;
      const rE2 = rEpiExt(y);
      const g0 = lvOn && lvGuard[i] === 1;
      const th = wLv !== 0 || g0 ? Math.atan2(s, c) : 0;
      const sh = wLv === 0 ? 0 : lvShrinkAtTh(wall, th, y);
      const rr = rE2 + f - wLv * sh;
      cur[i3] = rr * c - uLv * eux;
      cur[i3 + 1] = y - uLv * euy;
      cur[i3 + 2] = rr * s - uLv * euz;
      // Boundary case: same projection as the endocardium (even when lvGuard = 0 near the contact seam)
      const g = g0 || (lvOn && rr - rE2 < Math.abs(uLv) * (eH + eV) + gSlack);
      if (g) {
        if (uLv === 0 && wLv !== 0) guardLvFast(wall, cur, i3, y, rr, c, s, rE2 - sh + RV_LV_GUARD_MARGIN, th);
        else guardLv(wall, cur, i3);
      }
    }
  }
}

/**
 * LV Phase 4b: the same guard when the final position is (rr·c, y, rr·s) and the recession at that (θ, y) has already been queried (rMin ready).
 * Same result as guardLv (rounding only). No allocation.
 * LV Phase 4d (A1): + margin of the triangulated LV mesh (excess measured over the grid + clearance; 0 without the LV rig) and LOCAL LV top at θ
 * (before: the lowest top, which left the band between it and the local top without a guard).
 */
function guardLvFast(wall: RvWallRig, cur: Float64Array, i3: number, y: number, rr: number, c: number, s: number, rMin: number, th: number): void {
  if (y < LV_ANALYTIC_PROFILE.y0) return;
  const env = wall.lvEnvExt ?? wall.lvEnv;
  // LV Phase 5b (performance, P1; identical result): rm ≤ rMin + largest margin of the frame; whoever is already beyond that is not pushed and
  // does not query the local top or the mesh margin
  if (rr >= rMin + env.divMaxSlack) return;
  if (y > lvLocalTopTh(env, th)) return;
  const rm = rMin + lvMeshExcessTh(env, th, y);
  if (rr < rm && rr > 0) {
    cur[i3] = c * rm;
    cur[i3 + 2] = s * rm;
  }
}

/** LV Phase 4: no-penetration guard at the final position (radial, up to the current epicardium + clearance; only below the current top). Phase 4d: likewise above. */
function guardLv(wall: RvWallRig, cur: Float64Array, i3: number): void {
  const y = cur[i3 + 1];
  if (y < LV_ANALYTIC_PROFILE.y0) return;
  const x = cur[i3];
  const z = cur[i3 + 2];
  const th = Math.atan2(z, x);
  const env = wall.lvEnvExt ?? wall.lvEnv;
  if (y > lvLocalTopTh(env, th)) return;
  const r = Math.hypot(x, z);
  const rMin = rEpiExt(y) - lvShrinkAtTh(wall, th, y) + RV_LV_GUARD_MARGIN + lvMeshExcessTh(env, th, y);
  if (r < rMin && r > 0) {
    cur[i3] = (x * rMin) / r;
    cur[i3 + 2] = (z * rMin) / r;
  }
}

/** q of column k of the table, at the current LV contraction. No allocation. */
function qAtColumn(w: RvWallRig, k: number): number {
  if (w.lvV === 0) return w.qGrid[k];
  // LV Phase 5b: v < 0 (LV above the reference) interpolates between v = 0 and its own node at RV_LV_V_MIN (before: extrapolation of nodes 0 and 1)
  if (w.lvV < 0 && w.qGridNeg.length === w.qGrid.length) {
    const an = w.lvV / RV_LV_V_MIN;
    return w.qGrid[k] * (1 - an) + w.qGridNeg[k] * an;
  }
  const t = (w.lvV / RV_LV_V_MAX) * (RV_LV_V_NODES - 1);
  const i = Math.max(0, Math.min(RV_LV_V_NODES - 2, Math.floor(t)));
  const a = t - i;
  const N = w.qGrid.length;
  return w.qGridV[i * N + k] * (1 - a) + w.qGridV[(i + 1) * N + k] * a;
}

/** Reference k_L (q = 0.4) at the current LV contraction. No allocation. */
function kLrefNow(w: RvWallRig): number {
  if (w.lvV === 0 || w.kLrefV.length === 0) return w.kLref;
  const t = (w.lvV / RV_LV_V_MAX) * (RV_LV_V_NODES - 1);
  const i = Math.max(0, Math.min(RV_LV_V_NODES - 2, Math.floor(t)));
  const a = t - i;
  return w.kLrefV[i] * (1 - a) + w.kLrefV[i + 1] * a;
}

/**
 * Reports the current LV contraction as seen by the septum (LV Phase 3: v = λ of the field, mean of λ·c_i over the segments in contact).
 * The septal face of the RV follows the current epicardium (dynamic envelope) and the q(λ, v) table compensates the volume, so the mesh
 * cavity keeps following vRV. Without the LV rig on, the envelope is that of the field with c = 1 at v. No allocation
 * (the own envelope is recomputed only when v changes).
 */
export function setRvLvContraction(rig: RvContractionRig | null, v: number): void {
  const w = rig?.wall;
  if (!w) return;
  const c = Number.isFinite(v) ? Math.max(RV_LV_V_MIN, Math.min(RV_LV_V_MAX, v)) : 0;
  const ext = w.lvEnvExt;
  if (ext) {
    // the LV envelope changes every frame (λ and c_i): always re-evaluate
    w.lvV = c;
    w.lvOn = ext.active;
    w.dirty = true;
    return;
  }
  if (c === w.lvV) return;
  w.lvV = c;
  fillLvEpiEnvelopeUniform(w.lvEnv, c);
  w.lvOn = c !== 0;
  w.dirty = true;
}

/** LV Phase 3: turns on (env) or off (null) the epicardial envelope of the LV rig as the source for the RV septum. */
export function linkRvLvEnvelope(rig: RvContractionRig | null, env: LvEpiEnvelope | null): void {
  const w = rig?.wall;
  if (!w) return;
  w.lvEnvExt = env;
  w.lvOn = env ? env.active : w.lvV !== 0;
  w.dirty = true;
}

/** LV contraction as seen by the RV: mean of the 17 segments weighted by the septal contact area. No allocation. */
export function rvSeptalLvContraction(rig: RvContractionRig | null, perSegment: ArrayLike<number>): number {
  const w = rig?.wall;
  if (!w) return 0;
  let sum = 0;
  for (let i = 0; i < w.lvSegWeights.length; i++) sum += w.lvSegWeights[i] * (perSegment[i] ?? 0);
  return sum;
}

/** Closed-cavity volume at `cur`: endocardium + fan caps (definition of measureRvCavityVolume). */
function wallCavityVolume(wall: RvWallRig): number {
  const { cur, endoTri, loops } = wall;
  let v6 = 0;
  for (let t = 0; t < endoTri.length; t += 3) {
    const a = endoTri[t] * 3;
    const b = endoTri[t + 1] * 3;
    const c = endoTri[t + 2] * 3;
    v6 += cur[a] * (cur[b + 1] * cur[c + 2] - cur[b + 2] * cur[c + 1])
      - cur[a + 1] * (cur[b] * cur[c + 2] - cur[b + 2] * cur[c])
      + cur[a + 2] * (cur[b] * cur[c + 1] - cur[b + 1] * cur[c]);
  }
  for (let l = 0; l < loops.length; l++) {
    const loop = loops[l];
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] * 3;
      mx += cur[a];
      my += cur[a + 1];
      mz += cur[a + 2];
    }
    mx /= loop.length;
    my /= loop.length;
    mz /= loop.length;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[(i + 1) % loop.length] * 3;
      const b = loop[i] * 3;
      v6 += mx * (cur[a + 1] * cur[b + 2] - cur[a + 2] * cur[b + 1])
        - my * (cur[a] * cur[b + 2] - cur[a + 2] * cur[b])
        + mz * (cur[a] * cur[b + 1] - cur[a + 1] * cur[b]);
    }
  }
  return Math.abs(v6) / 6;
}

/** Inverts q(λ) in the table (q decreasing in λ; linear interpolation). No allocation. */
export function rvLambdaFromQ(rig: RvContractionRig, q: number): number {
  const w = rig.wall;
  if (!w) return solveRvLambda(q, RV_COMPONENT_WEIGHTS.longitudinal, RV_COMPONENT_WEIGHTS.radial, RV_COMPONENT_WEIGHTS.anteroposterior);
  if (!Number.isFinite(q) || (q === 1 && w.lvV === 0)) return 0;
  const N = w.qGrid.length;
  if (q >= qAtColumn(w, 0)) return w.lamGrid[0];
  if (q <= qAtColumn(w, N - 1)) return w.lamGrid[N - 1];
  let lo = 0;
  let hi = N - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (qAtColumn(w, mid) > q) lo = mid;
    else hi = mid;
  }
  const qLo = qAtColumn(w, lo);
  const a = (qLo - q) / (qLo - qAtColumn(w, hi));
  return w.lamGrid[lo] + (w.lamGrid[hi] - w.lamGrid[lo]) * a;
}

/** q(λ) from the rig table (used in the continuity tests). */
export function rvQFromLambda(rig: RvContractionRig, lambda: number): number {
  const w = rig.wall;
  if (!w) {
    const W = RV_COMPONENT_WEIGHTS;
    return (1 - W.longitudinal * lambda) * (1 - W.radial * lambda) * (1 - W.anteroposterior * lambda);
  }
  const ls = w.lamGrid;
  const N = ls.length;
  if (lambda <= ls[0]) return qAtColumn(w, 0);
  if (lambda >= ls[N - 1]) return qAtColumn(w, N - 1);
  const dl = ls[1] - ls[0];
  const k = Math.min(N - 2, Math.floor((lambda - ls[0]) / dl));
  const a = (lambda - ls[k]) / dl;
  const q0 = qAtColumn(w, k);
  return q0 + (qAtColumn(w, k + 1) - q0) * a;
}

/** Phase 4b/4d: matrix S of the annulus affine field for amplitude D (x' = S·x, parent space). No allocation. */
function writeAnnulusField(wall: RvWallRig, D: number, out: THREE.Matrix4): THREE.Matrix4 {
  const { v0x, v0y, v0z, v1x, v1y, v1z, hx, hy, hz, hPs } = wall;
  const e = out.elements;
  // S = I + D·v1 hᵀ (linear) and translation D·(v0 − v1·(pS·h)), by columns
  e[0] = 1 + D * v1x * hx;
  e[1] = D * v1y * hx;
  e[2] = D * v1z * hx;
  e[3] = 0;
  e[4] = D * v1x * hy;
  e[5] = 1 + D * v1y * hy;
  e[6] = D * v1z * hy;
  e[7] = 0;
  e[8] = D * v1x * hz;
  e[9] = D * v1y * hz;
  e[10] = 1 + D * v1z * hz;
  e[11] = 0;
  e[12] = D * (v0x - v1x * hPs);
  e[13] = D * (v0y - v1y * hPs);
  e[14] = D * (v0z - v1z * hPs);
  e[15] = 1;
  // Common wall: the septal side of the annulus recedes with the LV epicardium: Δ(x) = −E·ê·(1 − τ), with τ = x·h − p_s·h
  const E = wall.lvE;
  if (E !== 0) {
    const { eux, euy, euz } = wall;
    e[0] += E * eux * hx;
    e[1] += E * euy * hx;
    e[2] += E * euz * hx;
    e[4] += E * eux * hy;
    e[5] += E * euy * hy;
    e[6] += E * euz * hy;
    e[8] += E * eux * hz;
    e[9] += E * euy * hz;
    e[10] += E * euz * hz;
    e[12] -= E * eux * (1 + hPs);
    e[13] -= E * euy * (1 + hPs);
    e[14] -= E * euz * (1 + hPs);
  }
  return out;
}

/** Phase 4d: annulus field at the systolic reference of the RV normals (for atrium skinning, at load only). `out` receives the matrix; returns the amplitude D. */
export function rvAnnulusReferenceField(rig: RvContractionRig, out: THREE.Matrix4): number {
  const w = rig.wall;
  if (!w) return 0;
  const D = w.kLref * w.lengthD;
  writeAnnulusField(w, D, out);
  return D;
}

/**
 * Phase 4b: tricuspid apparatus by annulus affine field, papillary muscles per vertex and chordae by matrix. No allocation.
 * Leaflets and chordae keep the valvar kinematics in local space (the deformation enters only through the node matrix).
 */
function applyApparatus(rig: RvContractionRig, wall: RvWallRig): void {
  const D = rig.kL * wall.lengthD;
  const { v1x, v1y, v1z, hx, hy, hz } = wall;
  const e = writeAnnulusField(wall, D, wall.shear).elements;
  for (let i = 0; i < wall.apparatusMat.length; i++) {
    const a = wall.apparatusMat[i];
    a.obj.matrix.multiplyMatrices(wall.shear, a.rest);
    a.obj.matrixWorldNeedsUpdate = true;
  }

  const cur = wall.cur;
  const restP = wall.restP;
  const refNow = kLrefNow(wall);
  const sRef = refNow > 0 ? rig.kL / refNow : 0;
  const shorten = RV_PAPILLARY_SHORTENING * Math.max(-1, Math.min(1.15, sRef));
  const margin = RV_WALL_PARAMS.septalEpsEpi;
  for (let p = 0; p < wall.papillaries.length; p++) {
    const d = wall.papillaries[p];
    const a = d.ia * 3;
    const b = d.ib * 3;
    const c = d.ic * 3;
    // base: barycentric combination of the endocardium displacement (septal or free)
    const ux = d.ba * (cur[a] - restP[a]) + d.bb * (cur[b] - restP[b]) + d.bc * (cur[c] - restP[c]);
    const uy = d.ba * (cur[a + 1] - restP[a + 1]) + d.bb * (cur[b + 1] - restP[b + 1]) + d.bc * (cur[c + 1] - restP[c + 1]);
    const uz = d.ba * (cur[a + 2] - restP[a + 2]) + d.bb * (cur[b + 2] - restP[b + 2]) + d.bc * (cur[c + 2] - restP[c + 2]);
    // tip: base + (1 − s)·L0 in the rest direction rotated toward the annulus field
    const fieldX = e[0] * d.tx + e[4] * d.ty + e[8] * d.tz + e[12] - d.tx;
    const fieldY = e[1] * d.tx + e[5] * d.ty + e[9] * d.tz + e[13] - d.ty;
    const fieldZ = e[2] * d.tx + e[6] * d.ty + e[10] * d.tz + e[14] - d.tz;
    let dirX = d.tx - d.bx + RV_PAPILLARY_TIP_FOLLOW * (fieldX - ux);
    let dirY = d.ty - d.by + RV_PAPILLARY_TIP_FOLLOW * (fieldY - uy);
    let dirZ = d.tz - d.bz + RV_PAPILLARY_TIP_FOLLOW * (fieldZ - uz);
    const len = Math.hypot(dirX, dirY, dirZ) || 1;
    dirX /= len;
    dirY /= len;
    dirZ /= len;
    // cone around the rest direction
    const r0x = (d.tx - d.bx) / d.L0;
    const r0y = (d.ty - d.by) / d.L0;
    const r0z = (d.tz - d.bz) / d.L0;
    const cosA = dirX * r0x + dirY * r0y + dirZ * r0z;
    if (cosA < PAP_CONE_COS) {
      let px = dirX - cosA * r0x;
      let py = dirY - cosA * r0y;
      let pz = dirZ - cosA * r0z;
      const pl = Math.hypot(px, py, pz) || 1;
      px /= pl;
      py /= pl;
      pz /= pl;
      dirX = PAP_CONE_COS * r0x + PAP_CONE_SIN * px;
      dirY = PAP_CONE_COS * r0y + PAP_CONE_SIN * py;
      dirZ = PAP_CONE_COS * r0z + PAP_CONE_SIN * pz;
    }
    const L = d.L0 * (1 - shorten);
    // tip kept outside the LV epicardium (with clearance for the chordae), without changing the shortened length
    const bx1 = d.bx + ux;
    const by1 = d.by + uy;
    const bz1 = d.bz + uz;
    for (let it = 0; it < 4; it++) {
      const tipX = bx1 + dirX * L;
      const tipY = by1 + dirY * L;
      const tipZ = bz1 + dirZ * L;
      if (tipY < LV_ANALYTIC_PROFILE.y0 || tipY > LV_TOP_Y) break;
      const rTip = Math.hypot(tipX, tipZ);
      const rMin = lvEpiNow(wall, tipX, tipZ, tipY) + RV_PAPILLARY_TIP_LV_MARGIN;
      if (rTip >= rMin || rTip === 0) break;
      const kx = (tipX * rMin) / rTip - bx1;
      const ky = tipY - by1;
      const kz = (tipZ * rMin) / rTip - bz1;
      const kl = Math.hypot(kx, ky, kz) || 1;
      dirX = kx / kl;
      dirY = ky / kl;
      dirZ = kz / kl;
    }
    dirX *= L;
    dirY *= L;
    dirZ *= L;
    d.dBx = ux;
    d.dBy = uy;
    d.dBz = uz;
    d.dTx = d.bx + ux + dirX - d.tx;
    d.dTy = d.by + uy + dirY - d.ty;
    d.dTz = d.bz + uz + dirZ - d.tz;

    const attr = d.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const r3 = d.restP;
    const inv = d.invE;
    for (let j = 0; j < d.ratio.length; j++) {
      const j3 = j * 3;
      const w = d.ratio[j];
      let x = r3[j3] + w * ux + (1 - w) * d.dTx;
      const y = r3[j3 + 1] + w * uy + (1 - w) * d.dTy;
      let z = r3[j3 + 2] + w * uz + (1 - w) * d.dTz;
      // papillary muscle never enters the LV
      if (y >= LV_ANALYTIC_PROFILE.y0 && y <= LV_TOP_Y) {
        const r = Math.hypot(x, z);
        const rMin = lvEpiNow(wall, x, z, y) + margin;
        if (r < rMin && r > 0) {
          x *= rMin / r;
          z *= rMin / r;
        }
      }
      arr[j3] = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
      arr[j3 + 1] = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
      arr[j3 + 2] = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
    }
    attr.needsUpdate = true;
  }

  // Phase 4c: chordae as tie rods: Gauss–Seidel projection of the interval constraints; aD stores the field amplitudes per insertion
  if (wall.leaflets.length > 0) {
    const eps = RV_LEAFLET_RIG.maxChordStrain;
    const aD = wall.anchorD;
    aD.fill(0);
    for (let it = 0; it < RV_LEAFLET_RIG.iterations; it++) {
      let worst = 0;
      for (let i = 0; i < wall.chords.length; i++) {
        const c = wall.chords[i];
        if (!c.drive || c.row.length === 0) continue;
        let fx = e[0] * c.tx + e[4] * c.ty + e[8] * c.tz + e[12];
        let fy = e[1] * c.tx + e[5] * c.ty + e[9] * c.tz + e[13];
        let fz = e[2] * c.tx + e[6] * c.ty + e[10] * c.tz + e[14];
        for (let k = 0; k < c.row.length; k++) {
          const w = c.row[k];
          fx += w * aD[k * 3];
          fy += w * aD[k * 3 + 1];
          fz += w * aD[k * 3 + 2];
        }
        const vx = c.bx + c.wP * c.drive.dBx + (1 - c.wP) * c.drive.dTx - fx;
        const vy = c.by + c.wP * c.drive.dBy + (1 - c.wP) * c.drive.dTy - fy;
        const vz = c.bz + c.wP * c.drive.dBz + (1 - c.wP) * c.drive.dTz - fz;
        const len = Math.hypot(vx, vy, vz);
        if (!(len > 0)) continue;
        const hi = c.len0 * (1 + eps);
        const lo = c.len0 * (1 - eps);
        const excess = len > hi ? len - hi : len < lo ? len - lo : 0;
        if (excess === 0) continue;
        if (Math.abs(excess) > worst) worst = Math.abs(excess);
        const k = excess / len;
        aD[i * 3] += k * vx;
        aD[i * 3 + 1] += k * vy;
        aD[i * 3 + 2] += k * vz;
      }
      if (worst < 1e-7) break;
    }
    const nA = wall.chords.length;
    // S⁻¹ = I − D·v1 hᵀ/(1 + D·h·v1) (Sherman–Morrison): the displacement is added after the annulus field
    const sm = D / (1 + D * (hx * v1x + hy * v1y + hz * v1z));
    for (let l = 0; l < wall.leaflets.length; l++) {
      const L = wall.leaflets[l];
      const attr = L.spec.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const inv = L.inv;
      const off = L.offset;
      const tb = L.table;
      let row = 0;
      for (let v = 0; v < L.n; v++) {
        let dx = 0;
        let dy = 0;
        let dz = 0;
        for (let k = 0; k < nA; k++) {
          const w = tb[row++];
          dx += w * aD[k * 3];
          dy += w * aD[k * 3 + 1];
          dz += w * aD[k * 3 + 2];
        }
        const hd = sm * (hx * dx + hy * dy + hz * dz);
        dx -= hd * v1x;
        dy -= hd * v1y;
        dz -= hd * v1z;
        const v3 = v * 3;
        const ox = inv[0] * dx + inv[3] * dy + inv[6] * dz;
        const oy = inv[1] * dx + inv[4] * dy + inv[7] * dz;
        const oz = inv[2] * dx + inv[5] * dy + inv[8] * dz;
        arr[v3] += ox - off[v3];
        arr[v3 + 1] += oy - off[v3 + 1];
        arr[v3 + 2] += oz - off[v3 + 2];
        off[v3] = ox;
        off[v3 + 1] = oy;
        off[v3 + 2] = oz;
      }
      attr.needsUpdate = true;
    }
    for (let i = 0; i < nA; i++) {
      const c = wall.chords[i];
      let dx = 0;
      let dy = 0;
      let dz = 0;
      for (let k = 0; k < c.row.length; k++) {
        const w = c.row[k];
        dx += w * aD[k * 3];
        dy += w * aD[k * 3 + 1];
        dz += w * aD[k * 3 + 2];
      }
      c.dLx = dx;
      c.dLy = dy;
      c.dLz = dz;
    }
  }

  // Chordae: M = S·M0 + δ_P ⊗ w + δ_L ⊗ (1 − w), with w = 1 at the papillary muscle and 0 at the leaflet (linear along the rest chorda)
  for (let i = 0; i < wall.chords.length; i++) {
    const c = wall.chords[i];
    const m = c.obj.matrix.elements;
    const m0 = c.rest.elements;
    c.obj.matrix.multiplyMatrices(wall.shear, c.rest);
    if (c.drive) {
      const px = c.bx + (c.wP * c.drive.dBx + (1 - c.wP) * c.drive.dTx);
      const py = c.by + (c.wP * c.drive.dBy + (1 - c.wP) * c.drive.dTy);
      const pz = c.bz + (c.wP * c.drive.dBz + (1 - c.wP) * c.drive.dTz);
      const ax = e[0] * c.bx + e[4] * c.by + e[8] * c.bz + e[12];
      const ay = e[1] * c.bx + e[5] * c.by + e[9] * c.bz + e[13];
      const az = e[2] * c.bx + e[6] * c.by + e[10] * c.bz + e[14];
      const dx = px - ax;
      const dy = py - ay;
      const dz = pz - az;
      for (let col = 0; col < 3; col++) {
        const g = -(c.ex * m0[col * 4] + c.ey * m0[col * 4 + 1] + c.ez * m0[col * 4 + 2]);
        m[col * 4] += (dx - c.dLx) * g;
        m[col * 4 + 1] += (dy - c.dLy) * g;
        m[col * 4 + 2] += (dz - c.dLz) * g;
      }
      const g3 = 1 - (c.ex * (m0[12] - c.bx) + c.ey * (m0[13] - c.by) + c.ez * (m0[14] - c.bz));
      m[12] += dx * g3 + c.dLx * (1 - g3);
      m[13] += dy * g3 + c.dLy * (1 - g3);
      m[14] += dz * g3 + c.dLz * (1 - g3);
    }
    c.obj.matrixWorldNeedsUpdate = true;
  }
}

/** Writes the wall geometry and the apparatus into the current state (k_L, k_R, k_AP). No allocation. */
export function flushRvContraction(rig: RvContractionRig): void {
  const wall = rig.wall;
  if (!wall || !wall.dirty) return;
  wall.dirty = false;
  evaluateWall(wall, rig.kL, rig.kR, rig.kAP);
  // parent space → node local space (fixed rest matrix)
  const geom = rig.mesh.geometry;
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const cur = wall.cur;
  const e = wall.invM.elements;
  for (let i = 0; i < wall.n; i++) {
    const i3 = i * 3;
    const x = cur[i3];
    const y = cur[i3 + 1];
    const z = cur[i3 + 2];
    arr[i3] = e[0] * x + e[4] * y + e[8] * z + e[12];
    arr[i3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    arr[i3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  pos.needsUpdate = true;
  // Normals: interpolation between the rest normals and those of the systolic reference (visual)
  const nAttr = geom.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (nAttr && wall.nRef.length === nAttr.array.length) {
    const na = nAttr.array as Float32Array;
    const refNow = kLrefNow(wall);
    const a = refNow > 0 ? Math.max(-0.5, Math.min(1.5, rig.kL / refNow)) : 0;
    for (let i = 0; i < na.length; i += 3) {
      const nx = wall.nRest[i] + a * (wall.nRef[i] - wall.nRest[i]);
      const ny = wall.nRest[i + 1] + a * (wall.nRef[i + 1] - wall.nRest[i + 1]);
      const nz = wall.nRest[i + 2] + a * (wall.nRef[i + 2] - wall.nRest[i + 2]);
      // LV Phase 5b (performance, P3): Math.sqrt instead of 3-argument Math.hypot (only the last bit of some normals changes)
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      na[i] = nx / l;
      na[i + 1] = ny / l;
      na[i + 2] = nz / l;
    }
    nAttr.needsUpdate = true;
  }
  applyApparatus(rig, wall);
}

/**
 * Per step: tracks EDV/ESV, updates the reference and solves λ (without touching the geometry). No allocation.
 * LV Phase 5c (D-VE34): tInBeat (clock.tInBeat, optional) aligns the current-beat EDV reference that the fill (glow) uses.
 */
export function updateRvDriver(rig: RvContractionRig | null, vRV: number, beatIndex: number, t: number, tInBeat = NaN): void {
  if (!rig || !Number.isFinite(vRV) || vRV <= 0) return;
  updateRvVolumeTracker(rig.tracker, vRV, beatIndex, tInBeat);
  const tr = rig.tracker;
  rig.fill = rvFillFraction(tr, vRV);
  if (!(rig.refVolume > 0)) rig.refVolume = vRV;
  if (!tr.valid) {
    if (vRV > rig.refVolume) rig.refVolume = vRV;
  } else {
    const dt = Number.isFinite(rig.lastT) && Number.isFinite(t) ? t - rig.lastT : 0;
    if (dt > 0) {
      const a = 1 - Math.exp(-Math.min(dt, 0.25) / RV_REF_TAU_S);
      rig.refVolume += (tr.edv - rig.refVolume) * a;
    }
  }
  if (Number.isFinite(t)) rig.lastT = t;
  const q = vRV / rig.refVolume;
  rig.lambda = rvLambdaFromQ(rig, q);
  if (rig.wall) {
    rigGains(rig.lambda, _gainsScratch);
    rig.kL = _gainsScratch[0];
    rig.kR = _gainsScratch[1];
    rig.kAP = _gainsScratch[2];
    rig.deltaTV.copy(rig.wall.dirTV).multiplyScalar(rig.kL * rig.wall.lengthD);
    rig.wall.dirty = true;
  } else {
    setRvDeformation(
      rig,
      RV_COMPONENT_WEIGHTS.longitudinal * rig.lambda,
      RV_COMPONENT_WEIGHTS.radial * rig.lambda,
      RV_COMPONENT_WEIGHTS.anteroposterior * rig.lambda,
    );
  }
}

const _gainsScratch: [number, number, number] = [0, 0, 0];
const PAP_CONE_COS = Math.cos((RV_PAPILLARY_TIP_MAX_ANGLE_DEG * Math.PI) / 180);
const PAP_CONE_SIN = Math.sin((RV_PAPILLARY_TIP_MAX_ANGLE_DEG * Math.PI) / 180);

/** Builds the per-vertex rig over the procedural wall (requires the apparatus ALREADY posed by T_TV). Allocates; at load only. */
function setupProceduralRig(
  rvMesh: THREE.Mesh,
  annulusMesh: THREE.Mesh | null | undefined,
  lvAxisOrigin: THREE.Vector3,
  lvAxisDir: THREE.Vector3,
  restMatrix: THREE.Matrix4,
  valvarData: ValvarKinematicsData | null,
): RvContractionRig | null {
  const geom = rvMesh.geometry;
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  const uv = geom.getAttribute('uv') as THREE.BufferAttribute;
  const swAttr = geom.getAttribute('septalWeight') as THREE.BufferAttribute;
  const trAttr = geom.getAttribute('transmural') as THREE.BufferAttribute;
  const index = geom.getIndex();
  if (!annulusMesh?.isMesh || !annulusMesh.geometry || !index) return null;
  const root = rvMesh.parent;
  if (!root) return null;

  // Protected rest: on repeated setup, always starts from the rest pose
  let restLocal = wallRestCache.get(geom);
  if (!restLocal) {
    restLocal = new Float32Array(pos.array as Float32Array);
    wallRestCache.set(geom, restLocal);
  }
  (pos.array as Float32Array).set(restLocal);
  pos.needsUpdate = true;
  const n = pos.count;

  // Explicit apex: pole of the generator endocardium (geometry.userData.rvApex, never "farthest vertex")
  const apexLocal = geom.userData.rvApex as [number, number, number];
  const apex = new THREE.Vector3(apexLocal[0], apexLocal[1], apexLocal[2]).applyMatrix4(restMatrix);

  // Annulus: center of the posed annulus vertices, with the node's current matrix (T_TV already applied)
  annulusMesh.updateMatrix();
  const annPos = annulusMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const annulus = new THREE.Vector3();
  const annPts: THREE.Vector3[] = [];
  for (let i = 0; i < annPos.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(annPos, i).applyMatrix4(annulusMesh.matrix);
    annPts.push(p);
    annulus.add(p);
  }
  annulus.multiplyScalar(1 / annPos.count);

  const axisL = new THREE.Vector3().subVectors(annulus, apex);
  const lengthD = axisL.length();
  if (lengthD < 1e-8) return null;
  axisL.normalize();

  const septalPoint = new THREE.Vector3().setFromMatrixPosition(restMatrix);
  const axisR = new THREE.Vector3().subVectors(septalPoint, lvAxisOrigin);
  axisR.addScaledVector(lvAxisDir, -axisR.dot(lvAxisDir));
  axisR.addScaledVector(axisL, -axisR.dot(axisL));
  if (axisR.lengthSq() < 1e-8) return null;
  axisR.normalize();
  const axisAP = new THREE.Vector3().crossVectors(axisL, axisR).normalize();

  // Phase 4b: lateral point (farthest from the LV epicardium) and septal point (nearest) of the posed annulus
  const S = GLTF_SCALE_MM_PER_UNIT;
  const annOff = (p: THREE.Vector3) => Math.hypot(p.x, p.z) - rEpiExt(p.y);
  let pLat = annPts[0];
  let pSep = annPts[0];
  for (const p of annPts) {
    if (annOff(p) > annOff(pLat)) pLat = p;
    if (annOff(p) < annOff(pSep)) pSep = p;
  }
  const chordSL = pLat.distanceTo(pSep);
  const aHat = pLat.clone().sub(pSep).normalize();
  const hVec = aHat.clone().multiplyScalar(1 / chordSL);
  const hPs = pSep.dot(hVec);
  const tauOf = (x: number, y: number, z: number) => x * hVec.x + y * hVec.y + z * hVec.z - hPs;
  const rho = RV_ANNULUS_SEPTAL_RATIO;
  const dirBase = axisL.clone().negate();
  const eOut = new THREE.Vector3(pSep.x, 0, pSep.z).normalize();
  eOut.addScaledVector(axisL, -eOut.dot(axisL)).normalize();
  // α: minimum deviation (septal side) so the annulus does not enter the LV over the whole stroke
  const margin = RV_ANNULUS_LV_MARGIN_MM / S;
  const qTest = new THREE.Vector3();
  const clearanceAlong = (a: number) => {
    let worst = Infinity;
    for (let mm = 0; mm <= RV_TAPSE_MAX_MM; mm += 1) {
      const lat = mm / S;
      for (let i = 0; i < annPts.length; i += 3) {
        const p = annPts[i];
        const t = tauOf(p.x, p.y, p.z);
        qTest.copy(p).addScaledVector(dirBase, lat * (rho + (1 - rho) * t)).addScaledVector(eOut, lat * a * (1 - t));
        worst = Math.min(worst, Math.hypot(qTest.x, qTest.z) - rEpiExt(qTest.y));
      }
    }
    return worst;
  };
  let alpha = 0;
  while (alpha < 1 && clearanceAlong(alpha) < margin) alpha += RV_ALPHA_GRID_STEP;
  const dirTV = dirBase.clone();
  const v0 = dirBase.clone().multiplyScalar(rho).addScaledVector(eOut, alpha);
  const v1 = dirBase.clone().multiplyScalar(1 - rho).addScaledVector(eOut, -alpha);

  const NU = (geom.userData.rvSegmentsU as number) ?? 96;
  const uStart = geom.userData.rvFreeWallUStart as number;
  const Ns = Math.round(uStart * NU);
  const vFix = (geom.userData.rvSeptalAttachV as number) ?? RV_WALL_PARAMS.septalAttachV;

  const restP = new Float64Array(n * 3);
  const ringB = new Float64Array(n);
  const wL = new Float64Array(n);
  const gCol = new Float64Array(n);
  const devCol = new Float64Array(n);
  const slide = new Float64Array(n);
  const f0 = new Float64Array(n);
  const W = new Float64Array(n);
  const hL = new Float64Array(n);
  const hR = new Float64Array(n);
  const gAP = new Float64Array(n);
  const partner = new Int32Array(n).fill(-1);
  const dY = new Float64Array(n);
  const dF = new Float64Array(n);
  const cosD = new Float64Array(n);
  const sinD = new Float64Array(n);
  const transmural = new Uint8Array(n);
  const tmp = new THREE.Vector3();

  // Grid (c, j) → endocardium index; θ of the horns per level (for the middle of the free wall)
  const endoMap = new Map<string, number>();
  const col = (u: number) => Math.round(u * NU);
  const lvKey = (v: number) => v.toFixed(6);
  for (let i = 0; i < n; i++) {
    tmp.fromBufferAttribute(pos, i).applyMatrix4(restMatrix);
    restP[3 * i] = tmp.x;
    restP[3 * i + 1] = tmp.y;
    restP[3 * i + 2] = tmp.z;
    transmural[i] = trAttr.getX(i) === 0 ? 0 : 1;
    if (transmural[i] === 0) {
      const c = col(uv.getX(i));
      const key = `${c}_${lvKey(uv.getY(i))}`;
      if (!endoMap.has(key)) endoMap.set(key, i);
    }
  }

  // Phase 4b: τ, annular gain and deviation per column, from the edge vertex (v = 0) of the same column
  const tauCol = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (transmural[i] === 0 && uv.getY(i) === 0) tauCol.set(col(uv.getX(i)), tauOf(restP[3 * i], restP[3 * i + 1], restP[3 * i + 2]));
  }

  for (let i = 0; i < n; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    const c = col(u);
    const tauC = tauCol.get(c) ?? tauOf(restP[3 * i], restP[3 * i + 1], restP[3 * i + 2]);
    gCol[i] = rho + (1 - rho) * tauC;
    devCol[i] = 1 - tauC;
    const free = c > Ns;
    const b = 1 - smoothstep(0, vFix, v);
    // Phase 4b: nothing zeroes at the horn; radial and anteroposterior continue over the septum and decay with distance from the horn
    const distHorn = c <= Ns ? Math.min(c, Ns - c) / Ns : 0;
    const hornDecay = 1 - smoothstep(0, RV_RIG_SHAPE.septalApDecay, distHorn);
    W[i] = free ? swAttr.getX(i) : Math.max(b, hornDecay);
    hL[i] = 1 - Math.pow(v, RV_RIG_SHAPE.longitudinalPower);
    hR[i] = smoothstep(0, RV_RADIAL_RAMP_V, v) * (1 - smoothstep(0.85, 1, v));
    gAP[i] = hornDecay;
    ringB[i] = 1 - smoothstep(0, RV_RIG_SHAPE.ringBlendV, v);
    // Phase 4b: septum slides (1 − v^p); the free wall becomes septum at the horns through the same tapering
    wL[i] = free ? hL[i] : 1 - Math.pow(v, RV_RIG_SHAPE.septalSlidePower);
    // full sliding only far from the horns and below the annulus band (continuity with the free wall)
    slide[i] = free ? 0 : smoothstep(0, RV_SLIDE_HORN_RAMP, distHorn) * (1 - ringB[i]);
    f0[i] = Math.hypot(restP[3 * i], restP[3 * i + 2]) - rEpiExt(restP[3 * i + 1]);
    if (transmural[i] === 1) {
      const k = endoMap.get(`${c}_${lvKey(v)}`);
      if (k === undefined) return null;
      partner[i] = k;
      dY[i] = restP[3 * i + 1] - restP[3 * k + 1];
      dF[i] = Math.hypot(restP[3 * i], restP[3 * i + 2]) - rEpiExt(restP[3 * i + 1]) - (Math.hypot(restP[3 * k], restP[3 * k + 2]) - rEpiExt(restP[3 * k + 1]));
      const d = Math.atan2(restP[3 * i + 2], restP[3 * i]) - Math.atan2(restP[3 * k + 2], restP[3 * k]);
      cosD[i] = Math.cos(d);
      sinD[i] = Math.sin(d);
    }
  }

  // Common wall: whatever touches the LV at rest follows it; endocardium and epicardium of the same column have the same weight
  const lvFollow = new Float64Array(n);
  const followMin = RV_LV_FOLLOW_FULL_MM / S;
  const followMax = RV_LV_FOLLOW_ZERO_MM / S;
  const lvSegWeights = new Float64Array(17);
  for (let i = 0; i < n; i++) {
    if (transmural[i] !== 1) continue;
    const k = partner[i];
    const inside = restP[3 * i + 1] >= LV_ANALYTIC_PROFILE.y0 && restP[3 * i + 1] <= LV_TOP_Y;
    const w = inside ? 1 - smoothstep(followMin, followMax, Math.min(f0[i], f0[k])) : 0;
    lvFollow[i] = w;
    lvFollow[k] = Math.max(lvFollow[k], w);
    if (w > 0) {
      const seg = ahaWedgeOf(tmp.set(restP[3 * i], restP[3 * i + 1], restP[3 * i + 2]));
      lvSegWeights[seg - 1] += w;
    }
  }
  // Whatever touches the LV slides over it (same rule as the septum), also near the horns; the annulus keeps the edge
  const lvRing = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lvRing[i] = smoothstep(0, RV_LV_RING_RAMP_V, uv.getY(i));
    const col = Math.round(uv.getX(i) * NU);
    const distCols = col <= Ns ? Math.min(col, Ns - col) : 0;
    // The horn ramp only applies next to the annulus, where the horn is thin; below that, whatever touches slides entirely
    const hornGate = Math.max(smoothstep(0, RV_LV_HORN_RAMP_COLS, distCols), smoothstep(0.1, 0.2, uv.getY(i)));
    slide[i] = Math.max(slide[i], lvFollow[i] * lvRing[i] * (col <= Ns ? hornGate : 0));
  }
  const lvGuard = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const y = restP[3 * i + 1];
    void y;
    if (f0[i] * S < RV_LV_GUARD_MM) lvGuard[i] = 1;
  }
  let segSum = 0;
  for (let i = 0; i < 17; i++) segSum += lvSegWeights[i];
  if (segSum > 0) for (let i = 0; i < 17; i++) lvSegWeights[i] /= segSum;

  // Endocardium: triangles and edge loops (indices)
  const endoT: number[] = [];
  const directed = new Set<string>();
  for (let t = 0; t < index.count; t += 3) {
    const ia = index.getX(t);
    const ib = index.getX(t + 1);
    const ic = index.getX(t + 2);
    if (transmural[ia] !== 0 || transmural[ib] !== 0 || transmural[ic] !== 0) continue;
    endoT.push(ia, ib, ic);
    directed.add(`${ia}>${ib}`);
    directed.add(`${ib}>${ic}`);
    directed.add(`${ic}>${ia}`);
  }
  const next = new Map<number, number>();
  for (let t = 0; t < endoT.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const p = endoT[t + e];
      const q = endoT[t + ((e + 1) % 3)];
      if (!directed.has(`${q}>${p}`)) next.set(p, q);
    }
  }
  const loops: Uint32Array[] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const list: number[] = [];
    let cursor: number | undefined = start;
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      list.push(cursor);
      cursor = next.get(cursor);
    }
    loops.push(new Uint32Array(list));
  }

  // Tricuspid apparatus (position ALREADY posed): annulus and leaflets by matrix; chordae and papillary muscles handled below
  const apparatusMat: RvWallRig['apparatusMat'] = [];
  for (const name of TRICUSPID_APPARATUS_NODE_NAMES) {
    if (name.includes('_chorda_') || name.includes('_papillary_muscle')) continue;
    const obj = root.getObjectByName(name);
    if (!obj || obj.parent !== rvMesh.parent) continue;
    obj.updateMatrix();
    obj.matrixAutoUpdate = false;
    apparatusMat.push({ obj, rest: obj.matrix.clone() });
  }

  const wall: RvWallRig = {
    n,
    restLocal,
    restP,
    cur: new Float64Array(n * 3),
    cosT: new Float64Array(n),
    sinT: new Float64Array(n),
    yy: new Float64Array(n),
    ff: new Float64Array(n),
    transmural,
    W,
    hL,
    hR,
    gAP,
    ringB,
    wL,
    gCol,
    devCol,
    slide,
    f0,
    partner,
    dY,
    dF,
    cosD,
    sinD,
    endoTri: new Uint32Array(endoT),
    loops,
    dirTV,
    v0x: v0.x,
    v0y: v0.y,
    v0z: v0.z,
    v1x: v1.x,
    v1y: v1.y,
    v1z: v1.z,
    hx: hVec.x,
    hy: hVec.y,
    hz: hVec.z,
    hPs,
    shear: new THREE.Matrix4(),
    apparatusMat,
    chords: [],
    leaflets: [],
    anchorD: new Float64Array(0),
    dlx: -axisL.x * lengthD,
    dly: -axisL.y * lengthD,
    dlz: -axisL.z * lengthD,
    dex: alpha * eOut.x * lengthD,
    dey: alpha * eOut.y * lengthD,
    dez: alpha * eOut.z * lengthD,
    ax: axisAP.x,
    ay: axisAP.y,
    az: axisAP.z,
    px: septalPoint.x,
    py: septalPoint.y,
    pz: septalPoint.z,
    alpha,
    lengthD,
    lambdaMax: 0,
    lamGrid: new Float64Array(RV_LAMBDA_TABLE_N),
    qGrid: new Float64Array(RV_LAMBDA_TABLE_N),
    restVolume: 0,
    nRest: new Float32Array(0),
    nRef: new Float32Array(0),
    kLref: 0,
    invM: restMatrix.clone().invert(),
    papillaries: [],
    epsEndo: RV_WALL_PARAMS.septalEpsEndo,
    epsEpi: RV_WALL_PARAMS.septalEpsEpi,
    dirty: false,
    lvFollow,
    lvGuard,
    lvRing,
    lvV: 0,
    lvE: 0,
    lvEnv: createLvEpiEnvelope(),
    lvEnvExt: null,
    lvOn: false,
    eux: eOut.x,
    euy: eOut.y,
    euz: eOut.z,
    annSepX: pSep.x,
    annSepY: pSep.y,
    annSepZ: pSep.z,
    annSepF0: annOff(pSep),
    qGridV: new Float64Array(RV_LV_V_NODES * RV_LAMBDA_TABLE_N),
    qGridNeg: new Float64Array(RV_LAMBDA_TABLE_N),
    kLrefV: new Float64Array(RV_LV_V_NODES),
    lvSegWeights,
  };

  // Papillary muscles: base by skinning on the endocardium; tip and body computed in applyApparatus
  const tri = new THREE.Triangle();
  const nearestEndoTri = (p: THREE.Vector3) => {
    const q = new THREE.Vector3();
    let best = Infinity;
    const out = { ia: 0, ib: 0, ic: 0, b: new THREE.Vector3() };
    for (let t = 0; t < wall.endoTri.length; t += 3) {
      const a = wall.endoTri[t];
      const b = wall.endoTri[t + 1];
      const c = wall.endoTri[t + 2];
      tri.a.fromArray(restP, a * 3);
      tri.b.fromArray(restP, b * 3);
      tri.c.fromArray(restP, c * 3);
      tri.closestPointToPoint(p, q);
      const d = q.distanceToSquared(p);
      if (d < best) {
        best = d;
        out.ia = a;
        out.ib = b;
        out.ic = c;
        tri.getBarycoord(q, out.b);
      }
    }
    return out;
  };
  const drive = (mesh: THREE.Mesh, weights: Float32Array, baseIndex: number, tipIndex: number, ownGeometry: boolean, anchor: THREE.Vector3): PapillaryDrive | null => {
    let g = mesh.geometry;
    if (ownGeometry && !g.userData.rvRigOwned) {
      // the septal papillary muscle shares the GLB geometry; the copy avoids altering the original
      g = g.clone();
      g.userData.rvRigOwned = true;
      mesh.geometry = g;
    }
    const attr = g.getAttribute('position') as THREE.BufferAttribute;
    let rest = papRestCache.get(g);
    if (!rest) {
      rest = new Float32Array(attr.array as Float32Array);
      papRestCache.set(g, rest);
    }
    (attr.array as Float32Array).set(rest);
    attr.needsUpdate = true;
    const wb = weights[baseIndex];
    if (!(wb > 0)) return null;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    const restP3 = new Float64Array(attr.count * 3);
    const ratio = new Float32Array(attr.count);
    const q0 = new THREE.Vector3();
    for (let i = 0; i < attr.count; i++) {
      q0.fromArray(rest, i * 3).applyMatrix4(mesh.matrix);
      restP3[i * 3] = q0.x;
      restP3[i * 3 + 1] = q0.y;
      restP3[i * 3 + 2] = q0.z;
      ratio[i] = weights[i] / wb;
    }
    const inv = mesh.matrix.clone().invert().elements;
    const near = nearestEndoTri(anchor);
    const bx = restP3[baseIndex * 3];
    const by = restP3[baseIndex * 3 + 1];
    const bz = restP3[baseIndex * 3 + 2];
    const tx = restP3[tipIndex * 3];
    const ty = restP3[tipIndex * 3 + 1];
    const tz = restP3[tipIndex * 3 + 2];
    return {
      mesh,
      restP: restP3,
      ratio,
      invE: Float64Array.from(inv),
      ia: near.ia,
      ib: near.ib,
      ic: near.ic,
      ba: near.b.x,
      bb: near.b.y,
      bc: near.b.z,
      bx,
      by,
      bz,
      tx,
      ty,
      tz,
      L0: Math.hypot(tx - bx, ty - by, tz - bz),
      dBx: 0,
      dBy: 0,
      dBz: 0,
      dTx: 0,
      dTy: 0,
      dTz: 0,
    };
  };
  const tmpB = new THREE.Vector3();
  const tipIndexOf = (m: THREE.Mesh, p: THREE.Vector3) => {
    const a2 = m.geometry.getAttribute('position') as THREE.BufferAttribute;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < a2.count; i++) {
      const d = tmpB.fromBufferAttribute(a2, i).applyMatrix4(m.matrix).distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  for (const e of rvPapillaryExtensions(root)) {
    const m = root.getObjectByName(e.name) as THREE.Mesh | undefined;
    if (!m?.isMesh) continue;
    m.updateMatrix();
    const d = drive(m, e.weights, e.baseIndex, tipIndexOf(m, e.tip), false, e.anchor);
    if (d) wall.papillaries.push(d);
  }
  const septal = root.getObjectByName('tricuspid_septal_papillary_muscle') as THREE.Mesh | undefined;
  if (septal?.isMesh) {
    septal.updateMatrix();
    const sw = papillaryBasalWeights(septal, septal.matrix);
    // septal base: lowest vertex (same definition as Phase 3)
    let baseIdx = 0;
    let lowest = Infinity;
    for (let i = 0; i < sw.local.length; i++) {
      const y = tmp.copy(sw.local[i]).applyMatrix4(septal.matrix).y;
      if (y < lowest) {
        lowest = y;
        baseIdx = i;
      }
    }
    const anchor = sw.local[baseIdx].clone().applyMatrix4(septal.matrix);
    const d = drive(septal, sw.weights, baseIdx, sw.tipIdx, true, anchor);
    if (d) wall.papillaries.push(d);
  }

  // Chordae: topological mapping (same origin as the valvar kinematics); papillary end at rest and leaflet end
  // in the CLOSED state (z = 0), since that is where the chorda sits in systole; restored afterwards
  if (valvarData) applyValvarDeformation(valvarData, 0, 0);
  // Phase 4c: insertion of each chorda (leaflet vertex, closed state, parent space)
  const anchors: THREE.Vector3[] = [];
  const anchorLeaflet: string[] = [];
  const anchorVertex: number[] = [];
  const leafletMatrix = (o: THREE.Object3D) => wall.apparatusMat.find((a) => a.obj === o)?.rest ?? null;
  for (const m of (chordaMappingRaw as Array<{ chordaName: string; papillaryName: string; leafletName: string; leafletVIdx: number; baseIdx: number; tipIdx: number }>)) {
    if (!m.chordaName.startsWith('tricuspid_')) continue;
    const c = root.getObjectByName(m.chordaName) as THREE.Mesh | undefined;
    if (!c?.isMesh) continue;
    c.updateMatrix();
    c.matrixAutoUpdate = false;
    const rp = (c.userData.restPositions as Float32Array | undefined) ?? (c.geometry.getAttribute('position').array as Float32Array);
    const closed = c.geometry.getAttribute('position').array as Float32Array;
    const b0 = new THREE.Vector3().fromArray(rp, m.baseIdx * 3).applyMatrix4(c.matrix);
    const t0 = new THREE.Vector3().fromArray(valvarData ? closed : rp, m.tipIdx * 3).applyMatrix4(c.matrix);
    const seg = t0.clone().sub(b0);
    const e2 = seg.dot(seg) || 1;
    const dr = wall.papillaries.find((p) => p.mesh.name === m.papillaryName) ?? null;
    let wP = 0;
    if (dr) {
      let bd = Infinity;
      for (let j = 0; j < dr.ratio.length; j++) {
        const dd = (dr.restP[j * 3] - b0.x) ** 2 + (dr.restP[j * 3 + 1] - b0.y) ** 2 + (dr.restP[j * 3 + 2] - b0.z) ** 2;
        if (dd < bd) {
          bd = dd;
          wP = dr.ratio[j];
        }
      }
    }
    wall.chords.push({ obj: c, rest: c.matrix.clone(), drive: dr, wP, bx: b0.x, by: b0.y, bz: b0.z, ex: seg.x / e2, ey: seg.y / e2, ez: seg.z / e2, len0: Math.sqrt(e2), tx: t0.x, ty: t0.y, tz: t0.z, dLx: 0, dLy: 0, dLz: 0, row: new Float32Array(0) });
    const lMesh = root.getObjectByName(m.leafletName) as THREE.Mesh | undefined;
    const lMat = lMesh ? leafletMatrix(lMesh) : null;
    anchors.push(lMesh && lMat ? new THREE.Vector3().fromArray(lMesh.geometry.getAttribute('position').array as Float32Array, m.leafletVIdx * 3).applyMatrix4(lMat) : t0.clone());
    anchorLeaflet.push(m.leafletName);
    anchorVertex.push(m.leafletVIdx);
  }
  if (valvarData) {
    // Phase 4c: field table over the closed state (Gaussian up to each insertion × hinge limiting; the diagonal of the insertions is 1)
    const nA = wall.chords.length;
    const hingeOf = (sp: LeafletSpec, ry: number) => {
      const y = Math.max(0, Math.min(1, (sp.maxY - ry) / sp.height));
      return y * y;
    };
    const anchorHinge = anchors.map((_, k) => {
      const sp = valvarData.leaflets.find((l) => l.name === anchorLeaflet[k]);
      if (!sp) return 1;
      return Math.max(1e-6, hingeOf(sp, (sp.mesh.userData.restPositions as Float32Array)[anchorVertex[k] * 3 + 1]));
    });
    const q1 = new THREE.Vector3();
    const sig = RV_LEAFLET_RIG.kernelSigmaMm / S;
    const twoSig2 = 2 * sig * sig;
    for (const sp of valvarData.leaflets) {
      if (sp.isMitral) continue;
      const mat = leafletMatrix(sp.mesh);
      if (!mat) continue;
      const attr = sp.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const rest = sp.mesh.userData.restPositions as Float32Array;
      const table = new Float32Array(attr.count * nA);
      for (let v = 0; v < attr.count; v++) {
        q1.fromBufferAttribute(attr, v).applyMatrix4(mat);
        const hv = hingeOf(sp, rest[v * 3 + 1]);
        for (let k = 0; k < nA; k++) table[v * nA + k] = Math.exp(-q1.distanceToSquared(anchors[k]) / twoSig2) * Math.min(1, hv / anchorHinge[k]);
      }
      const inv = new THREE.Matrix3().setFromMatrix4(mat).invert().elements;
      const offset = new Float32Array(attr.count * 3);
      sp.rigOffset = offset;
      sp.mesh.userData.rigOffset = offset;
      wall.leaflets.push({ spec: sp, n: attr.count, table, inv: Float64Array.from(inv), offset });
    }
    for (let i = 0; i < nA; i++) {
      const L = wall.leaflets.find((d) => d.spec.name === anchorLeaflet[i]);
      if (L) wall.chords[i].row = L.table.slice(anchorVertex[i] * nA, (anchorVertex[i] + 1) * nA);
    }
    wall.anchorD = new Float64Array(nA * 3);
  }
  if (valvarData) {
    // the closed state was only for the reference; the next frame rewrites these vertices
    for (const b of valvarData.chordae) {
      (b.chordaMesh.geometry.getAttribute('position').array as Float32Array).set(b.chordaMesh.userData.restPositions as Float32Array);
      b.chordaMesh.geometry.getAttribute('position').needsUpdate = true;
    }
    for (const l of valvarData.leaflets) {
      (l.mesh.geometry.getAttribute('position').array as Float32Array).set(l.mesh.userData.restPositions as Float32Array);
      l.mesh.geometry.getAttribute('position').needsUpdate = true;
    }
  }

  const rig: RvContractionRig = {
    mesh: rvMesh,
    restMatrix,
    apex,
    annulus,
    septalPoint,
    axisL,
    axisR,
    axisAP,
    freeWallIndex: new Uint32Array(0),
    tracker: createRvVolumeTracker(),
    refVolume: 0,
    lastT: NaN,
    fill: 1,
    lambda: 0,
    kL: 0,
    kR: 0,
    kAP: 0,
    deform: new THREE.Matrix4(),
    wall,
    deltaTV: new THREE.Vector3(),
  };

  // q(λ) table over the closed cavity
  evaluateWall(wall, 0, 0, 0);
  wall.restVolume = wallCavityVolume(wall);
  const gains: [number, number, number] = [0, 0, 0];
  const lamMax = RV_TAPSE_MAX_MM / S / lengthD / (RV_COMPONENT_WEIGHTS.longitudinal * RV_RIG_GAINS.longitudinal);
  wall.lambdaMax = lamMax;
  const step = (lamMax - RV_LAMBDA_TABLE_MIN) / (RV_LAMBDA_TABLE_N - 1);
  let prev = Infinity;
  for (let i = 0; i < RV_LAMBDA_TABLE_N; i++) {
    const lam = RV_LAMBDA_TABLE_MIN + step * i;
    rigGains(lam, gains);
    evaluateWall(wall, gains[0], gains[1], gains[2]);
    let q = wallCavityVolume(wall) / wall.restVolume;
    if (q >= prev) q = prev - 1e-9; // strict monotonicity for the inversion
    prev = q;
    wall.lamGrid[i] = lam;
    wall.qGrid[i] = q;
    wall.qGridV[i] = q;
  }

  // Common wall: same table at the other v nodes (the septum recedes with the LV and the cavity grows). Row 0 = v = 0.
  for (let nv = 1; nv < RV_LV_V_NODES; nv++) {
    const v = (RV_LV_V_MAX * nv) / (RV_LV_V_NODES - 1);
    wall.lvV = v;
    fillLvEpiEnvelopeUniform(wall.lvEnv, v);
    wall.lvOn = true;
    let prevV = Infinity;
    for (let i = 0; i < RV_LAMBDA_TABLE_N; i++) {
      rigGains(wall.lamGrid[i], gains);
      evaluateWall(wall, gains[0], gains[1], gains[2]);
      let q = wallCavityVolume(wall) / wall.restVolume;
      if (q >= prevV) q = prevV - 1e-9;
      prevV = q;
      wall.qGridV[nv * RV_LAMBDA_TABLE_N + i] = q;
    }
  }
  // LV Phase 5b: node at v = RV_LV_V_MIN (same construction as the other nodes)
  {
    wall.lvV = RV_LV_V_MIN;
    fillLvEpiEnvelopeUniform(wall.lvEnv, RV_LV_V_MIN);
    wall.lvOn = true;
    let prevN = Infinity;
    for (let i = 0; i < RV_LAMBDA_TABLE_N; i++) {
      rigGains(wall.lamGrid[i], gains);
      evaluateWall(wall, gains[0], gains[1], gains[2]);
      let q = wallCavityVolume(wall) / wall.restVolume;
      if (q >= prevN) q = prevN - 1e-9;
      prevN = q;
      wall.qGridNeg[i] = q;
    }
  }
  wall.lvV = 0;
  fillLvEpiEnvelopeUniform(wall.lvEnv, 0);
  wall.lvOn = false;
  wall.lvE = 0;

  // Rest normals and at the systolic reference (q ≈ 0.4)
  const nAttr = geom.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (nAttr) {
    wall.nRest = new Float32Array(nAttr.array as Float32Array);
    const lamRef = rvLambdaFromQ(rig, 0.4);
    rigGains(lamRef, gains);
    wall.kLref = gains[0];
    const gRef: [number, number, number] = [0, 0, 0];
    for (let nv = 0; nv < RV_LV_V_NODES; nv++) {
      const v = (RV_LV_V_MAX * nv) / (RV_LV_V_NODES - 1);
      wall.lvV = v;
      wall.kLrefV[nv] = rigGains(rvLambdaFromQ(rig, 0.4), gRef)[0];
    }
    wall.lvV = 0;
    rig.kL = gains[0];
    rig.kR = gains[1];
    rig.kAP = gains[2];
    rig.deltaTV.copy(dirTV).multiplyScalar(gains[0] * lengthD);
    wall.dirty = true;
    flushRvContraction(rig);
    geom.computeVertexNormals();
    wall.nRef = new Float32Array(nAttr.array as Float32Array);
    (nAttr.array as Float32Array).set(wall.nRest);
    nAttr.needsUpdate = true;
  }

  // Back to rest; the mesh stays at matrix = M0 and the geometry is deformed per vertex
  rig.kL = 0;
  rig.kR = 0;
  rig.kAP = 0;
  rig.deltaTV.set(0, 0, 0);
  wall.dirty = true;
  flushRvContraction(rig);

  rvMesh.matrixAutoUpdate = false;
  rvMesh.matrix.copy(restMatrix);
  rvMesh.matrixWorldNeedsUpdate = true;
  rvMesh.userData.rvContraction = true;
  return rig;
}
