import * as THREE from 'three';
import chordaMappingRaw from './chorda_topological_mapping.json';
import tricuspidTentingTransformRaw from './data/tricuspidTentingTransform.json';

/**
 * Decision D18: transformation on load of the tricuspid leaflets and chordae according to the literature
 * (Skwarek et al. 2006, PMID 16988916; Pokutta-Paskaleva et al. 2019, doi:10.1016/j.actbio.2018.12.029;
 * Topilsky et al. 2012, doi:10.1161/CIRCIMAGING.111.967919). Reverter: setTricuspidTentingTransformEnabled(false).
 */
export const TRICUSPID_TENTING_TRANSFORM = tricuspidTentingTransformRaw;
export let TRICUSPID_TENTING_TRANSFORM_ENABLED = true;
export function setTricuspidTentingTransformEnabled(enabled: boolean): void {
  TRICUSPID_TENTING_TRANSFORM_ENABLED = enabled;
}

// Global GLB scale: 34.3 mm/unit based on the male LVEDD of 50.2 mm over 1.4622 units (Lang 2015, Table 2, doi: 10.1016/j.echo.2014.10.003).
export const GLTF_SCALE_MM_PER_UNIT = 34.3;

// Coaptation thresholds ("closed") in model units, preserving the behavior and classification of the original model (2.5 mm and 3.5 mm on the historical 55 mm/unit scale):
export const MITRAL_CLOSED_GAP_UNITS = 2.5 / 55;
export const TRICUSPID_CLOSED_GAP_UNITS = 3.5 / 55;

export const VALVAR_OPEN_SCALE: Record<string, number> = {
  'mitral_anterior_leaflet': 0.065,
  'mitral_posterior_leaflet': 0.060,
  'tricuspid_anterior_leaflet': 0.030,
  'tricuspid_posterior_leaflet': 0.030,
  'tricuspid_septal_leaflet': 0.025,
};

export const VALVAR_CLOSE_SCALE: Record<string, number> = {
  'mitral_anterior_leaflet': 0.065,
  'mitral_posterior_leaflet': 0.060,
  'tricuspid_anterior_leaflet': 0.080,
  'tricuspid_posterior_leaflet': 0.075,
  'tricuspid_septal_leaflet': 0.070,
};

export interface LeafletSpec {
  mesh: THREE.Mesh;
  name: string;
  isMitral: boolean;
  minY: number;
  maxY: number;
  height: number;
  openDir: THREE.Vector3;
  closeDir: THREE.Vector3;
  openD: number;
  closeD: number;
  /** RV Phase 4c: local per-vertex displacement written by the rig (null: no rig); does not enter the chordae kinematics */
  rigOffset?: Float32Array | null;
  /** D17: local per-vertex displacement from rest to the closed state (z = 0); null: mesh outside the expected grid (falls back to the old translation) */
  closeField?: Float32Array | null;
}

/**
 * Closure geometry of the AV valves. Lengths in mm.
 * Tuned empirical parameters for coaptation clearance and leaflet overlap.
 */
export const VALVAR_COAPTATION = {
  /** fraction of the column length that forms the coaptation zone */
  zoneFraction: 0.24,
  zoneMinMm: 0.6,
  zoneMaxMm: 3.0,
  /** distance between the mid surfaces of neighboring leaflets in the zone (GLB thickness 0.584 mm + clearance) */
  clearanceMm: 0.64,
  /** setback at the top of the zone and advance at the free edge: the tilt generates the overlap in projection */
  overlapFromMm: 0.55,
  overlapToMm: 0.68,
  /** allowed leaflet elongation when computing depth by length */
  leafletSlack: 0.0,
  /** maximum chord length in the closed state, in multiples of the GLB length */
  chordLimit: 1.08,
  /** factor of the overlaps near the commissures */
  commissureOverlap: 0.35,
  /** maximum slope of the coaptation line (mm of depth per mm of line) */
  maxDepthSlope: 0.6,
  /** maximum leaflet elongation when deepening because of the chordae */
  leafletMaxStretch: 0.4,
  /** fraction of the tilt on the tricuspid leg without the overlying leaflet */
  secondaryLegScale: 0.5,
  /** clearance on the leg without the overlying leaflet (0.584 mm thickness + 0.04 mm) */
  secondaryClearanceMm: 0.62,
  /** fraction of the clearance at the commissure (σ = 0) */
  commissureClearance: 0.3,
  /** σ from which the columns converge to the resolved apex */
  apexBlendStart: 0.88,
  /** σ from which the line depth is smoothly brought to the apex value */
  apexFlatStart: 0.7,
  /** overlap reinforcement at the tricuspid apex */
  apexOverlapBoost: 0.6,
  /** final smoothing of the line depth (after the chordae limit) */
  depthFinalSmooth: 3,
  /** extra smoothing passes at the tricuspid apex crease */
  apexExtraSmooth: 6,
  /** smoothing passes of the closed mid surface */
  smoothPasses: 3,
  /** maximum half-thickness relative to the local spacing of the closed mesh */
  thicknessRadiusRatio: 0.45,
};

/** Maximum projected area to consider the valve closed (project HYPOTHESIS, no normal value in the literature consulted) */
export const VALVAR_CLOSED_ORIFICE_MM2 = 1.0;

export interface ChordaBinding {
  chordaMesh: THREE.Mesh;
  leafletMesh: THREE.Mesh;
  papillaryMesh: THREE.Mesh;
  chordaName: string;
  leafletName: string;
  papillaryName: string;
  chamber: string;
  baseIdx: number;
  tipIdx: number;
  leafletVIdx: number;
  basePos: THREE.Vector3;
  tipPos: THREE.Vector3;
  restLen: number;
  axialT: Float32Array;
  restGapTip: number;
  tipOffset: THREE.Vector3;
  /** LV Phase 3: local displacement of the base (AL papillary following the endocardium), with weight 1 − t up to the insertion. Absent = 0. */
  baseOffset?: Float32Array;
}

export interface ValvarKinematicsData {
  leaflets: LeafletSpec[];
  chordae: ChordaBinding[];
  annuli: THREE.Mesh[];
  papillaries: THREE.Mesh[];
  /** D17: geometry of the coaptation lines, for metrics and reports */
  coaptation: ValvarCoaptationInfo[];
  _leafPosCur: THREE.Vector3;
  _leafPosRest: THREE.Vector3;
  _tipDelta: THREE.Vector3;
  _vTmp1: THREE.Vector3;
  _vTmp2: THREE.Vector3;
  _vTmp3: THREE.Vector3;
}

function getMeshLocalCenter(mesh: THREE.Mesh): THREE.Vector3 {
  const pos = mesh.geometry.attributes.position;
  const c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    c.x += pos.getX(i);
    c.y += pos.getY(i);
    c.z += pos.getZ(i);
  }
  return c.divideScalar(pos.count || 1);
}

function getFreeEdgeCentroid(mesh: THREE.Mesh): { centroid: THREE.Vector3; minY: number; maxY: number; height: number } {
  const pos = mesh.geometry.attributes.position;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const height = maxY - minY || 1.0;
  const cut = minY + 0.35 * height;
  const c = new THREE.Vector3();
  let cnt = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y <= cut) {
      c.x += pos.getX(i);
      c.y += y;
      c.z += pos.getZ(i);
      cnt++;
    }
  }
  if (cnt > 0) c.divideScalar(cnt);
  else c.set(0, (minY + maxY) * 0.5, 0);
  return { centroid: c, minY, maxY, height };
}

/** Leaflet grid in the GLB: index = 16·column + row; row 0 hinge, 15 free edge; columns c and c + 27 are the two faces of the same point */
const LEAFLET_ROWS = 16;
const LEAFLET_COLS = 27;
const APEX_COL = 13;
const DEPTH_SAMPLES = 32;

export interface ValvarCoaptationInfo {
  isMitral: boolean;
  center: THREE.Vector3;
  normal: THREE.Vector3;
  e1: THREE.Vector3;
  e2: THREE.Vector3;
  apex: [number, number];
  commissures: Array<[number, number]>;
  /** top of the zone (mm, ventricular +) along each leg, from the commissure (index 0) to the apex */
  topDepthMm: Float64Array[];
  /** overlying leaflet on each leg (index in leaflets) */
  topLeaflet: number[];
  leaflets: LeafletSpec[];
  /** column, band and depth of the top per leaflet, for the metrics */
  columnLeg: Int32Array[];
  columnSigma: Float64Array[];
  zoneStartRow: Float64Array[];
  /** chordae that did not fit within the limit even when deepening the line (mm of excess) */
  chordExcessMm: Array<{ name: string; excessMm: number }>;
}

type Plan = [number, number];

/**
 * D17: computes, at assembly only, the displacement of each vertex to the closed state.
 * The free edge goes to a coaptation line (Y in the tricuspid; A-P curve in the mitral), the body interpolates by h²
 * and the final part of the column forms the coaptation zone, in parallel tilted laminae: the separation between neighbors is built in, not corrected.
 */
