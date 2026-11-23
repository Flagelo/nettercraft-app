import * as THREE from 'three';
import { lvEnvelopeRadius, LV_ANALYTIC_PROFILE } from './rvGeometryMetrics';
import { TRICUSPID_APPARATUS_POSE_ENABLED, tricuspidPoseMatrix } from './tricuspidApparatusPose';
import { GLTF_SCALE_MM_PER_UNIT } from './valvarKinematics';

// ============================================================================
// Procedural RV wall (Phases 3, 3b and 3c of the RV plan)
// ----------------------------------------------------------------------------
// Diagnosis: DIAGNOSTICO_VD_GEOMETRIA_20261107.md (Sections 3, 4.1 and 5).
// Reports: VD_FASE3_20261108.md, VD_FASE3B_20261108.md and VD_FASE3C_20261108.md.
// Reference scale: 34.3 mm/unit (D1).
//
// Hybrid approach: the RV wall is generated here; the GLB tricuspid apparatus stays the same,
// repositioned by the rigid pose T_TV of Phase 2 (tricuspidApparatusPose.ts). The geometry of the node
// `right_ventricle` is swapped IN MEMORY on load (same node, same matrix, same material); the GLB
// stays untouched. Revert: RV_PROCEDURAL_ENABLED = false.
//
// Parameterization (u circumferential, v longitudinal, w transmural) in cylindrical coordinates around
// the LV axis: (θ, y, f), f = r − r_epi(y) = radial offset from the LV epicardium.
//  - each column u belongs to the septal half or the free half of the loop; the horns are the two columns of
//    lowest and highest θ of the annulus;
//  - crescent at each level v: septum at f = ε_endo, from θ_a (anterior horn, next to the LAD in the anterior
//    interventricular groove: D3) to θ_b (inferior horn); free wall at f = ε_endo + D(s, v);
//  - v = 0 (inflow tract): the endocardium IS the outer edge of the posed tricuspid annulus tube
//    (96 vertices of the annulus itself: annulus–wall gap = 0). (θ, y, f) of each column goes from the annulus and runs,
//    continuously in v, to the crescent (no plateau at the roof);
//  - explicit APEX: generator point P (endocardial pole), stored in geometry.userData.rvApex;
//  - epicardium: free wall = endocardium + thickness (with slope correction, thinning at the
//    horns); septum = LV-facing surface at f = ε_epi (0 < ε_epi < ε_endo);
//  - septal papillary muscle: Gaussian depression of the septum toward the cavity until it touches the base;
//    anterior and posterior papillary muscles: base moved to the CLOSEST POINT of the free-wall endocardium
//    with y_anchor ≤ y_base (D4 and D5; only the basal portion deforms; the tip with the chordae
//    insertions stays fixed), in an in-memory copy of the geometry;
//  - outflow tract: provisional opening in the roof, the closest to the pulmonary valve (Phase 5);
//  - openings closed by thickness edges: closed solid, 0 boundary edges.
// Attributes: position, normal, uv (u, v), `septalWeight` (0 on the septum, 1 on the free wall; Phase 4),
// `transmural` (0 endocardium, 1 epicardium).
// Setup only (allocates); never call per frame.
// ============================================================================

/** Revert flag: false keeps the GLB spherical mesh and the original papillary muscles. */
export const RV_PROCEDURAL_ENABLED = true;

/** Global scale (mm per model unit; D1 = 34.3, Lang 2015), the same as the valvular kinematics. */
export const RV_MM_PER_UNIT = GLTF_SCALE_MM_PER_UNIT;

export const RV_WALL_PARAMS = {
  /** free wall thickness: 3 mm */
  wallThickness: 3 / RV_MM_PER_UNIT,
  /** offset of the septal endocardium over the LV epicardium (ε ≤ 0.5 mm) */
  septalEpsEndo: 0.45 / RV_MM_PER_UNIT,
  /** offset of the LV-facing septal surface (0 < ε_epi < ε_endo) */
  septalEpsEpi: 0.15 / RV_MM_PER_UNIT,
  /** circumferential divisions (= segments of the GLB tricuspid annulus tube) */
  segmentsU: 96,
  /** longitudinal levels (not counting the apical pole) */
  levelsV: 84,
  /** explicit RV apex: θ (degrees), height y and offset f from the LV epicardium */
  apexThetaDeg: 140,
  apexY: -1.28,
  apexOffset: 0.05,
  /** crescent horns (degrees): anterior next to the LAD (D3: θ ≈ 68–75° in the mid portion of the GLB), without covering it; inferior in the posterior groove */
  hornAnteriorDeg: 75,
  hornInferiorDeg: 214,
  /** exponent of the angular closure of the horns up to the apex */
  hornApexExponent: 8,
  /** D3: v at which the columns next to the anterior horn (s < hornBlendS) are already at the crescent angle; the edge reaches the LAD above the middle third */
  hornBlendV: 0.25,
  hornBlendS: 0.15,
  /** D3: fraction of the thickness by which the epicardium folds beyond the anterior horn (1 at the inferior horn): keeps the LAD outside the wall */
  hornAnteriorWrap: 0.5,
  /** maximum cavity depth (f − ε) along the free wall */
  depthMax: 1.1,
  /** shape of the depth profile in s (0 at the anterior horn, 1 at the inferior): shifted peak and blunt horns */
  depthSkew: 0.45,
  depthBlunt: 0.2,
  /** shape of the depth in v: exponents of the thinning toward the apex */
  depthApexExpA: 2,
  depthApexExpB: 0.5,
  /** v at which the column leaves the annulus and becomes the crescent (free wall and angles) */
  blendV: 0.4,
  /** v at which the septal half is already over the LV (ε_endo) */
  septalAttachV: 0.12,
  /** fraction s at which the free wall thickness reaches its full value starting from the horns */
  hornTaper: 0.09,
  septalPapillarySigma: 0.09,
  /** provisional outflow tract: half-widths of the cell block (columns, levels) and searched v range */
  outletHalfCols: 7,
  outletHalfLevels: 5,
  outletVMin: 0.06,
  outletVMax: 0.34,
} as const;

