import * as THREE from 'three';

// ============================================================================
// Geometric metrics of the RV and the tricuspid apparatus (pure functions, read-only)
// ----------------------------------------------------------------------------
// All measurements are in model UNITS, in the world space of the loaded scene (the root group of the
// GLB has matrixWorld = identity, the same parent space used in rvContractionComponent).
// Conversion to mm is left to the caller (global scale), so that the tests do not depend on the
// scale.
//
// Definitions (Lang 2015, Table 7, adapted to the mesh):
//  - L axis: from the center of the `tricuspid_annulus` box to the RV vertex farthest from it
//    (same rule as setupRvContraction);
//  - 4C plane: spanned by L and R = (LV axis → origin of the RV node), horizontal, orthogonalized
//    against L;
//  - cavity width at a fraction f of L: along +R, from the end of the LV epicardial envelope
//    (septum) to the last crossing with the RV mesh (free wall); 0 when the free wall lies
//    inside the LV; NaN when the ray does not cross the RV;
//  - RVD1: largest width in the basal third (f ≤ 1/3); RVD2: width at f = 0.5.
// Use: diagnosis and tests. Allocates; do not use per frame.
// ============================================================================

/**
 * Analytical LV profile of the generator (scripts/generate_realistic_heart.js, getPoint):
 * axisymmetric spheroid about the y axis, y ∈ [Y0, Y0 + H], ν = (y − Y0)/H.
 */
export const LV_ANALYTIC_PROFILE = {
  y0: -1.42,
  height: 2.15,
  endoRadius: 0.78,
  wallBase: 0.24,
} as const;

/** Radius of the LV endocardium (epi = false) or epicardium (epi = true) at height y; 0 outside the LV. */
export function lvEnvelopeRadius(y: number, epi: boolean): number {
  const P = LV_ANALYTIC_PROFILE;
  const EPS = 1e-6;
  if (y < P.y0 - EPS || y > P.y0 + P.height + EPS) return 0;
  const nu = Math.min(1, Math.max(0, (y - P.y0) / P.height));
  const sinProf = Math.sin(Math.max(0.06, nu * 0.84 * Math.PI * 0.5 + 0.08));
  const rEndo = P.endoRadius * sinProf;
  return epi ? rEndo + P.wallBase * (0.65 + 0.35 * sinProf) : rEndo;
}

export type LvRegion = 'cavity' | 'wall' | 'outside';

/** Classifies a point relative to the analytical LV envelope. */
export function classifyAgainstLv(p: THREE.Vector3): LvRegion {
  const r = Math.hypot(p.x, p.z);
  const rEpi = lvEnvelopeRadius(p.y, true);
  if (!(rEpi > 0) || r >= rEpi) return 'outside';
  return r < lvEnvelopeRadius(p.y, false) ? 'cavity' : 'wall';
}

// Sampled epicardial profile (dy = 0.0005 units) for the meridional distance; built on demand
let epiProfile: { y: Float64Array; r: Float64Array } | null = null;
function getEpiProfile() {
  if (epiProfile) return epiProfile;
  const P = LV_ANALYTIC_PROFILE;
  const dy = 0.0005;
  const n = Math.round(P.height / dy) + 1;
  const y = new Float64Array(n);
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    y[i] = P.y0 + i * dy;
    r[i] = lvEnvelopeRadius(y[i], true);
  }
  epiProfile = { y, r };
  return epiProfile;
}

/**
 * Signed clearance (units) from the point to the analytical LV epicardium: distance in the meridional plane
 * (r, y) to the curve r = r_epi(y), y ∈ [y0, y0 + H]; negative inside the epicardium. The LV base is open
 * (y > y0 + H counts as outside; the distance goes to the basal edge).
 */
export function lvEpicardialClearance(p: THREE.Vector3): number {
  const prof = getEpiProfile();
  const r = Math.hypot(p.x, p.z);
  let best = Infinity;
  for (let i = 0; i < prof.y.length; i++) {
    const dy = p.y - prof.y[i];
    if (dy > best || -dy > best) continue;
    const d = Math.hypot(r - prof.r[i], dy);
    if (d < best) best = d;
  }
  return classifyAgainstLv(p) === 'outside' ? best : -best;
}

