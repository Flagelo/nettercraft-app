import * as THREE from 'three';
import { lvEnvelopeRadius, LV_ANALYTIC_PROFILE } from './rvGeometryMetrics';
import { GLTF_SCALE_MM_PER_UNIT } from './valvarKinematics';

// ============================================================================
// Atrial skinning coupled to the atrioventricular annulus plane
// ----------------------------------------------------------------------------
// The atrium follows the atrioventricular annulus in systole. The code receives the annulus field as a matrix S
// (x' = S·x, in parent space) and the anchors as a list of meshes: for Option A (mitral annulus and LA) it is enough to
// call the same setup with another annulus, another anchor list and another matrix.
//
// Displacement of each vertex (x = rest position in parent space):
//   x' = x + wE·(a − 1)·(x − c) + wA·(S·x − x)
//  1) atrial contraction: scale `a` (atrialContractionScale: 1 − 0.14·eRA in the RA) about the node origin (c), attenuated by wE at the seams;
//  2) annulus: field Δ(x) = S·x − x, evaluated at the REST position (does not depend on `a`).
// The two terms add up over the rest position, so the order between them does not change the result.
// The scale no longer goes into mesh.scale: at eRA = 1 (a = 0.86) it would pull the RA away from the annulus and the SVC by up to 2.8 mm.
//
// Weights (computed only at load, from the position):
//   wA = fH(h)·fR(ρ)·Π fAnchor(d)
//    h: height above the annulus plane along the annulus axis; fH = 1 up to heightStart and decays to 0 at heightEnd (roof).
//       Below the plane fH = 1: the region descends as a block, with no compression along the field (does not invert triangles).
//    ρ: radial distance, in the annulus plane, to the annulus contour (0 inside the contour); fR = 1 up to radialStart, 0 at radialEnd.
//    d: distance to the mesh of each anchor (SVC, LA); fAnchor = 0 up to d0 and 1 from d1 on.
//   wE = 1 − wC, with wC = 1 near the annulus and the anchors marked with `pinScale`.
//
// Floor: the RA sphere descends to ~18 mm below the annulus plane, inside the RV (model artifact). Following the annulus as a block,
// this cap would collide with the chordae and the LV; in systole it is pulled back toward the plane (fraction floorCompression × s, s = systole
// fraction), only below floorOffset, so as not to disturb the contact band.
// ============================================================================

/** Shortening of each atrium at full elastance, in the realistic model */
export const ATRIAL_SCALE_GAIN = 0.14;

/** Contraction scale per chamber: the RA follows eRA and the LA follows eLA (D13). Called every frame, no allocation. */
export function atrialContractionScale(chamber: 'la' | 'ra', hemo: { eLA: number; eRA: number } | null | undefined): number {
  return 1 - ATRIAL_SCALE_GAIN * ((chamber === 'ra' ? hemo?.eRA : hemo?.eLA) ?? 0);
}

export interface AtrialAnchor {
  mesh: THREE.Mesh;
  /** distances (mm) over which the annulus weight goes from 0 to 1 */
  d0: number;
  d1: number;
  /** atrial contraction is also pinned near this anchor */
  pinScale: boolean;
}

export interface AtrialSkinParams {
  /** height (mm) above the annulus plane at which the weight starts to decay and at which it reaches 0 */
  heightStart: number;
  heightEnd: number;
  /** radial distance (mm) to the annulus contour at which the weight starts to decay and at which it reaches 0 */
  radialStart: number;
  radialEnd: number;
  /** distances (mm) to the annulus over which atrial contraction goes from 0 to 1 */
  scalePin0: number;
  scalePin1: number;
  /** minimum clearance (mm) to the LV epicardium; a vertex closer than that at rest does not get any closer than it was */
  lvMargin: number;
  /** floor: fraction of the depth below floorOffset (mm under the annulus plane) pulled back at full systole (0 = no pull-back) */
  floorCompression: number;
  floorOffset: number;
  /**
   * LV Phase 4b (LA, D-VE17): at load, pulls whatever lies below the annulus plane up to the plane, along the axis, with radial weight
   * 1 − smoothstep(r0, r1, ρ) (mm from the annulus contour). Changes the rest pose; absent = no pull-back (RA).
   */
  floorToPlane?: readonly [number, number];
}