export type RvWallParams = { -readonly [K in keyof typeof RV_WALL_PARAMS]: number };

export interface RvWallInputs {
  /** vertices of the ALREADY POSED tricuspid annulus, in the RV parent space */
  annulusPoints: ReadonlyArray<THREE.Vector3>;
  /** base (lowest vertex) of the posed septal papillary muscle, in the parent space */
  septalPapillaryBase: THREE.Vector3;
  /** center of the pulmonary valve (to orient the provisional outflow tract opening) */
  pulmonaryTarget: THREE.Vector3;
}

export interface RvWallResult {
  /** geometry in the RV parent space */
  geometry: THREE.BufferGeometry;
  /** indices (in the geometry) of the endocardial vertices of the inflow edge (= annulus vertices) */
  inletRim: number[];
  /** edges of the outflow tract border on the endocardium, as index pairs (they close the loop) */
  outletRim: Array<[number, number]>;
  /** indices of the endocardial vertices of the [level][u] grid and apical pole */
  innerGrid: Int32Array;
  innerPole: number;
  levels: number;
  segments: number;
  /** annulus center and explicit apex (endocardium), in the parent space */
  annulusCenter: THREE.Vector3;
  apex: THREE.Vector3;
}

const LV_TOP = LV_ANALYTIC_PROFILE.y0 + LV_ANALYTIC_PROFILE.height;

/** LV epicardium radius with constant continuation above the top (for a continuous f at the annulus). */
function rEpiExt(y: number): number {
  return lvEnvelopeRadius(Math.max(LV_ANALYTIC_PROFILE.y0, Math.min(LV_TOP - 1e-9, y)), true);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function centroid(pts: ReadonlyArray<THREE.Vector3>): THREE.Vector3 {
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  return c.multiplyScalar(1 / Math.max(1, pts.length));
}

/**
 * Loop of `n` vertices of the outer edge of the annulus: in each angular sector around c0 (in the mid plane),
 * the vertex of largest radius. Returns null if any sector is empty or repeats a vertex.
 */
function extractAnnulusLoop(pts: ReadonlyArray<THREE.Vector3>, c0: THREE.Vector3, normal: THREE.Vector3, n: number): THREE.Vector3[] | null {
  const e1 = new THREE.Vector3(1, 0, 0);
  if (Math.abs(e1.dot(normal)) > 0.9) e1.set(0, 0, 1);
  e1.addScaledVector(normal, -e1.dot(normal)).normalize();
  const e2 = new THREE.Vector3().crossVectors(normal, e1);
  const d = new THREE.Vector3();
  let bestR = -1;
  let phi0 = 0;
  for (const p of pts) {
    d.subVectors(p, c0);
    const x = d.dot(e1);
    const y = d.dot(e2);
    const r = Math.hypot(x, y);
    if (r > bestR) {
      bestR = r;
      phi0 = Math.atan2(y, x);
    }
  }
  const sector = (2 * Math.PI) / n;
  const best: number[] = new Array(n).fill(-1);
  const bestRad: number[] = new Array(n).fill(-1);
  for (let k = 0; k < pts.length; k++) {
    d.subVectors(pts[k], c0);
    const x = d.dot(e1);
    const y = d.dot(e2);
    let a = Math.atan2(y, x) - phi0 + 0.5 * sector;
    a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const s = Math.min(n - 1, Math.floor(a / sector));
    const r = Math.hypot(x, y);
    if (r > bestRad[s]) {
      bestRad[s] = r;
      best[s] = k;
    }
  }
  if (best.some((k) => k < 0) || new Set(best).size !== n) return null;
  return best.map((k) => pts[k].clone());
}

/** Normal of the mid plane of the points (smallest eigenvector of the covariance), oriented toward −y (ventricular). */
function planeNormal(pts: ReadonlyArray<THREE.Vector3>, c: THREE.Vector3): THREE.Vector3 {
  const m = [0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const x = p.x - c.x;
    const y = p.y - c.y;
    const z = p.z - c.z;
    m[0] += x * x;
    m[1] += x * y;
    m[2] += x * z;
    m[3] += y * y;
    m[4] += y * z;
    m[5] += z * z;
  }
  const inv = new THREE.Matrix3().set(m[0], m[1], m[2], m[1], m[3], m[4], m[2], m[4], m[5]).invert();
  const n = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 64; i++) n.applyMatrix3(inv).normalize();
  if (n.y > 0) n.negate();
  return n;
}