/** AHA wedge (1–17) of the generator that contains the point, by height ν and angle θ = atan2(z, x). */
export function ahaWedgeOf(p: THREE.Vector3): number {
  const P = LV_ANALYTIC_PROFILE;
  const nu = (p.y - P.y0) / P.height;
  let th = Math.atan2(p.z, p.x);
  if (th < 0) th += 2 * Math.PI;
  const sixth = Math.PI / 3;
  if (nu >= 0.68) return 1 + Math.min(5, Math.floor(th / sixth));
  if (nu >= 0.36) return 7 + Math.min(5, Math.floor(th / sixth));
  if (nu >= 0.14) {
    let t2 = th + Math.PI / 12;
    if (t2 >= 2 * Math.PI) t2 -= 2 * Math.PI;
    return 13 + Math.min(3, Math.floor(t2 / (Math.PI / 2)));
  }
  return 17;
}

/** Vertex positions in world space (requires updateMatrixWorld of the scene). */
export function worldPositions(mesh: THREE.Mesh): THREE.Vector3[] {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
  return out;
}

export interface MeshTopology {
  vertices: number;
  weldedVertices: number;
  triangles: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
}

/** Topology after welding coincident vertices (tolerance 1e−4). */
export function meshTopology(mesh: THREE.Mesh): MeshTopology {
  const geom = mesh.geometry;
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  const index = geom.getIndex();
  const keyToId = new Map<string, number>();
  const wid: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    let id = keyToId.get(k);
    if (id === undefined) {
      id = keyToId.size;
      keyToId.set(k, id);
    }
    wid.push(id);
  }
  const triCount = index ? index.count / 3 : pos.count / 3;
  const edges = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    const tri = [0, 1, 2].map((j) => wid[index ? index.getX(t * 3 + j) : t * 3 + j]);
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const n of edges.values()) {
    if (n === 1) boundaryEdges++;
    else if (n > 2) nonManifoldEdges++;
  }
  return { vertices: pos.count, weldedVertices: keyToId.size, triangles: triCount, boundaryEdges, nonManifoldEdges };
}

/** All distances t (along unit dir) at which the ray crosses mesh triangles (Möller–Trumbore, double-sided). */
export function rayHits(mesh: THREE.Mesh, origin: THREE.Vector3, dir: THREE.Vector3): number[] {
  const geom = mesh.geometry;
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  const index = geom.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const pv = new THREE.Vector3();
  const tv = new THREE.Vector3();
  const qv = new THREE.Vector3();
  const hits: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, ib).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, ic).applyMatrix4(mesh.matrixWorld);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    pv.crossVectors(dir, e2);
    const det = e1.dot(pv);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    tv.subVectors(origin, a);
    const u = tv.dot(pv) * inv;
    if (u < 0 || u > 1) continue;
    qv.crossVectors(tv, e1);
    const v = dir.dot(qv) * inv;
    if (v < 0 || u + v > 1) continue;
    hits.push(e2.dot(qv) * inv);
  }
  return hits.sort((x, y) => x - y);
}

export interface RvAxes {
  annulusCenter: THREE.Vector3;
  apex: THREE.Vector3;
  /** unit longitudinal axis (apex → annulus) */
  L: THREE.Vector3;
  /** unit transverse axis of the 4C plane (⊥ L, toward the free wall) */
  R: THREE.Vector3;
  /** annulus → apex length (units) */
  length: number;
}

