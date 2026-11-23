import * as THREE from 'three';
import { lvEnvelopeRadius } from './rvGeometryMetrics';

// ============================================================================
// LV metrics (Phase 1, pure functions; read-only; Phase 4d: no function writes a matrix)
// ----------------------------------------------------------------------------
// Pure read-only LV geometric metrics (no function mutates a node matrix).
// Space: that of the wedges' parent (GLB root, matrixWorld = identity), via each node's `mesh.matrix`,
// as in measureLvCavityVolume. LV axis = y axis (x = z = 0). Model units; conversion
// to mm (34.3 mm/u) is left to the caller.
// Wedge convention (generator and watertight regeneration): the 1st half of the vertices is the endocardium and
// vertex i + n/2 is the epicardial pair of vertex i.
// Use: diagnostics and tests. Allocates; do not use per frame.
// ============================================================================

/** AHA bands of the generator (scripts/generate_realistic_heart.js, AHA_SPECS): ν ∈ [nu0, nu1], θ ∈ [th0, th1] (rad). */
export const LV_AHA_WEDGES: ReadonlyArray<{ id: number; nu0: number; nu1: number; th0: number; th1: number }> = [
  ...[0, 1, 2, 3, 4, 5].map((k) => ({ id: 1 + k, nu0: 0.68, nu1: 1.0, th0: (k * Math.PI) / 3, th1: ((k + 1) * Math.PI) / 3 })),
  ...[0, 1, 2, 3, 4, 5].map((k) => ({ id: 7 + k, nu0: 0.36, nu1: 0.68, th0: (k * Math.PI) / 3, th1: ((k + 1) * Math.PI) / 3 })),
  ...[0, 1, 2, 3].map((k) => ({ id: 13 + k, nu0: 0.14, nu1: 0.36, th0: -Math.PI / 12 + (k * Math.PI) / 2, th1: -Math.PI / 12 + ((k + 1) * Math.PI) / 2 })),
  { id: 17, nu0: 0, nu1: 0.14, th0: 0, th1: 2 * Math.PI },
];

const LOCAL_M = new THREE.Matrix4();

/**
  * Local matrix of a node WITHOUT writing to it (regression case A3): with `matrixAutoUpdate = true`, the current TRS
  * composed into a scratch matrix (the rig may have changed `position` without `updateMatrix`); with `false`, the matrix written by the rig (RV, tricuspid
  * apparatus), as is. Before, `mesh.updateMatrix()` recomposed the tricuspid apparatus matrix from the static pose (up to 21.7 mm).
 */
export function localMatrixOf(obj: THREE.Object3D, out: THREE.Matrix4 = LOCAL_M): THREE.Matrix4 {
  if (obj.matrixAutoUpdate) return out.compose(obj.position, obj.quaternion, obj.scale);
  return out.copy(obj.matrix);
}

/** Positions in the parent space (local matrix of `localMatrixOf`; does not alter the node). */
export function parentPositions(mesh: THREE.Mesh): Float64Array {
  const M = localMatrixOf(mesh, new THREE.Matrix4());
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const out = new Float64Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(M);
    out[3 * i] = v.x;
    out[3 * i + 1] = v.y;
    out[3 * i + 2] = v.z;
  }
  return out;
}

