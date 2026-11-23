import * as THREE from 'three';
import { LV_ANALYTIC_PROFILE, lvEnvelopeRadius } from './rvGeometryMetrics';
import { LV_AHA_WEDGES } from './lvMetrics';

// ============================================================================
// LV — Phase 2: watertight rest geometry of the 17 wedges (approach C, D-VE1)
// ----------------------------------------------------------------------------
// Report: VE_FASE1_2_20261111.md. Diagnosis: VE_FASE0_DIAGNOSTICO_20261111.md.
// Keeps the 17 GLB nodes (name, material, userData.segId, selection, color, valve mode); only `mesh.geometry`
// changes, in memory, at load. The GLB is not modified.
//  - Common global θ grid of LV_GRID_DTHETA_DEG (multiple of 15°: covers the 60° boundaries of the
//    basal/mid levels and the −15° + 90°k ones of the apical level). No T junction.
//  - Same ν lines as the generator (6 bands per wedge) and the same analytic profile (lvEnvelopeRadius).
//  - Closed apex: below y0 = −1.42 the profile continues as a paraboloid of revolution with
//    C1 continuity at y0 (r² linear in y): r(y) = r0·√((y − y_p)/(y0 − y_p)), y_p = y0 − r0/(2·r'(y0)).
//    Own endocardial pole and epicardial pole (closed apical wall).
//  - Per-wedge layout as in the generator: 1st half = endocardium, 2nd = epicardium, vertex i ↔ i + n/2.
//  - Analytic normals of the surface of revolution (equal on vertices shared between nodes),
//    oriented by the triangle winding.
// The contraction (per-node scale, HeartMesh17) does not change in this phase. Revert: LV_WATERTIGHT_ENABLED = false.
// ============================================================================

export const LV_WATERTIGHT_ENABLED = true;
/** Step of the global θ grid (degrees). 72 columns around the circumference. */
export const LV_GRID_DTHETA_DEG = 5;
/** ν bands per wedge (the same as the generator). */
export const LV_NU_BANDS = 6;
/** Intermediate rings on the apical cap (between y0 and the pole). */
export const LV_APEX_CAP_RINGS = 3;

const P = LV_ANALYTIC_PROFILE;
const K_NU = (0.84 * Math.PI * 0.5) / P.height; // d(sine argument)/dy

/** Analytic derivative dr/dy of the profile at y0 (sinProf = sin(0.08); the 0.06 floor does not act in [0, 1]). */
function profileSlopeAtY0(epi: boolean): number {
  const c = Math.cos(0.08);
  const dEndo = P.endoRadius * c * K_NU;
  return epi ? dEndo * (1 + (P.wallBase * 0.35) / P.endoRadius) : dEndo;
}

/** Apical cap: radius at y0, height of the pole y_p. */
export function lvApexCap(epi: boolean): { r0: number; yPole: number } {
  const r0 = lvEnvelopeRadius(P.y0, epi);
  return { r0, yPole: P.y0 - r0 / (2 * profileSlopeAtY0(epi)) };
}

/** Closed profile: lvEnvelopeRadius in [y0, y0 + H]; parabolic C1 cap in [y_p, y0); 0 outside. */
export function lvClosedProfileRadius(y: number, epi: boolean): number {
  if (y >= P.y0) return lvEnvelopeRadius(y, epi);
  const { r0, yPole } = lvApexCap(epi);
  if (y <= yPole) return 0;
  return r0 * Math.sqrt((y - yPole) / (P.y0 - yPole));
}

function profileDrDy(y: number, epi: boolean): number {
  if (y < P.y0) {
    const { r0, yPole } = lvApexCap(epi);
    const t = (y - yPole) / (P.y0 - yPole);
    return t > 1e-12 ? r0 / (2 * (P.y0 - yPole) * Math.sqrt(t)) : Infinity;
  }
  const nu = Math.min(1, Math.max(0, (y - P.y0) / P.height));
  const c = Math.cos(nu * 0.84 * Math.PI * 0.5 + 0.08);
  const dEndo = P.endoRadius * c * K_NU;
  return epi ? dEndo * (1 + (P.wallBase * 0.35) / P.endoRadius) : dEndo;
}