function buildCoaptationField(valve: LeafletSpec[], chordae: ChordaBinding[], annulus: THREE.Mesh, isMitral: boolean): ValvarCoaptationInfo | null {
  const P = VALVAR_COAPTATION;
  const S = GLTF_SCALE_MM_PER_UNIT;
  const N_LEAF = valve.length;
  if (N_LEAF !== (isMitral ? 2 : 3)) return null;
  for (const l of valve) if (l.mesh.geometry.attributes.position.count !== 2 * LEAFLET_COLS * LEAFLET_ROWS) return null;

  // Annulus plane (same local space as the leaflets)
  const aPos = annulus.geometry.attributes.position;
  const center = new THREE.Vector3();
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < aPos.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(aPos, i);
    pts.push(p);
    center.add(p);
  }
  center.multiplyScalar(1 / pts.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of pts) {
    const x = p.x - center.x, y = p.y - center.y, z = p.z - center.z;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const inv = new THREE.Matrix3().set(xx, xy, xz, xy, yy, yz, xz, yz, zz).invert();
  const normal = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 64; i++) normal.applyMatrix3(inv).normalize();

  // Grid of mid surfaces and half-thicknesses (sign: atrial = opposite to the free edge side)
  const nG = LEAFLET_COLS * LEAFLET_ROWS;
  const midOf = valve.map((l) => {
    const r = l.mesh.userData.restPositions as Float32Array;
    const mid = new Float64Array(nG * 3), off = new Float64Array(nG * 3);
    for (let g = 0; g < LEAFLET_COLS; g++) for (let k = 0; k < LEAFLET_ROWS; k++) {
      const a = (g * LEAFLET_ROWS + k) * 3, b = ((g + LEAFLET_COLS) * LEAFLET_ROWS + k) * 3, m = (g * LEAFLET_ROWS + k) * 3;
      for (let c = 0; c < 3; c++) {
        mid[m + c] = (r[a + c] + r[b + c]) / 2;
        off[m + c] = (r[a + c] - r[b + c]) / 2;
      }
    }
    return { mid, off };
  });
  const gridV = (arr: Float64Array, g: number, k: number, out: THREE.Vector3) => out.fromArray(arr, (g * LEAFLET_ROWS + k) * 3);
  const tmp = new THREE.Vector3();
  let hingeSum = 0, freeSum = 0;
  for (const { mid } of midOf) for (let g = 0; g < LEAFLET_COLS; g++) {
    hingeSum += gridV(mid, g, 0, tmp).sub(center).dot(normal);
    freeSum += gridV(mid, g, LEAFLET_ROWS - 1, tmp).sub(center).dot(normal);
  }
  if (hingeSum < freeSum) normal.negate();
  const e1 = new THREE.Vector3(1, 0, 0);
  if (Math.abs(e1.dot(normal)) > 0.9) e1.set(0, 0, 1);
  e1.addScaledVector(normal, -e1.dot(normal)).normalize();
  const e2 = new THREE.Vector3().crossVectors(normal, e1);
  const toPlan = (v: THREE.Vector3): [number, number, number] => {
    const d = tmp.copy(v).sub(center);
    return [d.dot(e1), d.dot(e2), -d.dot(normal)];
  };
  const fromPlan = (x: number, y: number, d: number, out: THREE.Vector3) => out.copy(center).addScaledVector(e1, x).addScaledVector(e2, y).addScaledVector(normal, -d);

  // Lengths per column
  const arcs = midOf.map(({ mid }) => {
    const arc = new Float64Array(nG);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let g = 0; g < LEAFLET_COLS; g++) for (let k = 1; k < LEAFLET_ROWS; k++) {
      arc[g * LEAFLET_ROWS + k] = arc[g * LEAFLET_ROWS + k - 1] + gridV(mid, g, k, a).distanceTo(gridV(mid, g, k - 1, b));
    }
    return arc;
  });
  const lenOf = (i: number, g: number) => arcs[i][g * LEAFLET_ROWS + LEAFLET_ROWS - 1];
  // parameter u by free edge length, normalized
  const uOf = midOf.map(({ mid }) => {
    const u = new Float64Array(LEAFLET_COLS);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let g = 1; g < LEAFLET_COLS; g++) u[g] = u[g - 1] + gridV(mid, g, LEAFLET_ROWS - 1, a).distanceTo(gridV(mid, g - 1, LEAFLET_ROWS - 1, b));
    const t = u[LEAFLET_COLS - 1] || 1;
    return u.map((x) => x / t);
  });
  const hingePlan = (i: number, g: number): [number, number, number] => toPlan(gridV(midOf[i].mid, g, 0, new THREE.Vector3()));

  // Commissures: closest ends of neighboring leaflets
  type End = { i: number; side: 0 | 1; p: [number, number, number] };
  const ends: End[] = [];
  for (let i = 0; i < N_LEAF; i++) {
    ends.push({ i, side: 0, p: hingePlan(i, 0) });
    ends.push({ i, side: 1, p: hingePlan(i, LEAFLET_COLS - 1) });
  }
  const commissures: Array<{ x: number; y: number; ends: [End, End] }> = [];
  const used = new Set<End>();
  for (const a of ends) {
    if (used.has(a)) continue;
    let best: End | null = null, bd = Infinity;
    for (const b of ends) {
      if (b.i === a.i || used.has(b)) continue;
      const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) return null;
    used.add(a); used.add(best);
    commissures.push({ x: (a.p[0] + best.p[0]) / 2, y: (a.p[1] + best.p[1]) / 2, ends: [a, best] });
  }
  const legOf: number[][] = valve.map(() => [-1, -1]);
  commissures.forEach((c, id) => { for (const e of c.ends) legOf[e.i][e.side] = id; });
  if (legOf.some((a) => a[0] < 0 || a[1] < 0)) return null;

  // Apex: position where the slack (length − reach) is equal across the leaflets
  const hMid = valve.map((_, i) => hingePlan(i, APEX_COL));
  const lenMid = valve.map((_, i) => lenOf(i, APEX_COL));
  const apex: Plan = [hMid.reduce((s, h) => s + h[0], 0) / N_LEAF, hMid.reduce((s, h) => s + h[1], 0) / N_LEAF];
  for (let it = 0; it < 100; it++) {
    const reach = hMid.map((h) => Math.hypot(apex[0] - h[0], apex[1] - h[1]));
    const slack = reach.map((r, i) => lenMid[i] - r);
    const mean = slack.reduce((s, x) => s + x, 0) / N_LEAF;
    let dx = 0, dy = 0;
    hMid.forEach((h, i) => { const r = Math.max(1e-6, reach[i]); dx += ((mean - slack[i]) * (h[0] - apex[0])) / r; dy += ((mean - slack[i]) * (h[1] - apex[1])) / r; });
    apex[0] += 0.4 * dx; apex[1] += 0.4 * dy;
  }

  // Curve of the line of each leg (commissure → apex) and tangent
  const legPoint = (id: number, sigma: number): Plan => {
    const c = commissures[id];
    if (!isMitral) return [c.x + (apex[0] - c.x) * sigma, c.y + (apex[1] - c.y) * sigma];
    const c0 = commissures[0], c1 = commissures[1];
    const qx = 2 * apex[0] - (c0.x + c1.x) / 2, qy = 2 * apex[1] - (c0.y + c1.y) / 2;
    const s = id === 0 ? sigma / 2 : 1 - sigma / 2;
    const m = 1 - s;
    return [m * m * c0.x + 2 * s * m * qx + s * s * c1.x, m * m * c0.y + 2 * s * m * qy + s * s * c1.y];
  };
  const legNormal = (i: number, id: number, sigma: number, g: number): Plan => {
    const a = legPoint(id, Math.max(0, sigma - 0.02)), b = legPoint(id, Math.min(1, sigma + 0.02));
    let nx = -(b[1] - a[1]), ny = b[0] - a[0];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    // direction toward the leaflet's own side
    const here = legPoint(id, sigma);
    const h = hingePlan(i, g);
    if (nx * (h[0] - here[0]) + ny * (h[1] - here[1]) < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  };

  // Column → leg and σ (0 at the commissure, 1 at the apex)
  const columnLeg = valve.map(() => new Int32Array(LEAFLET_COLS));
  const columnSigma = valve.map(() => new Float64Array(LEAFLET_COLS));
  valve.forEach((_, i) => {
    const u = uOf[i];
    const uA = u[APEX_COL];
    for (let g = 0; g < LEAFLET_COLS; g++) {
      const side = g <= APEX_COL ? 0 : 1;
      columnLeg[i][g] = legOf[i][side];
      columnSigma[i][g] = side === 0 ? u[g] / uA : (1 - u[g]) / (1 - uA);
    }
  });

  // Coaptation zone per column
  const zoneLen = valve.map((_, i) => {
    const z = new Float64Array(LEAFLET_COLS);
    for (let g = 0; g < LEAFLET_COLS; g++) z[g] = Math.max(P.zoneMinMm / S, Math.min(P.zoneMaxMm / S, P.zoneFraction * lenOf(i, g)));
    return z;
  });
  const zoneStartRow = valve.map(() => new Float64Array(LEAFLET_COLS));

  // Who lies on top on each leg: fixed, acyclic order, so that the apex is always covered
  const rank = isMitral ? [0, 1] : [2, 1, 0];
  const topLeaflet = commissures.map((c) => (rank[c.ends[0].i] > rank[c.ends[1].i] ? c.ends[0].i : c.ends[1].i));
  const clearance = P.clearanceMm / S, a0 = P.overlapFromMm / S, o0 = P.overlapToMm / S;
  const kappaAt = (sigma: number) => {
    if (!isMitral) {
      // the RV rig displaces the leaflets relative to each other near the apex: local overlap reinforcement, so the Y stays covered in systole
      const w = Math.max(0, (sigma - 0.7) / 0.3);
      return P.commissureOverlap + (1 - P.commissureOverlap) * sigma + P.apexOverlapBoost * w * w * (3 - 2 * w);
    }
    const s = Math.min(1, sigma * 3);
    return P.commissureOverlap + (1 - P.commissureOverlap) * s * s * (3 - 2 * s);
  };
  // On the tricuspid, the leg without the overlying leaflet uses a smaller tilt: a leaflet "on top" on one leg and "underneath" on the other twists the apex and folds it onto itself
  const topMost = rank.indexOf(Math.max(...rank));
  const legScale = commissures.map((c) => (isMitral || c.ends[0].i === topMost || c.ends[1].i === topMost ? 1 : P.secondaryLegScale));
  const legClearance = commissures.map((_, id) => (legScale[id] < 1 ? P.secondaryClearanceMm / S : clearance));
  const towardNeighbor = (isTop: boolean, kappa0: number, t: number, id: number, sigma = 1) => {
    const kappa = kappa0 * legScale[id];
    const a = a0 * kappa, o = o0 * kappa;
    const xi = -a + (a + o) * t;
    // near the commissure the hinges already separate the leaflets: the clearance grows with σ, to avoid creasing short columns
    const c = legClearance[id] * Math.min(1, P.commissureClearance + (1 - P.commissureClearance) * Math.min(1, sigma / 0.2));
    return isTop ? -(xi + c / 2) : xi - c / 2;
  };
  const apexOffset = (i: number, t: number): Plan => {
    const legs = legOf[i];
    const n0 = legNormal(i, legs[0], 1, APEX_COL), n1 = legNormal(i, legs[1], 1, APEX_COL);
    const k1 = kappaAt(1);
    const d0 = towardNeighbor(topLeaflet[legs[0]] === i, k1, t, legs[0]), d1 = towardNeighbor(topLeaflet[legs[1]] === i, k1, t, legs[1]);
    // solve (−n0)·x = d0, (−n1)·x = d1
    const a = -n0[0], b = -n0[1], c = -n1[0], d = -n1[1];
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) return [-n0[0] * d0, -n0[1] * d0];
    return [(d0 * d - b * d1) / det, (a * d1 - c * d0) / det];
  };
  /** in-plan point of the zone, for column g at parameter t (0 top, 1 free edge) */
  const zonePlan = (i: number, g: number, t: number): Plan => {
    const id = columnLeg[i][g], sigma = columnSigma[i][g];
    const isTop = topLeaflet[id] === i;
    if (isMitral) {
      const p = legPoint(id, sigma);
      const n = legNormal(i, id, sigma, g);
      const d = towardNeighbor(isTop, kappaAt(sigma), t, id, sigma);
      return [p[0] - n[0] * d, p[1] - n[1] * d];
    }
    // Leg: straight line offset along the normal, with the same position along the line for both neighbors; only the final stretch goes to the resolved apex
    const n = legNormal(i, id, Math.min(0.5, sigma), g);
    const d = towardNeighbor(isTop, kappaAt(sigma), t, id, sigma);
    const p = legPoint(id, sigma);
    const A = apexOffset(i, t);
    const ax = apex[0] + A[0], ay = apex[1] + A[1];
    const qx = p[0] - n[0] * d, qy = p[1] - n[1] * d;
    const w = Math.max(0, (sigma - P.apexBlendStart) / (1 - P.apexBlendStart));
    return [qx + (ax - qx) * w, qy + (ay - qy) * w];
  };

  // Depth of the top of the zone: from length conservation (mean of the leaflets that share the leg)
  const nS = DEPTH_SAMPLES;
  const topDepth = commissures.map(() => new Float64Array(nS + 1));
  const topCount = commissures.map(() => new Float64Array(nS + 1));
  const depthCap = commissures.map(() => new Float64Array(nS + 1));
  const sampleSeq = (seq: Array<{ s: number; v: number }>, s: number) => {
    let k = 1;
    while (k < seq.length - 1 && seq[k].s < s) k++;
    const a = seq[k - 1], b = seq[k];
    const f = Math.max(0, Math.min(1, (s - a.s) / Math.max(1e-9, b.s - a.s)));
    return a.v + (b.v - a.v) * f;
  };
  const sideCols = (side: 0 | 1) => {
    const cols: number[] = [];
    for (let g = 0; g < LEAFLET_COLS; g++) if (side === 0 ? g <= APEX_COL : g >= APEX_COL) cols.push(g);
    return cols;
  };
  // Common zone per leg: the smallest value among the leaflets that share it, so the laminae are parallel and end together
  const zoneLine = commissures.map(() => new Float64Array(nS + 1).fill(Infinity));
  valve.forEach((_, i) => {
    for (const side of [0, 1] as const) {
      const id = legOf[i][side];
      const seq = sideCols(side).map((g) => ({ s: columnSigma[i][g], v: zoneLen[i][g] })).sort((a, b) => a.s - b.s);
      for (let j = 0; j <= nS; j++) zoneLine[id][j] = Math.min(zoneLine[id][j], sampleSeq(seq, j / nS));
    }
  });
  valve.forEach((_, i) => {
    for (let g = 0; g < LEAFLET_COLS; g++) {
      const id = columnLeg[i][g];
      const f = Math.min(nS - 1e-9, Math.max(0, columnSigma[i][g]) * nS), j = Math.floor(f);
      zoneLen[i][g] = Math.min(lenOf(i, g) * 0.6, zoneLine[id][j] + (zoneLine[id][j + 1] - zoneLine[id][j]) * (f - j));
      const target = lenOf(i, g) - zoneLen[i][g];
      let k = 1;
      const base = g * LEAFLET_ROWS;
      while (k < LEAFLET_ROWS - 1 && arcs[i][base + k] < target) k++;
      zoneStartRow[i][g] = k - 1 + (target - arcs[i][base + k - 1]) / Math.max(1e-9, arcs[i][base + k] - arcs[i][base + k - 1]);
    }
  });
  valve.forEach((_, i) => {
    for (const side of [0, 1] as const) {
      const id = legOf[i][side];
      const value = (g: number, slack: number) => {
        const h = hingePlan(i, g);
        const z = zoneLen[i][g];
        const p = legPoint(id, columnSigma[i][g]);
        const plan = Math.hypot(p[0] - h[0], p[1] - h[1]);
        const L = lenOf(i, g) * (1 + slack) - z;
        return h[2] + Math.sqrt(Math.max(0, L * L - plan * plan));
      };
      const seq = sideCols(side).map((g) => ({ s: columnSigma[i][g], v: value(g, P.leafletSlack) })).sort((a, b) => a.s - b.s);
      const capSeq = sideCols(side).map((g) => ({ s: columnSigma[i][g], v: value(g, P.leafletMaxStretch) })).sort((a, b) => a.s - b.s);
      for (let j = 0; j <= nS; j++) {
        const s = j / nS;
        topDepth[id][j] += sampleSeq(seq, s);
        topCount[id][j]++;
        depthCap[id][j] = Math.max(depthCap[id][j], sampleSeq(capSeq, s));
      }
    }
  });
  topDepth.forEach((d, id) => { for (let j = 0; j <= nS; j++) d[j] /= topCount[id][j] || 1; });
  const smooth = (d: Float64Array) => {
    const c = Float64Array.from(d);
    for (let j = 1; j < nS; j++) d[j] = 0.25 * c[j - 1] + 0.5 * c[j] + 0.25 * c[j + 1];
  };
  const unifyApex = () => {
    let m = 0;
    topDepth.forEach((d) => (m += d[nS]));
    m /= topDepth.length;
    topDepth.forEach((d) => (d[nS] = m));
  };
  unifyApex();
  for (let it = 0; it < 3; it++) topDepth.forEach(smooth);
  const legLen = commissures.map((_, id) => {
    let L = 0;
    let prev = legPoint(id, 0);
    for (let j = 1; j <= nS; j++) {
      const q = legPoint(id, j / nS);
      L += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
      prev = q;
    }
    return L;
  });
  // Maximum slope of the line: raises the shallower side (never deepens beyond the chord), passing through the apex common to all legs
  const limitSlope = () => {
    const slope = P.maxDepthSlope;
    for (let pass = 0; pass < 8; pass++) {
      topDepth.forEach((d, id) => {
        const ds = (slope * legLen[id]) / nS;
        for (let j = 1; j <= nS; j++) d[j] = Math.max(d[j], d[j - 1] - ds);
        for (let j = 0; j <= nS; j++) d[j] = Math.min(d[j], depthCap[id][j]);
      });
      let top = -Infinity;
      topDepth.forEach((d) => (top = Math.max(top, d[nS])));
      topDepth.forEach((d) => (d[nS] = top));
    }
  };
  limitSlope();
  const depthAt = (id: number, sigma: number) => {
    const f = Math.min(nS - 1e-9, Math.max(0, sigma) * nS);
    const j = Math.floor(f);
    return topDepth[id][j] + (topDepth[id][j + 1] - topDepth[id][j]) * (f - j);
  };

  // Closed mid surface
  const closedMid = (i: number, g: number, kReal: number, out: THREE.Vector3): THREE.Vector3 => {
    const base = g * LEAFLET_ROWS;
    const k0 = Math.min(LEAFLET_ROWS - 2, Math.floor(kReal)), f = kReal - k0;
    const start = zoneStartRow[i][g];
    const startK0 = Math.min(LEAFLET_ROWS - 2, Math.floor(start)), startF = start - startK0;
    const z = zoneLen[i][g], L = lenOf(i, g);
    const arc = arcs[i][base + k0] + (arcs[i][base + k0 + 1] - arcs[i][base + k0]) * f;
    const id = columnLeg[i][g], sigma = columnSigma[i][g];
    const top = zonePlan(i, g, 0);
    const dTop = depthAt(id, sigma);
    if (kReal >= start) {
      const l = arc - (L - z);
      const t = Math.max(0, Math.min(1, l / z));
      const q = zonePlan(i, g, t);
      const kappa = kappaAt(sigma);
      const slant = kappa * legScale[id] * (a0 + o0);
      const cosF = z / Math.hypot(z, slant);
      return fromPlan(q[0], q[1], dTop + l * cosF, out);
    }
    // body: h² up to the top of the zone
    const h = kReal / Math.max(1e-6, start);
    const w = h * h;
    const mid = midOf[i].mid;
    const m0 = (base + k0) * 3, s0 = (base + startK0) * 3;
    const tp = fromPlan(top[0], top[1], dTop, new THREE.Vector3());
    const rx = mid[m0] + (mid[m0 + 3] - mid[m0]) * f, ry = mid[m0 + 1] + (mid[m0 + 4] - mid[m0 + 1]) * f, rz = mid[m0 + 2] + (mid[m0 + 5] - mid[m0 + 2]) * f;
    const sx = mid[s0] + (mid[s0 + 3] - mid[s0]) * startF, sy = mid[s0 + 1] + (mid[s0 + 4] - mid[s0 + 1]) * startF, sz = mid[s0 + 2] + (mid[s0 + 5] - mid[s0 + 2]) * startF;
    return out.set(rx + w * (tp.x - sx), ry + w * (tp.y - sy), rz + w * (tp.z - sz));
  };

  // Chordae limit: deepens the line where the chord would become too long
  const inValve = chordae.filter((b) => valve.some((l) => l.mesh === b.leafletMesh));
  const anchorWork = new THREE.Vector3();
  for (let it = 0; it < 24; it++) {
    const bump = topDepth.map(() => new Float64Array(nS + 1));
    let worst = 0;
    for (const b of inValve) {
      const i = valve.findIndex((l) => l.mesh === b.leafletMesh);
      const col = Math.floor(b.leafletVIdx / LEAFLET_ROWS), row = b.leafletVIdx % LEAFLET_ROWS;
      const g = col % LEAFLET_COLS;
      closedMid(i, g, row, anchorWork).add(b.tipOffset);
      const a = toPlan(anchorWork);
      const r = toPlan(b.basePos);
      const limit = P.chordLimit * b.restLen;
      const planD = Math.hypot(a[0] - r[0], a[1] - r[1]);
      const dist = Math.hypot(planD, a[2] - r[2]);
      if (dist <= limit) continue;
      const need = r[2] - Math.sqrt(Math.max(0, limit * limit - planD * planD));
      const delta = need - a[2];
      if (delta <= 0) continue;
      worst = Math.max(worst, delta);
      const id = columnLeg[i][g], sig = columnSigma[i][g];
      for (let j = 0; j <= nS; j++) {
        const s = j / nS;
        const w = Math.exp(-(((s - sig) / 0.3) ** 2));
        bump[id][j] = Math.max(bump[id][j], delta * w);
      }
    }
    if (worst < 1e-5) break;
    topDepth.forEach((d, id) => { for (let j = 0; j <= nS; j++) d[j] += bump[id][j]; });
    limitSlope();
  }
  // The final line is smoothed, to avoid steps in the short columns where a chord deepened it
  for (let it = 0; it < P.depthFinalSmooth; it++) topDepth.forEach(smooth);
  // Near the apex the depth becomes uniform: columns very close in plan cannot undulate
  topDepth.forEach((d) => {
    const j0 = Math.floor(P.apexFlatStart * nS);
    const end = d[nS], start = d[j0];
    for (let j = j0; j < nS; j++) {
      const f = (j - j0) / (nS - j0);
      d[j] = start + (end - start) * f * f * (3 - 2 * f);
    }
  });
  const chordExcessMm: Array<{ name: string; excessMm: number }> = [];
  for (const b of inValve) {
    const i = valve.findIndex((l) => l.mesh === b.leafletMesh);
    const col = Math.floor(b.leafletVIdx / LEAFLET_ROWS), row = b.leafletVIdx % LEAFLET_ROWS;
    closedMid(i, col % LEAFLET_COLS, row, anchorWork).add(b.tipOffset);
    const excess = anchorWork.distanceTo(b.basePos) - P.chordLimit * b.restLen;
    if (excess > 1e-4) chordExcessMm.push({ name: b.chordaName, excessMm: excess * S });
  }

  // Per-vertex field: closed mid surface + half-thickness along the closed normal; at the hinge the thickness follows that of rest
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
  const rm = new THREE.Vector3(), rn = new THREE.Vector3(), rdg = new THREE.Vector3(), rdk = new THREE.Vector3(), off = new THREE.Vector3(), n = new THREE.Vector3();
  // Closed surface, rounded by Laplacian smoothing (the hinge, row 0, stays fixed)
  const closedGrid = valve.map((_, i) => {
    const q = new Float64Array(nG * 3);
    for (let g = 0; g < LEAFLET_COLS; g++) for (let k = 0; k < LEAFLET_ROWS; k++) closedMid(i, g, k, a).toArray(q, (g * LEAFLET_ROWS + k) * 3);
    const lapPass = (select: (g: number, k: number) => boolean) => {
      const prev = Float64Array.from(q);
      const at = (g: number, k: number, c0: number) => prev[(Math.max(0, Math.min(LEAFLET_COLS - 1, g)) * LEAFLET_ROWS + Math.max(0, Math.min(LEAFLET_ROWS - 1, k))) * 3 + c0];
      for (let g = 0; g < LEAFLET_COLS; g++) for (let k = 1; k < LEAFLET_ROWS; k++) {
        if (!select(g, k)) continue;
        for (let c0 = 0; c0 < 3; c0++) {
          const lap = (at(g - 1, k, c0) + at(g + 1, k, c0) + at(g, k - 1, c0) + at(g, k + 1, c0)) / 4 - at(g, k, c0);
          q[(g * LEAFLET_ROWS + k) * 3 + c0] += 0.5 * lap;
        }
      }
    };
    for (let pass = 0; pass < P.smoothPasses; pass++) lapPass(() => true);
    // the V crease at the apex is the only fold between columns: it receives extra smoothing
    if (!isMitral) for (let pass = 0; pass < P.apexExtraSmooth; pass++) lapPass((g, k) => Math.abs(g - APEX_COL) <= 3 && k >= 8);
    return q;
  });
  valve.forEach((spec, i) => {
    const rest = spec.mesh.userData.restPositions as Float32Array;
    const q = closedGrid[i], { mid, off: restOff } = midOf[i];
    const field = new Float32Array(rest.length);
    for (let g = 0; g < LEAFLET_COLS; g++) for (let k = 0; k < LEAFLET_ROWS; k++) {
      const gm = Math.max(0, g - 1), gp = Math.min(LEAFLET_COLS - 1, g + 1), km = Math.max(0, k - 1), kp = Math.min(LEAFLET_ROWS - 1, k + 1);
      gridV(q, gp, k, a).sub(gridV(q, gm, k, b));
      gridV(q, g, kp, c).sub(gridV(q, g, km, d));
      n.crossVectors(a, c);
      if (n.lengthSq() < 1e-16) n.copy(normal);
      n.normalize();
      gridV(mid, gp, k, rdg).sub(gridV(mid, gm, k, rn));
      gridV(mid, g, kp, rdk).sub(gridV(mid, g, km, rn));
      rn.crossVectors(rdg, rdk);
      gridV(restOff, g, k, off);
      // at the folds the half-thickness is smaller than the local radius, so the faces do not cross each other
      const spacing = Math.min(a.length() / Math.max(1, gp - gm), c.length() / Math.max(1, kp - km));
      const halfT = Math.min(off.length(), Math.max(0.2 * off.length(), P.thicknessRadiusRatio * spacing));
      if (rn.dot(off) < 0) n.negate();
      const h = k / Math.max(1, zoneStartRow[i][g]);
      const w = Math.min(1, h * h * (3 - 2 * h));
      gridV(q, g, k, rm);
      for (const face of [0, 1]) {
        const col = g + face * LEAFLET_COLS;
        const v = (col * LEAFLET_ROWS + k) * 3;
        const sgn = face === 0 ? 1 : -1;
        const tx = off.x * (1 - w) + n.x * halfT * w, ty = off.y * (1 - w) + n.y * halfT * w, tz = off.z * (1 - w) + n.z * halfT * w;
        field[v] = rm.x + sgn * tx - rest[v];
        field[v + 1] = rm.y + sgn * ty - rest[v + 1];
        field[v + 2] = rm.z + sgn * tz - rest[v + 2];
      }
    }
    spec.closeField = field;
  });

  return {
    isMitral,
    center,
    normal,
    e1,
    e2,
    apex,
    commissures: commissures.map((c0) => [c0.x, c0.y] as [number, number]),
    topDepthMm: topDepth.map((x) => x.map((v) => v * S)),
    topLeaflet,
    leaflets: valve,
    columnLeg,
    columnSigma,
    zoneStartRow,
    chordExcessMm,
  };
}

