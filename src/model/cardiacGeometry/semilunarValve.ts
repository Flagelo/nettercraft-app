import * as THREE from 'three';

// ============================================================================
// Procedural semilunar valves (aortic and pulmonary), assembled at runtime
// on the root of the great vessels of the GLB, without altering the asset.
//
// Anchor: the center of each valve is the base position stored in the GLB itself,
// in the `matrix` field of the `aortic_valve` and `pulmonary_valve` nodes (the GLTFLoader
// decomposes it into `position`). The axis and radius come from the vessel root, estimated
// from the vertices of `organui_aorta_ascending` / `organui_pulmonary_trunk`.
// The legacy flat discs are reoriented along this axis and hidden
// when the cusps are assembled.
// Cusps: 3 per valve, semitransparent sinuses of Valsalva and, on the aortic valve, the
// coronary ostia with the proximal segments up to the coronary tubes.
// The animation uses the engine's continuous ζ (hemo.zAortic / hemo.zPulmonary),
// interpolating per vertex between the closed and open shapes, without allocation.
// ============================================================================

export const SEMILUNAR_GROUP_NAME = 'semilunar_valves_procedural';

export type SemilunarValveType = 'aortic' | 'pulmonary';

/**
 * Proportions in multiples of the fitted root radius R.
 * PROVISIONAL VALUES: pending anatomical reference (PubMed), per
 * DIAGNOSTICO_VALVAS_3D_20261107.md §7. Adjust here, in a single place.
 */
export interface SemilunarSpec {
  /** Height of the commissures above the cusp nadir (× R). */
  commissureHeight: number;
  /** Height of the coaptation center with the valve closed (× R). */
  coaptationHeight: number;
  /** Extra elevation of the nodule of Arantius at the center (× R). */
  noduleHeight: number;
  /** Bulge of the belly of the closed cusp toward the ventricle (× R). */
  bellyDepth: number;
  /** Maximum radial bulge of the sinus (fraction of R). */
  sinusBulge: number;
  /** Height of the sinotubular junction above the nadir (× R). */
  sinusHeight: number;
  /** Radial setback of the open free edge at the middle of the cusp (fraction of R). */
  openInset: number;
  /** Offset of the closed free edge relative to the coaptation line (× R). */
  closedGap: number;
  /** Height of the coronary ostium (fraction of sinusHeight); 0 = no ostia. */
  ostiumHeight: number;
  /** Radius of the coronary ostium (× R). */
  ostiumRadius: number;
}

export const SEMILUNAR_SPECS: Record<SemilunarValveType, SemilunarSpec> = {
  aortic: {
    commissureHeight: 1.3,
    coaptationHeight: 0.8,
    noduleHeight: 0.08,
    bellyDepth: 0.3,
    sinusBulge: 0.32,
    sinusHeight: 1.45,
    openInset: 0.06,
    closedGap: 0.012,
    ostiumHeight: 0.62,
    ostiumRadius: 0.17,
  },
  pulmonary: {
    commissureHeight: 1.2,
    coaptationHeight: 0.75,
    noduleHeight: 0.06,
    bellyDepth: 0.26,
    sinusBulge: 0.2,
    sinusHeight: 1.3,
    openInset: 0.06,
    closedGap: 0.012,
    ostiumHeight: 0,
    ostiumRadius: 0,
  },
};

/**
 * Color of the semilunar cusps: pinkish ivory, distinct from the ivory of the leaflets,
 * annuli and AV chordae of the GLB (≈ 0.85/0.82/0.75) and from the white of the legacy discs.
 */
export const SEMILUNAR_CUSP_COLOR = new THREE.Color(0.92, 0.66, 0.58);

/** Opacity of the sinuses: low, with depthWrite disabled, so as not to hide the cusps. */
export const SEMILUNAR_SINUS_OPACITY = 0.28;

/** Fraction of the median wall radius used as the valve radius (stays inside the lumen). */
export const ROOT_RADIUS_FIT = 0.85;

/** Mesh resolution of each cusp (s: circumferential, t: hinge → free edge). */
export const CUSP_SEGMENTS_S = 24;
export const CUSP_SEGMENTS_T = 10;

const SINUS_SEGMENTS_THETA = 72;
const SINUS_SEGMENTS_Z = 12;
const TWO_PI_3 = (2 * Math.PI) / 3;

export const AORTA_ROOT_MESH = 'organui_aorta_ascending';
export const PULMONARY_ROOT_MESH = 'organui_pulmonary_trunk';

export interface VesselRootFrame {
  /** Center of the valve plane (cusp nadir), in the parent space of the vessel. */
  center: THREE.Vector3;
  /** Vessel axis, pointing from the ventricle downstream. */
  axis: THREE.Vector3;
  /** Valve radius (median wall radius × ROOT_RADIUS_FIT). */
  radius: number;
  /** Origin of the center: GLB anchor (`matrix` of the legacy disc) or estimate from the vessel vertices. */
  anchorSource: 'glb-matrix' | 'vertex-estimate';
}