export const RA_SKIN_PARAMS: AtrialSkinParams = {
  heightStart: 5,
  heightEnd: 20,
  radialStart: 6,
  radialEnd: 18,
  scalePin0: 6,
  scalePin1: 16,
  lvMargin: 0.3,
  floorCompression: 0.75,
  floorOffset: 4,
};

/** Reversal: false returns the RA to the node scale, without following the annulus. */
export const RA_SKINNING_ENABLED = true;

/** RA anchors (mm): SVC (weight and atrial contraction pinned) and interatrial septum next to the LA (weight only). The GLB has no IVC mesh. */
export const RA_ANCHORS = { svc0: 2, svc1: 12, la0: 3, la1: 15 } as const;

const SECTORS = 72;
const LV_TOP_Y = LV_ANALYTIC_PROFILE.y0 + LV_ANALYTIC_PROFILE.height;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export interface AtrialSkinRig {
  mesh: THREE.Mesh;
  n: number;
  restLocal: Float32Array;
  /** rest position in parent space */
  restP: Float64Array;
  /** annulus field weight and atrial contraction weight */
  wA: Float32Array;
  wE: Float32Array;
  /** minimum radial clearance to the LV epicardium per vertex (GLB units; negative if it was already inside at rest) */
  lvClear: Float32Array;
  /** depth below the floor (GLB units), axis direction and pulled-back fraction */
  depth: Float32Array;
  ax: number;
  ay: number;
  az: number;
  floorCompression: number;
  /** node origin (contraction pivot), parent space */
  cx: number;
  cy: number;
  cz: number;
  invM: THREE.Matrix4;
  nRest: Float32Array;
  nRef: Float32Array;
  /** displacement of the normals' reference annulus (mm at the lateral point, in D·k) */
  refD: number;
  /** last written state (avoids work when nothing changed) */
  lastA: number;
  lastAmount: number;
  /** LV Phase 4b: largest rest displacement from the floor pull-back (mm) and moved vertices */
  floorLiftMaxMm: number;
  floorLifted: number;
}

/** Rest per geometry (StrictMode: repeated setup does not capture a deformed pose). */
const restCache = new WeakMap<THREE.BufferGeometry, Float32Array>();

/**
 * Prepares the skinning of an atrium. Allocates; load time only.
 * @param mesh atrium mesh (the geometry is copied: the GLB may share buffers)
 * @param annulusMesh annulus mesh in the rest pose
 * @param axis annulus axis, pointing to the atrium (unit vector, parent space)
 * @param anchors meshes to which the atrium is pinned
 * @param refField systolic reference field, used only for the normals; `refAmount` is the corresponding amplitude
 */