/** "Outward" normal (away from the axis) of the surface of revolution r = R(y) at the point (θ, y). */
function outwardNormal(th: number, y: number, epi: boolean, out: THREE.Vector3): THREE.Vector3 {
  const d = profileDrDy(y, epi);
  if (!Number.isFinite(d)) return out.set(0, -1, 0);
  return out.set(Math.cos(th), -d, Math.sin(th)).normalize();
}

interface Ring {
  y: number;
  rEndo: number;
  rEpi: number;
  /** y per layer (the cap has a different y on endo and epi) */
  yEndo: number;
  yEpi: number;
}

/** Rings (bottom to top) of a wedge: generator ν lines; at the apex, cap + pole before them. */
function ringsOf(nu0: number, nu1: number, apex: boolean): { rings: Ring[]; pole: boolean } {
  const rings: Ring[] = [];
  if (apex) {
    const ce = lvApexCap(false);
    const cp = lvApexCap(true);
    for (let k = 1; k <= LV_APEX_CAP_RINGS; k++) {
      const s = k / (LV_APEX_CAP_RINGS + 1);
      const yEndo = ce.yPole + (P.y0 - ce.yPole) * s * s;
      const yEpi = cp.yPole + (P.y0 - cp.yPole) * s * s;
      rings.push({ y: NaN, rEndo: ce.r0 * s, rEpi: cp.r0 * s, yEndo, yEpi });
    }
  }
  for (let i = 0; i <= LV_NU_BANDS; i++) {
    const nu = nu0 + (i / LV_NU_BANDS) * (nu1 - nu0);
    const y = P.y0 + nu * P.height;
    rings.push({ y, rEndo: lvEnvelopeRadius(y, false), rEpi: lvEnvelopeRadius(y, true), yEndo: y, yEpi: y });
  }
  return { rings, pole: apex };
}