/**
 * Generates the RV wall (closed solid) in the RV parent space. Deterministic; allocates (only on load).
 * Returns null if the inputs do not allow the construction.
 */
export function buildRvWallGeometry(inputs: RvWallInputs, params: RvWallParams = { ...RV_WALL_PARAMS }): RvWallResult | null {
  const P = params;
  const NU = Math.round(P.segmentsU);
  const NV = Math.round(P.levelsV);
  const ann = inputs.annulusPoints;
  if (ann.length < NU) return null;

  const c0 = centroid(ann);
  const loop = extractAnnulusLoop(ann, c0, planeNormal(ann, c0), NU);
  if (!loop) return null;

  // Explicit apex (endocardial pole) and construction axis
  const thP = (P.apexThetaDeg * Math.PI) / 180;
  const apexR = rEpiExt(P.apexY) + P.apexOffset;
  const apex = new THREE.Vector3(apexR * Math.cos(thP), P.apexY, apexR * Math.sin(thP));
  const axis = new THREE.Vector3().subVectors(apex, c0).normalize();

  // Cylindrical coordinates of each column on the annulus
  const annTh = new Float64Array(NU);
  const annY = new Float64Array(NU);
  const annF = new Float64Array(NU);
  for (let i = 0; i < NU; i++) {
    const p = loop[i];
    let th = Math.atan2(p.z, p.x);
    if (th < 0) th += 2 * Math.PI;
    annTh[i] = th;
    annY[i] = p.y;
    annF[i] = Math.hypot(p.x, p.z) - rEpiExt(p.y);
  }

  // Horns on the annulus: columns of lowest and highest θ. Septal half = the arc of lowest mean f
  let iA = 0;
  let iB = 0;
  for (let i = 1; i < NU; i++) {
    if (annTh[i] < annTh[iA]) iA = i;
    if (annTh[i] > annTh[iB]) iB = i;
  }
  const arcLen = (from: number, to: number) => (to - from + NU) % NU;
  const meanF = (from: number, n: number) => {
    let s = 0;
    for (let k = 0; k <= n; k++) s += annF[(from + k) % NU];
    return s / (n + 1);
  };
  const nAB = arcLen(iA, iB);
  const nBA = arcLen(iB, iA);
  const abIsSeptal = meanF(iA, nAB) < meanF(iB, nBA);
  // col ∈ [0, NU): 0 = anterior horn; 0..Ns = septum from A to B; Ns..NU = free wall from B to A
  const Ns = abIsSeptal ? nAB : nBA;
  const dirStep = abIsSeptal ? 1 : -1;
  const colToLoop = new Int32Array(NU);
  for (let c = 0; c < NU; c++) colToLoop[c] = (iA + dirStep * c + NU * 2) % NU;
  const isSeptal = (c: number) => c <= Ns; // both horns belong to the septal half (columns 0 and Ns)
  // s ∈ [0, 1] of each column (0 at the anterior horn, 1 at the inferior)
  const colS = new Float64Array(NU);
  for (let c = 0; c < NU; c++) colS[c] = c <= Ns ? c / Ns : (NU - c) / (NU - Ns);

  // Levels: v_j from 0 (annulus) to almost 1; the pole is at v = 1
  const vLev = new Float64Array(NV);
  for (let j = 0; j < NV; j++) {
    const x = j / NV;
    vLev[j] = 0.35 * x * x + 0.65 * x;
  }

  const thA = (P.hornAnteriorDeg * Math.PI) / 180;
  const thB = (P.hornInferiorDeg * Math.PI) / 180;
  const hornW = (v: number) => Math.pow(Math.max(0, 1 - Math.pow(v, P.hornApexExponent)), 0.5);
  // depth: profile in s with peak shifted toward the anterior side and blunt horns; thins toward the apex
  const profS = (s: number) => {
    const x = Math.pow(Math.min(1, Math.max(0, s)), P.depthSkew);
    return Math.pow(Math.max(0, Math.sin(Math.PI * x)), P.depthBlunt);
  };
  const profV = (v: number) => Math.pow(Math.max(0, 1 - Math.pow(v, P.depthApexExpA)), P.depthApexExpB);
  const depthAt = (s: number, v: number) => P.depthMax * profS(s) * profV(v);

  const eEndo = P.septalEpsEndo;
  const eEpi = P.septalEpsEpi;
  const T = P.wallThickness;

  // Septal papillary base: amplitude of the Gaussian depression (touches the base at the radius passing through it)
  const sb = inputs.septalPapillaryBase;
  const sbF = Math.hypot(sb.x, sb.z) - rEpiExt(sb.y);
  const sigS2 = P.septalPapillarySigma * P.septalPapillarySigma;
  const dentD = Math.max(0, sbF - eEndo);
  const dentAmp = dentD * Math.exp((dentD * dentD) / sigS2);

  // ----- grid in (θ, y, f) -----
  const NPTS = NV * NU;
  const gTh = new Float64Array(NPTS);
  const gY = new Float64Array(NPTS);
  const gF = new Float64Array(NPTS); // endocardium without the septal depression
  const inner = new Float64Array(NPTS * 3);
  const outer = new Float64Array(NPTS * 3);
  const wIn = new Float64Array(NPTS);
  const wOut = new Float64Array(NPTS);
  const toXYZ = (th: number, y: number, f: number, out: THREE.Vector3) => {
    const r = rEpiExt(y) + f;
    return out.set(r * Math.cos(th), y, r * Math.sin(th));
  };

  for (let j = 0; j < NV; j++) {
    const v = vLev[j];
    const b = smoothstep(0, P.blendV, v);
    const bS = smoothstep(0, P.septalAttachV, v);
    const hw = hornW(v);
    const a0 = thP + (thA - thP) * hw;
    const b0 = thP + (thB - thP) * hw;
    for (let c = 0; c < NU; c++) {
      const k = j * NU + c;
      const li = colToLoop[c];
      const s = colS[c];
      const bTh = smoothstep(0, lerp(P.hornBlendV, P.blendV, smoothstep(0, P.hornBlendS, s)), v);
      gTh[k] = lerp(annTh[li], a0 + (b0 - a0) * s, bTh);
      gY[k] = annY[li] + (P.apexY - annY[li]) * v;
      gF[k] = isSeptal(c) ? lerp(annF[li], eEndo, bS) : Math.max(eEndo + 1e-4, lerp(annF[li], eEndo + depthAt(s, v), b));
    }
  }

  const q = new THREE.Vector3();
  const q0 = new THREE.Vector3();
  // thickness factor (normal offset in f): 1/cos of the free surface slope
  const thickFactor = (j: number, c: number) => {
    const k = j * NU + c;
    const kp = j * NU + ((c + 1) % NU);
    const km = j * NU + ((c - 1 + NU) % NU);
    const r = Math.max(0.05, rEpiExt(gY[k]) + gF[k]);
    const ds = Math.abs(gTh[kp] - gTh[km]) * r;
    const dfdS = ds > 1e-6 ? (gF[kp] - gF[km]) / ds : 0;
    const jp = Math.min(NV - 1, j + 1);
    const jm = Math.max(0, j - 1);
    const dl = Math.abs(gY[jp * NU + c] - gY[jm * NU + c]);
    const dfdL = dl > 1e-6 ? (gF[jp * NU + c] - gF[jm * NU + c]) / dl : 0;
    return Math.min(2.2, Math.sqrt(1 + dfdS * dfdS + dfdL * dfdL));
  };

  for (let j = 0; j < NV; j++) {
    const v = vLev[j];
    const apexW = smoothstep(0.85, 1, v);
    for (let c = 0; c < NU; c++) {
      const k = j * NU + c;
      const th = gTh[k];
      const y = gY[k];
      const fBase = gF[k];
      const horn = c === 0 || c === Ns;
      // endocardium (v = 0: vertices of the annulus itself)
      let f = fBase;
      if (isSeptal(c) && !horn) {
        toXYZ(th, y, fBase, q0);
        f = fBase + dentAmp * Math.exp(-q0.distanceToSquared(sb) / sigS2);
      }
      if (j === 0) q.copy(loop[colToLoop[c]]);
      else toXYZ(th, y, f, q);
      inner[3 * k] = q.x;
      inner[3 * k + 1] = q.y;
      inner[3 * k + 2] = q.z;
      // epicardium
      let thO = th;
      let fO: number;
      let wI: number;
      let wO: number;
      if (horn) {
        // horn: the epicardium wraps around the tip (beyond the horn, next to the LV)
        const rr = Math.max(0.05, rEpiExt(y) + fBase);
        thO = th + ((c === 0 ? -P.hornAnteriorWrap : 1) * T) / rr;
        fO = Math.max(eEpi, fBase - (eEndo - eEpi));
        wI = smoothstep(eEndo, eEndo + 0.06, fBase);
        wO = wI; // 0 only where the endocardium is already over the LV
      } else if (isSeptal(c)) {
        fO = Math.max(eEpi, fBase - T);
        wI = smoothstep(eEndo, eEndo + 0.06, fBase);
        wO = wI; // 0 only where the endocardium is already over the LV
      } else {
        const s = colS[c];
        const g = smoothstep(0, P.hornTaper, Math.min(s, 1 - s));
        fO = fBase + T * g * thickFactor(j, c);
        wI = smoothstep(eEndo, eEndo + 0.05, fBase);
        wO = wI;
      }
      toXYZ(thO, y, fO, q);
      if (!isSeptal(c)) q.addScaledVector(axis, T * apexW * smoothstep(0, 0.05, fBase - eEndo));
      outer[3 * k] = q.x;
      outer[3 * k + 1] = q.y;
      outer[3 * k + 2] = q.z;
      wIn[k] = wI;
      wOut[k] = wO;
    }
  }

  // ----- provisional outflow tract: cell block of the free wall, the closest to the pulmonary valve -----
  const tgt = inputs.pulmonaryTarget;
  const hc = Math.round(P.outletHalfCols);
  let bestD = Infinity;
  let jC = 0;
  let cC = 0;
  for (let j = 1; j < NV; j++) {
    if (vLev[j] < P.outletVMin || vLev[j] > P.outletVMax) continue;
    for (let c = Ns + hc + 2; c < NU - hc - 2; c++) {
      const k = j * NU + c;
      const d = (inner[3 * k] - tgt.x) ** 2 + (inner[3 * k + 1] - tgt.y) ** 2 + (inner[3 * k + 2] - tgt.z) ** 2;
      if (d < bestD) {
        bestD = d;
        jC = j;
        cC = c;
      }
    }
  }
  if (!Number.isFinite(bestD)) return null;
  const isHoleCell = (j: number, c: number) =>
    Math.abs(j + 0.5 - jC) <= P.outletHalfLevels && Math.abs(c + 0.5 - cC) <= P.outletHalfCols;

  // ----- assembly -----
  const positions: number[] = [];
  const uvs: number[] = [];
  const septW: number[] = [];
  const trans: number[] = [];
  const indices: number[] = [];
  const pushV = (x: number, y: number, z: number, u: number, v: number, w: number, tr: number) => {
    positions.push(x, y, z);
    uvs.push(u, v);
    septW.push(w);
    trans.push(tr);
    return positions.length / 3 - 1;
  };
  const innerIdx = new Int32Array(NPTS);
  const outerIdx = new Int32Array(NPTS);
  for (let k = 0; k < NPTS; k++) {
    const j = Math.floor(k / NU);
    innerIdx[k] = pushV(inner[3 * k], inner[3 * k + 1], inner[3 * k + 2], (k % NU) / NU, vLev[j], wIn[k], 0);
  }
  const innerPole = pushV(apex.x, apex.y, apex.z, 0.5, 1, 1, 0);
  for (let k = 0; k < NPTS; k++) {
    const j = Math.floor(k / NU);
    outerIdx[k] = pushV(outer[3 * k], outer[3 * k + 1], outer[3 * k + 2], (k % NU) / NU, vLev[j], wOut[k], 1);
  }
  const outerPoleP = apex.clone().addScaledVector(axis, T);
  const outerPole = pushV(outerPoleP.x, outerPoleP.y, outerPoleP.z, 0.5, 1, 1, 1);

  const id = (j: number, c: number) => j * NU + (c % NU);
  const innerTris: number[] = [];
  const outerTris: number[] = [];
  for (let j = 0; j < NV - 1; j++) {
    for (let c = 0; c < NU; c++) {
      if (isHoleCell(j, c)) continue;
      const a0i = innerIdx[id(j, c)];
      const a1i = innerIdx[id(j, c + 1)];
      const b0i = innerIdx[id(j + 1, c)];
      const b1i = innerIdx[id(j + 1, c + 1)];
      innerTris.push(a0i, b0i, a1i, a1i, b0i, b1i);
      const a0o = outerIdx[id(j, c)];
      const a1o = outerIdx[id(j, c + 1)];
      const b0o = outerIdx[id(j + 1, c)];
      const b1o = outerIdx[id(j + 1, c + 1)];
      outerTris.push(a0o, a1o, b0o, a1o, b1o, b0o);
    }
  }
  for (let c = 0; c < NU; c++) {
    innerTris.push(innerIdx[id(NV - 1, c)], innerPole, innerIdx[id(NV - 1, c + 1)]);
    outerTris.push(outerIdx[id(NV - 1, c)], outerIdx[id(NV - 1, c + 1)], outerPole);
  }
  for (const t of outerTris) indices.push(t);
  for (const t of innerTris) indices.push(t);

  // Thickness edges: for each endocardial edge a→b without its opposite (borders of the openings), quad
  // (b, a, a', b') with duplicated vertices (sharp normals at the edge)
  const innerToGrid = new Map<number, number>();
  for (let k = 0; k < NPTS; k++) innerToGrid.set(innerIdx[k], k);
  const dirEdges = new Set<string>();
  for (let t = 0; t < innerTris.length; t += 3) {
    for (let e = 0; e < 3; e++) dirEdges.add(`${innerTris[t + e]}_${innerTris[t + ((e + 1) % 3)]}`);
  }
  const inletRim: number[] = [];
  const outletRim: Array<[number, number]> = [];
  const dupIn = new Map<number, number>();
  const dupOut = new Map<number, number>();
  const dup = (src: number, map: Map<number, number>) => {
    let d = map.get(src);
    if (d === undefined) {
      d = pushV(positions[3 * src], positions[3 * src + 1], positions[3 * src + 2], uvs[2 * src], uvs[2 * src + 1], septW[src], trans[src]);
      map.set(src, d);
    }
    return d;
  };
  for (let t = 0; t < innerTris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const ia = innerTris[t + e];
      const ib = innerTris[t + ((e + 1) % 3)];
      if (dirEdges.has(`${ib}_${ia}`)) continue;
      const ka = innerToGrid.get(ia);
      const kb = innerToGrid.get(ib);
      if (ka === undefined || kb === undefined) return null;
      const dia = dup(ia, dupIn);
      const dib = dup(ib, dupIn);
      const doa = dup(outerIdx[ka], dupOut);
      const dob = dup(outerIdx[kb], dupOut);
      indices.push(dib, dia, doa, dib, doa, dob);
      if (Math.floor(ka / NU) === 0 && Math.floor(kb / NU) === 0) inletRim.push(ia);
      else outletRim.push([ia, ib]);
    }
  }

  // Orientation: solid with outward normals (signed volume > 0)
  let v6 = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const cc = new THREE.Vector3();
  for (let t = 0; t < indices.length; t += 3) {
    a.fromArray(positions, 3 * indices[t]);
    b.fromArray(positions, 3 * indices[t + 1]);
    cc.fromArray(positions, 3 * indices[t + 2]);
    v6 += a.dot(b.cross(cc));
  }
  if (v6 < 0) {
    for (let t = 0; t < indices.length; t += 3) {
      const tmp = indices[t + 1];
      indices[t + 1] = indices[t + 2];
      indices[t + 2] = tmp;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('septalWeight', new THREE.Float32BufferAttribute(septW, 1));
  geometry.setAttribute('transmural', new THREE.Float32BufferAttribute(trans, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // rvFreeWallUStart: columns with u greater than this value belong to the free half (used by the roof metrics)
  geometry.userData = {
    rvProcedural: true,
    rvApex: apex.toArray(),
    rvFreeWallUStart: Ns / NU,
    // Phase 4: the rig uses this data (adherent septum, septal depression of the septal papillary muscle)
    rvSegmentsU: NU,
    rvSeptalAttachV: P.septalAttachV,
    rvSeptalDent: { amp: dentAmp, sigma2: sigS2, base: sb.toArray() },
  };

  return {
    geometry,
    inletRim: [...new Set(inletRim)],
    outletRim,
    innerGrid: innerIdx,
    innerPole,
    levels: NV,
    segments: NU,
    annulusCenter: c0,
    apex,
  };
}

// ----------------------------------------------------------------------------
// Anchoring of the anterior and posterior papillary muscles to the wall (D4)
// ----------------------------------------------------------------------------

/** Fraction of the papillary muscle height, from the base, that deforms; above it nothing moves. */
export const PAPILLARY_STRETCH_FRACTION = 0.6;

export interface PapillaryExtension {
  name: string;
  /** length before (extension along the main axis of the papillary muscle) and after (tip → wall anchor), in units */
  lengthBefore: number;
  lengthAfter: number;
  /** tip → base axis, in the local space of the node (defines the basal portion) */
  axisLocal: THREE.Vector3;
  /** base vertex (the lowest after the pose), wall anchor and tip, in the RV parent space */
  baseIndex: number;
  anchor: THREE.Vector3;
  tip: THREE.Vector3;
  geometry: THREE.BufferGeometry;
  /** weight of the basal portion of each vertex (1 at the base, 0 above PAPILLARY_STRETCH_FRACTION); used in the Phase 4 skinning */
  weights: Float32Array;
}

/**
 * Point of the free-wall endocardium closest to `p` (`transmural` = 0 and `septalWeight` > 0.5 in the
 * three vertices of the triangle). Restricting to the free wall prevents anchoring a free-wall papillary muscle to the septum.
 * D5: `yMax` limits the anchor height (discards triangles whose closest point lies above it),
 * so that the base does not end up above the tip (inverted papillary muscle).
 */
function nearestFreeWallEndocardium(geom: THREE.BufferGeometry, p: THREE.Vector3, yMax: number = Infinity): THREE.Vector3 | null {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  const tr = geom.getAttribute('transmural') as THREE.BufferAttribute;
  const w = geom.getAttribute('septalWeight') as THREE.BufferAttribute;
  const index = geom.getIndex()!;
  const tri = new THREE.Triangle();
  const q = new THREE.Vector3();
  let best = Infinity;
  let at: THREE.Vector3 | null = null;
  for (let t = 0; t < index.count; t += 3) {
    const ia = index.getX(t);
    const ib = index.getX(t + 1);
    const ic = index.getX(t + 2);
    if (tr.getX(ia) !== 0 || tr.getX(ib) !== 0 || tr.getX(ic) !== 0) continue;
    if (w.getX(ia) <= 0.5 || w.getX(ib) <= 0.5 || w.getX(ic) <= 0.5) continue;
    tri.a.fromBufferAttribute(pos, ia);
    tri.b.fromBufferAttribute(pos, ib);
    tri.c.fromBufferAttribute(pos, ic);
    tri.closestPointToPoint(p, q);
    if (q.y > yMax) continue;
    const d = q.distanceToSquared(p);
    if (d < best) {
      best = d;
      at = q.clone();
    }
  }
  return at;
}

/**
 * Main axis of the papillary muscle (tip → base, oriented by the pose) and weight of the basal portion of each vertex
 * (1 at the base, 0 above PAPILLARY_STRETCH_FRACTION of the height). Same rule in the extension and in the skinning.
 */
export function papillaryBasalWeights(mesh: THREE.Mesh, poseM: THREE.Matrix4): { local: THREE.Vector3[]; axis: THREE.Vector3; tipIdx: number; L0: number; weights: Float32Array } {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const local: THREE.Vector3[] = [];
  const c = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(pos, i);
    local.push(p);
    c.add(p);
  }
  c.multiplyScalar(1 / n);
  // main axis (eigenvector of the largest eigenvalue) oriented toward the base (lowest in the posed space)
  const cov = [0, 0, 0, 0, 0, 0];
  for (const p of local) {
    const x = p.x - c.x;
    const y = p.y - c.y;
    const z = p.z - c.z;
    cov[0] += x * x;
    cov[1] += x * y;
    cov[2] += x * z;
    cov[3] += y * y;
    cov[4] += y * z;
    cov[5] += z * z;
  }
  const C = new THREE.Matrix3().set(cov[0], cov[1], cov[2], cov[1], cov[3], cov[4], cov[2], cov[4], cov[5]);
  const axis = new THREE.Vector3(0, -1, 0);
  for (let i = 0; i < 200; i++) axis.applyMatrix3(C).normalize();
  if (axis.clone().transformDirection(poseM).y > 0) axis.negate();
  const heights = local.map((p) => p.clone().sub(c).dot(axis));
  let zMin = Infinity;
  let zMax = -Infinity;
  let tipIdx = 0;
  for (let i = 0; i < n; i++) {
    const z = heights[i];
    if (z < zMin) {
      zMin = z;
      tipIdx = i;
    }
    zMax = Math.max(zMax, z);
  }
  const L0 = zMax - zMin;
  const F = PAPILLARY_STRETCH_FRACTION;
  const weights = new Float32Array(n);
  for (let i = 0; i < n; i++) weights[i] = Math.max(0, 1 - (zMax - heights[i]) / (L0 * F)); // 1 at the base, 0 above F
  return { local, axis, tipIdx, L0, weights };
}

/**
 * Copy of the papillary muscle geometry with the base moved, by the shortest path, to the free-wall endocardium.
 * Base = lowest vertex in the posed space (the definition of Phases 2 and 3); its displacement is the
 * segment to the closest point of the wall, and the basal portion follows with linear weight in height.
 * The tip (above PAPILLARY_STRETCH_FRACTION of the height), where the chordae insertions are, does not move.
 * `wall` and `poseM` in the same space (the RV parent space).
 */
export function buildPapillaryExtension(mesh: THREE.Mesh, wall: THREE.BufferGeometry, poseM: THREE.Matrix4): PapillaryExtension | null {
  const { local, axis, tipIdx, L0, weights } = papillaryBasalWeights(mesh, poseM);
  const n = local.length;
  const weight = (i: number) => weights[i];
  // base: lowest vertex after the pose
  let baseIdx = 0;
  let lowest = Infinity;
  const q = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    q.copy(local[i]).applyMatrix4(poseM);
    if (q.y < lowest) {
      lowest = q.y;
      baseIdx = i;
    }
  }
  const baseW = weight(baseIdx);
  if (!(baseW > 0)) return null;
  const base = local[baseIdx].clone().applyMatrix4(poseM);
  // D5: anchor at the closest point of the free endocardium with y_anchor ≤ y_base (no inverted papillary muscle)
  const anchor = nearestFreeWallEndocardium(wall, base, base.y);
  if (!anchor) return null;
  const inv = poseM.clone().invert();
  const deltaLocal = anchor.clone().applyMatrix4(inv).sub(local[baseIdx]).multiplyScalar(1 / baseW);
  const geometry = mesh.geometry.clone();
  const out = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < n; i++) {
    const w = weight(i);
    out.setXYZ(i, local[i].x + deltaLocal.x * w, local[i].y + deltaLocal.y * w, local[i].z + deltaLocal.z * w);
  }
  out.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const tip = local[tipIdx].clone().applyMatrix4(poseM);
  return { name: mesh.name, lengthBefore: L0, lengthAfter: tip.distanceTo(anchor), axisLocal: axis, baseIndex: baseIdx, anchor, tip, geometry, weights };
}