const keyOf = (x: number, y: number, z: number, q: number) => `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;

/**
  * Closed cavity volume (u³): endocardial triangles of all wedges + flat caps over each
  * boundary edge of the merged (welded at 1e−4) surface: the basal cap, the apical hole (if any) and the
  * gaps at the T junctions. Each boundary edge (a→b) closes with the triangle (C, b, a), C on the axis and at the
  * height of the edge; for horizontal loops, this is the flat cap of the loop. Reference at the center of the basal
  * ring (highest y of the endocardium), where the basal cap does not contribute.
 */
export function lvClosedCavityVolume(meshes: ReadonlyArray<THREE.Mesh>): { volume: number; boundaryEdges: number; capVolume: number } {
  return lvClosedLayerVolume(meshes, false);
}

/**
  * LV Phase 4: the same closure for the endocardial layer (epi = false) or epicardial layer (epi = true). Translation-invariant
  * wall volume = closed epicardium − closed endocardium (both caps lie on the same top ring).
 */
export function lvClosedLayerVolume(meshes: ReadonlyArray<THREE.Mesh>, epi: boolean): { volume: number; boundaryEdges: number; capVolume: number } {
  const Q = 1e4;
  const idOf = new Map<string, number>();
  const P: number[] = [];
  const tris: number[] = [];
  let baseY = -Infinity;
  for (const m of meshes) {
    const pp = parentPositions(m);
    const idx = m.geometry.getIndex();
    if (!idx) continue;
    const half = pp.length / 6;
    const wid = new Int32Array(pp.length / 3);
    for (let i = 0; i < wid.length; i++) {
      const k = keyOf(pp[3 * i], pp[3 * i + 1], pp[3 * i + 2], Q);
      let id = idOf.get(k);
      if (id === undefined) {
        id = idOf.size;
        idOf.set(k, id);
        P.push(pp[3 * i], pp[3 * i + 1], pp[3 * i + 2]);
      }
      wid[i] = id;
      if (epi ? i >= half : i < half) baseY = Math.max(baseY, pp[3 * i + 1]);
    }
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      if (epi ? a < half || b < half || c < half : a >= half || b >= half || c >= half) continue;
      const wa = wid[a], wb = wid[b], wc = wid[c];
      if (wa === wb || wb === wc || wa === wc) continue;
      tris.push(wa, wb, wc);
    }
  }
  const tet = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) =>
    ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  const rel = (i: number): [number, number, number] => [P[3 * i], P[3 * i + 1] - baseY, P[3 * i + 2]];
  let v6 = 0;
  const directed = new Map<string, number>();
  for (let t = 0; t < tris.length; t += 3) {
    const A = rel(tris[t]), B = rel(tris[t + 1]), C = rel(tris[t + 2]);
    v6 += tet(...A, ...B, ...C);
    for (let e = 0; e < 3; e++) {
      const p = tris[t + e], q = tris[t + ((e + 1) % 3)];
      const k = `${p}>${q}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  let cap6 = 0;
  let boundaryEdges = 0;
  for (const k of directed.keys()) {
    const [p, q] = k.split('>').map(Number);
    if (directed.has(`${q}>${p}`)) continue;
    boundaryEdges++;
    const a = rel(p), b = rel(q);
    const cy = (a[1] + b[1]) / 2;
    cap6 += tet(0, cy, 0, ...b, ...a);
  }
  const total = v6 + cap6;
  return { volume: Math.abs(total) / 6, boundaryEdges, capVolume: (Math.sign(total) * cap6) / 6 };
}

