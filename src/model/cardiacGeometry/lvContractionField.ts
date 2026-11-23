import * as THREE from 'three';
import { LV_ANALYTIC_PROFILE, lvEnvelopeRadius } from './rvGeometryMetrics';
import { lvClosedProfileRadius, lvApexCap } from './lvWatertightGeometry';
import { papillaryBasalWeights } from './rvGeometry';
import type { ValvarKinematicsData, ChordaBinding } from './valvarKinematics';
import { setupAtrialSkinning, applyAtrialSkinning, RA_SKIN_PARAMS, type AtrialSkinRig, type AtrialSkinParams } from './atrialSkinning';

// ============================================================================
// LV radial + longitudinal contraction per vertex, calibrated by volume
// ----------------------------------------------------------------------------
// Rest coordinates (θ, u) of each vertex (u = rest y). Twist: see the twist section below.
//  - Endocardium: ρ_n² = R_n(u)²·(1 − λ·c_n), c_n = c·m, m = 1 − k·window (septal attenuation, D-VE13).
//  - Epicardium: ρ_p² = ρ_n² + W0/(1 − κλc), W0 = R_p² − R_n² + λR_n²[c_n − (1 − s)(c_n + β c_n⁺)], s = S·window (D-VE4),
//    β(u) from per-slice conservation; the factor 1/(1 − κλc) returns to the slice the area that longitudinal compression removes (mass).
//  - Longitudinal (Phase 4, D-VE2/D-VE5): y = u − κλ·G(θ, u), G = ∫ c du from the epicardial pole (fixed apex). The same
//    Δy for endocardium and epicardium at the same (θ, u). κ: Carlsson MAPSE (60 % of the SV) at the end-systolic λ.
//  - λ: per-frame scalar, from the table q(λ) = V_mesh/V_rest (129 nodes), with q = vLV/V_ref (V_ref ← EDV, τ = 1.5 s).
//  - c(θ, ν): smooth field from c_i (wm and ischemia), evaluated at the rest position ⇒ no gap.
//  - Normals: central differences of the analytic position on a fixed rest stencil (θ ± 2.5°, u ± 0.03).
//  - Epicardial envelope (144 θ × 88 y) at the CURRENT y, for the RV; current endocardial grid for the papillary muscles.
//  - Mitral apparatus (annulus, leaflets, 12 chordae): rigid translation of the AV plane (descent + toward the axis), in the node matrix.
//    Papillary muscles: base on the wall, tip with the apparatus; tip y solved to keep the chordae length (tethers).
//  - LA: skinning coupled to the apparatus field. Aortic valve: descent in y; aortic root by local skinning.
//  - LA floor rises to the annulus plane under load, with floor at current LV top and RA contact post-step;
//    table λ → apparatus translation correction on c_i change; papillary tip = apparatus, chordae at rest LV length; 30° septal ramp.
// No per-frame allocation. Revert: LV_FIELD_ENABLED = false (back to per-node scaling); LV_LONG_KAPPA = 0 turns Phase 4 off.
// ============================================================================

export const LV_FIELD_ENABLED = true;
/** Maximum epicardial fixation fraction at the RV contact (S = 0.20). */
export const LV_SEPTAL_FIX_MAX = 0.2;
/** Attenuation of radial endocardial motion in the septal window (k = 0.30). */
export const LV_SEPTAL_ENDO_ATTEN = 0.3;
/** Longitudinal gain κ: s_L = κλ (c = 1); calibrated to MAPSE target 8.838 mm at λ_ES. */
export const LV_LONG_KAPPA = 0.16806;
/** MAPSE target (Carlsson 2007, 60 % of the SV) on the watertight mesh: 0.25767 u = 8.838 mm. */
export const LV_MAPSE_TARGET_U = 0.25767;
/** Gain of the mitral apparatus translation toward the axis: |u_h| = g·(1 − f), f = √(1 − λ c_n) at the annulus center. */
export const LV_APPARATUS_INWARD_GAIN = 0.41578;
/** Half-width of the c-field transitions between segments: θ (degrees) and ν. */
export const LV_C_THETA_HALF_DEG = 15;
export const LV_C_NU_HALF = 0.05;
/**
 * Nominal λ at end systole with wm = 1: λ(q = 1 − 0.6234) in the current model. Only normalizes the RV annulus offset (and the LA reference normals).
 * Phase 4b (30° ramp): 0.6571. Phase 4c (60° ramp, D-VE22): 0.6748 (λ = 0.674776 measured; by definition, no calibration).
 */
export const LV_LAMBDA_ES_NOMINAL = 0.6748;
/** Minimum relative r² of the endocardium (λ·c ≤ 1 − LV_G_MIN). */
export const LV_G_MIN = 0.1;
/** Absolute ceiling of λ (with small c the table would go too far). */
export const LV_LAMBDA_ABS_MAX = 1.5;
const LV_LAMBDA_TABLE_MIN = -0.15;
const LV_LAMBDA_TABLE_N = 129;
const LV_REF_TAU_S = 1.5;
const LV_MIN_STROKE_ML = 2;
/** Safety margin of the mitral papillary muscles from the current endocardium (u ≈ 0.017 mm). */
export const LV_PAPILLARY_WALL_MARGIN = 0.0005;
/** Aortic root: weight 1 up to 5 mm above the base and 0 at 20 mm. */
export const LV_AORTA_ROOT_MM: readonly [number, number] = [5, 20];
/**
 * LA: RA skinning parameters without the static LV epicardium lock; no anchor on the RA, and the floor below the
 * annulus plane rises to the plane under load (radial weight 1 up to 6 mm from the annulus contour, 0 at 18 mm).
 */
export const LA_SKIN_PARAMS: AtrialSkinParams = { ...RA_SKIN_PARAMS, lvMargin: -1e6, floorToPlane: [6, 18] };
/**
 * RA with the floor below the tricuspid plane collapsed to the plane under load. Radial weight 1 up to
 * 18 mm from the annulus contour and 0 at 30 mm (12 mm transition, matching LA; smallest measured band clearing RA from LV at rest).
 */
export const RA_SKIN_PARAMS_LV: AtrialSkinParams = { ...RA_SKIN_PARAMS, floorToPlane: [18, 30] };
/** LA, per-frame post-step: floor at the current top of the LV (u margin) inside the top epicardium (+ u tolerance). */
export const LA_FLOOR_MARGIN = 0.0005;
export const LA_FLOOR_FOOTPRINT_TOL = 0.02;
/** LA, post-step: contact with the RA for vertices ≤ 8 mm from the RA at rest (half-space at the closest point; u margin). */
export const LA_RA_CONTACT_MM = 8;
export const LA_RA_MARGIN = 0.0005;
/** Mitral apparatus (D-VE18): nodes of the λ → xz correction table, margin to the endocardium (u), iterations and candidate filter (r/R_n). */
export const LV_APP_TABLE_N = 25;
export const LV_APP_WALL_MARGIN = 0.001;
const LV_APP_GN_ITERS = 12;
const LV_APP_CAND_RATIO = 0.6;
/**
 * Phase 4b: with regional motion the envelope grid misjudges the endocardial radius by up to 0.38 mm (0.011 u) at the c-field transitions
 * (probe dbg_erro_grade.json); points within this band (u) of the wall by the grid use the exact radius (papillary projection, table).
 */
const LV_EXACT_BAND = 0.02;
/** Maximum measured grid error (0.011 u) rounded up: extra table margin before the exact check. */
const LV_EXACT_GRID_ERR = 0.012;

/** Measured RV–LV contact (lvFollow > 0.5): y, start and end θ (degrees). */
const LV_RV_CONTACT: ReadonlyArray<readonly [number, number, number]> = [
  [-1.25, 102, 190], [-1.15, 88, 204], [-1.05, 82, 213], [-0.95, 77, 217], [-0.85, 75, 219], [-0.75, 73, 220],
  [-0.65, 72, 221], [-0.05, 72, 220], [0.05, 72, 217], [0.15, 72, 211], [0.25, 72, 204], [0.35, 75, 197],
  [0.45, 89, 190], [0.55, 113, 179], [0.65, 136, 176], [0.75, 149, 175],
];
/**
 * Width of the septal window ramp (degrees): 60° full width (expanded from 30° without recalibrating κ).
 */
export const LV_SEPTAL_TAPER_DEG = 60;
/** Phase 4c (D-VE21): guard of the local top field near the LV axis (mm): 0 up to 1 mm, 1 from 3 mm (no apparatus vertex at < 3.2 mm). */
export const LV_LOCAL_TOP_GUARD_MM: readonly [number, number] = [1, 3];
/** Phase 4c (D-VE24): RA post-step margin to the current epicardium/top (u) = LA margin (0.0005) + maximum measured grid error (0.012). */
export const RA_LV_MARGIN = 0.0125;
/** Phase 4c (D-VE21): annulus neighbors per LA vertex (Δy inherited from the annulus, IDW p = 4). */
const LA_ANN_NEIGHBORS = 8;
/** Normal stencil steps (mesh scale): half a θ grid column (2.5°) and ~1/4 of the ring spacing. */
const LV_NORMAL_DTHETA = 2.5 * (Math.PI / 180);
const LV_NORMAL_DY = 0.03;

const P = LV_ANALYTIC_PROFILE;
const Y0 = P.y0;
const Y_TOP = P.y0 + P.height;
/** Longitudinal fixed point: epicardial pole (D-VE5). */
export const LV_APEX_FIXED_Y = lvApexCap(true).yPole;
const Y_PE = LV_APEX_FIXED_Y;
const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

const MITRAL_APPARATUS_RE = /^mitral_(annulus|anterior_leaflet|posterior_leaflet|(anterolateral|posteromedial)_chorda_\d+)$/;

// ---------- LV twist (Maharaj 2013, PMID 23053853) ----------
// φ(u, λ) = T·w_c(ν)·Φ(ν) about the LV y axis; φ > 0 = increasing θ = counterclockwise seen from the apex (AR > 0, BR < 0).
// Φ(ν) = Φ_A + (Φ_B − Φ_A)·smoothstep(ν_A, ν_B, ν), constant outside [ν_A, ν_B] (rigid apical cap and base).
// u estimated from the CURRENT y (inversion with c ≡ 1): φ is a function of y only, the same for all envelope consumers.
// Everything is still computed in the non-rotating frame; rotation is the last step of each object (wedges, apparatus, papillary muscles, aortic,
// aortic root, LA through the apparatus field). The RV, the tricuspid apparatus and the RA do not rotate. Revert: LV_TWIST_ENABLED = false.

export const LV_TWIST_ENABLED = true;
/** Mean apical and basal rotation from Maharaj 2013 (degrees) at the nominal end-systolic λ (by definition, no calibration). */
export const LV_TWIST_APEX_DEG = 5.56;
export const LV_TWIST_BASE_DEG = -3.31;
/** Measurement levels (ν = (u − y0)/H): middle of the AHA apical level (0.14–0.36) and basal level (0.68–1). Mesh rings at u = −0.8825 and 0.386. */
export const LV_TWIST_NU_APICAL = 0.25;
export const LV_TWIST_NU_BASAL = 0.84;
/**
 * Untwisting without the engine signals (or without a reference from the previous beat): T = T_sw·(1 − smoothstep(0, T_u, t − t_sw)), T_u (s).
 * With the engine's zMitral and qMitral, the event-driven profile below applies.
 */
export const LV_UNTWIST_S = 0.2;
/**
 * Event-driven untwisting tied to filling. Untwisted fraction U; T = T_sw·(1 − U).
 *  - IVR (end of ejection → mitral opening): U = LV_UNTWIST_IVR_FRACTION·smoothstep(0, D_riv, t − t_fim); t_fim = last step in which λ
 *    rose before the switch; D_riv = IVR measured in the previous beat
 *    (initial LV_UNTWIST_IVR_DEFAULT_S). 0.42 = untwisting/twist ratio in the IVR of Maufrais 2014 (PMID 25127983), by definition.
 *  - Filling (mitral opening onward): U = U_ab + (1 − U_ab)·smoothstep(0, 1, (V − V_ab)/ΔV_E); ΔV_E = volume that entered between
 *    mitral opening and the E-wave peak in the previous beat (largest qMitral within LV_UNTWIST_E_WINDOW_S after opening).
 * Mitral opening = zMitral ≥ LV_UNTWIST_VALVE_Z (project convention for a valve event) after the switch.
 */
export const LV_UNTWIST_IVR_FRACTION = 0.42;
export const LV_UNTWIST_IVR_DEFAULT_S = 0.08;
export const LV_UNTWIST_E_WINDOW_S = 0.3;
export const LV_UNTWIST_VALVE_Z = 0.25;
/** Smallest ΔV_E (mL) accepted as a reference (below that the time profile applies). */
const LV_UNTWIST_MIN_DV = 1e-3;
/**
 * Engine-event untwisting path, active when the driver receives a finite zAortic (7th argument; the
 * 1 ms step system passes it). Switch at aortic closure (zAortic crosses LV_UNTWIST_VALVE_Z downward, interpolated instant), without
 * waiting for the λ plateau; an ejection that crosses the beat turnover postpones the reference of the next systole; T never falls faster than
 * LV_UNTWIST_MAX_RATE: mean + 2 SD of the peak resting untwisting velocity of Doucende 2010 (PMID 20581049; −88.7 ± 34.2 °/s),
 * converted by the nominal twist per unit of T (5.56 + 3.31 = 8.87°). Without zAortic the Phase 5b path applies, unchanged.
 */
export const LV_UNTWIST_PEAK_RATE_DEG_S = 88.7 + 2 * 34.2;
export const LV_UNTWIST_MAX_RATE = LV_UNTWIST_PEAK_RATE_DEG_S / (LV_TWIST_APEX_DEG - LV_TWIST_BASE_DEG);
/** Systole → untwisting switch: armed with λ ≥ λ_min,beat + 0.05; when λ no longer rises by more than 2e−4 per 20 ms (IVR plateau). */
export const LV_TWIST_ARM = 0.05;
export const LV_TWIST_PLATEAU_S = 0.02;
export const LV_TWIST_RISE_EPS = 2e-4;
const TW_N = 256;
const WC_N = 64;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** sin and cos of a small angle (|a| ≤ 0.5 rad: error < 1e−9) without trigonometry. Writes to SC[0], SC[1]. */
const SC = new Float64Array(2);
function sinCosSmall(a: number): void {
  const a2 = a * a;
  SC[0] = a * (1 - (a2 / 6) * (1 - (a2 / 20) * (1 - (a2 / 42) * (1 - a2 / 72))));
  SC[1] = 1 - (a2 / 2) * (1 - (a2 / 12) * (1 - (a2 / 30) * (1 - a2 / 56)));
}

function nuOf(y: number): number {
  return (y - Y0) / P.height;
}

/**
 * Effective longitudinal gain κ·max(λ, 0). The longitudinal component acts only in contraction;
 * with λ < 0 (LV above the reference volume) the field is radial only and the base NEVER rises above the rest top (Y_TOP), which is what
 * all envelope consumers assume (y grid ∈ [y0, Y_TOP], RV guard, tricuspid papillary muscles, RA and LA post-steps).
 * Revert: return κ·λ.
 */
function klOf(kappa: number, lambda: number): number {
  return lambda > 0 ? kappa * lambda : 0;
}

/** Phase 4c (D-VE21): radial guard of the local top field (r in u, distance to the LV axis). */
function localTopGuard(r: number): number {
  return smoothstep(LV_LOCAL_TOP_GUARD_MM[0] / 34.3, LV_LOCAL_TOP_GUARD_MM[1] / 34.3, r);
}

/** RV contact window (0…1), θ in rad, rest u. */
export function lvSeptalWindow(theta: number, y: number): number {
  if (y < -1.4) return 0;
  let a: number;
  let b: number;
  const C = LV_RV_CONTACT;
  if (y <= C[0][0]) {
    a = C[0][1];
    b = C[0][2];
  } else if (y >= C[C.length - 1][0]) {
    a = C[C.length - 1][1];
    b = C[C.length - 1][2];
  } else {
    let k = 0;
    while (y > C[k + 1][0]) k++;
    const t = (y - C[k][0]) / (C[k + 1][0] - C[k][0]);
    a = C[k][1] + t * (C[k + 1][1] - C[k][1]);
    b = C[k][2] + t * (C[k + 1][2] - C[k][2]);
  }
  let d = (theta / DEG) % 360;
  if (d < 0) d += 360;
  const T = LV_SEPTAL_TAPER_DEG;
  return smoothstep(a - T, a, d) * (1 - smoothstep(b, b + T, d)) * smoothstep(-1.4, -1.3, y);
}

/** Epicardial fixation weight on the RV side (0…LV_SEPTAL_FIX_MAX). θ in rad. */
export function lvSeptalFixWeight(theta: number, y: number): number {
  return LV_SEPTAL_FIX_MAX * lvSeptalWindow(theta, y);
}

// ---------- c(θ, ν) field ----------

function ringValue(c: ArrayLike<number>, first: number, count: number, th0: number, theta: number): number {
  const w = TWO_PI / count;
  let t = (theta - th0) % TWO_PI;
  if (t < 0) t += TWO_PI;
  let j = Math.floor(t / w);
  if (j >= count) j = count - 1;
  const d0 = t - j * w;
  const d1 = (j + 1) * w - t;
  const h = LV_C_THETA_HALF_DEG * DEG;
  const cj = c[first + j];
  if (d0 < h) {
    const cp = c[first + ((j + count - 1) % count)];
    return cp + (cj - cp) * smoothstep(-h, h, d0);
  }
  if (d1 < h) {
    const cn = c[first + ((j + 1) % count)];
    return cj + (cn - cj) * smoothstep(-h, h, -d1);
  }
  return cj;
}

function levelValue(c: ArrayLike<number>, level: number, theta: number): number {
  if (level === 0) return c[16];
  if (level === 1) return ringValue(c, 12, 4, -Math.PI / 12, theta);
  if (level === 2) return ringValue(c, 6, 6, 0, theta);
  return ringValue(c, 0, 6, 0, theta);
}

const NU_BOUNDS = [0.14, 0.36, 0.68];

/** Smooth c(θ, ν) from c_i (index 0 = segment 1). θ in rad; ν < 0 (cap) = apex; ν > 1 = basal. */
export function lvMotionField(c: ArrayLike<number>, theta: number, nu: number): number {
  let level = 0;
  while (level < 3 && nu >= NU_BOUNDS[level]) level++;
  const h = LV_C_NU_HALF;
  if (level > 0) {
    const d0 = nu - NU_BOUNDS[level - 1];
    if (d0 < h) {
      const a = levelValue(c, level - 1, theta);
      const b = levelValue(c, level, theta);
      return a + (b - a) * smoothstep(-h, h, d0);
    }
  }
  if (level < 3) {
    const d1 = NU_BOUNDS[level] - nu;
    if (d1 < h) {
      const a = levelValue(c, level, theta);
      const b = levelValue(c, level + 1, theta);
      return a + (b - a) * smoothstep(-h, h, -d1);
    }
  }
  return levelValue(c, level, theta);
}

/** c_i from wm (1–4) and ischemia (HeartMesh17 rules). */
export function lvMotionWeight(wm: number, ischemic: boolean): number {
  const base = wm === 1 ? 1.0 : wm === 2 ? 0.45 : wm === 3 ? 0.0 : -0.32;
  return ischemic ? Math.min(base, 0.35) : base;
}

function rEndo2(y: number): number {
  const r = lvClosedProfileRadius(y, false);
  return r * r;
}
function rEpi2(y: number): number {
  const r = lvClosedProfileRadius(y, true);
  return r * r;
}

const cAt = (c: ArrayLike<number> | null, th: number, u: number) => (c ? lvMotionField(c, th, nuOf(u)) : 1);

/** β(u) from per-slice conservation over c_n (720 θ samples). Without c (null) = c ≡ 1. */
export function lvSliceBeta(c: ArrayLike<number> | null, y: number): number {
  let num = 0;
  let den = 0;
  let abs = 0;
  for (let k = 0; k < 720; k++) {
    const th = (k + 0.5) * (TWO_PI / 720);
    const w = lvSeptalWindow(th, y);
    const cn = cAt(c, th, y) * (1 - LV_SEPTAL_ENDO_ATTEN * w);
    const s = LV_SEPTAL_FIX_MAX * w;
    num += s * cn;
    den += (1 - s) * (cn > 0 ? cn : 0);
    abs += Math.abs(cn);
  }
  if (!(abs > 0) || den <= 1e-3 * abs) return 0;
  return num / den;
}

/** Field coefficients at (θ, u): ρ_n² = a0 + λa1; ρ_p² = a0 + λa1 + (b0 + λb1)/(1 − κλ·cl). */
interface Coeffs {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  cl: number;
}

function coeffsAt(c: ArrayLike<number> | null, th: number, u: number, beta: number, out: Coeffs): Coeffs {
  const rn2 = rEndo2(u);
  const rp2 = rEpi2(u);
  const cc = cAt(c, th, u);
  const w = lvSeptalWindow(th, u);
  const cn = cc * (1 - LV_SEPTAL_ENDO_ATTEN * w);
  const s = LV_SEPTAL_FIX_MAX * w;
  out.a0 = rn2;
  out.a1 = -rn2 * cn;
  out.b0 = rp2 - rn2;
  out.b1 = rn2 * (cn - (1 - s) * (cn + beta * (cn > 0 ? cn : 0)));
  out.cl = cc;
  return out;
}

function layerR2(epi: boolean, a0: number, a1: number, b0: number, b1: number, cl: number, lam: number, kl: number): number {
  const en = a0 + lam * a1;
  if (!epi) return en;
  const den = 1 - kl * cl;
  return en + (b0 + lam * b1) / (den > 0.05 ? den : 0.05);
}

// ---------- G(θ, u) = ∫ c du (longitudinal descent) ----------

const G_NT = 144;
const G_NU = 473;
const G_DU = (Y_TOP - Y_PE) / (G_NU - 1);
const G_DTH = TWO_PI / G_NT;

/** G grid (u rows, θ columns); null = c ≡ 1 (G = u − y_pe). */
function buildGGrid(c: ArrayLike<number> | null): Float64Array | null {
  if (!c) return null;
  const g = new Float64Array(G_NT * G_NU);
  for (let j = 0; j < G_NT; j++) {
    const th = j * G_DTH;
    let prev = cAt(c, th, Y_PE);
    let acc = 0;
    g[j] = 0;
    for (let i = 1; i < G_NU; i++) {
      const cur = cAt(c, th, Y_PE + i * G_DU);
      acc += 0.5 * (prev + cur) * G_DU;
      g[i * G_NT + j] = acc;
      prev = cur;
    }
  }
  return g;
}

function gLookup(grid: Float64Array | null, th: number, u: number): number {
  if (u <= Y_PE) return 0;
  if (!grid) return u - Y_PE;
  let uu = (u - Y_PE) / G_DU;
  if (uu > G_NU - 1) uu = G_NU - 1;
  let i0 = Math.floor(uu);
  if (i0 >= G_NU - 1) i0 = G_NU - 2;
  const fi = uu - i0;
  let t = th % TWO_PI;
  if (t < 0) t += TWO_PI;
  const v = t / G_DTH;
  let j0 = Math.floor(v);
  const fj = v - j0;
  if (j0 >= G_NT) j0 -= G_NT;
  const j1 = j0 + 1 === G_NT ? 0 : j0 + 1;
  const o0 = i0 * G_NT;
  const o1 = o0 + G_NT;
  const a = grid[o0 + j0] + (grid[o0 + j1] - grid[o0 + j0]) * fj;
  const b = grid[o1 + j0] + (grid[o1 + j1] - grid[o1 + j0]) * fj;
  return a + (b - a) * fi;
}