export function setupAtrialSkinning(
  mesh: THREE.Mesh | null | undefined,
  annulusMesh: THREE.Mesh | null | undefined,
  axis: THREE.Vector3,
  anchors: ReadonlyArray<AtrialAnchor>,
  refField: THREE.Matrix4 | null,
  refAmount: number,
  params: AtrialSkinParams = RA_SKIN_PARAMS,
): AtrialSkinRig | null {
  if (!mesh?.isMesh || !mesh.geometry || !annulusMesh?.isMesh || !annulusMesh.geometry) return null;
  let geom = mesh.geometry;
  if (!geom.userData.atrialSkinOwned) {
    geom = geom.clone();
    geom.userData.atrialSkinOwned = true;
    mesh.geometry = geom;
  }
  const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < 4) return null;
  let restLocal = restCache.get(geom);
  if (!restLocal) {
    restLocal = new Float32Array(pos.array as Float32Array);
    restCache.set(geom, restLocal);
  }
  (pos.array as Float32Array).set(restLocal);
  pos.needsUpdate = true;

  const S = GLTF_SCALE_MM_PER_UNIT;
  mesh.updateMatrix();
  annulusMesh.updateMatrix();
  const n = pos.count;
  const restP = new Float64Array(n * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrix);
    restP[i * 3] = p.x;
    restP[i * 3 + 1] = p.y;
    restP[i * 3 + 2] = p.z;
  }

  // Annulus: center, plane base and contour per angular sector (maximum radius)
  const annPos = annulusMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const annPts: THREE.Vector3[] = [];
  const c = new THREE.Vector3();
  for (let i = 0; i < annPos.count; i++) {
    const q = new THREE.Vector3().fromBufferAttribute(annPos, i).applyMatrix4(annulusMesh.matrix);
    annPts.push(q);
    c.add(q);
  }
  c.multiplyScalar(1 / annPos.count);
  const e1 = new THREE.Vector3(1, 0, 0);
  if (Math.abs(e1.dot(axis)) > 0.9) e1.set(0, 0, 1);
  e1.addScaledVector(axis, -e1.dot(axis)).normalize();
  const e2 = new THREE.Vector3().crossVectors(axis, e1);
  const rimR = new Float64Array(SECTORS);
  const d = new THREE.Vector3();
  const sectorF = (u: number, v: number) => ((Math.atan2(v, u) / (2 * Math.PI) + 1) % 1) * SECTORS;
  for (const q of annPts) {
    d.copy(q).sub(c);
    const u = d.dot(e1);
    const v = d.dot(e2);
    const k = Math.min(SECTORS - 1, Math.floor(sectorF(u, v)));
    rimR[k] = Math.max(rimR[k], Math.hypot(u, v));
  }
  // sectors with no vertex receive the largest neighboring radius
  for (let k = 0; k < SECTORS; k++) if (rimR[k] === 0) rimR[k] = Math.max(rimR[(k + SECTORS - 1) % SECTORS], rimR[(k + 1) % SECTORS]);

  const tri = new THREE.Triangle();
  const closest = new THREE.Vector3();
  const distToMesh = (x: THREE.Vector3, m: THREE.Mesh, mat: THREE.Matrix4): number => {
    const g = m.geometry;
    const a = g.getAttribute('position') as THREE.BufferAttribute;
    const idx = g.getIndex();
    const nT = (idx ? idx.count : a.count) / 3;
    let best = Infinity;
    for (let t = 0; t < nT; t++) {
      tri.a.fromBufferAttribute(a, idx ? idx.getX(t * 3) : t * 3).applyMatrix4(mat);
      tri.b.fromBufferAttribute(a, idx ? idx.getX(t * 3 + 1) : t * 3 + 1).applyMatrix4(mat);
      tri.c.fromBufferAttribute(a, idx ? idx.getX(t * 3 + 2) : t * 3 + 2).applyMatrix4(mat);
      tri.closestPointToPoint(x, closest);
      const q = closest.distanceToSquared(x);
      if (q < best) best = q;
    }
    return Math.sqrt(best);
  };
  const anchorMats = anchors.map((a) => {
    a.mesh.updateMatrix();
    return a.mesh.matrix.clone();
  });

  // LV Phase 4b: floor below the annulus plane pulled back to the plane (new rest pose)
  let floorLiftMaxMm = 0;
  let floorLifted = 0;
  if (params.floorToPlane) {
    const [f0, f1] = params.floorToPlane;
    for (let i = 0; i < n; i++) {
      p.set(restP[i * 3], restP[i * 3 + 1], restP[i * 3 + 2]);
      d.copy(p).sub(c);
      const h = d.dot(axis);
      if (h >= 0) continue;
      const u = d.dot(e1);
      const v = d.dot(e2);
      const f = sectorF(u, v);
      const k0 = Math.floor(f) % SECTORS;
      const k1 = (k0 + 1) % SECTORS;
      const t = f - Math.floor(f);
      const rim = rimR[k0] + (rimR[k1] - rimR[k0]) * t;
      const rho = Math.max(0, Math.hypot(u, v) - rim) * S;
      const lift = -h * (1 - smoothstep(f0, f1, rho));
      if (!(lift > 0)) continue;
      restP[i * 3] += lift * axis.x;
      restP[i * 3 + 1] += lift * axis.y;
      restP[i * 3 + 2] += lift * axis.z;
      floorLiftMaxMm = Math.max(floorLiftMaxMm, lift * S);
      floorLifted++;
    }
  }

  const wA = new Float32Array(n);
  const wE = new Float32Array(n);
  const lvClear = new Float32Array(n);
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    p.set(restP[i * 3], restP[i * 3 + 1], restP[i * 3 + 2]);
    d.copy(p).sub(c);
    const h = d.dot(axis) * S;
    const u = d.dot(e1);
    const v = d.dot(e2);
    const f = sectorF(u, v);
    const k0 = Math.floor(f) % SECTORS;
    const k1 = (k0 + 1) % SECTORS;
    const t = f - Math.floor(f);
    const rim = rimR[k0] + (rimR[k1] - rimR[k0]) * t;
    const rho = Math.max(0, Math.hypot(u, v) - rim) * S;
    let w = (1 - smoothstep(params.heightStart, params.heightEnd, h)) * (1 - smoothstep(params.radialStart, params.radialEnd, rho));
    let pin = 0;
    for (let a = 0; a < anchors.length; a++) {
      const anc = anchors[a];
      const dA = distToMesh(p, anc.mesh, anchorMats[a]) * S;
      w *= smoothstep(anc.d0, anc.d1, dA);
      if (anc.pinScale) pin = Math.max(pin, 1 - smoothstep(anc.d0, anc.d1, dA));
    }
    let dAnn = Infinity;
    for (let q = 0; q < annPts.length; q += 4) {
      const dd = annPts[q].distanceToSquared(p);
      if (dd < dAnn) dAnn = dd;
    }
    pin = Math.max(pin, 1 - smoothstep(params.scalePin0, params.scalePin1, Math.sqrt(dAnn) * S));
    wA[i] = w;
    wE[i] = 1 - pin;
    depth[i] = Math.max(0, -h - params.floorOffset) / S;
    lvClear[i] = params.lvMargin / S;
    if (p.y >= LV_ANALYTIC_PROFILE.y0 && p.y <= LV_TOP_Y) lvClear[i] = Math.min(lvClear[i], Math.hypot(p.x, p.z) - lvEnvelopeRadius(p.y, true));
  }

  const nAttr = geom.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const nRest = nAttr ? new Float32Array(nAttr.array as Float32Array) : new Float32Array(0);
  const rig: AtrialSkinRig = {
    mesh,
    n,
    restLocal,
    restP,
    wA,
    wE,
    lvClear,
    depth,
    ax: axis.x,
    ay: axis.y,
    az: axis.z,
    floorCompression: params.floorCompression,
    cx: mesh.position.x,
    cy: mesh.position.y,
    cz: mesh.position.z,
    invM: mesh.matrix.clone().invert(),
    nRest,
    nRef: new Float32Array(0),
    refD: refAmount,
    lastA: NaN,
    lastAmount: NaN,
    floorLiftMaxMm,
    floorLifted,
  };
  // LV Phase 4b: with the floor pulled back the rest pose changes; rest normals recomputed (welded by position)
  if (floorLifted > 0 && nAttr) {
    writeAtrialSkin(rig, null, 0, 1);
    rig.nRest = weldedNormals(geom);
    (nAttr.array as Float32Array).set(rig.nRest);
    nAttr.needsUpdate = true;
  }

  // Culling and raycast bounds: include the systolic travel
  geom.computeBoundingSphere();
  if (refField && geom.boundingSphere) {
    let maxD = 0;
    for (let i = 0; i < n; i++) {
      p.set(restP[i * 3], restP[i * 3 + 1], restP[i * 3 + 2]);
      d.copy(p).applyMatrix4(refField).sub(p);
      maxD = Math.max(maxD, d.length() * wA[i]);
    }
    geom.boundingSphere.radius += maxD * 1.5;
  }

  // Normals of the systolic reference, welded by position (no visible seam at the sphere meridian)
  if (refField && nAttr && refAmount > 0) {
    writeAtrialSkin(rig, refField, 1, 1);
    rig.nRef = weldedNormals(geom);
    writeAtrialSkin(rig, null, 0, 1);
    (nAttr.array as Float32Array).set(rig.nRest);
    nAttr.needsUpdate = true;
  }
  mesh.matrixAutoUpdate = false;
  mesh.matrix.compose(mesh.position, mesh.quaternion, mesh.scale);
  mesh.matrixWorldNeedsUpdate = true;
  mesh.userData.atrialSkinning = true;
  return rig;
}