/** RV axes with the same rules as setupRvContraction (annulus = box center; apex = farthest vertex). */
export function computeRvAxes(rvMesh: THREE.Mesh, annulusMesh: THREE.Mesh): RvAxes {
  const annulusCenter = new THREE.Box3().setFromObject(annulusMesh).getCenter(new THREE.Vector3());
  const pts = worldPositions(rvMesh);
  let apex = pts[0];
  const explicit = rvMesh.geometry.userData?.rvApex as [number, number, number] | undefined;
  if (explicit) {
    // Phase 3b: explicit apex from the generator (endocardial pole); larger horns do not change the L axis
    apex = new THREE.Vector3(explicit[0], explicit[1], explicit[2]).applyMatrix4(rvMesh.matrixWorld);
  } else {
    let best = -1;
    for (const p of pts) {
      const d = p.distanceToSquared(annulusCenter);
      if (d > best) {
        best = d;
        apex = p;
      }
    }
  }
  const L = new THREE.Vector3().subVectors(annulusCenter, apex);
  const length = L.length();
  L.normalize();
  const origin = new THREE.Vector3().setFromMatrixPosition(rvMesh.matrixWorld);
  const R = new THREE.Vector3(origin.x, 0, origin.z).normalize();
  R.addScaledVector(L, -R.dot(L)).normalize();
  return { annulusCenter, apex: apex.clone(), L, R, length };
}

export interface RvStation {
  /** fraction of L from the annulus (0 = annulus, 1 = apex) */
  frac: number;
  /** cavity width (units); 0 if the free wall is inside the LV; NaN if it does not cross the RV */
  width: number;
  /** crossings with the RV mesh along +R from the axis (units, sorted) */
  hits: number[];
}

/** Last t ≤ tMax (starting from tMin) at which the ray point is inside the LV epicardium; NaN if never. */
function lastInsideLv(o: THREE.Vector3, dir: THREE.Vector3, tMin: number, tMax: number): number {
  const step = 0.001;
  const p = new THREE.Vector3();
  const inside = (t: number) => classifyAgainstLv(p.copy(o).addScaledVector(dir, t)) !== 'outside';
  let last = NaN;
  for (let t = tMin; t <= tMax; t += step) if (inside(t)) last = t;
  if (!Number.isFinite(last)) return NaN;
  if (last + step > tMax) return tMax;
  let lo = last;
  let hi = last + step;
  for (let i = 0; i < 30; i++) {
    const m = 0.5 * (lo + hi);
    if (inside(m)) lo = m;
    else hi = m;
  }
  return lo;
}

/** Transverse profile of the RV cavity in the 4C plane, in fractions of L. */
export function rvTransverseProfile(rvMesh: THREE.Mesh, axes: RvAxes, fracs: ReadonlyArray<number>): RvStation[] {
  const back = 3;
  const out: RvStation[] = [];
  for (const frac of fracs) {
    const c = axes.annulusCenter.clone().addScaledVector(axes.L, -frac * axes.length);
    const o = c.clone().addScaledVector(axes.R, -back);
    const hits = rayHits(rvMesh, o, axes.R).map((t) => t - back);
    if (hits.length === 0) {
      out.push({ frac, width: NaN, hits });
      continue;
    }
    const free = hits[hits.length - 1];
    const sept = lastInsideLv(c, axes.R, -2, free);
    const width = Number.isFinite(sept) ? Math.max(0, free - sept) : free - hits[0];
    out.push({ frac, width, hits });
  }
  return out;
}

/** Standard diagnostic stations: f = 0.02; 0.08; …; 0.98. */
export const RV_PROFILE_FRACS: ReadonlyArray<number> = Array.from({ length: 17 }, (_, i) => +(0.02 + 0.06 * i).toFixed(2));

export interface RvChamberMetrics {
  /** RVD1: largest width in the basal third (units; NaN treated as 0) */
  rvd1: number;
  /** RVD2: width at f = 0.5 (units) */
  rvd2: number;
  /** largest width in the middle third (1/3 < f ≤ 2/3) */
  midThirdMax: number;
  /** largest width over the whole profile and its fraction */
  maxWidth: number;
  maxWidthFrac: number;
  /** longitudinal length annulus → apex */
  length: number;
  /** free wall thickness at station f = 0.5: distance between the two outermost crossings if there are two beyond the septum; 0 if single surface */
  freeWallThickness: number;
  stations: RvStation[];
}