// ----------------------------------------------------------------------------
// Application to the loaded scene
// ----------------------------------------------------------------------------

const PAPILLARY_NAMES = {
  anterior: 'tricuspid_anterior_papillary_muscle',
  posterior: 'tricuspid_posterior_papillary_muscle',
  septal: 'tricuspid_septal_papillary_muscle',
} as const;

interface RvGeometryState {
  original: THREE.BufferGeometry;
  procedural: THREE.BufferGeometry | null;
  result: RvWallResult | null;
  papillaries: Array<{ mesh: THREE.Mesh; original: THREE.BufferGeometry; extension: PapillaryExtension }>;
}
const rvGeometryState = new WeakMap<THREE.Mesh, RvGeometryState>();

/** T_TV · M_rest of a node of the tricuspid apparatus (independent of the node's current state). */
function posedMatrix(obj: THREE.Mesh): THREE.Matrix4 {
  const ud = obj.userData as { tricuspidPoseRest?: number[] };
  const rest = ud.tricuspidPoseRest
    ? new THREE.Matrix4().fromArray(ud.tricuspidPoseRest)
    : new THREE.Matrix4().compose(obj.position, obj.quaternion, obj.scale);
  return tricuspidPoseMatrix().multiply(rest);
}

/** Vertex positions of a node of the apparatus in the RV parent space, ALREADY with the T_TV pose. */
function posedApparatusPoints(obj: THREE.Mesh): THREE.Vector3[] {
  const M = posedMatrix(obj);
  const pos = obj.geometry.getAttribute('position') as THREE.BufferAttribute;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(M));
  return out;
}