export function setupValvarKinematics(sceneClone: THREE.Group): ValvarKinematicsData | null {
  const chordaMapping = chordaMappingRaw as any[];
  if (!sceneClone || !chordaMapping || chordaMapping.length !== 30) {
    return null;
  }

  const allMeshes: Record<string, THREE.Mesh> = {};
  sceneClone.traverse((child: any) => {
    if (child && child.isMesh && child.name) {
      allMeshes[child.name] = child;
    }
  });

  const leafletNames = [
    'mitral_anterior_leaflet',
    'mitral_posterior_leaflet',
    'tricuspid_anterior_leaflet',
    'tricuspid_posterior_leaflet',
    'tricuspid_septal_leaflet'
  ];

  const mAnnulus = allMeshes['mitral_annulus'];
  const tAnnulus = allMeshes['tricuspid_annulus'];
  const annuli: THREE.Mesh[] = [];
  if (mAnnulus) annuli.push(mAnnulus);
  if (tAnnulus) annuli.push(tAnnulus);

  annuli.forEach(a => {
    a.userData.isStatic = true;
    a.userData.isStructure = true;
    a.userData.isAnnulus = true;
  });

  const mCenter = mAnnulus ? getMeshLocalCenter(mAnnulus) : new THREE.Vector3(0.318, 0.750, -0.180);
  const tCenter = tAnnulus ? getMeshLocalCenter(tAnnulus) : new THREE.Vector3(-0.468, 0.650, 0.180);

  const mAnt = allMeshes['mitral_anterior_leaflet'];
  const mPost = allMeshes['mitral_posterior_leaflet'];
  const tAnt = allMeshes['tricuspid_anterior_leaflet'];
  const tPost = allMeshes['tricuspid_posterior_leaflet'];
  const tSep = allMeshes['tricuspid_septal_leaflet'];

  // D18: radial scaling on load of the mid surface mid(g, k) of the tricuspid leaflets from the hinge mid(g, 0),
  // preserving the physical half-thickness off(g, k) (idempotent over glbOriginalPositions).
  const tricuspidScaleMap = TRICUSPID_TENTING_TRANSFORM.leafletRadialScale as Record<string, number>;
  for (const tName of ['tricuspid_anterior_leaflet', 'tricuspid_posterior_leaflet', 'tricuspid_septal_leaflet']) {
    const tMesh = allMeshes[tName];
    if (!tMesh) continue;
    tMesh.geometry = tMesh.geometry.clone();
    const pos = tMesh.geometry.attributes.position as THREE.BufferAttribute;
    let glbOrig = tMesh.userData.glbOriginalPositions as Float32Array | undefined;
    if (!glbOrig) {
      glbOrig = new Float32Array(pos.array as Float32Array);
      tMesh.userData.glbOriginalPositions = glbOrig;
    }
    const arr = pos.array as Float32Array;
    arr.set(glbOrig);
    const sc = TRICUSPID_TENTING_TRANSFORM_ENABLED ? (tricuspidScaleMap[tName] ?? 1) : 1;
    if (sc !== 1 && pos.count === 2 * LEAFLET_COLS * LEAFLET_ROWS) {
      for (let g = 0; g < LEAFLET_COLS; g++) {
        const i0a = (g * LEAFLET_ROWS + 0) * 3;
        const i0b = ((g + LEAFLET_COLS) * LEAFLET_ROWS + 0) * 3;
        const h0x = 0.5 * (glbOrig[i0a] + glbOrig[i0b]);
        const h0y = 0.5 * (glbOrig[i0a + 1] + glbOrig[i0b + 1]);
        const h0z = 0.5 * (glbOrig[i0a + 2] + glbOrig[i0b + 2]);
        for (let k = 1; k < LEAFLET_ROWS; k++) {
          const ia = (g * LEAFLET_ROWS + k) * 3;
          const ib = ((g + LEAFLET_COLS) * LEAFLET_ROWS + k) * 3;
          const mx = 0.5 * (glbOrig[ia] + glbOrig[ib]);
          const my = 0.5 * (glbOrig[ia + 1] + glbOrig[ib + 1]);
          const mz = 0.5 * (glbOrig[ia + 2] + glbOrig[ib + 2]);
          const ox = 0.5 * (glbOrig[ia] - glbOrig[ib]);
          const oy = 0.5 * (glbOrig[ia + 1] - glbOrig[ib + 1]);
          const oz = 0.5 * (glbOrig[ia + 2] - glbOrig[ib + 2]);
          const nmx = h0x + sc * (mx - h0x);
          const nmy = h0y + sc * (my - h0y);
          const nmz = h0z + sc * (mz - h0z);
          arr[ia] = nmx + ox;
          arr[ia + 1] = nmy + oy;
          arr[ia + 2] = nmz + oz;
          arr[ib] = nmx - ox;
          arr[ib + 1] = nmy - oy;
          arr[ib + 2] = nmz - oz;
        }
      }
    }
    pos.needsUpdate = true;
  }

  const eMA = mAnt ? getFreeEdgeCentroid(mAnt) : null;
  const eMP = mPost ? getFreeEdgeCentroid(mPost) : null;
  const midM = (eMA && eMP) ? new THREE.Vector3().addVectors(eMA.centroid, eMP.centroid).multiplyScalar(0.5) : mCenter;

  const eTA = tAnt ? getFreeEdgeCentroid(tAnt) : null;
  const eTP = tPost ? getFreeEdgeCentroid(tPost) : null;
  const eTS = tSep ? getFreeEdgeCentroid(tSep) : null;
  const midT = (eTA && eTP && eTS) ? new THREE.Vector3().add(eTA.centroid).add(eTP.centroid).add(eTS.centroid).divideScalar(3.0) : tCenter;

  const leaflets: LeafletSpec[] = [];
  for (let lIdx = 0; lIdx < leafletNames.length; lIdx++) {
    const lName = leafletNames[lIdx];
    const mesh = allMeshes[lName];
    if (!mesh) continue;

    mesh.geometry = mesh.geometry.clone();
    const pos = mesh.geometry.attributes.position;
    mesh.userData.restPositions = new Float32Array(pos.array);
    mesh.userData.isProceduralValvar = true;
    mesh.userData.isStatic = false;

    const isMitral = lName.includes('mitral');
    const aCenter = isMitral ? mCenter : tCenter;
    const coaptMid = isMitral ? midM : midT;
    const edgeData = isMitral
      ? (lName === 'mitral_anterior_leaflet' ? eMA : eMP)
      : (lName === 'tricuspid_anterior_leaflet' ? eTA : lName === 'tricuspid_posterior_leaflet' ? eTP : eTS);

    const c = getMeshLocalCenter(mesh);

    // Diastolic opening vector (outward and downward into the ventricle)
    const openDir = new THREE.Vector3().subVectors(c, aCenter);
    openDir.y = 0;
    openDir.normalize();
    openDir.y = -0.70;
    openDir.normalize();

    // Systolic closing vector (toward the center of the coaptation line)
    const edgeC = edgeData ? edgeData.centroid : c;
    const closeDir = new THREE.Vector3().subVectors(coaptMid, edgeC);
    closeDir.normalize();

    const minY = edgeData ? edgeData.minY : 0;
    const maxY = edgeData ? edgeData.maxY : 1;
    const height = edgeData ? edgeData.height : 1;

    leaflets.push({
      mesh,
      name: lName,
      isMitral,
      minY,
      maxY,
      height,
      openDir,
      closeDir,
      openD: VALVAR_OPEN_SCALE[lName] ?? 0.050,
      closeD: VALVAR_CLOSE_SCALE[lName] ?? 0.070
    });
  }

  // Papillary muscles remain 100% rigid/static
  const papillaries: THREE.Mesh[] = [];
  const papillaryNames = [
    'mitral_anterolateral_papillary_muscle',
    'mitral_posteromedial_papillary_muscle',
    'tricuspid_anterior_papillary_muscle',
    'tricuspid_posterior_papillary_muscle',
    'tricuspid_septal_papillary_muscle'
  ];
  papillaryNames.forEach(pName => {
    const pMesh = allMeshes[pName];
    if (pMesh) {
      pMesh.userData.isStatic = true;
      pMesh.userData.isStructure = true;
      pMesh.userData.isPapillary = true;
      papillaries.push(pMesh);
    }
  });

  // Explicit binding of the 30 chordae tendineae
  const chordae: ChordaBinding[] = [];
  for (let mIdx = 0; mIdx < chordaMapping.length; mIdx++) {
    const m = chordaMapping[mIdx];
    const cMesh = allMeshes[m.chordaName];
    const lMesh = allMeshes[m.leafletName];
    const pMesh = allMeshes[m.papillaryName];

    if (!cMesh || !lMesh || !pMesh) continue;

    cMesh.geometry = cMesh.geometry.clone();
    const pos = cMesh.geometry.attributes.position;
    let cGlbOrig = cMesh.userData.glbOriginalPositions as Float32Array | undefined;
    if (!cGlbOrig) {
      cGlbOrig = new Float32Array(pos.array as Float32Array);
      cMesh.userData.glbOriginalPositions = cGlbOrig;
    }
    const cArr = pos.array as Float32Array;
    cArr.set(cGlbOrig);
    cMesh.userData.restPositions = new Float32Array(cArr);
    cMesh.userData.isProceduralValvar = true;
    cMesh.userData.isStatic = false;

    const basePos = new THREE.Vector3(m.baseRestPos.x, m.baseRestPos.y, m.baseRestPos.z);
    const tipPos = new THREE.Vector3(m.tipRestPos.x, m.tipRestPos.y, m.tipRestPos.z);

    const strandAxis = new THREE.Vector3().subVectors(tipPos, basePos);
    let restLen = strandAxis.length();
    strandAxis.normalize();

    const vCoords = new THREE.Vector3();
    const axialT = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      vCoords.fromBufferAttribute(pos, i);
      const s = new THREE.Vector3().subVectors(vCoords, basePos).dot(strandAxis);
      axialT[i] = Math.max(0, Math.min(1, s / (restLen || 1)));
    }

    const lRest = lMesh.userData.restPositions as Float32Array;
    const lv3 = m.leafletVIdx * 3;
    if (TRICUSPID_TENTING_TRANSFORM_ENABLED && m.chordaName.startsWith('tricuspid_')) {
      const lGlbOrig = (lMesh.userData.glbOriginalPositions as Float32Array | undefined) ?? lRest;
      if (TRICUSPID_TENTING_TRANSFORM.stretchChordMeshToScaledLeafletInRest) {
        const dx = lRest[lv3] - lGlbOrig[lv3];
        const dy = lRest[lv3 + 1] - lGlbOrig[lv3 + 1];
        const dz = lRest[lv3 + 2] - lGlbOrig[lv3 + 2];
        for (let i = 0; i < pos.count; i++) {
          const t = axialT[i];
          const g = t * t * (3.0 - 2.0 * t);
          const i3 = i * 3;
          cArr[i3] = cGlbOrig[i3] + dx * g;
          cArr[i3 + 1] = cGlbOrig[i3 + 1] + dy * g;
          cArr[i3 + 2] = cGlbOrig[i3 + 2] + dz * g;
        }
        pos.needsUpdate = true;
        cMesh.userData.restPositions = new Float32Array(cArr);
        tipPos.fromBufferAttribute(pos, m.tipIdx);
      }
      const litMm = (TRICUSPID_TENTING_TRANSFORM.chordRestLengthMmByLeaflet as Record<string, number>)[m.leafletName];
      if (typeof litMm === 'number' && litMm > 0) {
        restLen = litMm / GLTF_SCALE_MM_PER_UNIT;
      }
    }
    const leafRestAnchor = new THREE.Vector3(lRest[lv3], lRest[lv3 + 1], lRest[lv3 + 2]);
    const tipOffset = new THREE.Vector3().subVectors(tipPos, leafRestAnchor);

    chordae.push({
      chordaMesh: cMesh,
      leafletMesh: lMesh,
      papillaryMesh: pMesh,
      chordaName: m.chordaName,
      leafletName: m.leafletName,
      papillaryName: m.papillaryName,
      chamber: m.chamber,
      baseIdx: m.baseIdx,
      tipIdx: m.tipIdx,
      leafletVIdx: m.leafletVIdx,
      basePos,
      tipPos,
      restLen,
      axialT,
      restGapTip: m.tipLeafletGap,
      tipOffset
    });
  }

  const coaptation: ValvarCoaptationInfo[] = [];
  if (tAnnulus) {
    const info = buildCoaptationField(leaflets.filter((l) => !l.isMitral), chordae, tAnnulus, false);
    if (info) coaptation.push(info);
  }
  if (mAnnulus) {
    const info = buildCoaptationField(leaflets.filter((l) => l.isMitral), chordae, mAnnulus, true);
    if (info) coaptation.push(info);
  }

  return {
    leaflets,
    chordae,
    annuli,
    papillaries,
    coaptation,
    _leafPosCur: new THREE.Vector3(),
    _leafPosRest: new THREE.Vector3(),
    _tipDelta: new THREE.Vector3(),
    _vTmp1: new THREE.Vector3(),
    _vTmp2: new THREE.Vector3(),
    _vTmp3: new THREE.Vector3()
  };
}