function weldedNormals(geom: THREE.BufferGeometry): Float32Array {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  const idx = geom.getIndex();
  const nT = (idx ? idx.count : pos.count) / 3;
  const key = (i: number) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const sum = new Map<string, THREE.Vector3>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let t = 0; t < nT; t++) {
    const ia = idx ? idx.getX(t * 3) : t * 3;
    const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    n.subVectors(c, b).cross(a.clone().sub(b));
    for (const i of [ia, ib, ic]) {
      const k = key(i);
      const v = sum.get(k);
      if (v) v.add(n);
      else sum.set(k, n.clone());
    }
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = sum.get(key(i))!;
    const l = v.length() || 1;
    out[i * 3] = v.x / l;
    out[i * 3 + 1] = v.y / l;
    out[i * 3 + 2] = v.z / l;
  }
  return out;
}

/** Writes the local positions for the field matrix `S` (null = identity), the systole fraction `sys` and the atrial scale `a`. No allocation. */
function writeAtrialSkin(rig: AtrialSkinRig, S: THREE.Matrix4 | null, sys: number, a: number): void {
  const pos = rig.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const { n, restP, wA, wE, lvClear, depth, ax, ay, az, cx, cy, cz } = rig;
  const lift = rig.floorCompression * sys;
  const inv = rig.invM.elements;
  const e = S ? S.elements : null;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const px = restP[i3];
    const py = restP[i3 + 1];
    const pz = restP[i3 + 2];
    const s = wE[i] * (a - 1);
    let x = px + s * (px - cx);
    let y = py + s * (py - cy);
    let z = pz + s * (pz - cz);
    if (e) {
      const w = wA[i];
      x += w * (e[0] * px + e[4] * py + e[8] * pz + e[12] - px);
      y += w * (e[1] * px + e[5] * py + e[9] * pz + e[13] - py);
      z += w * (e[2] * px + e[6] * py + e[10] * pz + e[14] - pz);
      const up = w * lift * depth[i];
      x += up * ax;
      y += up * ay;
      z += up * az;
    }
    // the skinning does not bring the vertex closer to the LV epicardium than the clearance (nor deepen one that was already inside at rest)
    if (y >= LV_ANALYTIC_PROFILE.y0 && y <= LV_TOP_Y) {
      const r = Math.hypot(x, z);
      const rMin = lvEnvelopeRadius(y, true) + lvClear[i];
      if (r < rMin && r > 0) {
        x *= rMin / r;
        z *= rMin / r;
      }
    }
    arr[i3] = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
    arr[i3 + 1] = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
    arr[i3 + 2] = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
  }
  pos.needsUpdate = true;
}