export function measureRvChamber(rvMesh: THREE.Mesh, annulusMesh: THREE.Mesh): RvChamberMetrics {
  const axes = computeRvAxes(rvMesh, annulusMesh);
  const stations = rvTransverseProfile(rvMesh, axes, RV_PROFILE_FRACS);
  const w = (s: RvStation) => (Number.isFinite(s.width) ? s.width : 0);
  const basal = stations.filter((s) => s.frac <= 1 / 3);
  const mid = stations.filter((s) => s.frac > 1 / 3 && s.frac <= 2 / 3);
  const at05 = stations.reduce((p, s) => (Math.abs(s.frac - 0.5) < Math.abs(p.frac - 0.5) ? s : p));
  let maxWidth = 0;
  let maxWidthFrac = NaN;
  for (const s of stations) if (w(s) > maxWidth) {
    maxWidth = w(s);
    maxWidthFrac = s.frac;
  }
  // Thickness: at the mid station, crossings beyond the septum (outside the LV) — 1 crossing = single surface
  const c = axes.annulusCenter.clone().addScaledVector(axes.L, -0.5 * axes.length);
  const p = new THREE.Vector3();
  const outer = at05.hits.filter((t) => classifyAgainstLv(p.copy(c).addScaledVector(axes.R, t)) === 'outside' && t > 0);
  const freeWallThickness = outer.length >= 2 ? outer[outer.length - 1] - outer[outer.length - 2] : 0;
  return {
    rvd1: Math.max(...basal.map(w)),
    rvd2: w(at05),
    midThirdMax: Math.max(...mid.map(w)),
    maxWidth,
    maxWidthFrac,
    length: axes.length,
    freeWallThickness,
    stations,
  };
}

export interface LvRegionCounts {
  cavity: number;
  wall: number;
  outside: number;
  total: number;
}

export function countLvRegions(points: ReadonlyArray<THREE.Vector3>): LvRegionCounts {
  const out: LvRegionCounts = { cavity: 0, wall: 0, outside: 0, total: points.length };
  for (const p of points) out[classifyAgainstLv(p)]++;
  return out;
}