export function applyValvarDeformation(
  valvarData: ValvarKinematicsData | null,
  zMitral: number,
  zTricuspid: number
): void {
  if (!valvarData) return;

  const zm = Math.max(0, Math.min(1, zMitral));
  const zt = Math.max(0, Math.min(1, zTricuspid));

  const leaflets = valvarData.leaflets;
  for (let sIdx = 0; sIdx < leaflets.length; sIdx++) {
    const spec = leaflets[sIdx];
    const z = spec.isMitral ? zm : zt;
    const pos = spec.mesh.geometry.attributes.position;
    const rest = spec.mesh.userData.restPositions as Float32Array;
    const arr = pos.array as Float32Array;

    const openD = spec.openD;
    const closeD = spec.closeD;
    const ox = spec.openDir.x, oy = spec.openDir.y, oz = spec.openDir.z;
    const cx = spec.closeDir.x, cy = spec.closeDir.y, cz = spec.closeDir.z;

    const rigOffset = spec.rigOffset ?? null;
    const field = spec.closeField ?? null;
    const zc = 1.0 - z;
    for (let i = 0; i < pos.count; i++) {
      const i3 = i * 3;
      const rx = rest[i3];
      const ry = rest[i3 + 1];
      const rz = rest[i3 + 2];

      const normY = Math.max(0, Math.min(1, (spec.maxY - ry) / spec.height));
      const hingeWeight = normY * normY;
      const dOpen = z * openD * hingeWeight;

      if (field) {
        arr[i3]     = rx + ox * dOpen + zc * field[i3];
        arr[i3 + 1] = ry + oy * dOpen + zc * field[i3 + 1];
        arr[i3 + 2] = rz + oz * dOpen + zc * field[i3 + 2];
      } else {
        const dClose = zc * closeD * hingeWeight;
        arr[i3]     = rx + (ox * dOpen + cx * dClose);
        arr[i3 + 1] = ry + (oy * dOpen + cy * dClose);
        arr[i3 + 2] = rz + (oz * dOpen + cz * dClose);
      }
      if (rigOffset) {
        arr[i3] += rigOffset[i3];
        arr[i3 + 1] += rigOffset[i3 + 1];
        arr[i3 + 2] += rigOffset[i3 + 2];
      }
    }
    pos.needsUpdate = true;
  }

  const chordae = valvarData.chordae;
  for (let bIdx = 0; bIdx < chordae.length; bIdx++) {
    const b = chordae[bIdx];
    const lPosArr = b.leafletMesh.geometry.attributes.position.array as Float32Array;
    const lRestArr = b.leafletMesh.userData.restPositions as Float32Array;

    const lv3 = b.leafletVIdx * 3;
    valvarData._leafPosCur.set(lPosArr[lv3], lPosArr[lv3 + 1], lPosArr[lv3 + 2]);
    valvarData._leafPosRest.set(lRestArr[lv3], lRestArr[lv3 + 1], lRestArr[lv3 + 2]);
    valvarData._tipDelta.subVectors(valvarData._leafPosCur, valvarData._leafPosRest);
    // Phase 4c: the rig displacement reaches the chordae through the node matrix, not through here
    const lOffset = (b.leafletMesh.userData.rigOffset ?? null) as Float32Array | null;
    if (lOffset) {
      valvarData._tipDelta.x -= lOffset[lv3];
      valvarData._tipDelta.y -= lOffset[lv3 + 1];
      valvarData._tipDelta.z -= lOffset[lv3 + 2];
    }

    const cPos = b.chordaMesh.geometry.attributes.position;
    const cRest = b.chordaMesh.userData.restPositions as Float32Array;
    const cArr = cPos.array as Float32Array;
    const axialT = b.axialT;

    const dx = valvarData._tipDelta.x;
    const dy = valvarData._tipDelta.y;
    const dz = valvarData._tipDelta.z;

    for (let i = 0; i < cPos.count; i++) {
      const i3 = i * 3;
      const t = axialT[i];
      const g = t * t * (3.0 - 2.0 * t);
      cArr[i3]     = cRest[i3]     + dx * g;
      cArr[i3 + 1] = cRest[i3 + 1] + dy * g;
      cArr[i3 + 2] = cRest[i3 + 2] + dz * g;
    }
    const bo = b.baseOffset;
    if (bo && (bo[0] !== 0 || bo[1] !== 0 || bo[2] !== 0)) {
      for (let i = 0; i < cPos.count; i++) {
        const i3 = i * 3;
        const t = axialT[i];
        const k = 1.0 - t * t * (3.0 - 2.0 * t);
        cArr[i3] += bo[0] * k;
        cArr[i3 + 1] += bo[1] * k;
        cArr[i3 + 2] += bo[2] * k;
      }
    }
    cPos.needsUpdate = true;
  }
}