/** Index of the endocardial vertex closest to the central analytic point of the wedge (mean ν and θ; apex: ν = 0.07, θ = π). */
export function lvSegmentCenterIndex(mesh: THREE.Mesh, segId: number): number {
  const w = LV_AHA_WEDGES[segId - 1];
  const nu = 0.5 * (w.nu0 + w.nu1);
  const th = segId === 17 ? Math.PI : 0.5 * (w.th0 + w.th1);
  const y = -1.42 + nu * 2.15;
  const r = lvEnvelopeRadius(y, false);
  const tx = r * Math.cos(th), tz = r * Math.sin(th);
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const half = pos.count / 2;
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < half; i++) {
    const d = (pos.getX(i) - tx) ** 2 + (pos.getY(i) - y) ** 2 + (pos.getZ(i) - tz) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Thickness at the endo↔epi pair (i, i + n/2), in the parent space (u). */
export function lvPairThickness(pp: Float64Array, i: number): number {
  const j = i + pp.length / 6;
  return Math.hypot(pp[3 * j] - pp[3 * i], pp[3 * j + 1] - pp[3 * i + 1], pp[3 * j + 2] - pp[3 * i + 2]);
}

/** Rotation (degrees) of vertex i about the LV axis between two poses; positive = counterclockwise seen from +y. */
export function lvRotationDeg(rest: Float64Array, now: Float64Array, i: number): number {
  let d = Math.atan2(now[3 * i + 2], now[3 * i]) - Math.atan2(rest[3 * i + 2], rest[3 * i]);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return (-d * 180) / Math.PI;
}

/** MAPSE: mean displacement of the annulus vertices along the LV axis (positive = toward the apex), in u. */
export function lvAnnulusDisplacement(rest: Float64Array, now: Float64Array): number {
  let s = 0;
  const n = rest.length / 3;
  for (let i = 0; i < n; i++) s += rest[3 * i + 1] - now[3 * i + 1];
  return n ? s / n : 0;
}

/**
  * Maximum gap (u) between vertices of DIFFERENT wedges that coincide at rest (key 1e−4), in the current pose.
  * `rest[k]` and `now[k]` are the positions in the parent space of wedge k.
 */
export function lvMaxSeamGap(rest: ReadonlyArray<Float64Array>, now: ReadonlyArray<Float64Array>): { gap: number; pair: [number, number] } {
  const owners = new Map<string, Array<[number, number]>>();
  rest.forEach((pp, k) => {
    for (let i = 0; i < pp.length / 3; i++) {
      const key = keyOf(pp[3 * i], pp[3 * i + 1], pp[3 * i + 2], 1e4);
      let l = owners.get(key);
      if (!l) owners.set(key, (l = []));
      l.push([k, i]);
    }
  });
  let gap = 0;
  let pair: [number, number] = [-1, -1];
  for (const l of owners.values()) {
    for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) {
      const [ka, ia] = l[a], [kb, ib] = l[b];
      if (ka === kb) continue;
      const A = now[ka], B = now[kb];
      const d = Math.hypot(A[3 * ia] - B[3 * ib], A[3 * ia + 1] - B[3 * ib + 1], A[3 * ia + 2] - B[3 * ib + 2]);
      if (d > gap) {
        gap = d;
        pair = [Math.min(ka, kb), Math.max(ka, kb)];
      }
    }
  }
  return { gap, pair };
}

/** Current endocardial radius with the per-node scale of HeartMesh17 (sxz·r_endo(y/sy)); 0 outside the LV range. */
export function lvScaledEndoRadius(sxz: number, sy: number): (y: number) => number {
  return (y: number) => sxz * lvEnvelopeRadius(y / sy, false);
}

/**
  * Maximum clearance (u) of the points of a papillary muscle to the endocardium: max (r − r_endo(y)) over the points with r_endo > 0.
  * Positive = some vertex beyond the endocardium (inside the wall); negative = all in the cavity.
 */
export function papillaryEndoClearance(points: Float64Array, endoRadiusAt: (y: number) => number): { max: number; insideWall: number } {
  let max = -Infinity;
  let insideWall = 0;
  for (let i = 0; i < points.length / 3; i++) {
    const y = points[3 * i + 1];
    const re = endoRadiusAt(y);
    if (!(re > 0)) continue;
    const d = Math.hypot(points[3 * i], points[3 * i + 2]) - re;
    if (d > max) max = d;
    if (d > 0) insideWall++;
  }
  return { max, insideWall };
}

/** Base of a papillary muscle (lowest-y vertex) and its signed radial distance to the endocardium (u; > 0 = inside the wall). */
export function papillaryBaseToEndo(points: Float64Array, endoRadiusAt: (y: number) => number): { index: number; signedDistance: number } {
  let lo = 0;
  for (let i = 1; i < points.length / 3; i++) if (points[3 * i + 1] < points[3 * lo + 1]) lo = i;
  const y = points[3 * lo + 1];
  return { index: lo, signedDistance: Math.hypot(points[3 * lo], points[3 * lo + 2]) - endoRadiusAt(y) };
}