/** Count, per AHA wedge, of the points that lie inside the LV epicardium. */
export function countInsideLvByAhaWedge(points: ReadonlyArray<THREE.Vector3>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const p of points) {
    if (classifyAgainstLv(p) === 'outside') continue;
    const k = ahaWedgeOf(p);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export interface RvotMetrics {
  /** highest y of the RV mesh */
  rvTopY: number;
  /** lowest y of the pulmonary trunk */
  trunkMinY: number;
  /** vertical gap trunk − RV (> 0: no continuity, RVOT absent) */
  verticalGap: number;
  /** diameter of the `pulmonary_valve` disc (longest side of the box in the xz plane) */
  pulmonaryDiscDiameter: number;
  /** distance from the center of the pulmonary disc to the nearest RV vertex */
  discToRvDistance: number;
  /** the proximal RVOT is only measurable when the RV mesh reaches the trunk */
  proximalMeasurable: boolean;
}

export function measureRvot(rvMesh: THREE.Mesh, trunkMesh: THREE.Mesh, pulmonaryDisc: THREE.Mesh): RvotMetrics {
  const rv = worldPositions(rvMesh);
  const trunk = worldPositions(trunkMesh);
  let rvTopY = -Infinity;
  for (const p of rv) rvTopY = Math.max(rvTopY, p.y);
  let trunkMinY = Infinity;
  for (const p of trunk) trunkMinY = Math.min(trunkMinY, p.y);
  const box = new THREE.Box3().setFromObject(pulmonaryDisc);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  let discToRvDistance = Infinity;
  for (const p of rv) discToRvDistance = Math.min(discToRvDistance, p.distanceTo(center));
  const verticalGap = trunkMinY - rvTopY;
  return {
    rvTopY,
    trunkMinY,
    verticalGap,
    pulmonaryDiscDiameter: Math.max(size.x, size.z),
    discToRvDistance,
    proximalMeasurable: verticalGap <= 0,
  };
}

/** Center (mean of the vertices, world space) of a mesh. */
export function meshCentroid(mesh: THREE.Mesh): THREE.Vector3 {
  const pts = worldPositions(mesh);
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  return c.multiplyScalar(1 / Math.max(1, pts.length));
}

// ----------------------------------------------------------------------------
// Phase 3: measurements of the procedural RV wall (same conventions: units, world space)
// ----------------------------------------------------------------------------

/** Distance from a point to the mesh surface (point–triangle, minimum over all triangles). */
export function pointToMeshDistance(p: THREE.Vector3, mesh: THREE.Mesh): number {
  const geom = mesh.geometry;
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  const index = geom.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const tri = new THREE.Triangle();
  const q = new THREE.Vector3();
  let best = Infinity;
  for (let t = 0; t < triCount; t++) {
    tri.a.fromBufferAttribute(pos, index ? index.getX(t * 3) : t * 3).applyMatrix4(mesh.matrixWorld);
    tri.b.fromBufferAttribute(pos, index ? index.getX(t * 3 + 1) : t * 3 + 1).applyMatrix4(mesh.matrixWorld);
    tri.c.fromBufferAttribute(pos, index ? index.getX(t * 3 + 2) : t * 3 + 2).applyMatrix4(mesh.matrixWorld);
    tri.closestPointToPoint(p, q);
    const d = q.distanceTo(p);
    if (d < best) best = d;
  }
  return best;
}

/** Base of a papillary muscle: lowest vertex (smallest world y), the same definition as in Phase 2. */
export function papillaryBase(mesh: THREE.Mesh): THREE.Vector3 {
  const pts = worldPositions(mesh);
  let lo = pts[0];
  for (const p of pts) if (p.y < lo.y) lo = p;
  return lo.clone();
}

/**
 * Annulus–wall gap: the annulus is divided into `sectors` angular sectors around its center, in the
 * mid plane (PCA). In each sector, the smallest distance from an annulus vertex to the RV mesh
 * (point–triangle); the gap is the largest of these minima (0 ⇔ the wall touches the annulus in all sectors).
 */
export function annulusWallGap(rvMesh: THREE.Mesh, annulusMesh: THREE.Mesh, sectors = 96): { gap: number; perSector: number[] } {
  const pts = worldPositions(annulusMesh);
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / pts.length);
  const cov = [0, 0, 0, 0, 0, 0];
  for (const p of pts) {
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
  const m = new THREE.Matrix3().set(cov[0], cov[1], cov[2], cov[1], cov[3], cov[4], cov[2], cov[4], cov[5]).invert();
  const n = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 64; i++) n.applyMatrix3(m).normalize();
  const e1 = new THREE.Vector3(1, 0, 0);
  if (Math.abs(e1.dot(n)) > 0.9) e1.set(0, 0, 1);
  e1.addScaledVector(n, -e1.dot(n)).normalize();
  const e2 = new THREE.Vector3().crossVectors(n, e1);
  const rvPts = worldPositions(rvMesh);
  // per sector, the annulus vertex closest to some RV vertex (candidate) and its exact distance
  const cand = new Array<number>(sectors).fill(-1);
  const candD = new Array<number>(sectors).fill(Infinity);
  const d = new THREE.Vector3();
  for (let k = 0; k < pts.length; k++) {
    d.subVectors(pts[k], c);
    let a = Math.atan2(d.dot(e2), d.dot(e1));
    if (a < 0) a += 2 * Math.PI;
    const s = Math.min(sectors - 1, Math.floor((a / (2 * Math.PI)) * sectors));
    let nearV = Infinity;
    for (const q of rvPts) {
      const dd = q.distanceToSquared(pts[k]);
      if (dd < nearV) nearV = dd;
    }
    if (nearV < candD[s]) {
      candD[s] = nearV;
      cand[s] = k;
    }
  }
  const perSector = cand.map((k, s) => (k < 0 ? Infinity : Math.min(Math.sqrt(candD[s]), pointToMeshDistance(pts[k], rvMesh))));
  let gap = 0;
  // Phase 4b: a sector without an annulus vertex is not counted (the annulus affine field alters the angular distribution)
  for (const g of perSector) if (Number.isFinite(g)) gap = Math.max(gap, g);
  return { gap, perSector };
}