const _freeA = new THREE.Vector3();
const _freeB = new THREE.Vector3();

/** Largest gap from the free edge (row 15, both faces) to the nearest vertex of the neighboring leaflets, in the parent space; in model units */
function largestFreeEdgeGap(valve: LeafletSpec[]): number {
  let largest = 0;
  const NCOL = 2 * LEAFLET_COLS;
  valve.forEach((a, ia) => {
    a.mesh.updateMatrix();
    const pa = a.mesh.geometry.attributes.position;
    for (let col = 0; col < NCOL; col++) {
      _freeA.fromBufferAttribute(pa, col * LEAFLET_ROWS + LEAFLET_ROWS - 1).applyMatrix4(a.mesh.matrix);
      let nearest = Infinity;
      valve.forEach((b, ib) => {
        if (ib === ia) return;
        b.mesh.updateMatrix();
        const pb = b.mesh.geometry.attributes.position;
        for (let v = 0; v < pb.count; v++) {
          _freeB.fromBufferAttribute(pb, v).applyMatrix4(b.mesh.matrix);
          const d = _freeA.distanceToSquared(_freeB);
          if (d < nearest) nearest = d;
        }
      });
      if (nearest > largest) largest = nearest;
    }
  });
  return Math.sqrt(largest);
}

/** Area (mm²) inside the hinge contour not covered by the leaflets, projected onto its plane; 0.2 mm grid */
function projectedOrificeMm2(valve: LeafletSpec[]): number {
  const S = GLTF_SCALE_MM_PER_UNIT;
  const step = 0.2 / S;
  const NCOL = 2 * LEAFLET_COLS;
  const pts: THREE.Vector3[] = [];
  valve.forEach((l) => {
    l.mesh.updateMatrix();
    const p = l.mesh.geometry.attributes.position;
    for (let col = 0; col < NCOL; col++) pts.push(new THREE.Vector3().fromBufferAttribute(p, col * LEAFLET_ROWS).applyMatrix4(l.mesh.matrix));
  });
  const c = new THREE.Vector3();
  pts.forEach((p) => c.add(p));
  c.multiplyScalar(1 / pts.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of pts) {
    const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const inv = new THREE.Matrix3().set(xx, xy, xz, xy, yy, yz, xz, yz, zz).invert();
  const n = new THREE.Vector3(0.3, 1, 0.2);
  for (let i = 0; i < 64; i++) n.applyMatrix3(inv).normalize();
  const e1 = new THREE.Vector3(1, 0, 0);
  if (Math.abs(e1.dot(n)) > 0.9) e1.set(0, 0, 1);
  e1.addScaledVector(n, -e1.dot(n)).normalize();
  const e2 = new THREE.Vector3().crossVectors(n, e1);
  const NA = 360;
  const rA = new Float64Array(NA).fill(Infinity);
  const toUV = (p: THREE.Vector3): [number, number] => {
    const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    return [dx * e1.x + dy * e1.y + dz * e1.z, dx * e2.x + dy * e2.y + dz * e2.z];
  };
  for (const p of pts) {
    const [u, v] = toUV(p);
    const a = Math.min(NA - 1, Math.floor(((Math.atan2(v, u) + Math.PI) / (2 * Math.PI)) * NA));
    const r = Math.hypot(u, v);
    if (r < rA[a]) rA[a] = r;
  }
  for (let i = 0; i < NA; i++) if (!Number.isFinite(rA[i])) {
    let lo = 1, hi = 1;
    while (!Number.isFinite(rA[(i - lo + NA) % NA]) && lo < NA) lo++;
    while (!Number.isFinite(rA[(i + hi) % NA]) && hi < NA) hi++;
    rA[i] = (rA[(i - lo + NA) % NA] + rA[(i + hi) % NA]) / 2;
  }
  // 0.95: the hinge line lies at the center of the annulus, whose inner contour is about 5% smaller
  const rMax = Math.max(...rA);
  const N = Math.ceil((2 * rMax) / step);
  const inside = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = -rMax + (i + 0.5) * step, y = -rMax + (j + 0.5) * step;
    const a = Math.min(NA - 1, Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * NA));
    if (Math.hypot(x, y) <= 0.95 * rA[a]) inside[j * N + i] = 1;
  }
  const tA = new THREE.Vector3(), tB = new THREE.Vector3(), tC = new THREE.Vector3();
  for (const l of valve) {
    const pos = l.mesh.geometry.attributes.position;
    const idx = l.mesh.geometry.index;
    if (!idx) continue;
    for (let t = 0; t < idx.count; t += 3) {
      const [ax, ay] = toUV(tA.fromBufferAttribute(pos, idx.getX(t)).applyMatrix4(l.mesh.matrix));
      const [bx, by] = toUV(tB.fromBufferAttribute(pos, idx.getX(t + 1)).applyMatrix4(l.mesh.matrix));
      const [cx, cy] = toUV(tC.fromBufferAttribute(pos, idx.getX(t + 2)).applyMatrix4(l.mesh.matrix));
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(den) < 1e-14) continue;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) + rMax) / step)), i1 = Math.min(N - 1, Math.floor((Math.max(ax, bx, cx) + rMax) / step));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) + rMax) / step)), j1 = Math.min(N - 1, Math.floor((Math.max(ay, by, cy) + rMax) / step));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (!inside[j * N + i]) continue;
        const x = -rMax + (i + 0.5) * step, y = -rMax + (j + 0.5) * step;
        const w1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
        const w2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
        if (w1 >= -1e-9 && w2 >= -1e-9 && w1 + w2 <= 1 + 1e-9) inside[j * N + i] = 0;
      }
    }
  }
  let open = 0;
  for (let k = 0; k < N * N; k++) open += inside[k];
  return open * (step * S) ** 2;
}