// ---------- dynamic epicardial envelope (consumed by the RV) at the current y ----------

export const LV_ENV_N_THETA = 144;
export const LV_ENV_N_Y = 88;
const ENV_DY = (Y_TOP - Y0) / (LV_ENV_N_Y - 1);
const ENV_DTH = TWO_PI / LV_ENV_N_THETA;

export interface LvEpiEnvelope {
  /** current epicardial recession δ(θ, y) = R_p(y) − ρ_p(θ, y) (u) at the CURRENT y, row k (y = y0 + k·dy) × column j (θ = j·dθ) */
  shrink: Float64Array;
  /** current endocardial radius on the same grid (papillary muscles) */
  endoNow: Float64Array;
  /** coefficients per rest node (θ_j, u_k = y0 + k·dy) */
  ca0: Float64Array;
  ca1: Float64Array;
  cb0: Float64Array;
  cb1: Float64Array;
  ccl: Float64Array;
  cg: Float64Array;
  /** rest R_p² and R_n² per row */
  rp2: Float64Array;
  rn2: Float64Array;
  lambda: number;
  kappa: number;
  /** lowest current y of the LV top (across columns) */
  topMin: number;
  /** some recession ≠ 0 */
  active: boolean;
  /** Phase 4b (performance): smallest current endocardial radius per row (exact exclusion of the papillary projection) */
  endoMinRow: Float64Array;
  /** per-column scratch */
  sy: Float64Array;
  sn: Float64Array;
  sp: Float64Array;
  /** Phase 4d (A1): current y of the LV top per grid θ column */
  topCol: Float64Array;
  /**
   * Phase 4d (A1): largest excess (u, ≥ 0) of the TRIANGULATED epicardial mesh over the grid (R_p − recession), per λ node × current y band ×
   * 5° column, built at the c_i change. null = no mesh (analytic only: the RV's own envelopes and scratch).
   */
  divTab: Float32Array | null;
  divStep: number;
  /** slice for the current λ: maximum of the two neighboring λ nodes and of the bands k ± 1 (per frame, in writeEnvelopeShrink) */
  divSlice: Float32Array;
  /**
   * Phase 5b (performance, P1): largest guard margin in this frame = largest slice value + LV_MESH_DIV_SLACK (0 without the table). Anything
   * farther than this from the grid radius cannot be pushed by the guard (exact early exit in the RV).
   */
  divMaxSlack: number;
  /**
   * Phase 5d (A1): largest advance of the epicardium OUTWARD from rest in this frame = max(0, −smallest grid recession) (u). The recession queried is a
   * bilinear interpolation of the grid, hence ≥ −outMax; with divMaxSlack it gives the exact early-exit bound of the guard for every RV vertex.
   */
  outMax: number;
  /** Phase 5b (performance, P4): √R_p² at rest per row (before: one root per grid node per frame) */
  rpS: Float64Array;
  /**
   * Phase 5 (twist): φ(current y) of the LV in TW_N rows of y ∈ [y_pe, top] (null = no rotation) and φ of the top (rigid base). The grids
   * above stay in the NON-rotating frame; public queries use θ − φ(y). Only the LV rig's envelope has the table.
   */
  twist: Float64Array | null;
  twistTop: number;
}

/** Phase 4d (A1): mesh × grid divergence table: λ nodes in [0, λmax], columns (5° = mesh columns) and current y bands. */
/** Phase 5 (user decision, 12/11/2026): 7 → 5 λ nodes. */
const DIV_NL = 5;
/**
 * Phase 5b (A1-final, B2): the table covers the driver's whole range: one extra slice, BEFORE the DIV_NL of [0, λmax], at the minimum λ of the
 * q(λ) table (LV_LAMBDA_TABLE_MIN). Slice 0 = minimum λ; slice 1 + n = λ = divStep·n. With λ < 0 the frame slice is the maximum of slices 0 and 1.
 */
const DIV_SLABS = DIV_NL + 1;
const DIV_NJ = 72;
const DIV_NK = 44;
const DIV_DY = (Y_TOP - Y0) / DIV_NK;
const DIV_DTH = TWO_PI / DIV_NJ;
/** Sampling margin added to the divergence (u ≈ 0.1 mm). */
export const LV_MESH_DIV_SLACK = 0.003;
/** Phase 5 (declared deviation): fraction of the 5° column next to the edge (0.25°) in which the sample also counts for the neighboring column. */
const DIV_EDGE_FRAC = 0.05;
/** Barycentric points per epicardial triangle in the table (centroid, 3 edge midpoints, 3 intermediate). */
const DIV_BARY: ReadonlyArray<readonly [number, number, number]> = [
  [1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3],
];

export function createLvEpiEnvelope(): LvEpiEnvelope {
  const n = LV_ENV_N_THETA * LV_ENV_N_Y;
  const rp2 = new Float64Array(LV_ENV_N_Y);
  const rn2 = new Float64Array(LV_ENV_N_Y);
  const rpS = new Float64Array(LV_ENV_N_Y);
  for (let k = 0; k < LV_ENV_N_Y; k++) {
    const y = Y0 + k * ENV_DY;
    rp2[k] = rEpi2(y);
    rn2[k] = rEndo2(y);
    rpS[k] = Math.sqrt(rp2[k]);
  }
  const f = () => new Float64Array(n);
  return {
    shrink: f(), endoNow: f(), ca0: f(), ca1: f(), cb0: f(), cb1: f(), ccl: f(), cg: f(), rp2, rn2,
    lambda: 0, kappa: LV_LONG_KAPPA, topMin: Y_TOP, active: false, endoMinRow: new Float64Array(LV_ENV_N_Y),
    sy: new Float64Array(LV_ENV_N_Y), sn: new Float64Array(LV_ENV_N_Y), sp: new Float64Array(LV_ENV_N_Y),
    topCol: new Float64Array(LV_ENV_N_THETA).fill(Y_TOP), divTab: null, divStep: 0, divSlice: new Float32Array(DIV_NJ * DIV_NK),
    divMaxSlack: 0, outMax: 0, rpS,
    twist: null, twistTop: 0,
  };
}

const TW_DY = (Y_TOP - Y_PE) / (TW_N - 1);

/** Phase 5: φ(current y) from the table (linear interpolation; 0 without a table). No allocation. */
function twistPhiAt(tab: Float64Array | null, y: number): number {
  if (!tab) return 0;
  let v = (y - Y_PE) / TW_DY;
  if (v <= 0) return tab[0];
  if (v >= TW_N - 1) return tab[TW_N - 1];
  const i = Math.floor(v);
  v -= i;
  return tab[i] + (tab[i + 1] - tab[i]) * v;
}

/** Phase 4d (A1): slice of the divergence table at the current λ (maximum of the neighboring nodes and of the bands k ± 1). No allocation. */
function reduceDivSlice(env: LvEpiEnvelope, lambda: number): void {
  const tab = env.divTab;
  if (!tab) return;
  const out = env.divSlice;
  // Phase 5b (B2): slice 0 = minimum λ of the table; slices 1…DIV_NL = [0, λmax]. λ < 0 ⇒ maximum of slices 0 and 1
  let s0 = 0;
  if (lambda >= 0) {
    let n0 = 0;
    if (env.divStep > 0) {
      n0 = Math.floor(lambda / env.divStep);
      if (n0 > DIV_NL - 2) n0 = DIV_NL - 2;
    }
    s0 = n0 + 1;
  }
  const a = s0 * DIV_NK * DIV_NJ;
  const b = a + DIV_NK * DIV_NJ;
  let vMax = 0;
  for (let k = 0; k < DIV_NK; k++) {
    const k0 = k > 0 ? k - 1 : 0;
    const k1 = k < DIV_NK - 1 ? k + 1 : DIV_NK - 1;
    for (let j = 0; j < DIV_NJ; j++) {
      let v = 0;
      for (let kk = k0; kk <= k1; kk++) {
        const o = kk * DIV_NJ + j;
        if (tab[a + o] > v) v = tab[a + o];
        if (tab[b + o] > v) v = tab[b + o];
      }
      out[k * DIV_NJ + j] = v;
      if (v > vMax) vMax = v;
    }
  }
  // Phase 5b (P1): same sum as lvMeshExcessTh (float32 slice value + margin), so the guard's early exit is exact
  env.divMaxSlack = vMax + LV_MESH_DIV_SLACK;
}

/**
 * Phase 4d (A1): RV guard margin at (θ, current y): measured excess of the mesh over the grid + LV_MESH_DIV_SLACK (u); 0 without the table
 * (envelope without mesh). No allocation.
 */
export function lvMeshExcessTh(env: LvEpiEnvelope, theta: number, y: number): number {
  if (!env.divTab) return 0;
  // Phase 5: world θ → non-rotating frame
  let t = theta - twistPhiAt(env.twist, y);
  if (t < 0) t += TWO_PI;
  let j = Math.floor(t / DIV_DTH);
  if (j >= DIV_NJ) j = DIV_NJ - 1;
  let k = Math.floor((y - Y0) / DIV_DY);
  if (k < 0) k = 0;
  if (k >= DIV_NK) k = DIV_NK - 1;
  return env.divSlice[k * DIV_NJ + j] + LV_MESH_DIV_SLACK;
}

/**
 * Phase 4d (A1): current LV top at θ for the RV guard: largest y of the two MESH columns (5°) that surround θ (the mesh edge between
 * them is the chord and the cap sits at the mean height). No allocation.
 */
export function lvLocalTopTh(env: LvEpiEnvelope, theta: number): number {
  // Phase 5: the top rotates rigidly with φ_top
  let t = theta - env.twistTop;
  if (t < 0) t += TWO_PI;
  if (t >= TWO_PI) t -= TWO_PI;
  let m = Math.floor(t / DIV_DTH);
  if (m >= DIV_NJ) m = DIV_NJ - 1;
  const j0 = (2 * m) % LV_ENV_N_THETA;
  const j1 = (2 * m + 2) % LV_ENV_N_THETA;
  const a = env.topCol[j0];
  const b = env.topCol[j1];
  return a > b ? a : b;
}

/**
 * Phase 5d (M3): current LV top at θ from the CHORD of the mesh edge: linear interpolation in θ between the two mesh columns (5°) that surround
 * θ (the same ones as lvLocalTopTh, which gives the maximum of them). With a warped regional top the chord lies above the interpolated top of the grid g. The
 * difference between the angle of a point on the chord and the linear fraction is second order at 5° (≪ LA_FLOOR_MARGIN). No allocation.
 */
export function lvLocalTopChordTh(env: LvEpiEnvelope, theta: number): number {
  let t = theta - env.twistTop;
  if (t < 0) t += TWO_PI;
  if (t >= TWO_PI) t -= TWO_PI;
  const v = t / DIV_DTH;
  let m = Math.floor(v);
  if (m >= DIV_NJ) m = DIV_NJ - 1;
  const f = v - m;
  const a = env.topCol[(2 * m) % LV_ENV_N_THETA];
  const b = env.topCol[(2 * m + 2) % LV_ENV_N_THETA];
  return a + (b - a) * f;
}

/** Current epicardial recession with θ already computed (rad; y clamped to [y0, top]). No allocation. */
export function lvEnvelopeShrinkTh(env: LvEpiEnvelope, theta: number, y: number): number {
  return gridLookupTh(env.shrink, theta - twistPhiAt(env.twist, y), y);
}

const tmpC: Coeffs = { a0: 0, a1: 0, b0: 0, b1: 0, cl: 0 };

function fillEnvelopeCoeffs(env: LvEpiEnvelope, c: ArrayLike<number> | null, g: Float64Array | null): void {
  for (let k = 0; k < LV_ENV_N_Y; k++) {
    const u = Y0 + k * ENV_DY;
    const b = lvSliceBeta(c, u);
    for (let j = 0; j < LV_ENV_N_THETA; j++) {
      const th = j * ENV_DTH;
      const o = k * LV_ENV_N_THETA + j;
      coeffsAt(c, th, u, b, tmpC);
      env.ca0[o] = tmpC.a0;
      env.ca1[o] = tmpC.a1;
      env.cb0[o] = tmpC.b0;
      env.cb1[o] = tmpC.b1;
      env.ccl[o] = tmpC.cl;
      env.cg[o] = gLookup(g, th, u);
    }
  }
}

/** Recomputes the current recession and endocardium for λ, inverting y = u − κλG column by column. No allocation. */
function writeEnvelopeShrink(env: LvEpiEnvelope, lambda: number): void {
  env.lambda = lambda;
  const kl = klOf(env.kappa, lambda);
  let any = false;
  const NT = LV_ENV_N_THETA;
  const NY = LV_ENV_N_Y;
  const { sy, sn, sp } = env;
  let topMin = Y_TOP;
  // Phase 5d (A1): smallest grid recession (for outMax)
  let dMin = 0;
  const emr = env.endoMinRow;
  emr.fill(Infinity);
  // Phase 5b (performance, P4; bit-for-bit identical result): local references and √R_p² per row precomputed (rpS)
  const { ca0, ca1, cb0, cb1, ccl, cg, rpS, shrink, endoNow, topCol } = env;
  for (let j = 0; j < NT; j++) {
    for (let k = 0; k < NY; k++) {
      const o = k * NT + j;
      sy[k] = Y0 + k * ENV_DY - kl * cg[o];
      sn[k] = ca0[o] + lambda * ca1[o];
      sp[k] = layerR2(true, ca0[o], ca1[o], cb0[o], cb1[o], ccl[o], lambda, kl);
    }
    if (sy[NY - 1] < topMin) topMin = sy[NY - 1];
    topCol[j] = sy[NY - 1];
    let m = 0;
    for (let k = 0; k < NY; k++) {
      const y = Y0 + k * ENV_DY;
      let rn2: number;
      let rp2: number;
      if (y >= sy[NY - 1]) {
        rn2 = sn[NY - 1];
        rp2 = sp[NY - 1];
      } else if (y <= sy[0]) {
        rn2 = sn[0];
        rp2 = sp[0];
      } else {
        while (m < NY - 2 && sy[m + 1] < y) m++;
        const t = (y - sy[m]) / (sy[m + 1] - sy[m]);
        rn2 = sn[m] + (sn[m + 1] - sn[m]) * t;
        rp2 = sp[m] + (sp[m + 1] - sp[m]) * t;
      }
      const o = k * NT + j;
      const d = rpS[k] - (rp2 > 0 ? Math.sqrt(rp2) : 0);
      shrink[o] = d;
      if (d < dMin) dMin = d;
      const en = rn2 > 0 ? Math.sqrt(rn2) : 0;
      endoNow[o] = en;
      if (en < emr[k]) emr[k] = en;
      if (d !== 0) any = true;
    }
  }
  env.active = any;
  env.topMin = topMin;
  env.outMax = -dMin;
  if (env.divTab) reduceDivSlice(env, lambda);
  else env.divMaxSlack = 0;
}

let uniformCoeffs: LvEpiEnvelope | null = null;

/** Field envelope with c ≡ 1 (wm = 1 in all segments) at λ: nodes of the RV table and tests without the LV rig. */
export function fillLvEpiEnvelopeUniform(env: LvEpiEnvelope, lambda: number): void {
  if (!uniformCoeffs) {
    uniformCoeffs = createLvEpiEnvelope();
    fillEnvelopeCoeffs(uniformCoeffs, null, null);
  }
  const U = uniformCoeffs;
  if (env.ca0 !== U.ca0) {
    env.ca0.set(U.ca0);
    env.ca1.set(U.ca1);
    env.cb0.set(U.cb0);
    env.cb1.set(U.cb1);
    env.ccl.set(U.ccl);
    env.cg.set(U.cg);
  }
  env.kappa = LV_LONG_KAPPA;
  writeEnvelopeShrink(env, lambda);
}

/** Bilinear lookup on the envelope grid with θ already computed (rad, any range). No allocation. */
function gridLookupTh(arr: Float64Array, theta: number, y: number): number {
  let th = theta;
  if (th < 0) th += TWO_PI;
  const u = th / ENV_DTH;
  let j0 = Math.floor(u);
  const fu = u - j0;
  if (j0 >= LV_ENV_N_THETA) j0 -= LV_ENV_N_THETA;
  const j1 = j0 + 1 === LV_ENV_N_THETA ? 0 : j0 + 1;
  let v = (y - Y0) / ENV_DY;
  if (v < 0) v = 0;
  if (v > LV_ENV_N_Y - 1) v = LV_ENV_N_Y - 1;
  let k0 = Math.floor(v);
  if (k0 >= LV_ENV_N_Y - 1) k0 = LV_ENV_N_Y - 2;
  const fv = v - k0;
  const o0 = k0 * LV_ENV_N_THETA;
  const o1 = o0 + LV_ENV_N_THETA;
  const a = arr[o0 + j0] + (arr[o0 + j1] - arr[o0 + j0]) * fu;
  const b = arr[o1 + j0] + (arr[o1 + j1] - arr[o1 + j0]) * fu;
  return a + (b - a) * fv;
}

/** Current epicardial recession of the LV at the point (x, y, z) of the current y (u; y clamped to the range [y0, top]). No allocation. */
export function lvEnvelopeShrink(env: LvEpiEnvelope, x: number, z: number, y: number): number {
  return gridLookupTh(env.shrink, Math.atan2(z, x) - twistPhiAt(env.twist, y), y);
}

/** Epicardial radius of the c ≡ 1 field at λ, at the CURRENT (θ, y); 0 above the current top or below the pole. Exact computation (tests). */
export function lvEpiRadiusUniform(lambda: number, theta: number, y: number): number {
  const kl = klOf(LV_LONG_KAPPA, lambda);
  const u = Y_PE + (y - Y_PE) / (1 - kl);
  if (u > Y_TOP + 1e-12 || u < Y_PE) return 0;
  coeffsAt(null, theta, u, lvSliceBeta(null, u), tmpC);
  const v = layerR2(true, tmpC.a0, tmpC.a1, tmpC.b0, tmpC.b1, tmpC.cl, lambda, kl);
  return v > 0 ? Math.sqrt(v) : 0;
}

// ---------- rig ----------

interface LvFieldMesh {
  mesh: THREE.Mesh;
  pos: Float32Array;
  nrm: Float32Array;
  n: number;
  cosT: Float64Array;
  sinT: Float64Array;
  /** u of the vertex and of the stencil (high/low) */
  u: Float64Array;
  uHi: Float64Array;
  uLo: Float64Array;
  /** coefficients at the 5 stencil points (0: own; 1: θ+h; 2: θ−h; 3: high u; 4: low u), 5 per vertex */
  a0: Float64Array;
  a1: Float64Array;
  b0: Float64Array;
  b1: Float64Array;
  cl: Float64Array;
  g: Float64Array;
  /** +1 endocardium, −1 epicardium; 0 = pole (fixed normal) */
  sgn: Int8Array;
  endoTri: Uint32Array;
  /** Phase 4d (A1): epicardial triangles (indices) */
  epiTri: Uint32Array;
  /** endocardial vertices of the top ring (u = top) */
  topRing: Uint32Array;
}

interface PapillaryRig {
  mesh: THREE.Mesh;
  pos: Float32Array;
  restP: Float64Array;
  /** basal weight per vertex (1 at the base → 0 in the tip portion) */
  w: Float32Array;
  /** vertices checked against the wall (indices) */
  check: Uint32Array;
  inv: Float64Array;
  /** PM: anchor (cos θ, u, sin θ) on the endocardium and rest base; AL: reference point on the wall */
  ax: number;
  az: number;
  ay: number;
  bx: number;
  by: number;
  bz: number;
  /** endocardial coefficients and G at the anchor/base reference */
  ba0: number;
  ba1: number;
  bg: number;
  /** tip: reference point (center of the chordae bases), coefficients and G */
  tx: number;
  ty: number;
  tz: number;
  ta0: number;
  ta1: number;
  tg: number;
  /** current displacement of the base and the tip (parent space) */
  ux: number;
  uy: number;
  uz: number;
  vx: number;
  vy: number;
  vz: number;
  /** tip y solved by the chordae (absolute, displacement) and whether it has already been solved */
  tipDy: number;
  tipSolved: boolean;
  clamped: number;
  kind: 'pm' | 'al';
  chords: ChordTie[];
  /** Phase 4d (D-VE25): δ = tip − apparatus per λ node (AL only; 3 per node) */
  tipTab: Float64Array;
}

interface ChordTie {
  b: ChordaBinding;
  offset: Float32Array;
  /** linear part of the inverse of the rest matrix of the chorda node (parent space → local) */
  inv: Float64Array;
  rest: THREE.Matrix4;
  /** rest base in parent space */
  bx: number;
  by: number;
  bz: number;
  /** last slide along the chorda (u) */
  slide: number;
  /** Phase 4d (D-VE25): insertion with the valve closed and the LV at rest (parent space, without u_app) and base–insertion length in that state */
  tx0: number;
  ty0: number;
  tz0: number;
  len0: number;
  /** same with the valve open (z = 1) */
  tx1: number;
  ty1: number;
  tz1: number;
  len1: number;
}

interface ApparatusNode {
  obj: THREE.Object3D;
  /** rest position (the node is a child of the root: adding u_app to the position translates in parent space) */
  x: number;
  y: number;
  z: number;
  /** Phase 5: rest quaternion (twist rotates the node about the LV axis: q = q_R·q_rest) */
  q: THREE.Quaternion;
}

interface RigidShift {
  obj: THREE.Object3D;
  x: number;
  y: number;
  z: number;
  /** Phase 5: rest quaternion */
  q: THREE.Quaternion;
}

/** Phase 4b: LA post-step. No per-frame allocation. */
export interface LaPostRig {
  mesh: THREE.Mesh;
  m: Float64Array;
  inv: Float64Array;
  /** RA contact index per vertex (−1 = no contact), point and normal (parent space) */
  slot: Int32Array;
  cp: Float64Array;
  cn: Float64Array;
  /** vertices moved in the last frame (floor, contact) */
  movedFloor: number;
  movedContact: number;
}

/**
 * Phase 4c (D-VE21): local vertical field of the mitral apparatus, Δy = −κλ·e, e = [G(θ, top) − Ḡ_top]·guard(r), θ and r from the REST position
 * (parent space). `e` changes only at the c_i change; per frame only Δy. `dl` = R⁻¹·ŷ (local direction of the parent's +y).
 */
interface LocalTopMesh {
  mesh: THREE.Mesh;
  /** local rest positions (annulus) or null (leaflets: the displacement goes to spec.rigOffset) */
  restLocal: Float32Array | null;
  offset: Float32Array | null;
  theta: Float64Array;
  guard: Float64Array;
  e: Float64Array;
  dl: [number, number, number];
  /** Phase 5b (N1): annulus only: rest normals (GLB) and triangle indices, to recompute the normals when the local top writes */
  restNormal: Float32Array | null;
  tri: Uint32Array | null;
}