export interface SemilunarCusp {
  mesh: THREE.Mesh;
  name: string;
  valveType: SemilunarValveType;
  closed: Float32Array;
  open: Float32Array;
  closedNormals: Float32Array;
  openNormals: Float32Array;
}

export interface SemilunarOstium {
  name: 'right_coronary_ostium' | 'left_coronary_ostium';
  position: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface SemilunarValve {
  type: SemilunarValveType;
  frame: VesselRootFrame;
  u: THREE.Vector3;
  v: THREE.Vector3;
  /** Angle of the first commissure in the (u, v) plane. */
  theta0: number;
  spec: SemilunarSpec;
  cusps: SemilunarCusp[];
  sinus: THREE.Mesh | null;
  ostia: SemilunarOstium[];
}

export interface CoronaryConnector {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  /** null for the left coronary trunk (supplies LAD and LCX). */
  territory: 'lad' | 'lcx' | 'rca' | null;
}

export interface SemilunarValvesData {
  group: THREE.Group;
  valves: Partial<Record<SemilunarValveType, SemilunarValve>>;
  frames: Partial<Record<SemilunarValveType, VesselRootFrame>>;
  /** Legacy flat discs, kept at the GLB anchor and reoriented by the vessel axis. */
  alignedDiscs: Array<{ mesh: THREE.Mesh; valveType: SemilunarValveType }>;
  connectors: CoronaryConnector[];
  materials: THREE.MeshStandardMaterial[];
  geometries: THREE.BufferGeometry[];
  lastZAortic: number;
  lastZPulmonary: number;
}

export interface SetupSemilunarOptions {
  /** false = only anchors and reorients the legacy discs, which remain visible. */
  buildCusps?: boolean;
}

// ----------------------------------------------------------------------------
// Setup utilities (may allocate; never called per frame)
// ----------------------------------------------------------------------------

function collectParentSpacePositions(mesh: THREE.Mesh): THREE.Vector3[] {
  mesh.updateMatrix();
  const pos = mesh.geometry?.attributes?.position;
  const out: THREE.Vector3[] = [];
  if (!pos) return out;
  for (let i = 0; i < pos.count; i++) {
    out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrix));
  }
  return out;
}

function centroid(points: THREE.Vector3[]): THREE.Vector3 | null {
  if (points.length === 0) return null;
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  return c.divideScalar(points.length);
}