/**
 * Coaptation by the LARGEST free-edge gap and by the area of the projected orifice. The valve only counts as closed if both pass.
 * The old metric (smallest gap between leaflets) remains in measureValvarCoaptationLegacy.
 */
export function measureValvarCoaptation(valvarData: ValvarKinematicsData | null): {
  mitralGapMm: number;
  tricuspidGapMm: number;
  mitralOrificeMm2: number;
  tricuspidOrificeMm2: number;
  isMitralClosed: boolean;
  isTricuspidClosed: boolean;
} {
  if (!valvarData) {
    return { mitralGapMm: 0, tricuspidGapMm: 0, mitralOrificeMm2: 0, tricuspidOrificeMm2: 0, isMitralClosed: false, isTricuspidClosed: false };
  }
  const mitral = valvarData.leaflets.filter((l) => l.isMitral);
  const tricuspid = valvarData.leaflets.filter((l) => !l.isMitral);
  const mGap = mitral.length === 2 ? largestFreeEdgeGap(mitral) : 0;
  const tGap = tricuspid.length === 3 ? largestFreeEdgeGap(tricuspid) : 0;
  const mOrifice = mitral.length === 2 ? projectedOrificeMm2(mitral) : 0;
  const tOrifice = tricuspid.length === 3 ? projectedOrificeMm2(tricuspid) : 0;
  return {
    mitralGapMm: mGap * GLTF_SCALE_MM_PER_UNIT,
    tricuspidGapMm: tGap * GLTF_SCALE_MM_PER_UNIT,
    mitralOrificeMm2: mOrifice,
    tricuspidOrificeMm2: tOrifice,
    isMitralClosed: mGap < MITRAL_CLOSED_GAP_UNITS && mOrifice <= VALVAR_CLOSED_ORIFICE_MM2,
    isTricuspidClosed: tGap < TRICUSPID_CLOSED_GAP_UNITS && tOrifice <= VALVAR_CLOSED_ORIFICE_MM2,
  };
}