/** Phase 4c (D-VE24): RA post-step against the current LV (smallest exit: radial to ρ_p or vertical to the top). No per-frame allocation. */
export interface RaPostRig {
  skin: AtrialSkinRig;
  m: Float64Array;
  inv: Float64Array;
  /** vertices moved in the last frame and largest displacement (u) */
  moved: number;
  maxMove: number;
}

interface AortaSkin {
  mesh: THREE.Mesh;
  restLocal: Float32Array;
  /** local displacement per unit of descent (weight × M⁻¹·(0, −1, 0)) */
  dir: Float32Array;
  /** Phase 5: rest position in parent space, root weight per vertex and M⁻¹ (the root rotates w·φ_top about the LV axis) */
  restP: Float64Array;
  w: Float32Array;
  inv: Float64Array;
}

/** Phase 5: state of the temporal amplitude T of the twist (driver). */
interface TwistDrive {
  init: boolean;
  /** true = beat systole (T rises with λ − λ_min,beat); false = untwisting */
  sys: boolean;
  lamMin: number;
  lamRef: number;
  tRise: number;
  armed: boolean;
  /** T and t at the systole → untwisting switch (NaN = no switch yet) */
  Tsw: number;
  tSw: number;
  T: number;
  /** switches made (probes) */
  switches: number;
  /**
   * Phase 5b (D-VE28): event-driven untwisting. evt = this cycle uses the event profile (engine signals + ΔV_E of the previous beat);
   * phase: 0 = no cycle, 1 = IVR (from the switch to mitral opening), 2 = filling; U = untwisted fraction (does not decrease within the cycle);
   * uOpen, vOpen, tOpen = U, vLV and t at mitral opening; dIvr = IVR of the previous beat (s); dvE = ΔV_E of the previous beat (mL; NaN = none);
   * qMax, vAtQ = largest qMitral in the E-wave window of this cycle and the vLV at that step.
   */
  evt: boolean;
  phase: number;
  U: number;
  uOpen: number;
  vOpen: number;
  tOpen: number;
  dIvr: number;
  dvE: number;
  qMax: number;
  vAtQ: number;
  /**
   * Phase 5b (declared deviation after the 1st result at 17 ms): tEnd = end of the cycle's ejection (last step in which λ rose, tRise at the switch):
   * the IVR of the event profile counts from it, not from the step in which the switch was detected (20–34 ms later); zPrev and tPrev = zMitral
   * and t of the driver's previous call (mitral opening instant interpolated between calls).
   */
  tEnd: number;
  zPrev: number;
  tPrev: number;
  /**
   * Phase 5c (event path): zAoPrev and tAoPrev = zAortic and t of the previous call (aortic closure instant interpolated);
   * pend = the beat turnover arrived with the aortic valve open and without a switch (the next systole starts at the switch); tLast = t of the
   * previous call (untwisting speed ceiling).
   */
  zAoPrev: number;
  tAoPrev: number;
  pend: boolean;
  tLast: number;
}

export interface LvFieldRig {
  parts: LvFieldMesh[];
  cSeg: Float64Array;
  cValid: boolean;
  gGrid: Float64Array | null;
  lamGrid: Float64Array;
  qGrid: Float64Array;
  lambdaMax: number;
  restVolume: number;
  lambda: number;
  kappa: number;
  envelope: LvEpiEnvelope;
  papillaries: PapillaryRig[];
  /** mitral apparatus (matrices), aortic valve (positions), LA and aorta */
  apparatus: ApparatusNode[];
  aortic: RigidShift[];
  aorta: AortaSkin | null;
  laSkin: AtrialSkinRig | null;
  /** Phase 4b: LA post-step (floor at the current LV top and contact with the RA) */
  laPost: LaPostRig | null;
  /** Phase 4b (D-VE18): apparatus candidates (x, y, z, extra margin; annulus, leaflets and mitral chordae axes at z = 0, parent space, rest) and λ → δ (xz) table */
  appCand: Float64Array;
  appTabDx: Float64Array;
  appTabDz: Float64Array;
  appTabLam0: number;
  appTabStep: number;
  /** remaining violations in the table (sum over nodes; diagnostic) */
  appTabResidual: number;
  appEnv: LvEpiEnvelope | null;
  /** apparatus field in this frame: T(u_app) (parent space) */
  apparatusField: THREE.Matrix4;
  /** current u_app and descent d (u) */
  appX: number;
  appY: number;
  appZ: number;
  mapse: number;
  /** unit direction (xz) from the annulus center to the axis and angle of the annulus center */
  annDirX: number;
  annDirZ: number;
  annTheta: number;
  /** c_n at the annulus center, top; mean of G at the top */
  cnAnn: number;
  gTopMean: number;
  edv: number;
  esv: number;
  beatMax: number;
  beatMin: number;
  lastBeat: number;
  samples: number;
  trackerValid: boolean;
  refVolume: number;
  lastT: number;
  dirty: boolean;
  /** time (ms) of the last rebuild of the coefficients and the table */
  lastRebuildMs: number;
  /** memoized β per u (exact diagnostic) */
  betaMemo: Map<number, number>;
  /** Phase 4b: current c field (null = c ≡ 1) */
  cField: ArrayLike<number> | null;
  /** Phase 4c (D-VE21): mitral annulus and leaflets on the local top; coefficients of the table candidates and of the LA; Δy written (≠ 0) in the last frame */
  appLocal: LocalTopMesh[];
  appCandE: Float64Array;
  appCandW: Float64Array;
  laTheta: Float64Array;
  laGuardW: Float64Array;
  laE: Float64Array;
  /** Phase 4c: LA inherits the annulus Δy: 8 closest annulus vertices (rest) and IDW weights (p = 4) per LA vertex */
  laNb: Int32Array;
  laNw: Float64Array;
  appLocalWritten: boolean;
  laLocalWritten: boolean;
  /** Phase 4c (D-VE24): RA post-step */
  raPost: RaPostRig | null;
  /** Phase 4d (A1): scratch of the mesh × grid divergence table (envelope, epicardial positions per part) and c ≡ 1 table */
  divEnv: LvEpiEnvelope | null;
  divPos: Float64Array[];
  divUniform: Float32Array | null;
  /**
   * Phase 5 (twist): table per row of current y (φ; cos φ; sin φ; dφ/dy) and φ only (envelope); T applied in the last flush; static mode
   * (setLvLambda: T = max(0, λ)/λ_ES,nom) or driver mode; φ of the top (rigid base = apparatus); w_c(ν) (null = c ≡ 1); driver state.
   */
  twistTab: Float64Array;
  twistPhi: Float64Array;
  twistOn: boolean;
  twistT: number;
  twistStatic: boolean;
  twistTop: number;
  twistQ: THREE.Quaternion;
  wcTab: Float64Array | null;
  tw: TwistDrive;
  /** Phase 5c (D-VE33): true = the driver runs in the engine's 1 ms step (createLvDriverSystem); applyLvContraction only writes the geometry */
  driverInStep: boolean;
  laTwistLast: number;
  /** Phase 5 (performance): endocardial positions per part for the q(λ) table (scratch, only at the c_i change) */
  volPos: Float64Array[];
  /** Phase 5b (P4): λ of the last envelope grid write (NaN = coefficients changed) */
  envLam: number;
  /** Phase 5b (D-VE27): time (ms) of the regional path warm-up at load (0 = off) */
  warmupMs: number;
}

export interface LvRigOptions {
  /** procedural semilunar valves (aortic cusps and sinus descend with the AV plane) */
  semilunar?: { valves: { aortic?: { cusps: Array<{ mesh: THREE.Mesh }>; sinus: THREE.Mesh | null } }; alignedDiscs: Array<{ mesh: THREE.Mesh; valveType: string }> } | null;
  /** builds the LA skinning (default: true) */
  leftAtrium?: boolean;
  /** builds the aortic root skinning (default: true) */
  aortaRoot?: boolean;
  /** Phase 4c (D-VE24): RA skinning (HeartMesh17); with it, applyLvRaPost takes the RA off the current LV each frame */
  rightAtriumSkin?: AtrialSkinRig | null;
  /** Phase 5b (D-VE27): warms up the regional path at load (default: true); false = no warm-up (equality tests) */
  warmRegional?: boolean;
}

/** Builds the rig over the 17 watertight wedges (Phase 2). Allocates; load only. null without the watertight geometry. */
export function setupLvContractionField(segmentMeshes: ReadonlyArray<THREE.Mesh>, root?: THREE.Object3D | null, valvarData?: ValvarKinematicsData | null, options: LvRigOptions = {}): LvFieldRig | null {
  if (segmentMeshes.length !== 17) return null;
  const parts: LvFieldMesh[] = [];
  for (const m of segmentMeshes) {
    const src = m.geometry;
    if (!src?.userData?.lvWatertight) return null;
    m.updateMatrix();
    if (!m.matrix.equals(new THREE.Matrix4())) return null;
  }
  for (const m of segmentMeshes) {
    let g = m.geometry;
    if (!g.userData.lvFieldOwned) {
      g = ownedGeometry(m);
      m.geometry = g;
    }
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    const rest = g.userData.lvFieldRest as Float32Array;
    (pos.array as Float32Array).set(rest);
    (nrm.array as Float32Array).set(g.userData.lvFieldRestNormal as Float32Array);
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    const n = pos.count;
    const half = n / 2;
    const f5 = () => new Float64Array(n * 5);
    const part: LvFieldMesh = {
      mesh: m,
      pos: pos.array as Float32Array,
      nrm: nrm.array as Float32Array,
      n,
      cosT: new Float64Array(n),
      sinT: new Float64Array(n),
      u: new Float64Array(n),
      uHi: new Float64Array(n),
      uLo: new Float64Array(n),
      a0: f5(),
      a1: f5(),
      b0: f5(),
      b1: f5(),
      cl: f5(),
      g: f5(),
      sgn: new Int8Array(n),
      endoTri: new Uint32Array(0),
      epiTri: new Uint32Array(0),
      topRing: new Uint32Array(0),
    };
    const top: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = rest[3 * i];
      const y = rest[3 * i + 1];
      const z = rest[3 * i + 2];
      const r = Math.hypot(x, z);
      part.u[i] = y;
      part.uHi[i] = Math.min(y + LV_NORMAL_DY, Y_TOP);
      part.uLo[i] = y - LV_NORMAL_DY;
      const epi = i >= half;
      if (r < 1e-9) {
        part.sgn[i] = 0;
        part.cosT[i] = 1;
        part.sinT[i] = 0;
      } else {
        part.sgn[i] = epi ? -1 : 1;
        part.cosT[i] = x / r;
        part.sinT[i] = z / r;
      }
      if (!epi && y >= Y_TOP - 1e-7) top.push(i);
    }
    part.topRing = Uint32Array.from(top);
    const idx = g.getIndex()!;
    const tris: number[] = [];
    const etris: number[] = [];
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      if (a < half && b < half && c < half) tris.push(a, b, c);
      if (a >= half && b >= half && c >= half) etris.push(a, b, c);
    }
    part.endoTri = Uint32Array.from(tris);
    part.epiTri = Uint32Array.from(etris);
    parts.push(part);
  }
  const rig: LvFieldRig = {
    parts,
    cSeg: new Float64Array(17).fill(NaN),
    cValid: false,
    gGrid: null,
    lamGrid: new Float64Array(LV_LAMBDA_TABLE_N),
    qGrid: new Float64Array(LV_LAMBDA_TABLE_N),
    lambdaMax: 0,
    restVolume: 0,
    lambda: 0,
    kappa: LV_LONG_KAPPA,
    envelope: createLvEpiEnvelope(),
    papillaries: [],
    apparatus: [],
    aortic: [],
    aorta: null,
    laSkin: null,
    laPost: null,
    appCand: new Float64Array(0),
    appTabDx: new Float64Array(LV_APP_TABLE_N),
    appTabDz: new Float64Array(LV_APP_TABLE_N),
    appTabLam0: 0,
    appTabStep: 0,
    appTabResidual: 0,
    appEnv: null,
    apparatusField: new THREE.Matrix4(),
    appX: 0,
    appY: 0,
    appZ: 0,
    mapse: 0,
    annDirX: 0,
    annDirZ: 0,
    annTheta: 0,
    cnAnn: 1,
    gTopMean: Y_TOP - Y_PE,
    edv: 0,
    esv: 0,
    beatMax: -Infinity,
    beatMin: Infinity,
    lastBeat: -1,
    samples: 0,
    trackerValid: false,
    refVolume: 0,
    lastT: NaN,
    dirty: true,
    lastRebuildMs: 0,
    betaMemo: new Map(),
    cField: null,
    appLocal: [],
    appCandE: new Float64Array(0),
    appCandW: new Float64Array(0),
    laTheta: new Float64Array(0),
    laGuardW: new Float64Array(0),
    laE: new Float64Array(0),
    laNb: new Int32Array(0),
    laNw: new Float64Array(0),
    appLocalWritten: false,
    laLocalWritten: false,
    raPost: null,
    divEnv: null,
    divPos: [],
    divUniform: null,
    twistTab: new Float64Array(TW_N * 4),
    twistPhi: new Float64Array(TW_N),
    twistOn: false,
    twistT: 0,
    twistStatic: true,
    twistTop: 0,
    twistQ: new THREE.Quaternion(),
    wcTab: null,
    tw: { init: false, sys: true, lamMin: 0, lamRef: 0, tRise: 0, armed: false, Tsw: NaN, tSw: NaN, T: 0, switches: 0,
      evt: false, phase: 0, U: 0, uOpen: 0, vOpen: 0, tOpen: NaN, dIvr: LV_UNTWIST_IVR_DEFAULT_S, dvE: NaN, qMax: -Infinity, vAtQ: NaN,
      tEnd: NaN, zPrev: NaN, tPrev: NaN, zAoPrev: NaN, tAoPrev: NaN, pend: false, tLast: NaN },
    driverInStep: false,
    laTwistLast: 0,
    volPos: [],
    envLam: NaN,
    warmupMs: 0,
  };
  rig.envelope.kappa = rig.kappa;
  if (root) {
    setupApparatus(rig, root, options, valvarData ?? null);
    setupPapillaries(rig, root, valvarData ?? null);
    setupLocalTop(rig, root, valvarData ?? null);
  }
  if (options.rightAtriumSkin) rig.raPost = setupRaPost(options.rightAtriumSkin);
  const ones = new Float64Array(17).fill(1);
  setLvSegmentMotion(rig, ones);
  rig.restVolume = cavityVolumeAt(rig, 0);
  // the table uses the rest volume: redo it with that defined
  rig.cValid = false;
  setLvSegmentMotion(rig, ones);
  flushLvField(rig);
  if (options.warmRegional !== false) warmLvRegionalPath(rig);
  return rig;
}

/** Phase 5b (D-VE27): mixed warm-up vector (c = 0 at seg 3, −0.32 at seg 10, 0.35 at seg 15, 0.45 at seg 5; the rest 1). */
const LV_WARM_MOTION: ReadonlyArray<number> = [1, 1, 0, 1, 0.45, 1, 1, 1, 1, -0.32, 1, 1, 1, 1, 0.35, 1, 1];
const LV_WARM_LAMBDA = 0.6;

/**
 * Pre-warms the regional contraction path at load (the first regional switch otherwise incurs ~30 ms JIT overhead):
 * switches to a mixed vector, one flush at λ = 0.6 (local top, annulus normals, exact papillary radius) and back to wm1 at
 * λ = 0. The final state is the same as a rig without warm-up (lvPhase5b test). Allocates (load).
 */
export function warmLvRegionalPath(rig: LvFieldRig): void {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const lam = rig.lambda;
  const stat = rig.twistStatic;
  const back = Float64Array.from(rig.cSeg);
  setLvSegmentMotion(rig, LV_WARM_MOTION);
  rig.lambda = LV_WARM_LAMBDA < rig.lambdaMax ? LV_WARM_LAMBDA : rig.lambdaMax;
  rig.twistStatic = true;
  rig.dirty = true;
  flushLvField(rig);
  setLvSegmentMotion(rig, back);
  rig.lambda = lam;
  rig.twistStatic = stat;
  rig.dirty = true;
  flushLvField(rig);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  rig.warmupMs = t1 - t0;
}

const ownedCache = new WeakMap<THREE.Mesh, THREE.BufferGeometry>();

function ownedGeometry(m: THREE.Mesh): THREE.BufferGeometry {
  const cached = ownedCache.get(m);
  if (cached && cached.userData.lvFieldSource === m.geometry) return cached;
  const src = m.geometry;
  const g = src.clone();
  g.userData = { ...src.userData, lvFieldOwned: true, lvFieldSource: src };
  g.userData.lvFieldRest = Float32Array.from(src.getAttribute('position').array as Float32Array);
  g.userData.lvFieldRestNormal = Float32Array.from(src.getAttribute('normal').array as Float32Array);
  // the discokinetic fold expands up to ~10 % and the base descends ~9 mm: bounding sphere with margin
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius *= 1.2;
  ownedCache.set(m, g);
  return g;
}

/** Current position of stencil point s (0…4) of vertex i (writes to out[0..2]). No allocation. */
function stencilPoint(p: LvFieldMesh, i: number, s: number, lam: number, kl: number, epi: boolean, out: Float64Array, o: number): void {
  const k = i * 5 + s;
  const v = layerR2(epi, p.a0[k], p.a1[k], p.b0[k], p.b1[k], p.cl[k], lam, kl);
  const rho = v > 1e-14 ? Math.sqrt(v) : 1e-7;
  let c = p.cosT[i];
  let sn = p.sinT[i];
  let u = p.u[i];
  if (s === 1 || s === 2) {
    const sh = s === 1 ? SIN_H : -SIN_H;
    const c2 = c * COS_H - sn * sh;
    sn = sn * COS_H + c * sh;
    c = c2;
  } else if (s === 3) u = p.uHi[i];
  else if (s === 4) u = p.uLo[i];
  out[o] = rho * c;
  out[o + 1] = u - kl * p.g[k];
  out[o + 2] = rho * sn;
}
const COS_H = Math.cos(LV_NORMAL_DTHETA);
const SIN_H = Math.sin(LV_NORMAL_DTHETA);
const SP = new Float64Array(15);

/** Cavity volume (u³) with the endocardium at λ (writes nothing): reference at the centroid of the top ring. */
function cavityVolumeAt(rig: LvFieldRig, lambda: number): number {
  const kl = klOf(rig.kappa, lambda);
  // Phase 5 (performance at the c_i change, bit-for-bit identical result): the endocardial position of each vertex is computed once per λ
  // (before: once per triangle corner); the order of the sums does not change
  if (rig.volPos.length !== rig.parts.length) rig.volPos = rig.parts.map((p) => new Float64Array((p.n / 2) * 3));
  for (let pi = 0; pi < rig.parts.length; pi++) {
    const p = rig.parts[pi];
    const V = rig.volPos[pi];
    const half = p.n / 2;
    for (let i = 0; i < half; i++) stencilPoint(p, i, 0, lambda, kl, false, V, 3 * i);
  }
  let cx = 0, cy = 0, cz = 0, nc = 0;
  for (let pi = 0; pi < rig.parts.length; pi++) {
    const p = rig.parts[pi];
    const V = rig.volPos[pi];
    for (let q = 0; q < p.topRing.length; q++) {
      const o = 3 * p.topRing[q];
      cx += V[o];
      cy += V[o + 1];
      cz += V[o + 2];
      nc++;
    }
  }
  if (nc) {
    cx /= nc;
    cy /= nc;
    cz /= nc;
  }
  let v6 = 0;
  for (let pi = 0; pi < rig.parts.length; pi++) {
    const p = rig.parts[pi];
    const V = rig.volPos[pi];
    const t = p.endoTri;
    for (let k = 0; k < t.length; k += 3) {
      const a = 3 * t[k], b = 3 * t[k + 1], c = 3 * t[k + 2];
      const ax = V[a] - cx, ay = V[a + 1] - cy, az = V[a + 2] - cz;
      const bx = V[b] - cx, by = V[b + 1] - cy, bz = V[b + 2] - cz;
      const qx = V[c] - cx, qy = V[c + 1] - cy, qz = V[c + 2] - cz;
      v6 += ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
    }
  }
  return Math.abs(v6) / 6;
}

/**
 * Motility per segment (c_i, index 0 = segment 1). Only recomputes (G, coefficients, envelope, apparatus and q(λ) table) when it changes.
 * Allocates at the change (not per frame).
 */
export function setLvSegmentMotion(rig: LvFieldRig, c: ArrayLike<number>): void {
  // LV Phase 4d (finding A2): a vector with fewer than 17 entries or with a non-finite entry is ignored (the previous c_i stay)
  if (!c || !(c.length >= 17)) return;
  for (let i = 0; i < 17; i++) if (!Number.isFinite(c[i])) return;
  let same = rig.cValid;
  for (let i = 0; i < 17 && same; i++) if (rig.cSeg[i] !== c[i]) same = false;
  if (same) return;
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  for (let i = 0; i < 17; i++) rig.cSeg[i] = c[i];
  rig.cValid = true;
  rig.betaMemo.clear();
  const cs = rig.cSeg;
  let uniform = true;
  for (let i = 0; i < 17; i++) if (cs[i] !== 1) uniform = false;
  const cField = uniform ? null : cs;
  rig.cField = cField;
  rig.gGrid = buildGGrid(cField);
  // Phase 5: w_c(ν) = circumferential mean of c over ν ∈ [ν_A, ν_B] (720 θ), clamped to [0, 1]; null with c ≡ 1
  if (cField) {
    if (!rig.wcTab) rig.wcTab = new Float64Array(WC_N);
    for (let k = 0; k < WC_N; k++) {
      const nu = LV_TWIST_NU_APICAL + ((LV_TWIST_NU_BASAL - LV_TWIST_NU_APICAL) * k) / (WC_N - 1);
      let s = 0;
      for (let q = 0; q < 720; q++) s += lvMotionField(cField, (q + 0.5) * (TWO_PI / 720), nu);
      const m = s / 720;
      rig.wcTab[k] = m < 0 ? 0 : m > 1 ? 1 : m;
    }
  } else rig.wcTab = null;
  const betaMemo = new Map<number, number>();
  const beta = (u: number) => {
    let b = betaMemo.get(u);
    if (b === undefined) {
      b = lvSliceBeta(cField, u);
      betaMemo.set(u, b);
    }
    return b;
  };
  for (const p of rig.parts) {
    for (let i = 0; i < p.n; i++) {
      const th = Math.atan2(p.sinT[i], p.cosT[i]);
      for (let s = 0; s < 5; s++) {
        const tt = s === 1 ? th + LV_NORMAL_DTHETA : s === 2 ? th - LV_NORMAL_DTHETA : th;
        const uu = s === 3 ? p.uHi[i] : s === 4 ? p.uLo[i] : p.u[i];
        coeffsAt(cField, tt, uu, beta(uu), tmpC);
        const k = i * 5 + s;
        p.a0[k] = tmpC.a0;
        p.a1[k] = tmpC.a1;
        p.b0[k] = tmpC.b0;
        p.b1[k] = tmpC.b1;
        p.cl[k] = tmpC.cl;
        p.g[k] = gLookup(rig.gGrid, tt, uu);
      }
    }
  }
  fillEnvelopeCoeffs(rig.envelope, cField, rig.gGrid);
  // AV plane: mean G at the top and c_n at the annulus center
  let gs = 0;
  for (let j = 0; j < G_NT; j++) gs += gLookup(rig.gGrid, j * G_DTH, Y_TOP);
  rig.gTopMean = gs / G_NT;
  rig.cnAnn = cAt(cField, rig.annTheta, Y_TOP) * (1 - LV_SEPTAL_ENDO_ATTEN * lvSeptalWindow(rig.annTheta, Y_TOP));
  for (const pr of rig.papillaries) papillaryCoeffs(rig, pr, cField, beta);
  fillLocalTopCoeffs(rig);
  // q(λ) table over the closed volume of the mesh
  let cMax = 0;
  for (let i = 0; i < 17; i++) cMax = Math.max(cMax, cs[i]);
  const lamMax = cMax > 0.05 ? Math.min(LV_LAMBDA_ABS_MAX, (1 - LV_G_MIN) / cMax) : 0;
  rig.lambdaMax = lamMax;
  if (rig.restVolume > 0) {
    const N = LV_LAMBDA_TABLE_N;
    const step = (lamMax - LV_LAMBDA_TABLE_MIN) / (N - 1);
    let prev = Infinity;
    for (let i = 0; i < N; i++) {
      const lam = LV_LAMBDA_TABLE_MIN + step * i;
      let q = cavityVolumeAt(rig, lam) / rig.restVolume;
      if (q >= prev) q = prev - 1e-9;
      prev = q;
      rig.lamGrid[i] = lam;
      rig.qGrid[i] = q;
    }
  }
  buildApparatusTable(rig, lamMax);
  buildEpiDivergenceTable(rig);
  buildAlTipTable(rig);
  rig.envLam = NaN;
  rig.dirty = true;
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  rig.lastRebuildMs = t1 - t0;
}