/**
 * Direct annulus–wall gap (Phase 4b): largest distance from a vertex of the endocardium entry edge (uv.v = 0,
 * transmural = 0) to the nearest annulus vertex. Independent of the angular distribution of the annulus vertices.
 */
export function entryBorderAnnulusGap(rvMesh: THREE.Mesh, annulusMesh: THREE.Mesh): { maxGap: number; n: number } {
  const uv = rvMesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
  const tr = rvMesh.geometry.getAttribute('transmural') as THREE.BufferAttribute;
  const pts = worldPositions(rvMesh);
  const ann = worldPositions(annulusMesh);
  let maxGap = 0;
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    if (uv.getY(i) !== 0 || tr.getX(i) !== 0) continue;
    n++;
    let best = Infinity;
    for (const a of ann) {
      const d = a.distanceToSquared(pts[i]);
      if (d < best) best = d;
    }
    maxGap = Math.max(maxGap, Math.sqrt(best));
  }
  return { maxGap, n };
}

export interface EdgeOrientation {
  /** welded edges used twice in the same direction (inconsistent orientation) */
  inconsistentEdges: number;
  /** signed volume of the closed solid (> 0: outward normals) */
  signedVolume: number;
}

function weldIds(mesh: THREE.Mesh): { wid: number[]; idPos: THREE.Vector3[] } {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const keyToId = new Map<string, number>();
  const idPos: THREE.Vector3[] = [];
  const wid: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    let id = keyToId.get(k);
    if (id === undefined) {
      id = keyToId.size;
      keyToId.set(k, id);
      idPos.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
    }
    wid.push(id);
  }
  return { wid, idPos };
}