/** Metric prior to D17: smallest gap between the leaflets (anterior-posterior only on the tricuspid). Kept for comparison. */
export function measureValvarCoaptationLegacy(valvarData: ValvarKinematicsData | null): {
  mitralGapMm: number;
  tricuspidGapMm: number;
  isMitralClosed: boolean;
  isTricuspidClosed: boolean;
} {
  if (!valvarData) {
    return { mitralGapMm: 0, tricuspidGapMm: 0, isMitralClosed: false, isTricuspidClosed: false };
  }

  const leaflets = valvarData.leaflets;
  const mAnt = leaflets.find(l => l.name === 'mitral_anterior_leaflet');
  const mPost = leaflets.find(l => l.name === 'mitral_posterior_leaflet');
  const tAnt = leaflets.find(l => l.name === 'tricuspid_anterior_leaflet');
  const tPost = leaflets.find(l => l.name === 'tricuspid_posterior_leaflet');

  let mitralGap = Infinity;
  if (mAnt && mPost) {
    const pA = mAnt.mesh.geometry.attributes.position;
    const pP = mPost.mesh.geometry.attributes.position;
    const cutA = mAnt.minY + 0.35 * mAnt.height;
    const cutP = mPost.minY + 0.35 * mPost.height;
    for (let i = 0; i < pA.count; i++) {
      const yA = pA.getY(i);
      if (yA <= cutA) {
        const xA = pA.getX(i), zA = pA.getZ(i);
        for (let j = 0; j < pP.count; j++) {
          const yP = pP.getY(j);
          if (yP <= cutP) {
            const dx = xA - pP.getX(j);
            const dy = yA - yP;
            const dz = zA - pP.getZ(j);
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < mitralGap) mitralGap = d;
          }
        }
      }
    }
  }

  let tricuspidGap = Infinity;
  if (tAnt && tPost) {
    const pA = tAnt.mesh.geometry.attributes.position;
    const pP = tPost.mesh.geometry.attributes.position;
    const cutA = tAnt.minY + 0.35 * tAnt.height;
    const cutP = tPost.minY + 0.35 * tPost.height;
    // Phase 4c: the free-edge band ignores the rig displacement, otherwise the vertices leave the band without the edge having opened
    const rA = (tAnt.mesh.userData.restPositions as Float32Array | undefined) ?? (pA.array as Float32Array);
    const rP = (tPost.mesh.userData.restPositions as Float32Array | undefined) ?? (pP.array as Float32Array);
    for (let i = 0; i < pA.count; i++) {
      const yA = pA.getY(i);
      if (rA[i * 3 + 1] <= cutA) {
        const xA = pA.getX(i), zA = pA.getZ(i);
        for (let j = 0; j < pP.count; j++) {
          const yP = pP.getY(j);
          if (rP[j * 3 + 1] <= cutP) {
            const dx = xA - pP.getX(j);
            const dy = yA - yP;
            const dz = zA - pP.getZ(j);
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < tricuspidGap) tricuspidGap = d;
          }
        }
      }
    }
  }

  const mGapUnits = mitralGap === Infinity ? 0 : mitralGap;
  const tGapUnits = tricuspidGap === Infinity ? 0 : tricuspidGap;
  const mGapMm = mGapUnits * GLTF_SCALE_MM_PER_UNIT;
  const tGapMm = tGapUnits * GLTF_SCALE_MM_PER_UNIT;

  return {
    mitralGapMm: mGapMm,
    tricuspidGapMm: tGapMm,
    isMitralClosed: mGapUnits < MITRAL_CLOSED_GAP_UNITS,
    isTricuspidClosed: tGapUnits < TRICUSPID_CLOSED_GAP_UNITS
  };
}