/** λ for q = V/V_rest (table, linear interpolation). No allocation. */
export function lvLambdaFromQ(rig: LvFieldRig, q: number): number {
  const N = rig.qGrid.length;
  if (!Number.isFinite(q)) return 0;
  if (q >= rig.qGrid[0]) return rig.lamGrid[0];
  if (q <= rig.qGrid[N - 1]) return rig.lamGrid[N - 1];
  let lo = 0;
  let hi = N - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rig.qGrid[mid] > q) lo = mid;
    else hi = mid;
  }
  const a = (rig.qGrid[lo] - q) / (rig.qGrid[lo] - rig.qGrid[hi]);
  return rig.lamGrid[lo] + (rig.lamGrid[hi] - rig.lamGrid[lo]) * a;
}

/**
 * Sets λ directly (tests and probes). λ is clamped to [0, λmax of the scenario] (mass departs by ±0.1 % above λmax)
 * and non-finite input is ignored (the previous λ stays). The driver (updateLvDriver) stays within the table range.
 */
export function setLvLambda(rig: LvFieldRig, lambda: number): void {
  if (!Number.isFinite(lambda)) return;
  const lam = lambda < 0 ? 0 : lambda > rig.lambdaMax ? rig.lambdaMax : lambda;
  rig.lambda = lam;
  // Phase 5: static pose ⇒ T = max(0, λ)/λ_ES,nom (no state; the driver state is kept)
  rig.twistStatic = true;
  rig.dirty = true;
}

/**
 * Temporal amplitude T of the twist in the driver. Systole: T = (λ − λ_min,beat)/λ_ES,nom (or the untwisting of the
 * previous beat, if larger); switch at the λ plateau (armed with Δλ ≥ LV_TWIST_ARM).
 * Phase 5b (D-VE28): event-driven untwisting (IVR → mitral opening → filling) when the driver receives finite zMitral and qMitral and the ΔV_E of the
 * previous beat already exists; otherwise, T_sw·(1 − smoothstep(0, T_u, t − t_sw)) as in Phase 5. The untwisting machine does not depend on
 * beatIndex (at high HR the mitral opening falls after the beat turnover). Without finite t: static mode. No allocation.
 */
function twistDrive(rig: LvFieldRig, lam: number, newBeat: boolean, t: number, vLV: number, zMi: number, qMi: number): void {
  if (!Number.isFinite(t)) {
    if (!rig.twistStatic) {
      rig.twistStatic = true;
      rig.dirty = true;
    }
    return;
  }
  if (rig.twistStatic) {
    rig.twistStatic = false;
    rig.dirty = true;
  }
  const tw = rig.tw;
  if (newBeat || !tw.init) {
    tw.init = true;
    tw.sys = true;
    tw.lamMin = lam;
    tw.lamRef = lam;
    tw.tRise = t;
    tw.armed = false;
  }
  const sig = zMi === zMi && qMi === qMi && zMi !== Infinity && zMi !== -Infinity && qMi !== Infinity && qMi !== -Infinity;
  const dec = untwistDec(tw, t, vLV, zMi, qMi, sig);
  let T: number;
  if (tw.sys) {
    if (!tw.armed && lam < tw.lamMin) {
      tw.lamMin = lam;
      tw.lamRef = lam;
      tw.tRise = t;
    }
    if (lam > tw.lamRef + LV_TWIST_RISE_EPS) {
      tw.lamRef = lam;
      tw.tRise = t;
    }
    if (lam - tw.lamMin >= LV_TWIST_ARM) tw.armed = true;
    const rise = lam > tw.lamMin ? (lam - tw.lamMin) / LV_LAMBDA_ES_NOMINAL : 0;
    T = rise > dec ? rise : dec;
    if (tw.armed && t - tw.tRise >= LV_TWIST_PLATEAU_S) openUntwist(tw, T, t, tw.tRise, sig);
  } else T = dec;
  if (sig) {
    tw.zPrev = zMi;
    tw.tPrev = t;
  } else {
    tw.zPrev = NaN;
    tw.tPrev = NaN;
  }
  if (T !== tw.T) {
    tw.T = T;
    rig.dirty = true;
  }
}

/**
 * Phase 5b: closes the previous cycle (the ΔV_E measured in it becomes the reference of this one) and opens the untwisting of a new cycle with T_sw = T at
 * instant t; tEnd = start of the IVR (Phase 5b: last step in which λ rose; Phase 5c: aortic closure). No allocation.
 */
function openUntwist(tw: TwistDrive, T: number, t: number, tEnd: number, sig: boolean): void {
  if (tw.phase === 2 && tw.qMax > 0 && tw.vAtQ - tw.vOpen > LV_UNTWIST_MIN_DV) tw.dvE = tw.vAtQ - tw.vOpen;
  tw.sys = false;
  tw.Tsw = T;
  tw.tSw = t;
  tw.tEnd = tEnd;
  tw.switches++;
  tw.evt = sig && tw.dvE > LV_UNTWIST_MIN_DV;
  tw.phase = 1;
  tw.U = 0;
  tw.uOpen = 0;
  tw.tOpen = NaN;
  tw.qMax = -Infinity;
  tw.vAtQ = NaN;
}

/**
 * T from the engine-event path (called at every 1 ms step by the LV system).
 *  - E1: switch at aortic closure (zAortic crosses LV_UNTWIST_VALVE_Z downward, instant interpolated between steps); U starts at 0
 *    at that instant, so T does not jump (in 5b the anchor sat 20–34 ms in the past and T dropped ~8 % in one step);
 *  - E2: beat turnover with the aortic valve open and no switch (ejection crossing the turnover, high HR) postpones the reference of the next systole
 *    to the step of the switch; turnover without a switch with the aortic valve closed forces the switch there (time profile from the current T);
 *  - E3: T does not fall faster than LV_UNTWIST_MAX_RATE (Doucende 2010, mean + 2 SD).
 * IVR, mitral opening and filling as in 5b (untwistDec). No allocation.
 */
function twistDriveEvt(rig: LvFieldRig, lam: number, newBeat: boolean, t: number, vLV: number, zMi: number, qMi: number, zAo: number): void {
  if (!Number.isFinite(t)) {
    if (!rig.twistStatic) {
      rig.twistStatic = true;
      rig.dirty = true;
    }
    return;
  }
  if (rig.twistStatic) {
    rig.twistStatic = false;
    rig.dirty = true;
  }
  const tw = rig.tw;
  const sig = zMi === zMi && qMi === qMi && zMi !== Infinity && zMi !== -Infinity && qMi !== Infinity && qMi !== -Infinity;
  if (!tw.init) {
    tw.init = true;
    startSystole(tw, lam, t);
  } else if (newBeat) {
    if (tw.sys) {
      // E2: ejection crossing the turnover (aortic valve open): the new systole starts at the switch step
      if (zAo >= LV_UNTWIST_VALVE_Z) tw.pend = true;
      else {
        tw.pend = false;
        openUntwist(tw, tw.T, t, t, false);
        startSystole(tw, lam, t);
      }
    } else startSystole(tw, lam, t);
  }
  const dec = untwistDec(tw, t, vLV, zMi, qMi, sig);
  let T: number;
  if (tw.sys) {
    if (!tw.armed && lam < tw.lamMin) {
      tw.lamMin = lam;
      tw.lamRef = lam;
      tw.tRise = t;
    }
    if (lam - tw.lamMin >= LV_TWIST_ARM) tw.armed = true;
    const rise = lam > tw.lamMin ? (lam - tw.lamMin) / LV_LAMBDA_ES_NOMINAL : 0;
    T = rise > dec ? rise : dec;
    // E1: aortic closure in this step
    if (tw.zAoPrev >= LV_UNTWIST_VALVE_Z && zAo < LV_UNTWIST_VALVE_Z && tw.tAoPrev < t) {
      const tC = tw.tAoPrev + ((tw.zAoPrev - LV_UNTWIST_VALVE_Z) / (tw.zAoPrev - zAo)) * (t - tw.tAoPrev);
      openUntwist(tw, T, t, tC, sig);
      if (tw.pend) {
        tw.pend = false;
        startSystole(tw, lam, t);
      }
    }
  } else T = dec;
  // E3: ceiling on the untwisting speed
  if (T < tw.T && tw.tLast === tw.tLast && t > tw.tLast) {
    const floor = tw.T - LV_UNTWIST_MAX_RATE * (t - tw.tLast);
    if (T < floor) T = floor;
  }
  tw.tLast = t;
  tw.zAoPrev = zAo;
  tw.tAoPrev = t;
  if (sig) {
    tw.zPrev = zMi;
    tw.tPrev = t;
  } else {
    tw.zPrev = NaN;
    tw.tPrev = NaN;
  }
  if (T !== tw.T) {
    tw.T = T;
    rig.dirty = true;
  }
}

/** Phase 5c: start of a beat's systole (reference λ_min = current λ). */
function startSystole(tw: TwistDrive, lam: number, t: number): void {
  tw.sys = true;
  tw.lamMin = lam;
  tw.lamRef = lam;
  tw.tRise = t;
  tw.armed = false;
}

/**
 * Phase 5b (extracted unchanged in Phase 5c): untwisting T of the current cycle (0 without a cycle) and tracking of the cycle events (mitral
 * opening, E peak). No allocation.
 */
function untwistDec(tw: TwistDrive, t: number, vLV: number, zMi: number, qMi: number, sig: boolean): number {
  let dec = 0;
  if (tw.tSw === tw.tSw) {
    const tau = t - tw.tSw;
    // time since the end of ejection (event profile)
    const tauE = t - tw.tEnd;
    // tracking of the cycle events (also when the profile in use is the time one: measures D_riv and ΔV_E for the next beat)
    if (sig && tw.phase === 1 && tau > 0 && zMi >= LV_UNTWIST_VALVE_Z) {
      tw.phase = 2;
      // opening instant interpolated between this call and the previous one (zMitral crossing LV_UNTWIST_VALVE_Z)
      let tauO = tauE;
      if (tw.zPrev < LV_UNTWIST_VALVE_Z && tw.tPrev < t && zMi > tw.zPrev) {
        const tO = tw.tPrev + ((LV_UNTWIST_VALVE_Z - tw.zPrev) / (zMi - tw.zPrev)) * (t - tw.tPrev);
        if (tO - tw.tEnd > 0 && tO <= t) tauO = tO - tw.tEnd;
      }
      if (tw.evt) {
        const u = tauO >= tw.dIvr ? LV_UNTWIST_IVR_FRACTION : LV_UNTWIST_IVR_FRACTION * smoothstep(0, tw.dIvr, tauO);
        if (u > tw.U) tw.U = u;
      }
      tw.uOpen = tw.U;
      tw.vOpen = vLV;
      tw.tOpen = t;
      if (tauO > 0) tw.dIvr = tauO;
      tw.qMax = -Infinity;
      tw.vAtQ = NaN;
    }
    if (sig && tw.phase === 2 && t - tw.tOpen <= LV_UNTWIST_E_WINDOW_S && qMi > tw.qMax) {
      tw.qMax = qMi;
      tw.vAtQ = vLV;
    }
    if (!tw.evt) {
      dec = tau <= 0 ? tw.Tsw : tau >= LV_UNTWIST_S ? 0 : tw.Tsw * (1 - smoothstep(0, LV_UNTWIST_S, tau));
    } else {
      let u = 0;
      if (tw.phase === 1) u = tauE <= 0 ? 0 : tauE >= tw.dIvr ? LV_UNTWIST_IVR_FRACTION : LV_UNTWIST_IVR_FRACTION * smoothstep(0, tw.dIvr, tauE);
      else if (tw.phase === 2) u = tw.uOpen + (1 - tw.uOpen) * smoothstep(0, 1, (vLV - tw.vOpen) / tw.dvE);
      if (u > tw.U) tw.U = u;
      dec = tw.Tsw * (1 - tw.U);
    }
  }
  return dec;
}

/**
 * Per step: tracks EDV/ESV of vLV, updates the reference and solves λ. No allocation.
 * Phase 5b (D-VE28): the engine's zMitral and qMitral (optional) tie the untwisting to the IVR and to filling; without them the time profile applies.
 * Phase 5c (D-VE33): with a finite zAortic (7th argument) the twist follows the event path (twistDriveEvt); without it, that of 5b.
 */
export function updateLvDriver(rig: LvFieldRig | null, vLV: number, beatIndex: number, t: number, zMitral = NaN, qMitral = NaN, zAortic = NaN): void {
  if (!rig || !Number.isFinite(vLV) || vLV <= 0) return;
  const newBeat = beatIndex !== rig.lastBeat;
  if (beatIndex !== rig.lastBeat) {
    if (rig.lastBeat >= 0 && rig.samples > 3 && rig.beatMax - rig.beatMin > LV_MIN_STROKE_ML) {
      rig.edv = rig.beatMax;
      rig.esv = rig.beatMin;
      rig.trackerValid = true;
    }
    rig.lastBeat = beatIndex;
    rig.beatMax = vLV;
    rig.beatMin = vLV;
    rig.samples = 0;
  }
  if (vLV > rig.beatMax) rig.beatMax = vLV;
  if (vLV < rig.beatMin) rig.beatMin = vLV;
  rig.samples++;
  if (!(rig.refVolume > 0)) rig.refVolume = vLV;
  if (!rig.trackerValid) {
    if (vLV > rig.refVolume) rig.refVolume = vLV;
  } else {
    const dt = Number.isFinite(rig.lastT) && Number.isFinite(t) ? t - rig.lastT : 0;
    if (dt > 0) rig.refVolume += (rig.edv - rig.refVolume) * (1 - Math.exp(-Math.min(dt, 0.25) / LV_REF_TAU_S));
  }
  if (Number.isFinite(t)) rig.lastT = t;
  const lam = lvLambdaFromQ(rig, vLV / rig.refVolume);
  if (lam !== rig.lambda) {
    rig.lambda = lam;
    rig.dirty = true;
  }
  if (zAortic === zAortic && zAortic !== Infinity && zAortic !== -Infinity) twistDriveEvt(rig, lam, newBeat, t, vLV, zMitral, qMitral, zAortic);
  else twistDrive(rig, lam, newBeat, t, vLV, zMitral, qMitral);
}

/** Phase 5c: the minimum of SimSystem (core/types) that the simulation loop uses; without importing core here. */
export interface LvDriverSystem {
  readonly id: string;
  readonly order: number;
  step(h: number, ctx: { clock: { t: number; beatIndex: number }; live: { hemo: { vLV: number; zMitral: number; qMitral: number; zAortic: number } } }): void;
  reset(): void;
}

let lvDriverSystemCount = 0;

/**
 * Simulation-loop system (order 15, after the hemodynamic engine) that runs the LV driver
 * at every 1 ms step with the engine signals (vLV, zMitral, qMitral, zAortic). It does not write geometry: only λ, the twist and rig.dirty; the
 * geometry stays 1x per frame (applyLvContraction → flushLvField). reset (registration and simulation restart) restarts the driver.
 * Whoever registers it sets rig.driverInStep (and clears it on removal). Allocates only here; step does not allocate.
 */
export function createLvDriverSystem(rig: LvFieldRig): LvDriverSystem {
  lvDriverSystemCount++;
  return {
    id: `cardiac3d.lvDriver.${lvDriverSystemCount}`,
    order: 15,
    step(_h, ctx) {
      const hemo = ctx.live.hemo;
      const c = ctx.clock;
      updateLvDriver(rig, hemo.vLV, c.beatIndex, c.t, hemo.zMitral, hemo.qMitral, hemo.zAortic);
    },
    reset() {
      resetLvDriver(rig);
    },
  };
}

/** Resets the tracker (tests). */
export function resetLvDriver(rig: LvFieldRig): void {
  rig.edv = 0;
  rig.esv = 0;
  rig.beatMax = -Infinity;
  rig.beatMin = Infinity;
  rig.lastBeat = -1;
  rig.samples = 0;
  rig.trackerValid = false;
  rig.refVolume = 0;
  rig.lastT = NaN;
  const tw = rig.tw;
  tw.init = false;
  tw.sys = true;
  tw.armed = false;
  tw.Tsw = NaN;
  tw.tSw = NaN;
  tw.T = 0;
  tw.switches = 0;
  tw.evt = false;
  tw.phase = 0;
  tw.U = 0;
  tw.uOpen = 0;
  tw.vOpen = 0;
  tw.tOpen = NaN;
  tw.dIvr = LV_UNTWIST_IVR_DEFAULT_S;
  tw.dvE = NaN;
  tw.qMax = -Infinity;
  tw.vAtQ = NaN;
  tw.tEnd = NaN;
  tw.zPrev = NaN;
  tw.tPrev = NaN;
  tw.zAoPrev = NaN;
  tw.tAoPrev = NaN;
  tw.pend = false;
  tw.tLast = NaN;
  rig.twistStatic = true;
  rig.dirty = true;
}

/** Writes positions, normals, envelope, apparatus and papillary muscles at the current λ. No allocation. */
export function flushLvField(rig: LvFieldRig): void {
  if (!rig.dirty) return;
  rig.dirty = false;
  const lam = rig.lambda;
  const kl = klOf(rig.kappa, lam);
  const S = SP;
  // Phase 5: the frame's twist table (before the wedges; the envelope and the apparatus use the same one)
  writeTwistTable(rig);
  const tw = rig.twistOn;
  const TT = rig.twistTab;
  for (const p of rig.parts) {
    const { pos, nrm, sgn } = p;
    const half = p.n / 2;
    for (let i = 0; i < p.n; i++) {
      const i3 = i * 3;
      const s = sgn[i];
      const epi = i >= half;
      if (s === 0) {
        // pole: on the axis, fixed normal; descends with the pole's G
        pos[i3 + 1] = p.u[i] - kl * p.g[i * 5];
        continue;
      }
      stencilPoint(p, i, 0, lam, kl, epi, S, 0);
      stencilPoint(p, i, 1, lam, kl, epi, S, 3);
      stencilPoint(p, i, 2, lam, kl, epi, S, 6);
      stencilPoint(p, i, 3, lam, kl, epi, S, 9);
      stencilPoint(p, i, 4, lam, kl, epi, S, 12);
      // N = T_u × T_θ (outward from the axis), with the layer's sign as in Phase 3
      let tux = S[9] - S[12], tuy = S[10] - S[13], tuz = S[11] - S[14];
      let ttx = S[3] - S[6], tty = S[4] - S[7], ttz = S[5] - S[8];
      if (!tw) {
        pos[i3] = S[0];
        pos[i3 + 1] = S[1];
        pos[i3 + 2] = S[2];
      } else {
        // Phase 5: rotation φ(y) of the point and Jacobian of the twist on the tangents: t' = R[t + φ'·t_y·(−z, 0, x)]
        const y = S[1];
        let v = (y - Y_PE) / TW_DY;
        if (v < 0) v = 0;
        if (v > TW_N - 1) v = TW_N - 1;
        let r0 = Math.floor(v);
        if (r0 >= TW_N - 1) r0 = TW_N - 2;
        const f = v - r0;
        const o0 = r0 * 4;
        const c = TT[o0 + 1] + (TT[o0 + 5] - TT[o0 + 1]) * f;
        const sn = TT[o0 + 2] + (TT[o0 + 6] - TT[o0 + 2]) * f;
        const dp = TT[o0 + 3] + (TT[o0 + 7] - TT[o0 + 3]) * f;
        const x = S[0], z = S[2];
        pos[i3] = x * c - z * sn;
        pos[i3 + 1] = y;
        pos[i3 + 2] = x * sn + z * c;
        const ku = dp * tuy;
        tux -= ku * z;
        tuz += ku * x;
        const kt = dp * tty;
        ttx -= kt * z;
        ttz += kt * x;
        // the normal (cross product in the non-rotating frame) is rotated below
        let nx = tuy * ttz - tuz * tty;
        const ny = tuz * ttx - tux * ttz;
        let nz = tux * tty - tuy * ttx;
        const nx2 = nx * c - nz * sn;
        nz = nx * sn + nz * c;
        nx = nx2;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nrm[i3] = (s * nx) / l;
        nrm[i3 + 1] = (s * ny) / l;
        nrm[i3 + 2] = (s * nz) / l;
        continue;
      }
      let nx = tuy * ttz - tuz * tty;
      let ny = tuz * ttx - tux * ttz;
      let nz = tux * tty - tuy * ttx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      nrm[i3] = s * nx;
      nrm[i3 + 1] = s * ny;
      nrm[i3 + 2] = s * nz;
    }
    const g = p.mesh.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('normal').needsUpdate = true;
  }
  // Phase 5b (P4): with λ and coefficients equal to those of the last write (only T changed: IVR) the grid is already correct
  if (rig.envLam !== lam) {
    writeEnvelopeShrink(rig.envelope, lam);
    rig.envLam = lam;
  }
  rig.envelope.twist = tw ? rig.twistPhi : null;
  rig.envelope.twistTop = tw ? rig.twistTop : 0;
  applyApparatus(rig);
  applyPapillaries(rig);
}

/** Phase 5: Φ(ν) (rad) per unit of T, without w_c. */
function twistUnit(nu: number): number {
  return (LV_TWIST_APEX_DEG + (LV_TWIST_BASE_DEG - LV_TWIST_APEX_DEG) * smoothstep(LV_TWIST_NU_APICAL, LV_TWIST_NU_BASAL, nu)) * DEG;
}