/** Watertight geometry of an AHA wedge (1–17), in node space (identity TRS in the GLB). */
export function buildLvWedgeGeometry(segId: number): THREE.BufferGeometry {
  const w = LV_AHA_WEDGES[segId - 1];
  const apex = segId === 17;
  const dTh = (LV_GRID_DTHETA_DEG * Math.PI) / 180;
  const nTh = Math.round((w.th1 - w.th0) / dTh);
  const closedLoop = apex; // full turn without a duplicated column
  const nCol = closedLoop ? nTh : nTh + 1;
  const { rings, pole } = ringsOf(w.nu0, w.nu1, apex);
  const nRing = rings.length;
  const layerVerts = (pole ? 1 : 0) + nRing * nCol;
  const positions = new Float32Array(layerVerts * 2 * 3);
  const normals = new Float32Array(layerVerts * 2 * 3);
  const thetaOf = (j: number) => {
    // exact angle on the global grid (k·dTh), avoiding error accumulation
    const k = Math.round(w.th0 / dTh) + j;
    return k * dTh;
  };
  const nrm = new THREE.Vector3();
  for (let layer = 0; layer < 2; layer++) {
    const epi = layer === 1;
    let v = layer * layerVerts;
    if (pole) {
      const yP = lvApexCap(epi).yPole;
      positions.set([0, yP, 0], v * 3);
      normals.set([0, -1, 0], v * 3);
      v++;
    }
    for (const rg of rings) {
      const r = epi ? rg.rEpi : rg.rEndo;
      const y = epi ? rg.yEpi : rg.yEndo;
      for (let j = 0; j < nCol; j++) {
        const th = thetaOf(j);
        positions[v * 3] = r * Math.cos(th);
        positions[v * 3 + 1] = y;
        positions[v * 3 + 2] = r * Math.sin(th);
        outwardNormal(th, y, epi, nrm);
        normals[v * 3] = nrm.x;
        normals[v * 3 + 1] = nrm.y;
        normals[v * 3 + 2] = nrm.z;
        v++;
      }
    }
  }
  const off = pole ? 1 : 0;
  const at = (i: number, j: number) => off + i * nCol + (closedLoop ? ((j % nCol) + nCol) % nCol : j);
  const idx: number[] = [];
  const L = layerVerts;
  // endo and epi surfaces (same winding as the generator)
  for (let i = 0; i < nRing - 1; i++) {
    for (let j = 0; j < nTh; j++) {
      const a0 = at(i, j), b0 = at(i, j + 1), c0 = at(i + 1, j), d0 = at(i + 1, j + 1);
      idx.push(a0, c0, b0, b0, c0, d0);
      idx.push(L + a0, L + b0, L + c0, L + b0, L + d0, L + c0);
    }
  }
  if (pole) {
    // pole fan: the generator's degenerate quad (a = b = pole) leaves (b, c, d) on endo and (b, d, c) on epi
    for (let j = 0; j < nTh; j++) {
      const c0 = at(0, j), d0 = at(0, j + 1);
      idx.push(0, c0, d0);
      idx.push(L + 0, L + d0, L + c0);
    }
  }
  if (!closedLoop) {
    // lateral walls (j = 0 and j = nTh), as in the generator
    for (let i = 0; i < nRing - 1; i++) {
      const e0 = at(i, 0), e1 = at(i + 1, 0);
      idx.push(e0, e1, L + e0, L + e0, e1, L + e1);
      const f0 = at(i, nTh), f1 = at(i + 1, nTh);
      idx.push(f0, L + f0, f1, L + f0, L + f1, f1);
    }
  }
  // circumferential caps: lower (only outside the apex) and upper
  for (let j = 0; j < nTh; j++) {
    if (!pole) {
      const e0 = at(0, j), e1 = at(0, j + 1);
      idx.push(e0, L + e0, e1, L + e0, L + e1, e1);
    }
    const t0 = at(nRing - 1, j), t1 = at(nRing - 1, j + 1);
    idx.push(t0, t1, L + t0, L + t0, t1, L + t1);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(idx);
  // Analytic normals with the generator's winding sign: on the endocardium (a, c, b) the face points
  // away from the axis (+"outward" normal); on the epicardium (a, b, c), toward the axis (−"outward" normal).
  for (let i = L; i < 2 * L; i++) {
    normals[3 * i] *= -1;
    normals[3 * i + 1] *= -1;
    normals[3 * i + 2] *= -1;
  }
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  geom.userData.lvWatertight = { segId, nCol, nRing, pole, layerVerts };
  return geom;
}

const lvGeometryState = new WeakMap<THREE.Mesh, { original: THREE.BufferGeometry; watertight: THREE.BufferGeometry | null }>();
let buildCache: Map<number, THREE.BufferGeometry> | null = null;

/** Last build time (ms) measured by applyLvWatertightGeometry (0 when reused). */
export let lvWatertightLastBuildMs = 0;

/**
  * Swaps (enabled = true) or restores (enabled = false) the geometry of the 17 `heart_segment_*` wedges (userData.segId).
  * Idempotent: originals and new ones are stored (WeakMap); the new geometries are built once per
  * segment and shared among clones. Same nodes, matrices and materials.
  * Returns the number of wedges swapped.
 */
export function applyLvWatertightGeometry(root: THREE.Object3D, enabled: boolean = LV_WATERTIGHT_ENABLED): number {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o: any) => {
    const id = o?.userData?.segId;
    if (o?.isMesh && typeof id === 'number' && id >= 1 && id <= 17) meshes.push(o);
  });
  let n = 0;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let built = false;
  for (const m of meshes) {
    let st = lvGeometryState.get(m);
    if (!st) {
      st = { original: m.geometry, watertight: null };
      lvGeometryState.set(m, st);
    }
    if (!enabled) {
      m.geometry = st.original;
      m.userData.lvWatertight = false;
      continue;
    }
    if (!st.watertight) {
      if (!buildCache) buildCache = new Map();
      let g = buildCache.get(m.userData.segId);
      if (!g) {
        g = buildLvWedgeGeometry(m.userData.segId);
        buildCache.set(m.userData.segId, g);
        built = true;
      }
      st.watertight = g;
    }
    m.geometry = st.watertight;
    m.userData.lvWatertight = true;
    n++;
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  lvWatertightLastBuildMs = built ? t1 - t0 : 0;
  return n;
}

/** Tests only: discards the geometry cache (forces rebuild and time measurement). */
export function resetLvWatertightCacheForTests(): void {
  buildCache = null;
}