/** Consistency of the triangle orientation (after welding, tolerance 1e−4) and signed volume. */
export function meshOrientation(mesh: THREE.Mesh): EdgeOrientation {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const index = mesh.geometry.getIndex();
  const { wid } = weldIds(mesh);
  const triCount = index ? index.count / 3 : pos.count / 3;
  const directed = new Map<string, number>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cr = new THREE.Vector3();
  let v6 = 0;
  for (let t = 0; t < triCount; t++) {
    const ix = [0, 1, 2].map((j) => (index ? index.getX(t * 3 + j) : t * 3 + j));
    a.fromBufferAttribute(pos, ix[0]).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, ix[1]).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, ix[2]).applyMatrix4(mesh.matrixWorld);
    v6 += a.dot(cr.crossVectors(b, c));
    const w = ix.map((i) => wid[i]);
    if (w[0] === w[1] || w[1] === w[2] || w[0] === w[2]) continue;
    for (let e = 0; e < 3; e++) {
      const k = `${w[e]}>${w[(e + 1) % 3]}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  let inconsistentEdges = 0;
  for (const n of directed.values()) if (n > 1) inconsistentEdges++;
  return { inconsistentEdges, signedVolume: v6 / 6 };
}

/**
 * Boundary loops of the surface formed by the triangles accepted by `keepTri`, as ordered lists
 * of world points (welded vertices). Used in the RV endocardium openings.
 */
export function boundaryLoops(mesh: THREE.Mesh, keepTri: (ia: number, ib: number, ic: number) => boolean): THREE.Vector3[][] {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const index = mesh.geometry.getIndex();
  const { wid, idPos } = weldIds(mesh);
  const triCount = index ? index.count / 3 : pos.count / 3;
  const directed = new Set<string>();
  const edges: Array<[number, number]> = [];
  for (let t = 0; t < triCount; t++) {
    const ix = [0, 1, 2].map((j) => (index ? index.getX(t * 3 + j) : t * 3 + j));
    if (!keepTri(ix[0], ix[1], ix[2])) continue;
    const w = ix.map((i) => wid[i]);
    if (w[0] === w[1] || w[1] === w[2] || w[0] === w[2]) continue;
    for (let e = 0; e < 3; e++) {
      edges.push([w[e], w[(e + 1) % 3]]);
      directed.add(`${w[e]}>${w[(e + 1) % 3]}`);
    }
  }
  const next = new Map<number, number>();
  for (const [p, q] of edges) if (!directed.has(`${q}>${p}`)) next.set(p, q);
  const loops: THREE.Vector3[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: THREE.Vector3[] = [];
    let cur: number | undefined = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      loop.push(idPos[cur].clone());
      cur = next.get(cur);
    }
    loops.push(loop);
  }
  return loops;
}

/** Endocardium of the procedural wall: triangles with all 3 vertices at `transmural` = 0. */
export function rvEndocardialSelector(mesh: THREE.Mesh): (ia: number, ib: number, ic: number) => boolean {
  const tr = mesh.geometry.getAttribute('transmural') as THREE.BufferAttribute | undefined;
  if (!tr) return () => true;
  return (ia, ib, ic) => tr.getX(ia) === 0 && tr.getX(ib) === 0 && tr.getX(ic) === 0;
}

/**
 * Volume of the RV cavity (units³): endocardium of the procedural wall closed by fan caps
 * over each opening (center = mean of the loop). Divergence theorem; independent of the rig.
 */
export function measureRvCavityVolume(rvMesh: THREE.Mesh): { volume: number; openings: number } {
  const pos = rvMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const index = rvMesh.geometry.getIndex();
  const keep = rvEndocardialSelector(rvMesh);
  const triCount = index ? index.count / 3 : pos.count / 3;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cr = new THREE.Vector3();
  let v6 = 0;
  for (let t = 0; t < triCount; t++) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    if (!keep(ia, ib, ic)) continue;
    a.fromBufferAttribute(pos, ia).applyMatrix4(rvMesh.matrixWorld);
    b.fromBufferAttribute(pos, ib).applyMatrix4(rvMesh.matrixWorld);
    c.fromBufferAttribute(pos, ic).applyMatrix4(rvMesh.matrixWorld);
    v6 += a.dot(cr.crossVectors(b, c));
  }
  const loops = boundaryLoops(rvMesh, keep);
  for (const loop of loops) {
    const m = new THREE.Vector3();
    for (const p of loop) m.add(p);
    m.multiplyScalar(1 / loop.length);
    // the cap traverses the loop in the opposite direction to that of the surface boundary
    for (let i = 0; i < loop.length; i++) v6 += m.dot(cr.crossVectors(loop[(i + 1) % loop.length], loop[i]));
  }
  return { volume: Math.abs(v6) / 6, openings: loops.length };
}

/**
 * Coverage of the LV face by the RV: samples the analytical epicardium at θ ∈ [th0, th1] (degrees) and y ∈ [y0, y1]
 * and counts the fraction of points whose radial normal crosses the RV mesh within `maxGap` units of the epicardium
 * (septal layer abutting the LV).
 */
export function lvFaceCoverage(rvMesh: THREE.Mesh, th0: number, th1: number, y0: number, y1: number, nTh = 24, nY = 30, maxGap = 0.05): { fraction: number; covered: number; total: number } {
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  let covered = 0;
  let total = 0;
  for (let i = 0; i < nTh; i++) {
    const th = ((th0 + ((th1 - th0) * (i + 0.5)) / nTh) * Math.PI) / 180;
    for (let j = 0; j < nY; j++) {
      const y = y0 + ((y1 - y0) * (j + 0.5)) / nY;
      const r = lvEnvelopeRadius(y, true);
      if (!(r > 0)) continue;
      total++;
      d.set(Math.cos(th), 0, Math.sin(th));
      o.set(r * d.x, y, r * d.z).addScaledVector(d, -1e-3);
      if (rayHits(rvMesh, o, d).some((t) => t > 0 && t <= maxGap)) covered++;
    }
  }
  return { fraction: total ? covered / total : 0, covered, total };
}

export interface RvRoofMetrics {
  /** fraction of the area of the free epicardium of the roof (v < vLimit) whose normal is less than `angleDeg` from the annulus direction */
  platformFraction: number;
  /** largest dihedral angle (degrees) between neighboring triangles of the free epicardium of the roof */
  maxCreaseDeg: number;
  /** 99th percentile of the dihedral angle (degrees) */
  p99CreaseDeg: number;
}

/**
 * Platform metric of the RV roof: on the free wall epicardium (`transmural` = 1, `septalWeight` > 0.5)
 * with v < vLimit, area facing the annulus (normal nearly parallel to the L axis, toward the base) and maximum crease.
 */
export function rvRoofMetrics(rvMesh: THREE.Mesh, axisToBase: THREE.Vector3, vLimit = 0.45, angleDeg = 25): RvRoofMetrics {
  const geom = rvMesh.geometry;
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  const uv = geom.getAttribute('uv') as THREE.BufferAttribute;
  const w = geom.getAttribute('septalWeight') as THREE.BufferAttribute;
  const tr = geom.getAttribute('transmural') as THREE.BufferAttribute;
  const index = geom.getIndex()!;
  const { wid } = weldIds(rvMesh);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const cosLim = Math.cos((angleDeg * Math.PI) / 180);
  // 3b: only the free half of the loop (the septal strip near the annulus faces the LV, it is not roof)
  const uFree = (geom.userData?.rvFreeWallUStart as number | undefined) ?? -1;
  let total = 0;
  let flat = 0;
  const edgeNormals = new Map<string, THREE.Vector3[]>();
  for (let t = 0; t < index.count; t += 3) {
    const ix = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    if (ix.some((i) => tr.getX(i) !== 1 || w.getX(i) <= 0.5 || uv.getY(i) >= vLimit || uv.getX(i) <= uFree)) continue;
    a.fromBufferAttribute(pos, ix[0]).applyMatrix4(rvMesh.matrixWorld);
    b.fromBufferAttribute(pos, ix[1]).applyMatrix4(rvMesh.matrixWorld);
    c.fromBufferAttribute(pos, ix[2]).applyMatrix4(rvMesh.matrixWorld);
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    const area = 0.5 * n.length();
    if (area < 1e-10) continue;
    n.normalize();
    total += area;
    if (n.dot(axisToBase) >= cosLim) flat += area;
    for (let e = 0; e < 3; e++) {
      const p = wid[ix[e]];
      const q = wid[ix[(e + 1) % 3]];
      const k = p < q ? `${p}_${q}` : `${q}_${p}`;
      const list = edgeNormals.get(k) ?? [];
      list.push(n.clone());
      edgeNormals.set(k, list);
    }
  }
  const angles: number[] = [];
  for (const list of edgeNormals.values()) {
    if (list.length !== 2) continue;
    angles.push((Math.acos(Math.min(1, Math.max(-1, list[0].dot(list[1])))) * 180) / Math.PI);
  }
  angles.sort((x, y) => x - y);
  return {
    platformFraction: total ? flat / total : 0,
    maxCreaseDeg: angles.length ? angles[angles.length - 1] : 0,
    p99CreaseDeg: angles.length ? angles[Math.floor(0.99 * (angles.length - 1))] : 0,
  };
}

/** Point inside a closed mesh: parity of crossings in 3 directions (majority). */
export function pointInsideClosedMesh(mesh: THREE.Mesh, p: THREE.Vector3): boolean {
  const dirs = [new THREE.Vector3(0.577, 0.577, 0.577).normalize(), new THREE.Vector3(-0.3, 0.9, 0.316).normalize(), new THREE.Vector3(0.2, -0.4, 0.894).normalize()];
  let k = 0;
  for (const d of dirs) if (rayHits(mesh, p, d).filter((t) => t > 1e-9).length % 2 === 1) k++;
  return k >= 2;
}