/** Phase 5: w_c(ν) from the table (1 without a table), ν clamped to [ν_A, ν_B]. */
function twistWc(rig: LvFieldRig, nu: number): number {
  const tab = rig.wcTab;
  if (!tab) return 1;
  let v = ((nu - LV_TWIST_NU_APICAL) / (LV_TWIST_NU_BASAL - LV_TWIST_NU_APICAL)) * (WC_N - 1);
  if (v <= 0) return tab[0];
  if (v >= WC_N - 1) return tab[WC_N - 1];
  const i = Math.floor(v);
  v -= i;
  return tab[i] + (tab[i + 1] - tab[i]) * v;
}

/**
 * Phase 5: the frame's T (static or from the driver) and table φ(current y) in TW_N rows: φ, cos φ, sin φ and dφ/dy (central difference), with
 * u estimated by inverting c ≡ 1 (u = y_pe + (y − y_pe)/(1 − κλ)). φ_top = last row (rigid base). No allocation.
 */
function writeTwistTable(rig: LvFieldRig): void {
  const lam = rig.lambda;
  const T = !LV_TWIST_ENABLED ? 0 : rig.twistStatic ? (lam > 0 ? lam / LV_LAMBDA_ES_NOMINAL : 0) : rig.tw.T;
  rig.twistT = T;
  if (T === 0) {
    rig.twistOn = false;
    rig.twistTop = 0;
    rig.twistQ.set(0, 0, 0, 1);
    return;
  }
  rig.twistOn = true;
  const tab = rig.twistTab;
  const phi = rig.twistPhi;
  const kl = klOf(rig.kappa, lam);
  const den = 1 - kl > 0.05 ? 1 - kl : 0.05;
  for (let r = 0; r < TW_N; r++) {
    const y = Y_PE + r * TW_DY;
    const u = Y_PE + (y - Y_PE) / den;
    const nu = (u - Y0) / P.height;
    const a = T * twistUnit(nu) * twistWc(rig, nu);
    phi[r] = a;
    tab[4 * r] = a;
    tab[4 * r + 1] = Math.cos(a);
    tab[4 * r + 2] = Math.sin(a);
  }
  for (let r = 0; r < TW_N; r++) {
    const a = r > 0 ? r - 1 : 0;
    const b = r < TW_N - 1 ? r + 1 : TW_N - 1;
    tab[4 * r + 3] = (phi[b] - phi[a]) / ((b - a) * TW_DY);
  }
  const top = phi[TW_N - 1];
  rig.twistTop = top;
  // three.js rotation about +y by β = −φ (x' = x cos φ − z sin φ, z' = x sin φ + z cos φ)
  rig.twistQ.set(0, -Math.sin(0.5 * top), 0, Math.cos(0.5 * top));
}

/**
 * Per frame: engine volume → λ → geometry. No allocation.
 * Phase 5c (D-VE33): with rig.driverInStep (1 ms step system registered) it only writes the geometry; without it, the driver runs here.
 */
export function applyLvContraction(rig: LvFieldRig | null, vLV: number, beatIndex: number, t: number, zMitral = NaN, qMitral = NaN, zAortic = NaN): void {
  if (!rig) return;
  if (!rig.driverInStep) updateLvDriver(rig, vLV, beatIndex, t, zMitral, qMitral, zAortic);
  flushLvField(rig);
}

// ---------- exact queries (diagnostics and tests; allocate in the memo) ----------

function betaExact(rig: LvFieldRig, u: number): number {
  const key = Math.round(u * 1e6);
  let b = rig.betaMemo.get(key);
  if (b === undefined) {
    let uniform = true;
    for (let i = 0; i < 17; i++) if (rig.cSeg[i] !== 1) uniform = false;
    b = lvSliceBeta(uniform ? null : rig.cSeg, key / 1e6);
    rig.betaMemo.set(key, b);
  }
  return b;
}

function cFieldOf(rig: LvFieldRig): ArrayLike<number> | null {
  for (let i = 0; i < 17; i++) if (rig.cSeg[i] !== 1) return rig.cSeg;
  return null;
}

/** Current LV top (y) at angle θ. */
export function lvTopNow(rig: LvFieldRig, theta: number): number {
  // Phase 5: world θ; the top rotates rigidly with φ_top (last flush)
  return Y_TOP - klOf(rig.kappa, rig.lambda) * gLookup(rig.gGrid, theta - (rig.twistOn ? rig.twistTop : 0), Y_TOP);
}

/**
 * Phase 5: twist φ (rad) at the CURRENT y, from the last flush (0 without twist). θ_world = θ_nonrotating + φ(y); φ > 0 = counterclockwise seen from the
 * apex. For probes and tests that take interior points (non-rotating frame) to the world.
 */
export function lvTwistAt(rig: LvFieldRig, y: number): number {
  return rig.twistOn ? twistPhiAt(rig.twistPhi, y) : 0;
}

/** Rest u of the wall point that is today at y (world θ); NaN above the current top. */
export function lvRestHeightAt(rig: LvFieldRig, theta: number, y: number): number {
  return restHeightFrame(rig, theta - lvTwistAt(rig, y), y);
}

/** Rest u with θ in the NON-rotating frame. */
function restHeightFrame(rig: LvFieldRig, theta: number, y: number): number {
  const kl = klOf(rig.kappa, rig.lambda);
  if (y > Y_TOP - kl * gLookup(rig.gGrid, theta, Y_TOP)) return NaN;
  let lo = Y_PE - 0.5;
  let hi = Y_TOP;
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi);
    if (mid - kl * gLookup(rig.gGrid, theta, mid) < y) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Phase 4b: exact endocardial radius at (θ, CURRENT y) at the current λ, without allocation: u by Newton on y = u − κλG(θ, u) (dG/du = c) and
 * ρ_n² = R_n(u)²·(1 − λ·c·(1 − k·window)). Equal to lvEndoRadiusNow (which uses bisection). 0 above the current top.
 */
function endoRadiusExactAt(rig: LvFieldRig, th: number, y: number, lam: number): number {
  const kl = klOf(rig.kappa, lam);
  const g = rig.gGrid;
  if (y > Y_TOP - kl * gLookup(g, th, Y_TOP)) return 0;
  const c = rig.cField;
  let u = y + kl * gLookup(g, th, y);
  // Newton with the derivative at the initial point (dG/du = c); converges in few iterations (G is piecewise linear in u)
  const dF0 = 1 - kl * cAt(c, th, u);
  const inv = 1 / (Math.abs(dF0) > 0.05 ? dF0 : 0.05);
  for (let it = 0; it < 12; it++) {
    const du = (u - kl * gLookup(g, th, u) - y) * inv;
    u -= du;
    if (Math.abs(du) < 1e-13) break;
  }
  if (u > Y_TOP) u = Y_TOP;
  const cn = cAt(c, th, u) * (1 - LV_SEPTAL_ENDO_ATTEN * lvSeptalWindow(th, u));
  const v = rEndo2(u) * (1 - lam * cn);
  return v > 0 ? Math.sqrt(v) : 0;
}

/** Layer radius at (θ, rest u) at the current λ (u). */
export function lvLayerRadiusAtRest(rig: LvFieldRig, epi: boolean, theta: number, u: number): number {
  coeffsAt(cFieldOf(rig), theta, u, betaExact(rig, u), tmpC);
  const v = layerR2(epi, tmpC.a0, tmpC.a1, tmpC.b0, tmpC.b1, tmpC.cl, rig.lambda, klOf(rig.kappa, rig.lambda));
  return v > 0 ? Math.sqrt(v) : 0;
}

/** Exact endocardial radius at (θ, CURRENT y) (u); 0 above the top or below the pole. */
export function lvEndoRadiusNow(rig: LvFieldRig, theta: number, y: number): number {
  // Phase 5: world θ → non-rotating frame
  const th = theta - lvTwistAt(rig, y);
  const u = restHeightFrame(rig, th, y);
  if (!Number.isFinite(u)) return 0;
  return lvLayerRadiusAtRest(rig, false, th, u);
}

/** Exact epicardial radius at (θ, CURRENT y) (u); 0 above the top or below the pole. */
export function lvEpiRadiusNow(rig: LvFieldRig, theta: number, y: number): number {
  const th = theta - lvTwistAt(rig, y);
  const u = restHeightFrame(rig, th, y);
  if (!Number.isFinite(u)) return 0;
  return lvLayerRadiusAtRest(rig, true, th, u);
}

// ---------- mitral apparatus, aortic valve, LA and aortic root ----------

function setupApparatus(rig: LvFieldRig, root: THREE.Object3D, options: LvRigOptions, valvarData: ValvarKinematicsData | null): void {
  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (MITRAL_APPARATUS_RE.test(o.name)) nodes.push(o);
  });
  for (const o of nodes) {
    let restArr = o.userData.lvApparatusRest as number[] | undefined;
    if (!restArr) {
      restArr = new THREE.Matrix4().compose(o.position, o.quaternion, o.scale).toArray();
      o.userData.lvApparatusRest = restArr;
    }
    const rest = new THREE.Matrix4().fromArray(restArr);
    rest.decompose(o.position, o.quaternion, o.scale);
    o.updateMatrix();
    rig.apparatus.push({ obj: o, x: o.position.x, y: o.position.y, z: o.position.z, q: o.quaternion.clone() });
  }
  const ann = root.getObjectByName('mitral_annulus') as THREE.Mesh | undefined;
  if (ann?.isMesh) {
    ann.updateMatrix();
    const rest = ann.matrix;
    const pos = ann.geometry.getAttribute('position') as THREE.BufferAttribute;
    const q = new THREE.Vector3();
    let cx = 0, cz = 0;
    for (let i = 0; i < pos.count; i++) {
      q.fromBufferAttribute(pos, i).applyMatrix4(rest);
      cx += q.x;
      cz += q.z;
    }
    cx /= pos.count;
    cz /= pos.count;
    const r = Math.hypot(cx, cz) || 1;
    rig.annDirX = cx / r;
    rig.annDirZ = cz / r;
    rig.annTheta = Math.atan2(cz, cx);
  }
  // Phase 4b (D-VE18): candidates of the apparatus table = annulus + mitral leaflets in the closed pose (z = 0), parent space, rest
  const candW: number[] = [];
  rig.appCand = apparatusCandidates(root, valvarData, candW);
  rig.appCandW = Float64Array.from(candW);
  // aortic valve: procedural cusps, sinus and legacy disc descend with the AV plane
  const shift = (o: THREE.Object3D | null | undefined) => {
    if (!o || rig.aortic.some((a) => a.obj === o)) return;
    let r = o.userData.lvAorticRest as number[] | undefined;
    if (!r) {
      r = [o.position.x, o.position.y, o.position.z];
      o.userData.lvAorticRest = r;
    }
    // Phase 5: rest quaternion (the twist rotates the aortic valve with the base)
    let rq = o.userData.lvAorticRestQ as number[] | undefined;
    if (!rq) {
      rq = [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w];
      o.userData.lvAorticRestQ = rq;
    }
    o.position.set(r[0], r[1], r[2]);
    o.quaternion.set(rq[0], rq[1], rq[2], rq[3]);
    rig.aortic.push({ obj: o, x: r[0], y: r[1], z: r[2], q: new THREE.Quaternion(rq[0], rq[1], rq[2], rq[3]) });
  };
  const sem = options.semilunar;
  if (sem) {
    for (const c of sem.valves.aortic?.cusps ?? []) shift(c.mesh);
    shift(sem.valves.aortic?.sinus ?? null);
    for (const d of sem.alignedDiscs) if (d.valveType === 'aortic') shift(d.mesh);
  } else {
    shift(root.getObjectByName('aortic_valve'));
  }
  // aortic root: local skinning (weight 1 up to 5 mm above the base, 0 at 20 mm)
  const aorta = root.getObjectByName('organui_aorta_ascending') as THREE.Mesh | undefined;
  if (options.aortaRoot !== false && aorta?.isMesh) {
    let g = aorta.geometry;
    if (!g.userData.lvAortaOwned) {
      const src = g;
      g = src.clone();
      g.userData = { ...src.userData, lvAortaOwned: true, lvAortaRest: Float32Array.from(src.getAttribute('position').array as Float32Array) };
      aorta.geometry = g;
    }
    const restLocal = g.userData.lvAortaRest as Float32Array;
    const attr = g.getAttribute('position') as THREE.BufferAttribute;
    (attr.array as Float32Array).set(restLocal);
    attr.needsUpdate = true;
    aorta.updateMatrix();
    const M = aorta.matrix.clone();
    const inv = new THREE.Matrix3().setFromMatrix4(M).invert();
    const dLocal = new THREE.Vector3(0, -1, 0).applyMatrix3(inv);
    const n = attr.count;
    const q = new THREE.Vector3();
    let yMin = Infinity;
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      q.fromArray(restLocal, i * 3).applyMatrix4(M);
      ys[i] = q.y;
      yMin = Math.min(yMin, q.y);
    }
    const dir = new Float32Array(n * 3);
    const wRoot = new Float32Array(n);
    const restP = new Float64Array(n * 3);
    const [h0, h1] = LV_AORTA_ROOT_MM;
    for (let i = 0; i < n; i++) {
      const w = 1 - smoothstep(h0, h1, (ys[i] - yMin) * 34.3);
      dir[3 * i] = w * dLocal.x;
      dir[3 * i + 1] = w * dLocal.y;
      dir[3 * i + 2] = w * dLocal.z;
      wRoot[i] = w;
      q.fromArray(restLocal, i * 3).applyMatrix4(M);
      restP[3 * i] = q.x;
      restP[3 * i + 1] = q.y;
      restP[3 * i + 2] = q.z;
    }
    g.computeBoundingSphere();
    if (g.boundingSphere) g.boundingSphere.radius += 0.4;
    rig.aorta = { mesh: aorta, restLocal, dir, restP, w: wRoot, inv: Float64Array.from(M.clone().invert().elements) };
  }
  // LA: Phase 4d skinning with the mitral annulus and the apparatus field
  const la = root.getObjectByName('left_atrium') as THREE.Mesh | undefined;
  const ra = root.getObjectByName('right_atrium') as THREE.Mesh | undefined;
  if (options.leftAtrium !== false && la?.isMesh && ann?.isMesh) {
    // annulus axis: PCA normal of the annulus vertices, oriented toward the LA (+y)
    const axis = annulusNormal(ann);
    const refField = new THREE.Matrix4();
    const refD = rig.kappa * LV_LAMBDA_ES_NOMINAL * (Y_TOP - Y_PE);
    const fRef = Math.sqrt(Math.max(0, 1 - LV_LAMBDA_ES_NOMINAL));
    const hRef = LV_APPARATUS_INWARD_GAIN * (1 - fRef);
    refField.makeTranslation(-hRef * rig.annDirX, -refD, -hRef * rig.annDirZ);
    // the annulus in the rest pose (the annulus node matrix is the rest one here). Phase 4b (D-VE17): no anchor on the RA; contact with the
    // RA moves to the post-step (half-space) and the floor is collapsed to the annulus plane at load (LA_SKIN_PARAMS.floorToPlane)
    rig.laSkin = setupAtrialSkinning(la, ann, axis, [], refField, refD, LA_SKIN_PARAMS);
    if (rig.laSkin) rig.laPost = setupLaPost(rig.laSkin, ra?.isMesh ? ra : null);
  }
}

function annulusNormal(ann: THREE.Mesh): THREE.Vector3 {
  ann.updateMatrix();
  const pos = ann.geometry.getAttribute('position') as THREE.BufferAttribute;
  const pts: THREE.Vector3[] = [];
  const c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(ann.matrix);
    pts.push(p);
    c.add(p);
  }
  c.multiplyScalar(1 / pts.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of pts) {
    const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const inv = new THREE.Matrix3().set(xx, xy, xz, xy, yy, yz, xz, yz, zz).invert();
  const n = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 64; i++) n.applyMatrix3(inv).normalize();
  if (n.y < 0) n.negate();
  return n;
}

/** AV plane translation at the current λ: descent d and toward the axis. No allocation. */
function applyApparatus(rig: LvFieldRig): void {
  const lam = rig.lambda;
  const d = klOf(rig.kappa, lam) * rig.gTopMean;
  const f2 = 1 - lam * rig.cnAnn;
  const f = f2 > 0 ? Math.sqrt(f2) : 0;
  const h = LV_APPARATUS_INWARD_GAIN * (1 - f);
  rig.mapse = d;
  // Phase 4b (D-VE18): minimal xz correction from the λ → δ table (linear interpolation; 0 where the nominal translation already fits)
  let dx = 0;
  let dz = 0;
  if (rig.appTabStep > 0) {
    let t = (lam - rig.appTabLam0) / rig.appTabStep;
    if (t < 0) t = 0;
    if (t > LV_APP_TABLE_N - 1) t = LV_APP_TABLE_N - 1;
    let i0 = Math.floor(t);
    if (i0 >= LV_APP_TABLE_N - 1) i0 = LV_APP_TABLE_N - 2;
    const a = t - i0;
    dx = rig.appTabDx[i0] + (rig.appTabDx[i0 + 1] - rig.appTabDx[i0]) * a;
    dz = rig.appTabDz[i0] + (rig.appTabDz[i0 + 1] - rig.appTabDz[i0]) * a;
  }
  rig.appX = -h * rig.annDirX + dx;
  rig.appY = -d;
  rig.appZ = -h * rig.annDirZ + dz;
  // Phase 5: the apparatus (annulus, leaflets, chordae) rotates rigidly with the base, φ_app = φ_top: matrix = R_y(φ)·T(u_app)·M_rest
  const on = rig.twistOn;
  const cA = on ? Math.cos(rig.twistTop) : 1;
  const sA = on ? Math.sin(rig.twistTop) : 0;
  if (!on) rig.apparatusField.makeTranslation(rig.appX, rig.appY, rig.appZ);
  else {
    const e = rig.apparatusField.elements;
    e[0] = cA; e[1] = 0; e[2] = sA; e[3] = 0;
    e[4] = 0; e[5] = 1; e[6] = 0; e[7] = 0;
    e[8] = -sA; e[9] = 0; e[10] = cA; e[11] = 0;
    e[12] = rig.appX * cA - rig.appZ * sA; e[13] = rig.appY; e[14] = rig.appX * sA + rig.appZ * cA; e[15] = 1;
  }
  for (let i = 0; i < rig.apparatus.length; i++) {
    const a = rig.apparatus[i];
    const px = a.x + rig.appX, pz = a.z + rig.appZ;
    if (!on) {
      a.obj.position.set(px, a.y + rig.appY, pz);
      a.obj.quaternion.copy(a.q);
    } else {
      a.obj.position.set(px * cA - pz * sA, a.y + rig.appY, px * sA + pz * cA);
      a.obj.quaternion.multiplyQuaternions(rig.twistQ, a.q);
    }
    a.obj.updateMatrix();
  }
  // Phase 4c (D-VE21): mitral annulus and leaflets follow the LOCAL LV top (Δy = −κλ·e per vertex); with c ≡ 1, e ≡ 0 and nothing is written
  const sc = -klOf(rig.kappa, lam);
  if (rig.cField && sc !== 0) {
    writeLocalTop(rig, sc);
    rig.appLocalWritten = true;
  } else if (rig.appLocalWritten) {
    writeLocalTop(rig, 0);
    rig.appLocalWritten = false;
  }
  for (let i = 0; i < rig.aortic.length; i++) {
    const a = rig.aortic[i];
    if (!on) {
      a.obj.position.set(a.x, a.y - d, a.z);
      a.obj.quaternion.copy(a.q);
    } else {
      // Phase 5: aortic valve on the rigid base: rotates φ_app about the LV axis
      a.obj.position.set(a.x * cA - a.z * sA, a.y - d, a.x * sA + a.z * cA);
      a.obj.quaternion.multiplyQuaternions(rig.twistQ, a.q);
    }
  }
  const ao = rig.aorta;
  if (ao) {
    const attr = ao.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const r = ao.restLocal;
    const dir = ao.dir;
    if (!on) {
      for (let i = 0; i < arr.length; i++) arr[i] = r[i] + d * dir[i];
    } else {
      // Phase 5: aortic root: descent and rotation w·φ_app (w = root weight) about the LV axis, in parent space
      const P0 = ao.restP;
      const I = ao.inv;
      const top = rig.twistTop;
      for (let i = 0; i < ao.w.length; i++) {
        const i3 = 3 * i;
        const w = ao.w[i];
        let x = P0[i3], y = P0[i3 + 1] - d * w, z = P0[i3 + 2];
        if (w > 0) {
          sinCosSmall(w * top);
          const x2 = x * SC[1] - z * SC[0];
          z = x * SC[0] + z * SC[1];
          x = x2;
        }
        arr[i3] = I[0] * x + I[4] * y + I[8] * z + I[12];
        arr[i3 + 1] = I[1] * x + I[5] * y + I[9] * z + I[13];
        arr[i3 + 2] = I[2] * x + I[6] * y + I[10] * z + I[14];
      }
    }
    attr.needsUpdate = true;
  }
}

// ---------- Phase 4b: λ → apparatus correction table (D-VE18) ----------

/**
 * Mitral annulus, leaflets and chordae in the closed pose (z = 0) in parent space, at the rest pose of the nodes; only r/R_n ≥ LV_APP_CAND_RATIO.
 * The chordae are included because, with the papillary tip on the apparatus (D-VE19), they move with it (base offset 0). Allocates (load).
 */