/** Generator inputs from the scene (RV parent space). null if any mesh is missing. */
export function rvWallInputsFromScene(root: THREE.Object3D): RvWallInputs | null {
  const rv = root.getObjectByName('right_ventricle') as THREE.Mesh | undefined;
  const ann = root.getObjectByName('tricuspid_annulus') as THREE.Mesh | undefined;
  const pv = root.getObjectByName('pulmonary_valve') as THREE.Mesh | undefined;
  const sept = root.getObjectByName(PAPILLARY_NAMES.septal) as THREE.Mesh | undefined;
  if (!rv?.isMesh || !ann?.isMesh || !pv?.isMesh || !sept?.isMesh) return null;
  if (ann.parent !== rv.parent || pv.parent !== rv.parent || sept.parent !== rv.parent) return null;
  const pts = posedApparatusPoints(sept);
  let lo = pts[0];
  for (const p of pts) if (p.y < lo.y) lo = p;
  pv.updateMatrix();
  const pvPos = pv.geometry.getAttribute('position') as THREE.BufferAttribute;
  const pvPts: THREE.Vector3[] = [];
  for (let i = 0; i < pvPos.count; i++) pvPts.push(new THREE.Vector3().fromBufferAttribute(pvPos, i).applyMatrix4(pv.matrix));
  return {
    annulusPoints: posedApparatusPoints(ann),
    septalPapillaryBase: lo.clone(),
    pulmonaryTarget: centroid(pvPts),
  };
}