function wrapToPi(a: number): number {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

/**
 * Estimates the reference frame of the root of a great vessel (closed mesh, axis
 * approximately ascending along +Y). Base = centroid of the vertices in the lowest 8%
 * of the height; axis = from the base to the centroid of the 17–33% band;
 * radius = median perpendicular distance to the axis in the 3–25% axial band.
 */
export function estimateVesselRootFrame(mesh: THREE.Mesh): VesselRootFrame | null {
  const pts = collectParentSpacePositions(mesh);
  if (pts.length < 12) return null;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const h = maxY - minY;
  if (!(h > 1e-6)) return null;

  const base = centroid(pts.filter((p) => p.y < minY + 0.08 * h));
  const up = centroid(pts.filter((p) => p.y >= minY + 0.17 * h && p.y < minY + 0.33 * h));
  if (!base || !up) return null;

  const axis = new THREE.Vector3().subVectors(up, base);
  if (axis.lengthSq() < 1e-12) return null;
  axis.normalize();

  const d = new THREE.Vector3();
  const radii: number[] = [];
  for (const p of pts) {
    d.subVectors(p, base);
    const t = d.dot(axis);
    if (t < 0.03 * h || t > 0.25 * h) continue;
    d.addScaledVector(axis, -t);
    radii.push(d.length());
  }
  if (radii.length < 6) return null;
  radii.sort((a, b) => a - b);
  const median = radii[radii.length >> 1];

  return { center: base, axis, radius: median * ROOT_RADIUS_FIT, anchorSource: 'vertex-estimate' };
}

function makeBasis(axis: THREE.Vector3, reference: THREE.Vector3 | null): { u: THREE.Vector3; v: THREE.Vector3 } {
  const u = new THREE.Vector3();
  if (reference) {
    u.copy(reference).addScaledVector(axis, -reference.dot(axis));
  }
  if (u.lengthSq() < 1e-10) {
    u.set(1, 0, 0).addScaledVector(axis, -axis.x);
    if (u.lengthSq() < 1e-10) u.set(0, 0, 1).addScaledVector(axis, -axis.z);
  }
  u.normalize();
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  return { u, v };
}

function angleInPlane(p: THREE.Vector3, frame: VesselRootFrame, u: THREE.Vector3, v: THREE.Vector3): number {
  const d = new THREE.Vector3().subVectors(p, frame.center);
  return Math.atan2(d.dot(v), d.dot(u));
}

/** Sinus radius at angle θ and height z (z measured along the axis from the nadir). */
function sinusRadius(valve: { frame: VesselRootFrame; spec: SemilunarSpec; theta0: number }, theta: number, z: number): number {
  const R = valve.frame.radius;
  const hs = valve.spec.sinusHeight * R;
  const bump = z > 0 && z < hs ? Math.sin((Math.PI * z) / hs) : 0;
  const w = Math.abs(Math.sin(1.5 * (theta - valve.theta0)));
  return R * (1 + valve.spec.sinusBulge * bump * w);
}

const _clampD = new THREE.Vector3();

/** Ensures (at setup) that the point does not cross the sinus wall: r ≤ local sinus radius. */
function clampInsideSinus(p: THREE.Vector3, valve: SemilunarValve): void {
  const { frame, u, v } = valve;
  _clampD.subVectors(p, frame.center);
  const z = _clampD.dot(frame.axis);
  _clampD.addScaledVector(frame.axis, -z);
  const r = _clampD.length();
  const limit = sinusRadius(valve, Math.atan2(_clampD.dot(v), _clampD.dot(u)), z);
  if (r > limit && r > 1e-9) p.addScaledVector(_clampD, limit / r - 1);
}

function pointOnFrame(
  out: THREE.Vector3,
  frame: VesselRootFrame,
  u: THREE.Vector3,
  v: THREE.Vector3,
  theta: number,
  radius: number,
  z: number,
): THREE.Vector3 {
  return out
    .copy(frame.center)
    .addScaledVector(frame.axis, z)
    .addScaledVector(u, radius * Math.cos(theta))
    .addScaledVector(v, radius * Math.sin(theta));
}

function gridIndices(ns: number, nt: number): number[] {
  const idx: number[] = [];
  const row = ns + 1;
  for (let j = 0; j < nt; j++) {
    for (let i = 0; i < ns; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  return idx;
}

function normalsFor(positions: Float32Array, index: number[]): Float32Array {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
  g.setIndex(index);
  g.computeVertexNormals();
  const n = new Float32Array((g.attributes.normal.array as Float32Array));
  g.dispose();
  return n;
}

function buildCusp(
  valve: SemilunarValve,
  k: number,
  name: string,
  material: THREE.MeshStandardMaterial,
): SemilunarCusp {
  const { frame, u, v, spec } = valve;
  const R = frame.radius;
  const ns = CUSP_SEGMENTS_S;
  const nt = CUSP_SEGMENTS_T;
  const count = (ns + 1) * (nt + 1);
  const closed = new Float32Array(count * 3);
  const open = new Float32Array(count * 3);

  const hc = spec.commissureHeight * R;
  const hco = spec.coaptationHeight * R;
  const thetaA = valve.theta0 + k * TWO_PI_3;
  const thetaB = thetaA + TWO_PI_3;
  const bisector = thetaA + TWO_PI_3 / 2;

  const hinge = new THREE.Vector3();
  const freeClosed = new THREE.Vector3();
  const freeOpen = new THREE.Vector3();
  const p = new THREE.Vector3();
  const gapDir = new THREE.Vector3()
    .addScaledVector(u, Math.cos(bisector))
    .addScaledVector(v, Math.sin(bisector));

  for (let i = 0; i <= ns; i++) {
    const s = i / ns;
    const sinS = Math.sin(Math.PI * s);
    const theta = thetaA + s * TWO_PI_3;

    // Semilunar insertion line (crown): nadir in the middle, commissures at the tips
    const zh = hc * (1 - sinS);
    pointOnFrame(hinge, frame, u, v, theta, sinusRadius(valve, theta, zh), zh);

    // Closed free edge: from the commissure to the center and from the center to the next commissure
    const rho = R * Math.abs(1 - 2 * s);
    const lineTheta = s <= 0.5 ? thetaA : thetaB;
    const centerness = 1 - rho / R;
    const nodule = spec.noduleHeight * R * Math.pow(centerness, 6);
    const zfc = hc + (hco - hc) * centerness + nodule;
    pointOnFrame(freeClosed, frame, u, v, lineTheta, rho, zfc).addScaledVector(gapDir, spec.closedGap * R);

    // Open free edge: arc along the wall, at the height of the commissures
    const zfo = hc * (1 - 0.1 * sinS);
    pointOnFrame(freeOpen, frame, u, v, theta, R * (1 - spec.openInset * sinS), zfo);

    for (let j = 0; j <= nt; j++) {
      const t = j / nt;
      const o3 = (j * (ns + 1) + i) * 3;

      // Closed: pocket with belly bulging toward the ventricle
      p.lerpVectors(hinge, freeClosed, t).addScaledVector(frame.axis, -spec.bellyDepth * R * Math.sin(Math.PI * t) * sinS);
      clampInsideSinus(p, valve);
      closed[o3] = p.x;
      closed[o3 + 1] = p.y;
      closed[o3 + 2] = p.z;

      // Open: cusp folded back against the root wall
      p.lerpVectors(hinge, freeOpen, t);
      clampInsideSinus(p, valve);
      open[o3] = p.x;
      open[o3 + 1] = p.y;
      open[o3 + 2] = p.z;
    }
  }

  const index = gridIndices(ns, nt);
  const closedNormals = normalsFor(closed, index);
  const openNormals = normalsFor(open, index);

  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(closed.slice(), 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const nrmAttr = new THREE.BufferAttribute(closedNormals.slice(), 3);
  nrmAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('normal', nrmAttr);
  geometry.setIndex(index);
  // Fixed bounding sphere covering the closed and open states (no per-frame recomputation)
  geometry.boundingSphere = new THREE.Sphere(
    frame.center.clone().addScaledVector(frame.axis, hc * 0.5),
    Math.hypot(R * (1 + spec.sinusBulge), hc) * 1.05,
  );

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.userData = {
    name,
    isValve: true,
    isStructure: true,
    isProceduralValvar: true,
    isSemilunarCusp: true,
    valveType: valve.type,
  };

  return { mesh, name, valveType: valve.type, closed, open, closedNormals, openNormals };
}

function buildSinus(valve: SemilunarValve, material: THREE.MeshStandardMaterial): THREE.Mesh {
  const { frame, u, v, spec } = valve;
  const nth = SINUS_SEGMENTS_THETA;
  const nz = SINUS_SEGMENTS_Z;
  const hs = spec.sinusHeight * frame.radius;
  const positions = new Float32Array((nth + 1) * (nz + 1) * 3);
  const p = new THREE.Vector3();
  for (let j = 0; j <= nz; j++) {
    const z = (j / nz) * hs;
    for (let i = 0; i <= nth; i++) {
      const theta = valve.theta0 + (i / nth) * 2 * Math.PI;
      pointOnFrame(p, frame, u, v, theta, sinusRadius(valve, theta, z), z);
      const o3 = (j * (nth + 1) + i) * 3;
      positions[o3] = p.x;
      positions[o3 + 1] = p.y;
      positions[o3 + 2] = p.z;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(gridIndices(nth, nz));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, material);
  const name = valve.type === 'aortic' ? 'aortic_sinuses_of_valsalva' : 'pulmonary_sinuses';
  mesh.name = name;
  mesh.userData = { name, isStructure: true, isSemilunarSinus: true, valveType: valve.type };
  return mesh;
}

/** Approximate center of the end of a coronary tube closest to `ref`. */
function tubeEndNear(mesh: THREE.Mesh, ref: THREE.Vector3): { point: THREE.Vector3; radius: number } | null {
  const pts = collectParentSpacePositions(mesh);
  if (pts.length < 12) return null;
  pts.sort((a, b) => a.distanceToSquared(ref) - b.distanceToSquared(ref));
  const ring = pts.slice(0, 12);
  const c = centroid(ring)!;
  let r = 0;
  for (const q of ring) r += q.distanceTo(c);
  return { point: c, radius: r / ring.length };
}

function findMeshByName(root: THREE.Object3D, name: string): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((child: any) => {
    if (!found && child?.isMesh && (child.name === name || child.userData?.name === name)) found = child;
  });
  return found;
}

function findPlanarDiscs(root: THREE.Object3D): Array<{ mesh: THREE.Mesh; valveType: SemilunarValveType }> {
  const out: Array<{ mesh: THREE.Mesh; valveType: SemilunarValveType }> = [];
  root.traverse((child: any) => {
    if (!child?.isMesh) return;
    const name = String(child.userData?.name || child.name || '').toLowerCase();
    if (name === 'aortic_valve') out.push({ mesh: child, valveType: 'aortic' });
    else if (name === 'pulmonary_valve') out.push({ mesh: child, valveType: 'pulmonary' });
  });
  return out;
}

/**
 * Base position of the valve stored in the GLB (`matrix` field of the legacy
 * disc node), in the space of `targetParent`. Cached in `userData.glbBaseAnchor`
 * on the first read, so that remounts (StrictMode) do not read the already
 * adjusted position.
 */
export function glbBaseAnchor(disc: THREE.Mesh, targetParent: THREE.Object3D): THREE.Vector3 {
  const stored = disc.userData?.glbBaseAnchor;
  const local = Array.isArray(stored) && stored.length === 3
    ? new THREE.Vector3(stored[0], stored[1], stored[2])
    : disc.position.clone();
  if (!Array.isArray(stored)) disc.userData.glbBaseAnchor = local.toArray();
  const discParent = disc.parent;
  if (!discParent || discParent === targetParent) return local;
  discParent.updateWorldMatrix(true, false);
  targetParent.updateWorldMatrix(true, false);
  return targetParent.worldToLocal(discParent.localToWorld(local));
}

/**
 * Reorients the legacy flat disc: center at the GLB anchor, normal along the
 * estimated vessel axis and outer radius equal to the valve radius.
 */
export function alignPlanarDisc(disc: THREE.Mesh, frame: VesselRootFrame): void {
  const pos = disc.geometry?.attributes?.position;
  let outer = 0;
  if (pos) {
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      if (r > outer) outer = r;
    }
  }
  const s = outer > 1e-6 ? frame.radius / outer : 1;
  // The frame is in the vessel's parent space; in the current GLB it is the same parent as the disc
  disc.position.copy(frame.center);
  disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), frame.axis);
  disc.scale.set(s, s, s);
  disc.updateMatrix();
  disc.userData.alignedToVesselRoot = true;
}

/** Idempotently removes the procedural group (StrictMode runs the useMemo twice). */
export function removeSemilunarValves(root: THREE.Object3D | null): void {
  if (!root) return;
  const existing: THREE.Object3D[] = [];
  root.traverse((child) => {
    if (child.name === SEMILUNAR_GROUP_NAME) existing.push(child);
  });
  for (const g of existing) g.parent?.remove(g);
}

function cuspNames(type: SemilunarValveType): [string, string, string] {
  return type === 'aortic'
    ? ['aortic_cusp_right_coronary', 'aortic_cusp_left_coronary', 'aortic_cusp_noncoronary']
    : ['pulmonary_cusp_anterior', 'pulmonary_cusp_right', 'pulmonary_cusp_left'];
}

// ----------------------------------------------------------------------------
// Main setup
// ----------------------------------------------------------------------------

export function setupSemilunarValves(
  sceneClone: THREE.Object3D | null,
  options: SetupSemilunarOptions = {},
): SemilunarValvesData | null {
  if (!sceneClone) return null;
  removeSemilunarValves(sceneClone);

  const aortaMesh = findMeshByName(sceneClone, AORTA_ROOT_MESH);
  const pulmMesh = findMeshByName(sceneClone, PULMONARY_ROOT_MESH);
  const frames: Partial<Record<SemilunarValveType, VesselRootFrame>> = {};
  if (aortaMesh) {
    const f = estimateVesselRootFrame(aortaMesh);
    if (f) frames.aortic = f;
  }
  if (pulmMesh) {
    const f = estimateVesselRootFrame(pulmMesh);
    if (f) frames.pulmonary = f;
  }
  if (!frames.aortic && !frames.pulmonary) return null;

  const parent = (aortaMesh?.parent ?? pulmMesh?.parent ?? sceneClone) as THREE.Object3D;

  // Anchor of each valve at the GLB base position; axis and radius estimated from the root
  const alignedDiscs: SemilunarValvesData['alignedDiscs'] = [];
  for (const d of findPlanarDiscs(sceneClone)) {
    const f = frames[d.valveType];
    if (!f) continue;
    f.center.copy(glbBaseAnchor(d.mesh, parent));
    f.anchorSource = 'glb-matrix';
    alignPlanarDisc(d.mesh, f);
    alignedDiscs.push(d);
  }

  const group = new THREE.Group();
  group.name = SEMILUNAR_GROUP_NAME;
  parent.add(group);

  const data: SemilunarValvesData = {
    group,
    valves: {},
    frames,
    alignedDiscs,
    connectors: [],
    materials: [],
    geometries: [],
    lastZAortic: NaN,
    lastZPulmonary: NaN,
  };

  if (options.buildCusps === false) return data;

  const cuspMaterial = new THREE.MeshStandardMaterial({
    color: SEMILUNAR_CUSP_COLOR.clone(),
    roughness: 0.55,
    metalness: 0.0,
    side: THREE.DoubleSide,
    clipShadows: true,
  });
  data.materials.push(cuspMaterial);

  const sinusMaterialFrom = (vessel: THREE.Mesh | null, fallback: THREE.Color): THREE.MeshStandardMaterial => {
    const src = vessel ? (Array.isArray(vessel.material) ? vessel.material[0] : vessel.material) : null;
    const color = (src as any)?.color?.isColor ? (src as any).color.clone() : fallback;
    // Semitransparent and without depth writes: shows the bulge without hiding the cusps
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.42,
      metalness: 0.08,
      side: THREE.DoubleSide,
      clipShadows: true,
      transparent: true,
      opacity: SEMILUNAR_SINUS_OPACITY,
      depthWrite: false,
    });
    data.materials.push(m);
    return m;
  };

  // --- Aortic: cusp orientation by the coronary origins ---
  const rcaMesh = findMeshByName(sceneClone, 'coronary_rca_artery');
  const ladMesh = findMeshByName(sceneClone, 'coronary_lad_artery');
  const lcxMesh = findMeshByName(sceneClone, 'coronary_lcx_artery');

  if (frames.aortic) {
    const frame = frames.aortic;
    const ref = frames.pulmonary ? new THREE.Vector3().subVectors(frames.pulmonary.center, frame.center) : null;
    const { u, v } = makeBasis(frame.axis, ref);
    const spec = SEMILUNAR_SPECS.aortic;

    const rcaEnd = rcaMesh ? tubeEndNear(rcaMesh, frame.center) : null;
    const ladEnd = ladMesh ? tubeEndNear(ladMesh, frame.center) : null;
    const lcxEnd = lcxMesh ? tubeEndNear(lcxMesh, frame.center) : null;

    // Cusp order: 0 = right coronary, 1 and 2 = left/non-coronary
    let theta0 = 0;
    let leftIndex = 1;
    if (rcaEnd && (ladEnd || lcxEnd)) {
      const leftRef = ladEnd && lcxEnd
        ? new THREE.Vector3().addVectors(ladEnd.point, lcxEnd.point).multiplyScalar(0.5)
        : (ladEnd ?? lcxEnd)!.point;
      const aR = angleInPlane(rcaEnd.point, frame, u, v);
      const aL = angleInPlane(leftRef, frame, u, v);
      const sgn = wrapToPi(aL - aR) >= 0 ? 1 : -1;
      const midR = aR + wrapToPi(aL - sgn * TWO_PI_3 - aR) / 2;
      theta0 = midR - TWO_PI_3 / 2;
      leftIndex = sgn > 0 ? 1 : 2;
    }
    const valve: SemilunarValve = { type: 'aortic', frame, u, v, theta0, spec, cusps: [], sinus: null, ostia: [] };
    const base = cuspNames('aortic');
    const names: [string, string, string] = leftIndex === 1 ? [base[0], base[1], base[2]] : [base[0], base[2], base[1]];
    for (let k = 0; k < 3; k++) {
      const cusp = buildCusp(valve, k, names[k], cuspMaterial);
      valve.cusps.push(cusp);
      group.add(cusp.mesh);
      data.geometries.push(cusp.mesh.geometry);
    }
    valve.sinus = buildSinus(valve, sinusMaterialFrom(aortaMesh, new THREE.Color(0.82, 0.18, 0.18)));
    group.add(valve.sinus);
    data.geometries.push(valve.sinus.geometry);

    // Ostia in the right (cusp 0) and left (leftIndex) coronary sinuses
    if (spec.ostiumHeight > 0) {
      const ringMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.55, 0.08, 0.1), roughness: 0.5, side: THREE.DoubleSide, clipShadows: true });
      const holeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.08, 0.01, 0.02), roughness: 0.9, side: THREE.DoubleSide, clipShadows: true });
      data.materials.push(ringMat, holeMat);
      const ro = spec.ostiumRadius * frame.radius;
      const zo = spec.ostiumHeight * spec.sinusHeight * frame.radius;
      const zAxis = new THREE.Vector3(0, 0, 1);

      const placeOstium = (cuspIndex: number, name: SemilunarOstium['name']): SemilunarOstium => {
        const theta = theta0 + cuspIndex * TWO_PI_3 + TWO_PI_3 / 2;
        const position = pointOnFrame(new THREE.Vector3(), frame, u, v, theta, sinusRadius(valve, theta, zo), zo);
        const normal = new THREE.Vector3().addScaledVector(u, Math.cos(theta)).addScaledVector(v, Math.sin(theta)).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(zAxis, normal);

        const ringGeom = new THREE.TorusGeometry(ro, ro * 0.22, 8, 20);
        const ring = new THREE.Mesh(ringGeom, ringMat);
        ring.name = `${name}_rim`;
        ring.position.copy(position);
        ring.quaternion.copy(q);
        ring.userData = { name: ring.name, isStructure: true, isCoronaryOstium: true };

        const holeGeom = new THREE.CircleGeometry(ro, 20);
        const hole = new THREE.Mesh(holeGeom, holeMat);
        hole.name = name;
        hole.position.copy(position).addScaledVector(normal, -0.004 * frame.radius);
        hole.quaternion.copy(q);
        hole.userData = { name, isStructure: true, isCoronaryOstium: true };

        group.add(ring, hole);
        data.geometries.push(ringGeom, holeGeom);
        return { name, position, normal };
      };

      const ostR = placeOstium(0, 'right_coronary_ostium');
      const ostL = placeOstium(leftIndex, 'left_coronary_ostium');
      valve.ostia.push(ostR, ostL);

      // Proximal segments: ostium → start of the GLB coronary tubes
      const addConnector = (
        curve: THREE.Curve<THREE.Vector3>,
        radius: number,
        source: THREE.Mesh | null,
        name: string,
        territory: CoronaryConnector['territory'],
      ) => {
        const srcMat = source ? (Array.isArray(source.material) ? source.material[0] : source.material) : null;
        const material = (srcMat as any)?.isMeshStandardMaterial
          ? ((srcMat as THREE.MeshStandardMaterial).clone())
          : new THREE.MeshStandardMaterial({ color: new THREE.Color(0.93, 0.26, 0.26), roughness: 0.3 });
        material.side = THREE.DoubleSide;
        material.clipShadows = true;
        data.materials.push(material);
        const geom = new THREE.TubeGeometry(curve, 16, radius, 10, false);
        const mesh = new THREE.Mesh(geom, material);
        mesh.name = name;
        mesh.userData = territory
          ? { name, isVessel: true, territory, isCoronaryConnector: true }
          : { name, isStructure: true, isCoronaryConnector: true };
        group.add(mesh);
        data.geometries.push(geom);
        data.connectors.push({ mesh, material, territory });
      };

      if (rcaEnd && rcaMesh) {
        const dist = rcaEnd.point.distanceTo(ostR.position);
        const ctrl = ostR.position.clone().addScaledVector(ostR.normal, 0.45 * dist);
        addConnector(
          new THREE.QuadraticBezierCurve3(ostR.position.clone(), ctrl, rcaEnd.point.clone()),
          THREE.MathUtils.clamp(rcaEnd.radius, 0.6 * ro, 1.2 * ro),
          rcaMesh,
          'coronary_rca_proximal',
          'rca',
        );
      }
      if (ladEnd || lcxEnd) {
        const ends = [ladEnd, lcxEnd].filter((e): e is { point: THREE.Vector3; radius: number } => !!e);
        const nearest = Math.min(...ends.map((e) => e.point.distanceTo(ostL.position)));
        const lmRadius = THREE.MathUtils.clamp(Math.max(...ends.map((e) => e.radius)) * 1.15, 0.6 * ro, 1.2 * ro);
        const bif = ostL.position.clone().addScaledVector(ostL.normal, 0.45 * nearest);
        addConnector(new THREE.LineCurve3(ostL.position.clone(), bif.clone()), lmRadius, ladMesh ?? lcxMesh, 'coronary_left_main', null);
        if (ladEnd && ladMesh) {
          const ctrl = bif.clone().lerp(ladEnd.point, 0.4).addScaledVector(ostL.normal, 0.15 * nearest);
          addConnector(new THREE.QuadraticBezierCurve3(bif.clone(), ctrl, ladEnd.point.clone()), THREE.MathUtils.clamp(ladEnd.radius, 0.5 * ro, 1.1 * ro), ladMesh, 'coronary_lad_proximal', 'lad');
        }
        if (lcxEnd && lcxMesh) {
          const ctrl = bif.clone().lerp(lcxEnd.point, 0.4).addScaledVector(ostL.normal, 0.15 * nearest);
          addConnector(new THREE.QuadraticBezierCurve3(bif.clone(), ctrl, lcxEnd.point.clone()), THREE.MathUtils.clamp(lcxEnd.radius, 0.5 * ro, 1.1 * ro), lcxMesh, 'coronary_lcx_proximal', 'lcx');
        }
      }
    }
    data.valves.aortic = valve;
  }

  // --- Pulmonary: anterior cusp opposite the aorta; right and left facing the aorta ---
  if (frames.pulmonary) {
    const frame = frames.pulmonary;
    const ref = frames.aortic ? new THREE.Vector3().subVectors(frames.aortic.center, frame.center) : null;
    const { u, v } = makeBasis(frame.axis, ref);
    const spec = SEMILUNAR_SPECS.pulmonary;
    // u points toward the aorta (angle 0); the anterior cusp is centered at π
    const theta0 = Math.PI - TWO_PI_3 / 2;
    const valve: SemilunarValve = { type: 'pulmonary', frame, u, v, theta0, spec, cusps: [], sinus: null, ostia: [] };

    // Right/left: the left pulmonary cusp lies on the side of the left coronary cusp of the aorta
    let rightFirst = true;
    const ao = data.valves.aortic;
    if (ao) {
      const leftAo = ao.cusps.findIndex((c) => c.name === 'aortic_cusp_left_coronary');
      if (leftAo >= 0) {
        const thetaL = ao.theta0 + leftAo * TWO_PI_3 + TWO_PI_3 / 2;
        const leftMid = pointOnFrame(new THREE.Vector3(), ao.frame, ao.u, ao.v, thetaL, ao.frame.radius, 0);
        const mid1 = pointOnFrame(new THREE.Vector3(), frame, u, v, theta0 + TWO_PI_3 + TWO_PI_3 / 2, frame.radius, 0);
        const mid2 = pointOnFrame(new THREE.Vector3(), frame, u, v, theta0 + 2 * TWO_PI_3 + TWO_PI_3 / 2, frame.radius, 0);
        rightFirst = mid2.distanceTo(leftMid) <= mid1.distanceTo(leftMid);
      }
    }
    const base = cuspNames('pulmonary');
    const names: [string, string, string] = rightFirst ? [base[0], base[1], base[2]] : [base[0], base[2], base[1]];
    for (let k = 0; k < 3; k++) {
      const cusp = buildCusp(valve, k, names[k], cuspMaterial);
      valve.cusps.push(cusp);
      group.add(cusp.mesh);
      data.geometries.push(cusp.mesh.geometry);
    }
    valve.sinus = buildSinus(valve, sinusMaterialFrom(pulmMesh, new THREE.Color(0.18, 0.38, 0.85)));
    group.add(valve.sinus);
    data.geometries.push(valve.sinus.geometry);
    data.valves.pulmonary = valve;
  }

  // With the cusps assembled, the legacy flat discs are no longer displayed
  for (const d of alignedDiscs) {
    if (data.valves[d.valveType]) {
      d.mesh.visible = false;
      d.mesh.userData.replacedBySemilunar = true;
    }
  }

  return data;
}