function apparatusCandidates(root: THREE.Object3D, valvarData: ValvarKinematicsData | null, wOut: number[] = []): Float64Array {
  const out: number[] = [];
  wOut.length = 0;
  const q = new THREE.Vector3();
  const matOf = (o: THREE.Object3D) => {
    const ra = o.userData.lvApparatusRest as number[] | undefined;
    if (ra) return new THREE.Matrix4().fromArray(ra);
    o.updateMatrix();
    return o.matrix.clone();
  };
  // Phase 4c (D-VE21): wl = local-top weight per vertex (annulus 1; leaflet 1 at the hinge → 0 at the free edge; chordae 0)
  const push = (o: THREE.Object3D, local: ArrayLike<number>, extra: ArrayLike<number> | null = null, wl: ArrayLike<number> | number = 0) => {
    const M = matOf(o);
    for (let i = 0; i < local.length; i += 3) {
      q.set(local[i], local[i + 1], local[i + 2]).applyMatrix4(M);
      const R = lvClosedProfileRadius(Math.min(q.y, Y_TOP), false);
      const e = extra ? extra[i / 3] : 0;
      if (R > 0 && (Math.hypot(q.x, q.z) + e) / R >= LV_APP_CAND_RATIO) {
        out.push(q.x, q.y, q.z, e);
        wOut.push(typeof wl === 'number' ? wl : wl[i / 3]);
      }
    }
  };
  const ann = root.getObjectByName('mitral_annulus') as THREE.Mesh | undefined;
  if (ann?.isMesh) push(ann, ann.geometry.getAttribute('position').array as ArrayLike<number>, null, 1);
  const closed = new Map<THREE.Object3D, Float64Array>();
  for (const spec of valvarData?.leaflets ?? []) {
    if (!spec.isMitral) continue;
    const rest = spec.mesh.userData.restPositions as Float32Array | undefined;
    if (!rest) continue;
    // pose z = 0 by the same formula as applyValvarDeformation (without writing to the mesh)
    const field = spec.closeField ?? null;
    // Phase 4c: the rigOffset of the mitral leaflets is the local-top Δy of this rig (0 at rest); the table uses the same field through the coefficients
    const off: Float32Array | null = null;
    const loc = new Float64Array(rest.length);
    for (let i = 0; i < rest.length; i += 3) {
      const ry = rest[i + 1];
      const normY = Math.max(0, Math.min(1, (spec.maxY - ry) / spec.height));
      const hw = normY * normY;
      if (field) {
        loc[i] = rest[i] + field[i];
        loc[i + 1] = ry + field[i + 1];
        loc[i + 2] = rest[i + 2] + field[i + 2];
      } else {
        const dc = spec.closeD * hw;
        loc[i] = rest[i] + spec.closeDir.x * dc;
        loc[i + 1] = ry + spec.closeDir.y * dc;
        loc[i + 2] = rest[i + 2] + spec.closeDir.z * dc;
      }
      if (off) {
        loc[i] += off[i];
        loc[i + 1] += off[i + 1];
        loc[i + 2] += off[i + 2];
      }
    }
    closed.set(spec.mesh, loc);
    const wl = leafletLocalTopWeights(spec);
    push(spec.mesh, loc, null, wl);
    // Phase 4c: also the open pose (z = 1). With the 60° ramp the end-systolic λ increases and the open posterior leaflet touched the
    // wall at wm = 1 (2 vertices in test 4.5/4.6)
    const open = new Float64Array(rest.length);
    for (let i = 0; i < rest.length; i += 3) {
      const normY = Math.max(0, Math.min(1, (spec.maxY - rest[i + 1]) / spec.height));
      const dOpen = spec.openD * normY * normY;
      open[i] = rest[i] + spec.openDir.x * dOpen;
      open[i + 1] = rest[i + 1] + spec.openDir.y * dOpen;
      open[i + 2] = rest[i + 2] + spec.openDir.z * dOpen;
    }
    push(spec.mesh, open, null, wl);
  }
  // chordae: rest + displacement of the leaflet vertex (z = 0, without rigOffset) with the axial weight of applyValvarDeformation
  for (const b of valvarData?.chordae ?? []) {
    if (!b.papillaryName.startsWith('mitral')) continue;
    const loc = closed.get(b.leafletMesh);
    const lRest = b.leafletMesh.userData.restPositions as Float32Array | undefined;
    const cRest = b.chordaMesh.userData.restPositions as Float32Array | undefined;
    if (!loc || !lRest || !cRest) continue;
    const lOff: Float32Array | null = null; // Phase 4c: same (mitral rigOffset = local top of this rig)
    const l3 = b.leafletVIdx * 3;
    const tx = loc[l3] - lRest[l3] - (lOff ? lOff[l3] : 0);
    const ty = loc[l3 + 1] - lRest[l3 + 1] - (lOff ? lOff[l3 + 1] : 0);
    const tz = loc[l3 + 2] - lRest[l3 + 2] - (lOff ? lOff[l3 + 2] : 0);
    // the chorda becomes 33 groups along the axis (axial t × 32): group center with margin = largest distance to the center × 1.3 (node scale)
    const rings = new Map<number, number[]>();
    for (let i = 0; i < cRest.length / 3; i++) {
      const key = Math.round(b.axialT[i] * 32);
      let r = rings.get(key);
      if (!r) rings.set(key, (r = []));
      r.push(i);
    }
    const M = matOf(b.chordaMesh);
    const sc = Math.cbrt(Math.abs(M.determinant())) || 1;
    const cl: number[] = [];
    const ex: number[] = [];
    for (const [key, idx] of rings) {
      let mx = 0, my = 0, mz = 0;
      for (const i of idx) {
        mx += cRest[3 * i];
        my += cRest[3 * i + 1];
        mz += cRest[3 * i + 2];
      }
      mx /= idx.length;
      my /= idx.length;
      mz /= idx.length;
      let rr = 0;
      for (const i of idx) rr = Math.max(rr, Math.hypot(cRest[3 * i] - mx, cRest[3 * i + 1] - my, cRest[3 * i + 2] - mz));
      // tip displacement with the group's mean weight; margin = largest distance to the center (ring radius + half an axial step) × 1.3
      let gm = 0;
      for (const i of idx) {
        const t = b.axialT[i];
        gm += t * t * (3 - 2 * t);
      }
      gm /= idx.length;
      void key;
      cl.push(mx + tx * gm, my + ty * gm, mz + tz * gm);
      ex.push(1.3 * rr * sc);
    }
    push(b.chordaMesh, cl, ex, 0);
  }
  return Float64Array.from(out);
}

/** Phase 4c (D-VE21): local-top weight along the mitral leaflet: 1 − normY² (1 at the hinge, 0 at the free edge, where the chordae attach). */
function leafletLocalTopWeights(spec: { maxY: number; height: number; mesh: THREE.Mesh }): Float64Array {
  const rest = spec.mesh.userData.restPositions as Float32Array;
  const w = new Float64Array(rest.length / 3);
  for (let i = 0; i < w.length; i++) {
    const normY = Math.max(0, Math.min(1, (spec.maxY - rest[3 * i + 1]) / spec.height));
    w[i] = 1 - normY * normY;
  }
  return w;
}

/** Band (u) of the active candidates in the Gauss–Newton of a node: only those within it of the wall can become a violation (|δ| ≤ ~0.08 u). */
const LV_APP_ACTIVE_BAND = 0.12;
const APP_SYS = new Float64Array(6);
let appActive = new Int32Array(0);
let appActiveN = 0;

/**
 * Sum of violations (u) and 2×2 normal system of the correction δ at a λ (scratch in APP_SYS). With `collect`, sweeps all candidates and
 * stores the active ones (g > −LV_APP_ACTIVE_BAND); without it, only the active ones. No allocation.
 */
function apparatusViolations(rig: LvFieldRig, env: LvEpiEnvelope, kl: number, d: number, bx: number, bz: number, collect: boolean, exact = false): number {
  const cand = rig.appCand;
  // without the exact radius, the margin covers the maximum grid error with regional motility (conservative); the exact one checks at the end
  const m = LV_APP_WALL_MARGIN + (rig.cField && !exact ? LV_EXACT_GRID_ERR : 0);
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0, viol = 0;
  const nAll = cand.length / 4;
  const nIt = collect ? nAll : appActiveN;
  if (collect) appActiveN = 0;
  const ce = rig.appCandE;
  const useE = !!rig.cField && ce.length === nAll;
  for (let q = 0; q < nIt; q++) {
    const qq = collect ? q : appActive[q];
    const k = qq * 4;
    const mk = m + cand[k + 3];
    const x = cand[k] + bx;
    // Phase 4c (D-VE21): the candidate descends with the local top (same field as the annulus and the leaflets)
    const y = cand[k + 1] - d - (useE ? kl * ce[qq] : 0);
    const z = cand[k + 2] + bz;
    const th = Math.atan2(z, x);
    if (y > Y_TOP - kl * gLookup(rig.gGrid, th, Y_TOP)) continue;
    let rn = gridLookupTh(env.endoNow, th, y);
    if (!(rn > 0)) continue;
    const r = Math.sqrt(x * x + z * z);
    if (collect && r - rn + mk > -LV_APP_ACTIVE_BAND) appActive[appActiveN++] = k / 4;
    if (exact && rig.cField && r > rn - mk - LV_EXACT_BAND) {
      const re = endoRadiusExactAt(rig, th, y, env.lambda);
      if (re > 0) rn = re;
    }
    const g = r - rn + mk;
    if (g <= 0 || r === 0) continue;
    const ex = x / r;
    const ez = z / r;
    a11 += ex * ex;
    a12 += ex * ez;
    a22 += ez * ez;
    b1 += g * ex;
    b2 += g * ez;
    viol += g;
  }
  APP_SYS[0] = a11;
  APP_SYS[1] = a12;
  APP_SYS[2] = a22;
  APP_SYS[3] = b1;
  APP_SYS[4] = b2;
  APP_SYS[5] = viol;
  return viol;
}

/**
 * At the c_i change (allocates the scratch envelope once): for each λ node, the smallest correction δ (xz) of the nominal translation of the
 * apparatus that takes the candidates off the wall (r ≤ ρ_n − margin, below the current top), by Gauss–Newton on the violations starting from the
 * nominal (or, if it does not fit, from the δ of the previous node), with the endocardium of the envelope grid at that λ (exact near the wall with
 * regional motility). δ = 0 where the nominal already fits. The final residual is checked on all candidates.
 */
function buildApparatusTable(rig: LvFieldRig, lamMax: number): void {
  rig.appTabDx.fill(0);
  rig.appTabDz.fill(0);
  rig.appTabResidual = 0;
  rig.appTabStep = 0;
  if (!rig.appCand.length || !(lamMax > LV_LAMBDA_TABLE_MIN)) return;
  if (appActive.length < rig.appCand.length / 4) appActive = new Int32Array(rig.appCand.length / 4);
  const src = rig.envelope;
  if (!rig.appEnv) rig.appEnv = createLvEpiEnvelope();
  const env = rig.appEnv;
  env.ca0 = src.ca0;
  env.ca1 = src.ca1;
  env.cb0 = src.cb0;
  env.cb1 = src.cb1;
  env.ccl = src.ccl;
  env.cg = src.cg;
  env.kappa = rig.kappa;
  const N = LV_APP_TABLE_N;
  const step = (lamMax - LV_LAMBDA_TABLE_MIN) / (N - 1);
  for (let n = 0; n < N; n++) {
    const lam = LV_LAMBDA_TABLE_MIN + step * n;
    writeEnvelopeShrink(env, lam);
    const kl = klOf(rig.kappa, lam);
    const d = kl * rig.gTopMean;
    const f2 = 1 - lam * rig.cnAnn;
    const h = LV_APPARATUS_INWARD_GAIN * (1 - (f2 > 0 ? Math.sqrt(f2) : 0));
    const bx = -h * rig.annDirX;
    const bz = -h * rig.annDirZ;
    let dx = 0;
    let dz = 0;
    let viol = apparatusViolations(rig, env, kl, d, bx, bz, true);
    if (viol > 0 && n > 0 && (rig.appTabDx[n - 1] !== 0 || rig.appTabDz[n - 1] !== 0)) {
      const wx = rig.appTabDx[n - 1];
      const wz = rig.appTabDz[n - 1];
      const vw = apparatusViolations(rig, env, kl, d, bx + wx, bz + wz, false);
      if (vw < viol) {
        dx = wx;
        dz = wz;
        viol = vw;
      } else apparatusViolations(rig, env, kl, d, bx, bz, false);
    }
    let iterated = false;
    for (let it = 0; it < LV_APP_GN_ITERS && viol > 0; it++) {
      const a11 = APP_SYS[0], a12 = APP_SYS[1], a22 = APP_SYS[2], b1 = APP_SYS[3], b2 = APP_SYS[4];
      const reg = 1e-3 * (a11 + a22) + 1e-12;
      const det = (a11 + reg) * (a22 + reg) - a12 * a12;
      dx -= ((a22 + reg) * b1 - a12 * b2) / det;
      dz -= (-a12 * b1 + (a11 + reg) * b2) / det;
      viol = apparatusViolations(rig, env, kl, d, bx + dx, bz + dz, false);
      iterated = true;
    }
    // exact check on all candidates; if a violation remains, a few more steps with the exact radius
    if (iterated || rig.cField) {
      viol = apparatusViolations(rig, env, kl, d, bx + dx, bz + dz, true, true);
      for (let it = 0; it < 4 && viol > 0; it++) {
        const a11 = APP_SYS[0], a12 = APP_SYS[1], a22 = APP_SYS[2], b1 = APP_SYS[3], b2 = APP_SYS[4];
        const reg = 1e-3 * (a11 + a22) + 1e-12;
        const det = (a11 + reg) * (a22 + reg) - a12 * a12;
        dx -= ((a22 + reg) * b1 - a12 * b2) / det;
        dz -= (-a12 * b1 + (a11 + reg) * b2) / det;
        viol = apparatusViolations(rig, env, kl, d, bx + dx, bz + dz, false, true);
      }
    }
    rig.appTabDx[n] = dx;
    rig.appTabDz[n] = dz;
    rig.appTabResidual += viol;
  }
  rig.appTabLam0 = LV_LAMBDA_TABLE_MIN;
  rig.appTabStep = step;
}

// ---------- Phase 4d (A1): divergence of the triangulated epicardial mesh × RV guard grid ----------

/**
 * At the c_i change (allocates the scratch once): at DIV_NL λ nodes ∈ [0, λmax] (+ 1 at the driver's minimum λ, Phase 5b), epicardial positions of the field (without writing to the mesh), envelope
 * grid at the same λ and, at 7 barycentric points of each epicardial triangle, the excess r_mesh − (R_p(y) − recession) at the point's (θ, y); the
 * table keeps the largest excess (≥ 0) per node × y band × 5° column. With c ≡ 1 the table is always the same (cached in the rig).
 * Measured mesh-to-grid excess reaches up to 0.48 mm at end systole (wm1) and up to 1.04 mm at λmax (dyskinetic seg 7).
 */
function buildEpiDivergenceTable(rig: LvFieldRig): void {
  const env = rig.envelope;
  const size = DIV_SLABS * DIV_NK * DIV_NJ;
  if (!env.divTab) env.divTab = new Float32Array(size);
  const tab = env.divTab;
  const lamMax = rig.lambdaMax;
  env.divStep = lamMax > 0 ? lamMax / (DIV_NL - 1) : 0;
  if (!rig.cField && rig.divUniform) {
    tab.set(rig.divUniform);
    return;
  }
  tab.fill(0);
  if (!rig.divEnv) rig.divEnv = createLvEpiEnvelope();
  const se = rig.divEnv;
  se.ca0 = env.ca0;
  se.ca1 = env.ca1;
  se.cb0 = env.cb0;
  se.cb1 = env.cb1;
  se.ccl = env.ccl;
  se.cg = env.cg;
  se.kappa = rig.kappa;
  if (rig.divPos.length !== rig.parts.length) rig.divPos = rig.parts.map((p) => new Float64Array(p.n * 3));
  for (let n = 0; n < DIV_SLABS; n++) {
    // Phase 5b (B2): slice 0 at the driver's minimum λ (q(λ) table); slices 1…DIV_NL in [0, λmax] (equal to those of Phase 5)
    const lam = n === 0 ? LV_LAMBDA_TABLE_MIN : env.divStep * (n - 1);
    const kl = klOf(rig.kappa, lam);
    writeEnvelopeShrink(se, lam);
    const o = n * DIV_NK * DIV_NJ;
    for (let pi = 0; pi < rig.parts.length; pi++) {
      const p = rig.parts[pi];
      const P = rig.divPos[pi];
      const half = p.n / 2;
      for (let i = half; i < p.n; i++) {
        if (p.sgn[i] === 0) {
          P[3 * i] = 0;
          P[3 * i + 1] = p.u[i] - kl * p.g[i * 5];
          P[3 * i + 2] = 0;
          continue;
        }
        stencilPoint(p, i, 0, lam, kl, true, SP, 0);
        P[3 * i] = SP[0];
        P[3 * i + 1] = SP[1];
        P[3 * i + 2] = SP[2];
      }
      const T = p.epiTri;
      for (let t = 0; t < T.length; t += 3) {
        const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
        for (let s = 0; s < DIV_BARY.length; s++) {
          const wa = DIV_BARY[s][0], wb = DIV_BARY[s][1], wc = DIV_BARY[s][2];
          const y = wa * P[a + 1] + wb * P[b + 1] + wc * P[c + 1];
          if (y < Y0 || y > Y_TOP) continue;
          const x = wa * P[a] + wb * P[b] + wc * P[c];
          const z = wa * P[a + 2] + wb * P[b + 2] + wc * P[c + 2];
          const r = Math.sqrt(x * x + z * z);
          if (r < 1e-6) continue;
          const th = Math.atan2(z, x);
          const yy = y < Y_TOP - 1e-9 ? y : Y_TOP - 1e-9;
          const d = r - (lvEnvelopeRadius(yy, true) - gridLookupTh(se.shrink, th, yy));
          if (!(d > 0)) continue;
          const tt = th < 0 ? th + TWO_PI : th;
          const fj = tt / DIV_DTH;
          let j = Math.floor(fj);
          if (j >= DIV_NJ) j = DIV_NJ - 1;
          let k = Math.floor((y - Y0) / DIV_DY);
          if (k >= DIV_NK) k = DIV_NK - 1;
          const q = o + k * DIV_NJ + j;
          if (d > tab[q]) tab[q] = d;
          // Phase 5 (declared deviation, after the 1st suite): samples within DIV_EDGE_FRAC of a column from the edge (the vertical edges of the
          // mesh lie exactly on it) also go into the neighboring column; the twist shifts the θ of those points and the query switched columns
          const fr = fj - Math.floor(fj);
          if (fr < DIV_EDGE_FRAC) {
            const qn = o + k * DIV_NJ + (j === 0 ? DIV_NJ - 1 : j - 1);
            if (d > tab[qn]) tab[qn] = d;
          } else if (fr > 1 - DIV_EDGE_FRAC) {
            const qn = o + k * DIV_NJ + (j === DIV_NJ - 1 ? 0 : j + 1);
            if (d > tab[qn]) tab[qn] = d;
          }
        }
      }
    }
  }
  if (!rig.cField) rig.divUniform = Float32Array.from(tab);
}

// ---------- Phase 4d (D-VE25): AL papillary tip following the apparatus only in part ----------

/** Fraction of the AL tip that follows the apparatus in xz (the rest follows the radial similarity of the endocardium). */
export const LV_AL_TIP_APP_FOLLOW = 0.75;

/**
 * At the c_i change, after the apparatus table: per λ node (the same as the apparatus table), δ = AL tip − apparatus: in xz
 * (1 − β)(similarity − apparatus); in y, the minimum of Σ((|q_c − δ| − L0_c)/L0_c)² over the AL chordae (q_c = insertion with the valve closed and
 * open and the LV at rest − rest base), by golden-section search in ±0.2 u. Allocates only the table (once).
 */
function buildAlTipTable(rig: LvFieldRig): void {
  const N = LV_APP_TABLE_N;
  for (const pr of rig.papillaries) {
    if (pr.kind !== 'al') continue;
    if (pr.tipTab.length !== N * 3) pr.tipTab = new Float64Array(N * 3);
    pr.tipTab.fill(0);
    const nc = pr.chords.length;
    if (!nc || rig.appTabStep <= 0 || !(pr.ta0 > 0)) continue;
    const beta = LV_AL_TIP_APP_FOLLOW;
    for (let n = 0; n < N; n++) {
      const lam = rig.appTabLam0 + rig.appTabStep * n;
      const f2 = 1 - lam * rig.cnAnn;
      const h = LV_APPARATUS_INWARD_GAIN * (1 - (f2 > 0 ? Math.sqrt(f2) : 0));
      const ax = -h * rig.annDirX + rig.appTabDx[n];
      const az = -h * rig.annDirZ + rig.appTabDz[n];
      const s2 = (pr.ta0 + lam * pr.ta1) / pr.ta0;
      const fs = (s2 > 0 ? Math.sqrt(s2) : 0) - 1;
      const dx = (1 - beta) * (fs * pr.tx - ax);
      const dz = (1 - beta) * (fs * pr.tz - az);
      // Phase 4d (declared deviation, after the 1st result): both valve poses (z = 0 and 1) enter the least squares
      const F = (dy: number) => {
        let e = 0;
        for (let c = 0; c < nc; c++) {
          const t = pr.chords[c];
          const qx = t.tx0 - t.bx - dx, qy = t.ty0 - t.by - dy, qz = t.tz0 - t.bz - dz;
          const r = (Math.sqrt(qx * qx + qy * qy + qz * qz) - t.len0) / t.len0;
          const px = t.tx1 - t.bx - dx, py = t.ty1 - t.by - dy, pz = t.tz1 - t.bz - dz;
          const r1 = (Math.sqrt(px * px + py * py + pz * pz) - t.len1) / t.len1;
          e += r * r + r1 * r1;
        }
        return e;
      };
      let lo = -0.2, hi = 0.2;
      const g = (Math.sqrt(5) - 1) / 2;
      let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
      let f1 = F(x1), fb = F(x2);
      for (let it = 0; it < 80; it++) {
        if (f1 < fb) {
          hi = x2; x2 = x1; fb = f1; x1 = hi - g * (hi - lo); f1 = F(x1);
        } else {
          lo = x1; x1 = x2; f1 = fb; x2 = lo + g * (hi - lo); fb = F(x2);
        }
      }
      pr.tipTab[3 * n] = dx;
      pr.tipTab[3 * n + 1] = 0.5 * (lo + hi);
      pr.tipTab[3 * n + 2] = dz;
    }
  }
}

const TIP_REL = new Float64Array(3);
/** δ of the AL tip at the current λ (interpolation in the table; 0 without a table and for the PM), in TIP_REL. No allocation. */
function alTipOffset(rig: LvFieldRig, pr: PapillaryRig): void {
  TIP_REL[0] = 0;
  TIP_REL[1] = 0;
  TIP_REL[2] = 0;
  if (pr.kind !== 'al' || pr.tipTab.length !== LV_APP_TABLE_N * 3 || !(rig.appTabStep > 0)) return;
  let t = (rig.lambda - rig.appTabLam0) / rig.appTabStep;
  if (t < 0) t = 0;
  if (t > LV_APP_TABLE_N - 1) t = LV_APP_TABLE_N - 1;
  let i0 = Math.floor(t);
  if (i0 >= LV_APP_TABLE_N - 1) i0 = LV_APP_TABLE_N - 2;
  const a = t - i0;
  const T = pr.tipTab;
  for (let k = 0; k < 3; k++) TIP_REL[k] = T[3 * i0 + k] + (T[3 * i0 + 3 + k] - T[3 * i0 + k]) * a;
}

// ---------- Phase 4b: LA post-step (D-VE17) ----------