export function measureValvarChordae(valvarData: ValvarKinematicsData | null): any[] {
  if (!valvarData) return [];

  return valvarData.chordae.map((b, idx) => {
    const cPos = b.chordaMesh.geometry.attributes.position;
    const lPos = b.leafletMesh.geometry.attributes.position;

    valvarData._vTmp1.fromBufferAttribute(cPos, b.tipIdx);
    valvarData._vTmp2.fromBufferAttribute(cPos, b.baseIdx);
    valvarData._vTmp3.fromBufferAttribute(lPos, b.leafletVIdx);
    // Phase 4c: local metrics compare chord and leaflet without the rig displacement (which is in the chord matrix)
    const lOffset = (b.leafletMesh.userData.rigOffset ?? null) as Float32Array | null;
    if (lOffset) {
      valvarData._vTmp3.x -= lOffset[b.leafletVIdx * 3];
      valvarData._vTmp3.y -= lOffset[b.leafletVIdx * 3 + 1];
      valvarData._vTmp3.z -= lOffset[b.leafletVIdx * 3 + 2];
    }

    const curLen = valvarData._vTmp2.distanceTo(valvarData._vTmp1);
    const lenRatio = curLen / (b.restLen || 1);
    const pctDelta = (lenRatio - 1) * 100;

    const absGapTip = valvarData._vTmp1.distanceTo(valvarData._vTmp3);
    const gapDeltaTip = Math.abs(absGapTip - b.restGapTip);
    const baseShift = valvarData._vTmp2.distanceTo(b.basePos);

    const lRest = b.leafletMesh.userData.restPositions as Float32Array;
    const lv3 = b.leafletVIdx * 3;
    const leafDelta = new THREE.Vector3().subVectors(
      valvarData._vTmp3,
      new THREE.Vector3(lRest[lv3], lRest[lv3 + 1], lRest[lv3 + 2])
    );
    const tipDelta = new THREE.Vector3().subVectors(valvarData._vTmp1, b.tipPos);
    const constraintError = tipDelta.distanceTo(leafDelta);

    return {
      index: idx + 1,
      chordaName: b.chordaName,
      chamber: b.chamber,
      leafletName: b.leafletName,
      papillaryName: b.papillaryName,
      restLenMm: b.restLen * GLTF_SCALE_MM_PER_UNIT,
      curLenMm: curLen * GLTF_SCALE_MM_PER_UNIT,
      pctDelta,
      absGapTipMm: absGapTip * GLTF_SCALE_MM_PER_UNIT,
      gapDeltaTipMm: gapDeltaTip * GLTF_SCALE_MM_PER_UNIT,
      baseShiftMm: baseShift * GLTF_SCALE_MM_PER_UNIT,
      constraintErrorMm: constraintError * GLTF_SCALE_MM_PER_UNIT
    };
  });
}

export function testValvarReversibility(valvarData: ValvarKinematicsData | null, cycles = 1000): number {
  if (!valvarData) return 0;

  applyValvarDeformation(valvarData, 0.0, 0.0);
  const meshesToCheck = [
    ...valvarData.leaflets.map(l => l.mesh),
    ...valvarData.chordae.map(c => c.chordaMesh)
  ];
  const baseline = meshesToCheck.map(m => new Float32Array(m.geometry.attributes.position.array));

  for (let c = 0; c < cycles; c++) {
    applyValvarDeformation(valvarData, Math.random(), Math.random());
  }
  applyValvarDeformation(valvarData, 0.0, 0.0);

  let maxDrift = 0;
  meshesToCheck.forEach((mesh, mIdx) => {
    const pos = mesh.geometry.attributes.position.array as Float32Array;
    const base = baseline[mIdx];
    for (let i = 0; i < pos.length; i += 3) {
      const dx = pos[i] - base[i];
      const dy = pos[i + 1] - base[i + 1];
      const dz = pos[i + 2] - base[i + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > maxDrift) maxDrift = d;
    }
  });

  return maxDrift * GLTF_SCALE_MM_PER_UNIT;
}