// ----------------------------------------------------------------------------
// Hot path (useFrame): no allocation
// ----------------------------------------------------------------------------

function deformValve(valve: SemilunarValve | undefined, z: number): void {
  if (!valve) return;
  const cusps = valve.cusps;
  for (let c = 0; c < cusps.length; c++) {
    const cusp = cusps[c];
    const posAttr = cusp.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const nrmAttr = cusp.mesh.geometry.attributes.normal as THREE.BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const nrm = nrmAttr.array as Float32Array;
    const a = cusp.closed;
    const b = cusp.open;
    const na = cusp.closedNormals;
    const nb = cusp.openNormals;
    for (let i = 0; i < pos.length; i++) {
      pos[i] = a[i] + (b[i] - a[i]) * z;
      nrm[i] = na[i] + (nb[i] - na[i]) * z;
    }
    posAttr.needsUpdate = true;
    nrmAttr.needsUpdate = true;
  }
}

/** Applies ζ (0 = closed, 1 = open) to the cusps. Skips the upload if ζ did not change. */
export function applySemilunarDeformation(
  data: SemilunarValvesData | null,
  zAortic: number,
  zPulmonary: number,
): void {
  if (!data) return;
  const za = zAortic < 0 ? 0 : zAortic > 1 ? 1 : zAortic || 0;
  const zp = zPulmonary < 0 ? 0 : zPulmonary > 1 ? 1 : zPulmonary || 0;
  if (za !== data.lastZAortic) {
    deformValve(data.valves.aortic, za);
    data.lastZAortic = za;
  }
  if (zp !== data.lastZPulmonary) {
    deformValve(data.valves.pulmonary, zp);
    data.lastZPulmonary = zp;
  }
}