/** Contact with the RA: LA vertices (rest already collapsed) at ≤ LA_RA_CONTACT_MM from the RA at rest. Allocates (load). */
function setupLaPost(skin: AtrialSkinRig, ra: THREE.Mesh | null): LaPostRig {
  const mesh = skin.mesh;
  const m = Float64Array.from(mesh.matrix.elements);
  const inv = Float64Array.from(skin.invM.elements);
  const n = skin.n;
  const slot = new Int32Array(n).fill(-1);
  const cp: number[] = [];
  const cn: number[] = [];
  if (ra?.geometry) {
    ra.updateMatrix();
    const g = ra.geometry;
    const a = g.getAttribute('position') as THREE.BufferAttribute;
    const idx = g.getIndex();
    const nT = (idx ? idx.count : a.count) / 3;
    const tris: THREE.Triangle[] = [];
    for (let t = 0; t < nT; t++) {
      const tt = new THREE.Triangle();
      tt.a.fromBufferAttribute(a, idx ? idx.getX(t * 3) : t * 3).applyMatrix4(ra.matrix);
      tt.b.fromBufferAttribute(a, idx ? idx.getX(t * 3 + 1) : t * 3 + 1).applyMatrix4(ra.matrix);
      tt.c.fromBufferAttribute(a, idx ? idx.getX(t * 3 + 2) : t * 3 + 2).applyMatrix4(ra.matrix);
      tris.push(tt);
    }
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const best = new THREE.Vector3();
    const lim = LA_RA_CONTACT_MM / 34.3;
    for (let i = 0; i < n; i++) {
      p.set(skin.restP[3 * i], skin.restP[3 * i + 1], skin.restP[3 * i + 2]);
      let bd = Infinity;
      for (const t of tris) {
        t.closestPointToPoint(p, q);
        const dd = q.distanceToSquared(p);
        if (dd < bd) {
          bd = dd;
          best.copy(q);
        }
      }
      const dist = Math.sqrt(bd);
      if (dist <= lim && dist > 1e-9) {
        slot[i] = cp.length / 3;
        cp.push(best.x, best.y, best.z);
        cn.push((p.x - best.x) / dist, (p.y - best.y) / dist, (p.z - best.z) / dist);
      }
    }
  }
  return { mesh, m, inv, slot, cp: Float64Array.from(cp), cn: Float64Array.from(cn), movedFloor: 0, movedContact: 0 };
}

/**
 * Phase 4b, per frame, after the LA skinning: floor at the current LV top (y ≥ top(θ) + margin, inside the top epicardium + tol.)
 * and contact with the RA (half-space at the closest rest point). If anything changed, the skin rewrites on the next frame. No allocation.
 */
export function applyLaPost(rig: LvFieldRig | null, localTop = false): void {
  const post = rig?.laPost;
  if (!rig || !post) return;
  // Phase 4c (D-VE21): Δy of the local top × annulus field weight (only over the freshly written skin: applyLvAtrium forces the rewrite)
  const eLa = localTop && rig.laE.length * 3 === (post.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array.length ? rig.laE : null;
  const scLa = -klOf(rig.kappa, rig.lambda);
  const attr = post.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  const M = post.m;
  const I = post.inv;
  const env = rig.envelope;
  const lam = rig.lambda;
  const kl = klOf(rig.kappa, lam);
  const NT = LV_ENV_N_THETA;
  const kTop = (LV_ENV_N_Y - 1) * NT;
  let mf = 0;
  let mc = 0;
  const n = arr.length / 3;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const lx = arr[i3], ly = arr[i3 + 1], lz = arr[i3 + 2];
    let x = M[0] * lx + M[4] * ly + M[8] * lz + M[12];
    let y = M[1] * lx + M[5] * ly + M[9] * lz + M[13];
    let z = M[2] * lx + M[6] * ly + M[10] * lz + M[14];
    let ch = false;
    if (eLa && eLa[i] !== 0) {
      y += scLa * eLa[i];
      ch = true;
    }
    if (y < Y_TOP + 0.1) {
      // Phase 5: top in the non-rotating frame (the top rotates φ_top)
      const thW = Math.atan2(z, x);
      const th = thW - env.twistTop;
      const top0 = Y_TOP - kl * gLookup(rig.gGrid, th, Y_TOP);
      // Phase 5d (M3): the mesh edge between two 5° columns is the chord of the top vertices; with a warped regional top it passes above the
      // interpolated top. The floor also uses this chord (lvLocalTopChordTh). Only rises. (Declared deviation: the 1st version used the maximum of the
      // two columns, lvLocalTopTh, which raised the LA up to 1.22 mm above the edge in the regional states.)
      const topL = lvLocalTopChordTh(env, thW);
      const top = topL > top0 ? topL : top0;
      if (y < top + LA_FLOOR_MARGIN) {
        // current epicardial radius of the top ring at θ (coefficients of the envelope's top row, interpolation in θ)
        let t = th % TWO_PI;
        if (t < 0) t += TWO_PI;
        const v = t / ENV_DTH;
        let j0 = Math.floor(v);
        const fj = v - j0;
        if (j0 >= NT) j0 -= NT;
        const j1 = j0 + 1 === NT ? 0 : j0 + 1;
        const o0 = kTop + j0;
        const o1 = kTop + j1;
        const r0 = layerR2(true, env.ca0[o0], env.ca1[o0], env.cb0[o0], env.cb1[o0], env.ccl[o0], lam, kl);
        const r1 = layerR2(true, env.ca0[o1], env.ca1[o1], env.cb0[o1], env.cb1[o1], env.ccl[o1], lam, kl);
        const rp = (r0 > 0 ? Math.sqrt(r0) : 0) * (1 - fj) + (r1 > 0 ? Math.sqrt(r1) : 0) * fj;
        if (Math.sqrt(x * x + z * z) < rp + LA_FLOOR_FOOTPRINT_TOL) {
          y = top + LA_FLOOR_MARGIN;
          ch = true;
          mf++;
        }
      }
    }
    const s = post.slot[i];
    if (s >= 0) {
      const s3 = s * 3;
      const nx = post.cn[s3], ny = post.cn[s3 + 1], nz = post.cn[s3 + 2];
      const dd = (x - post.cp[s3]) * nx + (y - post.cp[s3 + 1]) * ny + (z - post.cp[s3 + 2]) * nz;
      if (dd < LA_RA_MARGIN) {
        const k = LA_RA_MARGIN - dd;
        x += k * nx;
        y += k * ny;
        z += k * nz;
        ch = true;
        mc++;
      }
    }
    if (ch) {
      arr[i3] = I[0] * x + I[4] * y + I[8] * z + I[12];
      arr[i3 + 1] = I[1] * x + I[5] * y + I[9] * z + I[13];
      arr[i3 + 2] = I[2] * x + I[6] * y + I[10] * z + I[14];
    }
  }
  post.movedFloor = mf;
  post.movedContact = mc;
  if (mf + mc > 0 || eLa) {
    attr.needsUpdate = true;
    if (rig.laSkin) rig.laSkin.lastAmount = NaN;
  }
}

// ---------- Phase 4c (D-VE21): local top of the mitral apparatus and of the LA ----------

/** Builds the local-top field: annulus (own geometry), mitral leaflets (rigOffset), θ/guard of the LA. Allocates (load). */
function setupLocalTop(rig: LvFieldRig, root: THREE.Object3D, valvarData: ValvarKinematicsData | null): void {
  const restMat = (o: THREE.Object3D) => {
    const ra = o.userData.lvApparatusRest as number[] | undefined;
    if (ra) return new THREE.Matrix4().fromArray(ra);
    o.updateMatrix();
    return o.matrix.clone();
  };
  const upLocal = (M: THREE.Matrix4): [number, number, number] => {
    const v = new THREE.Vector3(0, 1, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(M).invert());
    return [v.x, v.y, v.z];
  };
  const make = (mesh: THREE.Mesh, localRest: ArrayLike<number>, restLocal: Float32Array | null, offset: Float32Array | null): LocalTopMesh => {
    const M = restMat(mesh);
    const n = localRest.length / 3;
    const theta = new Float64Array(n);
    const guard = new Float64Array(n);
    const q = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      q.set(localRest[3 * i], localRest[3 * i + 1], localRest[3 * i + 2]).applyMatrix4(M);
      theta[i] = Math.atan2(q.z, q.x);
      guard[i] = localTopGuard(Math.hypot(q.x, q.z));
    }
    return { mesh, restLocal, offset, theta, guard, e: new Float64Array(n), dl: upLocal(M), restNormal: null, tri: null };
  };
  const ann = root.getObjectByName('mitral_annulus') as THREE.Mesh | undefined;
  if (ann?.isMesh) {
    let g = ann.geometry;
    if (!g.userData.lvLocalTopOwned) {
      const src = g;
      g = src.clone();
      g.userData = { ...src.userData, lvLocalTopOwned: true, lvLocalTopRest: Float32Array.from(src.getAttribute('position').array as Float32Array) };
      ann.geometry = g;
    }
    const restLocal = g.userData.lvLocalTopRest as Float32Array;
    (g.getAttribute('position').array as Float32Array).set(restLocal);
    g.getAttribute('position').needsUpdate = true;
    g.computeBoundingSphere();
    if (g.boundingSphere) g.boundingSphere.radius += 0.2;
    const L = make(ann, restLocal, restLocal, null);
    // Phase 5b (N1): rest normals (those of the GLB) and annulus triangles, to recompute the normals with the local top
    const nAttr = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const gi = g.getIndex();
    if (nAttr && gi) {
      if (!g.userData.lvLocalTopRestNormal) g.userData.lvLocalTopRestNormal = Float32Array.from(nAttr.array as Float32Array);
      L.restNormal = g.userData.lvLocalTopRestNormal as Float32Array;
      (nAttr.array as Float32Array).set(L.restNormal);
      nAttr.needsUpdate = true;
      L.tri = Uint32Array.from(gi.array as ArrayLike<number>);
    }
    rig.appLocal.push(L);
  }
  for (const spec of valvarData?.leaflets ?? []) {
    if (!spec.isMitral) continue;
    const rest = spec.mesh.userData.restPositions as Float32Array | undefined;
    if (!rest) continue;
    const offset = new Float32Array(rest.length);
    spec.rigOffset = offset;
    spec.mesh.userData.rigOffset = offset;
    const L = make(spec.mesh, rest, null, offset);
    const wl = leafletLocalTopWeights(spec);
    for (let i = 0; i < wl.length; i++) L.guard[i] *= wl[i];
    rig.appLocal.push(L);
  }
  const skin = rig.laSkin;
  const annL = rig.appLocal.find((L) => L.restLocal !== null) ?? null;
  if (skin && annL) {
    // the LA inherits the annulus Δy (not that of its own θ): the LA facets (~15° of θ) do not follow the curve of the local top at the segment
    // transition, and the LA–annulus gap opened by the facet sagitta (probe __ve4c_dbg_gap). IDW weights (p = 4) of the 8 closest annulus vertices.
    const n = skin.n;
    const K = LA_ANN_NEIGHBORS;
    rig.laTheta = new Float64Array(n);
    rig.laGuardW = new Float64Array(n);
    rig.laE = new Float64Array(n);
    rig.laNb = new Int32Array(n * K);
    rig.laNw = new Float64Array(n * K);
    const M = restMat(annL.mesh);
    const r = annL.restLocal!;
    const na = r.length / 3;
    const ap = new Float64Array(na * 3);
    const q = new THREE.Vector3();
    for (let j = 0; j < na; j++) {
      q.set(r[3 * j], r[3 * j + 1], r[3 * j + 2]).applyMatrix4(M);
      ap[3 * j] = q.x;
      ap[3 * j + 1] = q.y;
      ap[3 * j + 2] = q.z;
    }
    const bd = new Float64Array(K);
    const bi = new Int32Array(K);
    for (let i = 0; i < n; i++) {
      const x = skin.restP[3 * i], y = skin.restP[3 * i + 1], z = skin.restP[3 * i + 2];
      rig.laTheta[i] = Math.atan2(z, x);
      rig.laGuardW[i] = skin.wA[i];
      bd.fill(Infinity);
      bi.fill(0);
      for (let j = 0; j < na; j++) {
        const d2 = (ap[3 * j] - x) ** 2 + (ap[3 * j + 1] - y) ** 2 + (ap[3 * j + 2] - z) ** 2;
        if (d2 >= bd[K - 1]) continue;
        let k = K - 1;
        while (k > 0 && bd[k - 1] > d2) {
          bd[k] = bd[k - 1];
          bi[k] = bi[k - 1];
          k--;
        }
        bd[k] = d2;
        bi[k] = j;
      }
      let ws = 0;
      for (let k = 0; k < K; k++) ws += 1 / Math.max(1e-12, bd[k] * bd[k]);
      for (let k = 0; k < K; k++) {
        rig.laNb[i * K + k] = bi[k];
        rig.laNw[i * K + k] = 1 / Math.max(1e-12, bd[k] * bd[k]) / ws;
      }
    }
  }
}

/** At the c_i change: e = [G(θ, top) − Ḡ_top]·guard·weight for annulus, leaflets (1 − normY²), LA (w_A) and table candidates. Allocates only the candidate vector. */
function fillLocalTopCoeffs(rig: LvFieldRig): void {
  const g = rig.gGrid;
  const on = !!rig.cField;
  const dev = (th: number) => (on ? gLookup(g, th, Y_TOP) - rig.gTopMean : 0);
  for (const L of rig.appLocal) for (let i = 0; i < L.e.length; i++) L.e[i] = dev(L.theta[i]) * L.guard[i];
  const annE = rig.appLocal.find((L) => L.restLocal !== null)?.e ?? null;
  const K = LA_ANN_NEIGHBORS;
  for (let i = 0; i < rig.laE.length; i++) {
    let e = 0;
    if (annE && rig.laNb.length === rig.laE.length * K) for (let k = 0; k < K; k++) e += rig.laNw[i * K + k] * annE[rig.laNb[i * K + k]];
    rig.laE[i] = e * rig.laGuardW[i];
  }
  const nC = rig.appCand.length / 4;
  if (rig.appCandE.length !== nC) rig.appCandE = new Float64Array(nC);
  for (let k = 0; k < nC; k++) {
    const x = rig.appCand[4 * k], z = rig.appCand[4 * k + 2];
    const wl = rig.appCandW.length === nC ? rig.appCandW[k] : 0;
    rig.appCandE[k] = wl !== 0 ? dev(Math.atan2(z, x)) * localTopGuard(Math.hypot(x, z)) * wl : 0;
  }
  if (rig.laSkin) rig.laSkin.lastAmount = NaN;
}

/** Writes Δy = sc·e (sc = −κλ; 0 = back to rest) to the annulus (local positions) and to the leaflets (rigOffset). No allocation. */
function writeLocalTop(rig: LvFieldRig, sc: number): void {
  for (const L of rig.appLocal) {
    const [ux, uy, uz] = L.dl;
    const e = L.e;
    if (L.restLocal) {
      const attr = L.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const r = L.restLocal;
      for (let i = 0; i < e.length; i++) {
        const dy = sc * e[i];
        arr[3 * i] = r[3 * i] + dy * ux;
        arr[3 * i + 1] = r[3 * i + 1] + dy * uy;
        arr[3 * i + 2] = r[3 * i + 2] + dy * uz;
      }
      attr.needsUpdate = true;
      // Phase 5b (N1): the normals follow the deformed surface; at rest (sc = 0) those of the GLB return, byte for byte
      if (L.restNormal && L.tri) {
        const nAttr = L.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
        const nrm = nAttr.array as Float32Array;
        if (sc === 0) nrm.set(L.restNormal);
        else writeVertexNormals(arr, L.tri, nrm);
        nAttr.needsUpdate = true;
      }
    } else if (L.offset) {
      const o = L.offset;
      for (let i = 0; i < e.length; i++) {
        const dy = sc * e[i];
        o[3 * i] = dy * ux;
        o[3 * i + 1] = dy * uy;
        o[3 * i + 2] = dy * uz;
      }
    }
  }
}

/**
 * Phase 5b (N1): per-vertex normals by the BufferGeometry.computeVertexNormals method (indexed geometry): sum of the face normals
 * (pC − pB) × (pA − pB), weighted by area, accumulated in the float32 vector itself, and normalization. No allocation.
 */
function writeVertexNormals(pos: Float32Array, tri: Uint32Array, nrm: Float32Array): void {
  nrm.fill(0);
  for (let t = 0; t < tri.length; t += 3) {
    const a = 3 * tri[t], b = 3 * tri[t + 1], c = 3 * tri[t + 2];
    const cbx = pos[c] - pos[b], cby = pos[c + 1] - pos[b + 1], cbz = pos[c + 2] - pos[b + 2];
    const abx = pos[a] - pos[b], aby = pos[a + 1] - pos[b + 1], abz = pos[a + 2] - pos[b + 2];
    const nx = cby * abz - cbz * aby;
    const ny = cbz * abx - cbx * abz;
    const nz = cbx * aby - cby * abx;
    nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
    nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
    nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const x = nrm[i], y = nrm[i + 1], z = nrm[i + 2];
    const k = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    nrm[i] = x * k;
    nrm[i + 1] = y * k;
    nrm[i + 2] = z * k;
  }
}

// ---------- Phase 4c (D-VE24): RA outside the LV ----------

function setupRaPost(skin: AtrialSkinRig): RaPostRig {
  const mesh = skin.mesh;
  mesh.updateMatrix();
  return { skin, m: Float64Array.from(mesh.matrix.elements), inv: Float64Array.from(mesh.matrix.clone().invert().elements), moved: 0, maxMove: 0 };
}

/**
 * Per frame, after the RA skinning (applyAtrialSkinning): each RA vertex with y ≤ top(θ) + m and r < ρ_p(θ, y) + m leaves by the smallest exit
 * (radial to ρ_p + m, or vertical to the top + m), m = RA_LV_MARGIN. Top from the G grid; ρ_p from the envelope grid. If it moved, the RA skin
 * is rewritten on the next frame (the LV may have relaxed). No allocation.
 */
export function applyLvRaPost(rig: LvFieldRig | null): void {
  const post = rig?.raPost;
  if (!rig || !post) return;
  const attr = post.skin.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  const M = post.m;
  const I = post.inv;
  const env = rig.envelope;
  const kl = klOf(rig.kappa, rig.lambda);
  const m = RA_LV_MARGIN;
  let moved = 0;
  let maxMove = 0;
  const n = arr.length / 3;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const lx = arr[i3], ly = arr[i3 + 1], lz = arr[i3 + 2];
    let x = M[0] * lx + M[4] * ly + M[8] * lz + M[12];
    let y = M[1] * lx + M[5] * ly + M[9] * lz + M[13];
    let z = M[2] * lx + M[6] * ly + M[10] * lz + M[14];
    if (y > Y_TOP + m || y < Y0) continue;
    // Phase 5: θ in the non-rotating frame (top: φ_top; recession: φ(y))
    const thW = Math.atan2(z, x);
    const top = Y_TOP - kl * gLookup(rig.gGrid, thW - env.twistTop, Y_TOP);
    if (y > top + m) continue;
    const yy = y < top ? y : top;
    const th = thW - twistPhiAt(env.twist, yy);
    let v = (yy - Y0) / ENV_DY;
    if (v < 0) v = 0;
    if (v > LV_ENV_N_Y - 1) v = LV_ENV_N_Y - 1;
    let k0 = Math.floor(v);
    if (k0 >= LV_ENV_N_Y - 1) k0 = LV_ENV_N_Y - 2;
    const fv = v - k0;
    const rpRest = Math.sqrt(env.rp2[k0]) * (1 - fv) + Math.sqrt(env.rp2[k0 + 1]) * fv;
    const rp = rpRest - gridLookupTh(env.shrink, th, yy);
    const r = Math.sqrt(x * x + z * z);
    if (!(rp > 0) || r >= rp + m) continue;
    const dr = rp + m - r;
    const dv = top + m - y;
    if (dv <= dr || r === 0) {
      y += dv;
      if (dv > maxMove) maxMove = dv;
    } else {
      const s = (r + dr) / r;
      x *= s;
      z *= s;
      if (dr > maxMove) maxMove = dr;
    }
    arr[i3] = I[0] * x + I[4] * y + I[8] * z + I[12];
    arr[i3 + 1] = I[1] * x + I[5] * y + I[9] * z + I[13];
    arr[i3 + 2] = I[2] * x + I[6] * y + I[10] * z + I[14];
    moved++;
  }
  post.moved = moved;
  post.maxMove = maxMove;
  if (moved > 0) {
    attr.needsUpdate = true;
    post.skin.lastAmount = NaN;
  }
}

/** LA per frame: Phase 4d skinning with the apparatus field + Phase 4b post-step. No allocation. */
export function applyLvAtrium(rig: LvFieldRig | null, a: number): void {
  if (!rig?.laSkin) return;
  // Phase 4c (D-VE21): with the local top active (or just switched off) the skin is rewritten from rest every frame before the Δy
  const local = !!rig.cField && rig.lambda !== 0 && rig.laE.length > 0;
  if (local || rig.laLocalWritten) rig.laSkin.lastAmount = NaN;
  // Phase 5: the apparatus field rotates with φ_top; in the IVR the descent stays constant and untwisting continues: rewrite when φ changes
  if (rig.twistTop !== rig.laTwistLast) {
    rig.laSkin.lastAmount = NaN;
    rig.laTwistLast = rig.twistTop;
  }
  applyAtrialSkinning(rig.laSkin, rig.apparatusField, rig.mapse, a);
  applyLaPost(rig, local);
  rig.laLocalWritten = local;
}

// ---------- mitral papillary muscles and chordae (tethers) ----------

function nearestEndoOnMeridian(bx: number, by: number, bz: number): { y: number } {
  const rb = Math.hypot(bx, bz);
  let best = Infinity;
  let yb = by;
  const yLo = Math.max(lvApexCap(false).yPole, by - 0.8);
  for (let k = 0; k <= 4000; k++) {
    const yy = by - (by - yLo) * (k / 4000);
    const d = (lvClosedProfileRadius(yy, false) - rb) ** 2 + (yy - by) ** 2;
    if (d < best) {
      best = d;
      yb = yy;
    }
  }
  return { y: yb };
}