/**
 * Swaps (enabled = true) or restores (enabled = false) the geometry of the `right_ventricle` node and of the
 * anterior and posterior papillary muscles. Same nodes, matrices and materials; only `mesh.geometry` changes.
 * Idempotent: the original and the new geometries are stored (WeakMap) and reused.
 * Requires the T_TV pose enabled (the wall is built around the posed annulus); without it, keeps the GLB.
 * Returns the generator result (or null when the original mesh stays).
 */
export function applyRvProceduralGeometry(
  root: THREE.Object3D,
  enabled: boolean = RV_PROCEDURAL_ENABLED && TRICUSPID_APPARATUS_POSE_ENABLED,
): RvWallResult | null {
  const rv = root.getObjectByName('right_ventricle') as THREE.Mesh | undefined;
  if (!rv?.isMesh) return null;
  let st = rvGeometryState.get(rv);
  if (!st) {
    st = { original: rv.geometry, procedural: null, result: null, papillaries: [] };
    rvGeometryState.set(rv, st);
  }
  if (!enabled) {
    rv.geometry = st.original;
    rv.userData.rvProcedural = false;
    for (const p of st.papillaries) p.mesh.geometry = p.original;
    return null;
  }
  if (!st.procedural) {
    const inputs = rvWallInputsFromScene(root);
    const result = inputs ? buildRvWallGeometry(inputs) : null;
    if (!result) {
      rv.geometry = st.original;
      rv.userData.rvProcedural = false;
      return null;
    }
    // papillary muscles: anchor on the wall still in the parent space
    for (const name of [PAPILLARY_NAMES.anterior, PAPILLARY_NAMES.posterior]) {
      const m = root.getObjectByName(name) as THREE.Mesh | undefined;
      if (!m?.isMesh) continue;
      const extension = buildPapillaryExtension(m, result.geometry, posedMatrix(m));
      if (extension) st.papillaries.push({ mesh: m, original: m.geometry, extension });
    }
    // parent space → local node space (the node matrix does not change)
    const toLocal = new THREE.Matrix4().compose(rv.position, rv.quaternion, rv.scale).invert();
    result.geometry.applyMatrix4(toLocal);
    result.geometry.computeBoundingBox();
    result.geometry.computeBoundingSphere();
    result.geometry.userData.rvApex = result.apex.clone().applyMatrix4(toLocal).toArray();
    st.procedural = result.geometry;
    st.result = result;
  }
  rv.geometry = st.procedural;
  rv.userData.rvProcedural = true;
  for (const p of st.papillaries) p.mesh.geometry = p.extension.geometry;
  return st.result;
}

/** Papillary muscles anchored to the wall (diagnostics and tests). */
export function rvPapillaryExtensions(root: THREE.Object3D): PapillaryExtension[] {
  const rv = root.getObjectByName('right_ventricle') as THREE.Mesh | undefined;
  const st = rv ? rvGeometryState.get(rv) : undefined;
  return st ? st.papillaries.map((p) => p.extension) : [];
}