/** Frees GPU buffers (safe under StrictMode: three re-uploads if the object is rendered again). */
export function disposeSemilunarGpuResources(data: SemilunarValvesData | null): void {
  if (!data) return;
  for (const g of data.geometries) g.dispose();
  for (const m of data.materials) m.dispose();
}

// ----------------------------------------------------------------------------
// Measurements (diagnosis and tests; may allocate)
// ----------------------------------------------------------------------------

function freeEdgePoint(cusp: SemilunarCusp, i: number, out: THREE.Vector3): THREE.Vector3 {
  const arr = cusp.mesh.geometry.attributes.position.array as Float32Array;
  const o3 = (CUSP_SEGMENTS_T * (CUSP_SEGMENTS_S + 1) + i) * 3;
  return out.set(arr[o3], arr[o3 + 1], arr[o3 + 2]);
}

export interface SemilunarMeasure {
  /** Smallest distance between free edges of neighboring cusps, in model units. */
  minCoaptationGap: number;
  /** Area of the orifice bounded by the free edges / (π R²). */
  orificeFraction: number;
  /** Largest radial distance of any cusp vertex to the axis / local sinus radius (≤ 1 = inside the root). */
  maxRadialRatio: number;
}

export function measureSemilunarValve(valve: SemilunarValve | undefined): SemilunarMeasure | null {
  if (!valve || valve.cusps.length !== 3) return null;
  const { frame, u, v } = valve;
  const R = frame.radius;
  const ns = CUSP_SEGMENTS_S;
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();

  let minGap = Infinity;
  for (let c = 0; c < 3; c++) {
    const A = valve.cusps[c];
    const B = valve.cusps[(c + 1) % 3];
    for (let i = 0; i <= ns; i++) {
      freeEdgePoint(A, i, pa);
      for (let j = 0; j <= ns; j++) {
        const d = pa.distanceTo(freeEdgePoint(B, j, pb));
        if (d < minGap) minGap = d;
      }
    }
  }

  // Shoelace of the polygon formed by the three free edges in sequence, projected onto the valve plane
  let area2 = 0;
  let prevX = 0;
  let prevY = 0;
  let firstX = 0;
  let firstY = 0;
  let first = true;
  const d = new THREE.Vector3();
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i <= ns; i++) {
      d.subVectors(freeEdgePoint(valve.cusps[c], i, pa), frame.center);
      const x = d.dot(u);
      const y = d.dot(v);
      if (first) {
        firstX = x;
        firstY = y;
        first = false;
      } else {
        area2 += prevX * y - x * prevY;
      }
      prevX = x;
      prevY = y;
    }
  }
  area2 += prevX * firstY - firstX * prevY;
  const orificeFraction = Math.abs(area2) / 2 / (Math.PI * R * R);

  let maxRadialRatio = 0;
  for (const cusp of valve.cusps) {
    const arr = cusp.mesh.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      d.set(arr[i], arr[i + 1], arr[i + 2]).sub(frame.center);
      const z = d.dot(frame.axis);
      d.addScaledVector(frame.axis, -z);
      const theta = Math.atan2(d.dot(v), d.dot(u));
      const ratio = d.length() / sinusRadius(valve, theta, z);
      if (ratio > maxRadialRatio) maxRadialRatio = ratio;
    }
  }

  return { minCoaptationGap: minGap, orificeFraction, maxRadialRatio };
}

export function testSemilunarReversibility(data: SemilunarValvesData | null, cycles = 1000): number {
  if (!data) return 0;
  applySemilunarDeformation(data, 0, 0);
  const meshes: THREE.Mesh[] = [];
  for (const valve of Object.values(data.valves)) {
    if (valve) for (const c of valve.cusps) meshes.push(c.mesh);
  }
  const baseline = meshes.map((m) => new Float32Array(m.geometry.attributes.position.array as Float32Array));
  for (let i = 0; i < cycles; i++) applySemilunarDeformation(data, Math.random(), Math.random());
  applySemilunarDeformation(data, 0, 0);
  let maxDrift = 0;
  meshes.forEach((m, k) => {
    const arr = m.geometry.attributes.position.array as Float32Array;
    const b = baseline[k];
    for (let i = 0; i < arr.length; i++) {
      const dd = Math.abs(arr[i] - b[i]);
      if (dd > maxDrift) maxDrift = dd;
    }
  });
  return maxDrift;
}