function setupPapillaries(rig: LvFieldRig, root: THREE.Object3D, valvarData: ValvarKinematicsData | null): void {
  const mk = (name: string, kind: 'pm' | 'al'): PapillaryRig | null => {
    const m = root.getObjectByName(name) as THREE.Mesh | undefined;
    if (!m?.isMesh) return null;
    m.updateMatrix();
    let g = m.geometry;
    if (!g.userData.lvFieldPapOwned) {
      const src = g;
      g = src.clone();
      g.userData = { ...src.userData, lvFieldPapOwned: true, lvFieldRest: Float32Array.from(src.getAttribute('position').array as Float32Array) };
      m.geometry = g;
    }
    const attr = g.getAttribute('position') as THREE.BufferAttribute;
    const restLocal = g.userData.lvFieldRest as Float32Array;
    (attr.array as Float32Array).set(restLocal);
    attr.needsUpdate = true;
    const n = attr.count;
    const restP = new Float64Array(n * 3);
    const q = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      q.fromArray(restLocal, i * 3).applyMatrix4(m.matrix);
      restP[3 * i] = q.x;
      restP[3 * i + 1] = q.y;
      restP[3 * i + 2] = q.z;
    }
    const w = new Float32Array(n);
    const pr: PapillaryRig = {
      mesh: m, pos: attr.array as Float32Array, restP, w, check: new Uint32Array(0), inv: Float64Array.from(m.matrix.clone().invert().elements),
      ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, ba0: 0, ba1: 0, bg: 0, tx: 0, ty: 0, tz: 0, ta0: 0, ta1: 0, tg: 0,
      ux: 0, uy: 0, uz: 0, vx: 0, vy: 0, vz: 0, tipDy: 0, tipSolved: false, clamped: 0, kind, chords: [], tipTab: new Float64Array(0),
    };
    // basal weight (rule of buildPapillaryExtension of the RV: basal portion; tip with the apparatus)
    const bw = papillaryBasalWeights(m, m.matrix);
    let lo = 0;
    for (let i = 1; i < n; i++) if (restP[3 * i + 1] < restP[3 * lo + 1]) lo = i;
    const wb = bw.weights[lo];
    if (!(wb > 0)) return null;
    for (let i = 0; i < n; i++) w[i] = Math.min(1, bw.weights[i] / wb);
    const checks: number[] = [];
    if (kind === 'al') {
      // base reference point: vertex closest to the wall (largest r/R_n)
      let best = -Infinity;
      for (let i = 0; i < n; i++) {
        const R = lvClosedProfileRadius(restP[3 * i + 1], false);
        if (!(R > 0)) continue;
        const ratio = Math.hypot(restP[3 * i], restP[3 * i + 2]) / R;
        if (ratio > best) {
          best = ratio;
          pr.ax = restP[3 * i];
          pr.ay = restP[3 * i + 1];
          pr.az = restP[3 * i + 2];
        }
      }
    } else {
      pr.bx = restP[3 * lo];
      pr.by = restP[3 * lo + 1];
      pr.bz = restP[3 * lo + 2];
      const near = nearestEndoOnMeridian(pr.bx, pr.by, pr.bz);
      const rb = Math.hypot(pr.bx, pr.bz) || 1;
      pr.ax = pr.bx / rb; // radial direction of the base (cos θ)
      pr.az = pr.bz / rb; // (sin θ)
      pr.ay = near.y;
    }
    // Every papillary vertex passes through the safety projection when the tip follows the apparatus
    for (let i = 0; i < n; i++) checks.push(i);
    pr.check = Uint32Array.from(checks);
    // chordae of this papillary muscle (tethers): rest base in parent space
    if (valvarData) {
      let sx = 0, sy = 0, sz = 0;
      for (const b of valvarData.chordae) {
        if (b.papillaryName !== name) continue;
        const restM = (b.chordaMesh.userData.lvApparatusRest ? new THREE.Matrix4().fromArray(b.chordaMesh.userData.lvApparatusRest as number[]) : b.chordaMesh.matrix.clone());
        const inv = new THREE.Matrix3().setFromMatrix4(restM).invert().elements;
        const cRest = b.chordaMesh.userData.restPositions as Float32Array;
        const p = new THREE.Vector3(cRest[3 * b.baseIdx], cRest[3 * b.baseIdx + 1], cRest[3 * b.baseIdx + 2]).applyMatrix4(restM);
        const offset = new Float32Array(3);
        b.baseOffset = offset;
        // Phase 4d (D-VE25): insertion with the valve closed (z = 0, same formula as applyValvarDeformation, without rigOffset)
        const q0 = poseInsertion(b, valvarData, restM, cRest, false);
        const q1 = poseInsertion(b, valvarData, restM, cRest, true);
        pr.chords.push({ b, offset, inv: Float64Array.from(inv), rest: restM, bx: p.x, by: p.y, bz: p.z, slide: 0,
          tx0: q0.x, ty0: q0.y, tz0: q0.z, len0: Math.hypot(q0.x - p.x, q0.y - p.y, q0.z - p.z),
          tx1: q1.x, ty1: q1.y, tz1: q1.z, len1: Math.hypot(q1.x - p.x, q1.y - p.y, q1.z - p.z) });
        sx += p.x;
        sy += p.y;
        sz += p.z;
      }
      const nc = pr.chords.length;
      if (nc) {
        pr.tx = sx / nc;
        pr.ty = sy / nc;
        pr.tz = sz / nc;
      }
    }
    if (!pr.chords.length) {
      // no chordae: tip = highest vertex
      let hi = 0;
      for (let i = 1; i < n; i++) if (restP[3 * i + 1] > restP[3 * hi + 1]) hi = i;
      pr.tx = restP[3 * hi];
      pr.ty = restP[3 * hi + 1];
      pr.tz = restP[3 * hi + 2];
    }
    return pr;
  };
  const al = mk('mitral_anterolateral_papillary_muscle', 'al');
  const pm = mk('mitral_posteromedial_papillary_muscle', 'pm');
  if (al) rig.papillaries.push(al);
  if (pm) rig.papillaries.push(pm);
}

/** Endocardial coefficients and G at the base and tip reference (at the c_i change). */
function papillaryCoeffs(rig: LvFieldRig, pr: PapillaryRig, c: ArrayLike<number> | null, beta: (u: number) => number): void {
  const thB = pr.kind === 'pm' ? Math.atan2(pr.az, pr.ax) : Math.atan2(pr.az, pr.ax);
  coeffsAt(c, thB, pr.ay, beta(pr.ay), tmpC);
  pr.ba0 = tmpC.a0;
  pr.ba1 = tmpC.a1;
  pr.bg = gLookup(rig.gGrid, thB, pr.ay);
  const thT = Math.atan2(pr.tz, pr.tx);
  coeffsAt(c, thT, pr.ty, beta(pr.ty), tmpC);
  pr.ta0 = tmpC.a0;
  pr.ta1 = tmpC.a1;
  pr.tg = gLookup(rig.gGrid, thT, pr.ty);
  pr.tipSolved = false;
}

/** Displacements of the base and the tip at the current λ (without the tip's solved y). No allocation. */
function papillaryDrive(rig: LvFieldRig, pr: PapillaryRig): void {
  const lam = rig.lambda;
  const kl = klOf(rig.kappa, lam);
  if (pr.kind === 'al') {
    const R = Math.sqrt(pr.ba0);
    const v = pr.ba0 + lam * pr.ba1;
    const rho = v > 0 ? Math.sqrt(v) : 0;
    const r = Math.hypot(pr.ax, pr.az) || 1;
    const d = R > 0 ? rho - R : 0;
    pr.ux = (d * pr.ax) / r;
    pr.uy = -kl * pr.bg;
    pr.uz = (d * pr.az) / r;
  } else {
    const v = pr.ba0 + lam * pr.ba1;
    const rho = (v > 0 ? Math.sqrt(v) : 0) - LV_PAPILLARY_WALL_MARGIN;
    pr.ux = rho * pr.ax - pr.bx;
    pr.uy = pr.ay - kl * pr.bg - pr.by;
    pr.uz = rho * pr.az - pr.bz;
  }
  // Phase 4b (D-VE19): the tip follows the apparatus in xz and in y (u_app): each chorda's vector stays equal to that of the LV at rest at the same z,
  // so the chordae length is the rest one and the base does not slide (before: xz by the radial similarity of the endocardium, y by the chordae)
  // Phase 4d (D-VE25): in the AL, the tip follows the apparatus only in part (δ from the table; 0 in the PM)
  alTipOffset(rig, pr);
  pr.vx = rig.appX + TIP_REL[0];
  pr.vy = rig.appY + TIP_REL[1];
  pr.vz = rig.appZ + TIP_REL[2];
  pr.tipDy = pr.vy;
  pr.tipSolved = true;
}

/**
 * Phase 4d: chorda insertion with the valve closed (z = 0) or open (z = 1) and the LV at rest, in parent space (rest pose of the node),
 * by the formulas of applyValvarDeformation (without rigOffset). Allocates (load).
 */
function poseInsertion(b: ChordaBinding, valvarData: ValvarKinematicsData, restM: THREE.Matrix4, cRest: Float32Array, open: boolean): THREE.Vector3 {
  const spec = valvarData.leaflets.find((l) => l.mesh === b.leafletMesh);
  const lRest = b.leafletMesh.userData.restPositions as Float32Array | undefined;
  const j = b.tipIdx * 3;
  let dx = 0, dy = 0, dz = 0;
  if (spec && lRest) {
    const l3 = b.leafletVIdx * 3;
    const field = spec.closeField ?? null;
    if (open) {
      const normY = Math.max(0, Math.min(1, (spec.maxY - lRest[l3 + 1]) / spec.height));
      const dOpen = spec.openD * normY * normY;
      dx = spec.openDir.x * dOpen;
      dy = spec.openDir.y * dOpen;
      dz = spec.openDir.z * dOpen;
    } else if (field) {
      dx = field[l3];
      dy = field[l3 + 1];
      dz = field[l3 + 2];
    } else {
      const normY = Math.max(0, Math.min(1, (spec.maxY - lRest[l3 + 1]) / spec.height));
      const dc = spec.closeD * normY * normY;
      dx = spec.closeDir.x * dc;
      dy = spec.closeDir.y * dc;
      dz = spec.closeDir.z * dc;
    }
  }
  return new THREE.Vector3(cRest[j] + dx, cRest[j + 1] + dy, cRest[j + 2] + dz).applyMatrix4(restM);
}

/**
 * Writes the geometry of a papillary muscle (base → tip by the basal weight) and projects whatever would go past the endocardium. No allocation.
 * Phase 4b (performance, same result): a single pass; whatever lies below the smallest endocardial radius of the two grid rows (minus the
 * margin and the exact-radius band) cannot be projected and does not query the grid.
 */
function writePapillary(rig: LvFieldRig, pr: PapillaryRig): void {
  const env = rig.envelope;
  const { restP, w, pos, inv } = pr;
  const n = w.length;
  const emr = env.endoMinRow;
  const band = rig.cField ? LV_EXACT_BAND : 0;
  // Phase 5: each vertex rotates α = w·φ(y) + (1 − w)·φ_app (base with the wall, tip with the apparatus); the projection against the endocardium is
  // done in the WALL frame at the vertex level (θ − φ(y))
  const on = rig.twistOn;
  const TT = rig.twistTab;
  const top = rig.twistTop;
  const cTop = on ? Math.cos(top) : 1;
  const sTop = on ? Math.sin(top) : 0;
  let clamped = 0;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const wi = w[i];
    let x = restP[i3] + wi * pr.ux + (1 - wi) * pr.vx;
    const y = restP[i3 + 1] + wi * pr.uy + (1 - wi) * pr.vy;
    let z = restP[i3 + 2] + wi * pr.uz + (1 - wi) * pr.vz;
    let phiY = 0;
    if (on) {
      let tv = (y - Y_PE) / TW_DY;
      if (tv < 0) tv = 0;
      if (tv > TW_N - 1) tv = TW_N - 1;
      let r0 = Math.floor(tv);
      if (r0 >= TW_N - 1) r0 = TW_N - 2;
      const f = tv - r0;
      const o0 = r0 * 4;
      phiY = TT[o0] + (TT[o0 + 4] - TT[o0]) * f;
      let c: number, s: number;
      if (wi === 0) {
        c = cTop;
        s = sTop;
      } else if (wi === 1) {
        c = TT[o0 + 1] + (TT[o0 + 5] - TT[o0 + 1]) * f;
        s = TT[o0 + 2] + (TT[o0 + 6] - TT[o0 + 2]) * f;
      } else {
        sinCosSmall(wi * phiY + (1 - wi) * top);
        s = SC[0];
        c = SC[1];
      }
      const x2 = x * c - z * s;
      z = x * s + z * c;
      x = x2;
    }
    const r = Math.sqrt(x * x + z * z);
    let v = (y - Y0) / ENV_DY;
    if (v < 0) v = 0;
    if (v > LV_ENV_N_Y - 1) v = LV_ENV_N_Y - 1;
    let k0 = Math.floor(v);
    if (k0 >= LV_ENV_N_Y - 1) k0 = LV_ENV_N_Y - 2;
    const minR = emr[k0] < emr[k0 + 1] ? emr[k0] : emr[k0 + 1];
    if (r > minR - LV_PAPILLARY_WALL_MARGIN - band) {
      const thW = Math.atan2(z, x) - phiY;
      let rMax = gridLookupTh(env.endoNow, thW, y) - LV_PAPILLARY_WALL_MARGIN;
      if (rMax > 0) {
        // Phase 4b: with regional motility, near the wall the exact radius applies (the grid errs by up to 0.011 u at the c transitions)
        if (rig.cField && r > rMax - LV_EXACT_BAND) {
          const re = endoRadiusExactAt(rig, thW, y, rig.lambda);
          if (re > 0) rMax = re - LV_PAPILLARY_WALL_MARGIN;
        }
        if (r > rMax && r !== 0) {
          x *= rMax / r;
          z *= rMax / r;
          clamped++;
        }
      }
    }
    pos[i3] = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
    pos[i3 + 1] = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
    pos[i3 + 2] = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
  }
  pr.clamped = clamped;
  pr.mesh.geometry.getAttribute('position').needsUpdate = true;
  // chordae base: displacement of the tip − u_app (0 with the tip on the apparatus; the chorda node already carries u_app)
  for (let c = 0; c < pr.chords.length; c++) setChordOffset(rig, pr, pr.chords[c], 0, 0, 0);
}

function setChordOffset(rig: LvFieldRig, pr: PapillaryRig, t: ChordTie, ex: number, ey: number, ez: number): void {
  const dx = pr.vx + ex - rig.appX;
  const dy = pr.vy + ey - rig.appY;
  const dz = pr.vz + ez - rig.appZ;
  const iv = t.inv;
  t.offset[0] = iv[0] * dx + iv[3] * dy + iv[6] * dz;
  t.offset[1] = iv[1] * dx + iv[4] * dy + iv[7] * dz;
  t.offset[2] = iv[2] * dx + iv[5] * dy + iv[8] * dz;
}

/** Positions the mitral papillary muscles at the current λ (tip y: the last one solved by the chordae). No allocation. */
function applyPapillaries(rig: LvFieldRig): void {
  for (const pr of rig.papillaries) {
    papillaryDrive(rig, pr);
    writePapillary(rig, pr);
  }
}

const TIE_IN = new Float64Array(3);
const TIP_D = new Float64Array(3);

/**
 * Current displacement of the chorda tip by the valvar kinematics (the same as applyValvarDeformation: current leaflet vertex −
 * rest − rigOffset), in TIP_D; current insertion in parent space at the node's rest pose (without u_app), in TIE_IN. No allocation.
 */
function chordInsertion(t: ChordTie): void {
  const b = t.b;
  const lPos = b.leafletMesh.geometry.attributes.position.array as Float32Array;
  const lRest = b.leafletMesh.userData.restPositions as Float32Array;
  const lOff = (b.leafletMesh.userData.rigOffset ?? null) as Float32Array | null;
  const l3 = b.leafletVIdx * 3;
  TIP_D[0] = lPos[l3] - lRest[l3] - (lOff ? lOff[l3] : 0);
  TIP_D[1] = lPos[l3 + 1] - lRest[l3 + 1] - (lOff ? lOff[l3 + 1] : 0);
  TIP_D[2] = lPos[l3 + 2] - lRest[l3 + 2] - (lOff ? lOff[l3 + 2] : 0);
  const cRest = b.chordaMesh.userData.restPositions as Float32Array;
  const j = b.tipIdx * 3;
  const e = t.rest.elements;
  const x = cRest[j] + TIP_D[0], y = cRest[j + 1] + TIP_D[1], z = cRest[j + 2] + TIP_D[2];
  TIE_IN[0] = e[0] * x + e[4] * y + e[8] * z + e[12];
  TIE_IN[1] = e[1] * x + e[5] * y + e[9] * z + e[13];
  TIE_IN[2] = e[2] * x + e[6] * y + e[10] * z + e[14];
}

/**
 * After `applyValvarDeformation` (leaflets of the frame). Phase 4b (D-VE19): with tip = apparatus, each chorda's base offset is
 * zero (the valvar kinematics already writes the right chorda) and only the diagnostic remains: `slide` = current length − length of the LV at
 * rest at the same z (should be 0). The papillary muscles were already written in flushLvField (once per frame). No allocation.
 */
export function applyLvChordTies(rig: LvFieldRig | null): void {
  if (!rig) return;
  // Phase 4c (D-VE21): the local top weighs 0 at the free edge of the leaflets (insertions): chordae and tips stay with the rigid apparatus
  for (const pr of rig.papillaries) {
    // Phase 4d (D-VE25; declared deviation, after the 1st result): in the AL, tip Δy by least squares of the chordae with the CURRENT insertions
    // (valve pose of this frame); the tip is rewritten and the chordae slide the rest
    if (pr.kind === 'al' && pr.tipTab.length === LV_APP_TABLE_N * 3 && pr.chords.length && pr.chords.length <= 16) {
      solveAlTipY(rig, pr);
      writePapillary(rig, pr);
    }
    const moved = pr.vx !== rig.appX || pr.vy !== rig.appY || pr.vz !== rig.appZ;
    for (const t of pr.chords) {
      chordInsertion(t);
      const L0 = Math.hypot(TIE_IN[0] - t.bx, TIE_IN[1] - t.by, TIE_IN[2] - t.bz);
      const vx = TIE_IN[0] + rig.appX - t.bx - pr.vx;
      const vy = TIE_IN[1] + rig.appY - t.by - pr.vy;
      const vz = TIE_IN[2] + rig.appZ - t.bz - pr.vz;
      const L = Math.sqrt(vx * vx + vy * vy + vz * vz);
      t.slide = L - L0;
      // Phase 4d (D-VE25): with the tip off the apparatus (AL), the base slides along the chorda to the length of the LV at rest at the same z
      if (moved && L > 0) {
        const k = (L - L0) / L;
        setChordOffset(rig, pr, t, k * vx, k * vy, k * vz);
        writeChord(t);
      }
    }
  }
}

const AL_Q = new Float64Array(16 * 4);
/**
 * Phase 4d (D-VE25; declared deviation, after the 2nd result): ceiling on the AL chordae slide = criterion limit (0.5 mm) − the papillary
 * margin (LV_PAPILLARY_WALL_MARGIN). If the xz δ of β = 0.75 exceeds it, the tip returns toward the apparatus in the same direction until it fits.
 */
export const LV_AL_SLIDE_CAP = 0.5 / 34.3 - LV_PAPILLARY_WALL_MARGIN;

/**
 * Phase 4d: y of the AL tip (pr.vy) that minimizes Σ((|q_c − δ| − L0_c)/L0_c)² with the current insertions (golden-section search in ±0.2 u); if the largest
 * slide exceeds LV_AL_SLIDE_CAP, the xz δ shrinks (bisection on the factor) until it fits. No allocation.
 */
function solveAlTipY(rig: LvFieldRig, pr: PapillaryRig): void {
  const nc = pr.chords.length;
  for (let c = 0; c < nc; c++) {
    const t = pr.chords[c];
    chordInsertion(t);
    const qx = TIE_IN[0] - t.bx, qy = TIE_IN[1] - t.by, qz = TIE_IN[2] - t.bz;
    AL_Q[4 * c] = qx;
    AL_Q[4 * c + 1] = qy;
    AL_Q[4 * c + 2] = qz;
    AL_Q[4 * c + 3] = Math.sqrt(qx * qx + qy * qy + qz * qz);
  }
  // xz δ always from the table at the current λ (not from the previous frame: no path dependence)
  alTipOffset(rig, pr);
  const dx0 = TIP_REL[0];
  const dz0 = TIP_REL[2];
  let dy = alBestY(nc, dx0, dz0);
  let f = 1;
  if (alMaxSlide(nc, dx0, dy, dz0) > LV_AL_SLIDE_CAP) {
    let a = 0;
    let b = 1;
    for (let it = 0; it < 24; it++) {
      const m = 0.5 * (a + b);
      if (alMaxSlide(nc, m * dx0, alBestY(nc, m * dx0, m * dz0), m * dz0) > LV_AL_SLIDE_CAP) b = m;
      else a = m;
    }
    f = a;
    dy = alBestY(nc, f * dx0, f * dz0);
  }
  pr.vx = rig.appX + f * dx0;
  pr.vz = rig.appZ + f * dz0;
  pr.vy = rig.appY + dy;
  pr.tipDy = pr.vy;
}
function alBestY(nc: number, dx: number, dz: number): number {
  let lo = -0.2;
  let hi = 0.2;
  const g = 0.6180339887498949;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let f1 = alChordErr(nc, dx, x1, dz);
  let f2 = alChordErr(nc, dx, x2, dz);
  for (let it = 0; it < 60; it++) {
    if (f1 < f2) {
      hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = alChordErr(nc, dx, x1, dz);
    } else {
      lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = alChordErr(nc, dx, x2, dz);
    }
  }
  return 0.5 * (lo + hi);
}
function alMaxSlide(nc: number, dx: number, dy: number, dz: number): number {
  let m = 0;
  for (let c = 0; c < nc; c++) {
    const qx = AL_Q[4 * c] - dx, qy = AL_Q[4 * c + 1] - dy, qz = AL_Q[4 * c + 2] - dz;
    const d = Math.abs(Math.sqrt(qx * qx + qy * qy + qz * qz) - AL_Q[4 * c + 3]);
    if (d > m) m = d;
  }
  return m;
}
function alChordErr(nc: number, dx: number, dy: number, dz: number): number {
  let e = 0;
  for (let c = 0; c < nc; c++) {
    const qx = AL_Q[4 * c] - dx, qy = AL_Q[4 * c + 1] - dy, qz = AL_Q[4 * c + 2] - dz;
    const L0 = AL_Q[4 * c + 3];
    const r = (Math.sqrt(qx * qx + qy * qy + qz * qz) - L0) / L0;
    e += r * r;
  }
  return e;
}

/** Rewrites the whole chorda: rest + tip displacement (weight g(t)) + base offset (weight 1 − g(t)). No allocation. */
export function writeChord(t: ChordTie): void {
  const b = t.b;
  const cPos = b.chordaMesh.geometry.attributes.position;
  const arr = cPos.array as Float32Array;
  const cRest = b.chordaMesh.userData.restPositions as Float32Array;
  const ax = b.axialT;
  const o0 = t.offset[0], o1 = t.offset[1], o2 = t.offset[2];
  for (let i = 0; i < cPos.count; i++) {
    const tt = ax[i];
    const g = tt * tt * (3 - 2 * tt);
    const k = 1 - g;
    arr[3 * i] = cRest[3 * i] + TIP_D[0] * g + o0 * k;
    arr[3 * i + 1] = cRest[3 * i + 1] + TIP_D[1] * g + o1 * k;
    arr[3 * i + 2] = cRest[3 * i + 2] + TIP_D[2] * g + o2 * k;
  }
  cPos.needsUpdate = true;
}

/** Diagnostic (console/probes): λ, V_ref, MAPSE (mm), u_app and projected vertices per papillary muscle. */
export function lvFieldInfo(rig: LvFieldRig | null): Record<string, number> | null {
  if (!rig) return null;
  const out: Record<string, number> = { lambda: rig.lambda, refVolume: rig.refVolume, lambdaMax: rig.lambdaMax, rebuildMs: rig.lastRebuildMs, mapseMm: rig.mapse * 34.3, appX: rig.appX, appY: rig.appY, appZ: rig.appZ,
    twistT: rig.twistT, twistTopDeg: rig.twistTop / DEG, twistApexDeg: (rig.twistOn ? rig.twistPhi[0] : 0) / DEG, twistStatic: rig.twistStatic ? 1 : 0,
    untwistEvt: rig.tw.evt ? 1 : 0, untwistPhase: rig.tw.phase, untwistU: rig.tw.U, untwistIvrMs: rig.tw.dIvr * 1000, untwistDvE: rig.tw.dvE, warmupMs: rig.warmupMs,
    driverInStep: rig.driverInStep ? 1 : 0, twistSwitches: rig.tw.switches };
  for (const p of rig.papillaries) out[`projetados_${p.kind}`] = p.clamped;
  return out;
}
