import * as THREE from 'three';

// ============================================================================
// VALVE MODE: vessel and chamber walls become semitransparent (without
// depth write) and the valves become opaque and highlighted, so that the aortic,
// pulmonary, mitral and tricuspid valves appear together without depending on the clipping plane.
// When turned off, each material returns EXACTLY to the values captured at setup.
// The switch runs only when the state changes (never per frame) and does not allocate.
// ============================================================================

/** Wall opacity with the mode on (authorized range: 0.12–0.25). */
export const VALVE_MODE_WALL_OPACITY = 0.18;

/** Emissive highlight of the valves with the mode on (warm ivory, subtle). */
export const VALVE_MODE_VALVE_EMISSIVE = new THREE.Color(0.18, 0.13, 0.1);

export type ValveModeRole = 'wall' | 'valve';

interface MaterialSnapshot {
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
  emissive: THREE.Color | null;
  emissiveIntensity: number;
}

export interface ValveModeEntry {
  material: THREE.MeshStandardMaterial;
  role: ValveModeRole;
  original: MaterialSnapshot;
}

export interface ValveModeState {
  entries: ValveModeEntry[];
  active: boolean;
}

const WALL_NAMES = ['right_ventricle', 'left_atrium', 'right_atrium'];

/**
 * Role of a mesh in valve mode, from the GLB metadata (extras) and from the
 * markers that HeartMesh17 and the semilunar component write to userData.
 * null = unchanged (sinuses already semitransparent, ostia, epicardial coronaries,
 * papillary muscles, vectors and other structures).
 */
export function classifyValveModeRole(mesh: THREE.Object3D): ValveModeRole | null {
  const u: any = mesh.userData || {};
  const name = String(u.name || mesh.name || '').toLowerCase();

  // Valves: semilunar cusps, leaflets, annuli and AV chordae
  if (u.isSemilunarCusp || u.isLeaflet || u.isAnnulus) return 'valve';
  if (u.structureType === 'leaflet' || u.structureType === 'annulus') return 'valve';
  if (u.subvalvarType === 'chordae_tendineae') return 'valve';

  // Structures that stay as they are
  if (u.isSemilunarSinus || u.isCoronaryOstium || u.isPlanarDisc) return null;

  // Walls: great vessels (aorta, pulmonary trunk, vena cava), proximal coronaries and chambers
  if (u.isCoronaryConnector) return 'wall';
  if (u.isGreatVessel) return 'wall';
  if (u.chamber === 'rv' || u.chamber === 'la' || u.chamber === 'ra' || u.chamber === 'aorta' || u.chamber === 'pulmonary') return 'wall';
  if (u.isExplicitSegment || u.isVentricular) return 'wall';
  if (WALL_NAMES.includes(name)) return 'wall';
  if (name.startsWith('heart_segment_')) return 'wall';
  return null;
}

function snapshot(m: THREE.MeshStandardMaterial): MaterialSnapshot {
  return {
    transparent: m.transparent,
    opacity: m.opacity,
    depthWrite: m.depthWrite,
    emissive: m.emissive ? m.emissive.clone() : null,
    emissiveIntensity: m.emissiveIntensity,
  };
}

/** Captures (once, at setup) the affected materials and their original values. */
export function buildValveModeState(root: THREE.Object3D | null): ValveModeState {
  const entries: ValveModeEntry[] = [];
  if (!root) return { entries, active: false };
  const seen = new Set<THREE.Material>();
  root.traverse((child: any) => {
    if (!child?.isMesh) return;
    const role = classifyValveModeRole(child);
    if (!role) return;
    const mats: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat || seen.has(mat) || !(mat as any).isMeshStandardMaterial) continue;
      seen.add(mat);
      const m = mat as THREE.MeshStandardMaterial;
      entries.push({ material: m, role, original: snapshot(m) });
    }
  });
  return { entries, active: false };
}

/** Turns the mode on or off. Idempotent; no allocation. */
export function applyValveMode(state: ValveModeState | null, on: boolean): void {
  if (!state) return;
  const entries = state.entries;
  for (let i = 0; i < entries.length; i++) {
    const { material: m, role, original: o } = entries[i];
    if (on) {
      if (role === 'wall') {
        m.transparent = true;
        m.opacity = VALVE_MODE_WALL_OPACITY;
        m.depthWrite = false;
      } else {
        m.transparent = false;
        m.opacity = 1;
        m.depthWrite = true;
        if (m.emissive) m.emissive.copy(VALVE_MODE_VALVE_EMISSIVE);
        m.emissiveIntensity = 1;
      }
    } else {
      m.transparent = o.transparent;
      m.opacity = o.opacity;
      m.depthWrite = o.depthWrite;
      // Emissive is only touched on the valves (the walls' is animated per frame in HeartMesh17)
      if (role === 'valve') {
        if (m.emissive && o.emissive) m.emissive.copy(o.emissive);
        m.emissiveIntensity = o.emissiveIntensity;
      }
    }
    m.needsUpdate = true;
  }
  state.active = on;
}