/**
 * Per frame: applies the annulus field and the atrial contraction. No allocation.
 * @param field matrix S of the annulus field in this frame (parent space)
 * @param amount field amplitude (same unit as `refAmount`), used to interpolate the normals
 * @param a atrial scale (1 = no contraction)
 */
export function applyAtrialSkinning(rig: AtrialSkinRig | null, field: THREE.Matrix4 | null, amount: number, a: number): void {
  if (!rig) return;
  if (amount === rig.lastAmount && a === rig.lastA) return;
  rig.lastAmount = amount;
  rig.lastA = a;
  const sys = rig.refD > 0 ? Math.max(0, Math.min(1.2, amount / rig.refD)) : 0;
  writeAtrialSkin(rig, field, sys, a);
  const nAttr = rig.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (nAttr && rig.nRef.length === nAttr.array.length && rig.refD > 0) {
    const na = nAttr.array as Float32Array;
    const s = Math.max(-0.5, Math.min(1.5, amount / rig.refD));
    for (let i = 0; i < na.length; i += 3) {
      const nx = rig.nRest[i] + s * (rig.nRef[i] - rig.nRest[i]);
      const ny = rig.nRest[i + 1] + s * (rig.nRef[i + 1] - rig.nRest[i + 1]);
      const nz = rig.nRest[i + 2] + s * (rig.nRef[i + 2] - rig.nRest[i + 2]);
      const l = Math.hypot(nx, ny, nz) || 1;
      na[i] = nx / l;
      na[i + 1] = ny / l;
      na[i + 2] = nz / l;
    }
    nAttr.needsUpdate = true;
  }
}
