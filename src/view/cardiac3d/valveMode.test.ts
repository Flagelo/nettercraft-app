import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { setupSemilunarValves } from '../../model/cardiacGeometry/semilunarValve';
import {
  buildValveModeState,
  applyValveMode,
  classifyValveModeRole,
  VALVE_MODE_WALL_OPACITY,
} from '../../model/cardiacGeometry/valveMode';
import { CardiacViewport } from '.';

async function loadGlbScene(): Promise<THREE.Group> {
  const fsName = 'f' + 's';
  const pathName = 'p' + 'a' + 't' + 'h';
  const fsMod: any = await import(/* @vite-ignore */ fsName);
  const pathMod: any = await import(/* @vite-ignore */ pathName);
  const buffer = fsMod.readFileSync(pathMod.resolve('public/models/realistic_heart.glb'));
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.parse(arrayBuffer, '', (gltf) => resolve(gltf.scene), reject);
  });
}

/** Scene as in the app: GLB + procedural semilunar valves. */
async function loadAppLikeScene(): Promise<THREE.Group> {
  const scene = await loadGlbScene();
  setupSemilunarValves(scene);
  return scene;
}

function matOf(scene: THREE.Object3D, name: string): THREE.MeshStandardMaterial {
  const mesh = scene.getObjectByName(name) as THREE.Mesh;
  expect(mesh, name).toBeDefined();
  return (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
}

type Snap = { transparent: boolean; opacity: number; depthWrite: boolean; emissive: number; emissiveIntensity: number };

function snapAll(scene: THREE.Object3D): Map<THREE.Material, Snap> {
  const out = new Map<THREE.Material, Snap>();
  scene.traverse((o: any) => {
    if (!o.isMesh) return;
    const mats: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats as THREE.MeshStandardMaterial[]) {
      if (!m || out.has(m)) continue;
      out.set(m, {
        transparent: m.transparent,
        opacity: m.opacity,
        depthWrite: m.depthWrite,
        emissive: m.emissive ? m.emissive.getHex() : -1,
        emissiveIntensity: m.emissiveIntensity,
      });
    }
  });
  return out;
}

const WALLS = [
  'organui_aorta_ascending',
  'organui_aortic_arch',
  'organui_pulmonary_trunk',
  'organui_superior_vena_cava',
  'right_ventricle',
  'left_atrium',
  'right_atrium',
  'heart_segment_1_basal_anterior',
  'heart_segment_17_apex',
  'coronary_left_main',
  'coronary_rca_proximal',
];
const VALVES = [
  'aortic_cusp_right_coronary',
  'pulmonary_cusp_anterior',
  'mitral_anterior_leaflet',
  'tricuspid_septal_leaflet',
  'mitral_annulus',
  'tricuspid_annulus',
  'mitral_anterolateral_chorda_1',
];

describe('VALVE MODE (semitransparent walls, highlighted valves)', () => {
  it('default state off: inactive button in the bar and no material changed at setup', async () => {
    const html = renderToStaticMarkup(React.createElement(CardiacViewport));
    const button = html.match(/<button[^>]*>[^<]*MODO VALVAS[^<]*<\/button>/);
    expect(button).not.toBeNull();
    expect(button![0]).toContain('aria-pressed="false"');
    expect(button![0]).not.toMatch(/class="btn-chip active"/);

    const scene = await loadAppLikeScene();
    const before = snapAll(scene);
    const state = buildValveModeState(scene);
    expect(state.active).toBe(false);
    const after = snapAll(scene);
    for (const [m, s] of before) expect(after.get(m)).toEqual(s);
  });

  it('classifies walls (vessels, chambers, LV, proximal coronaries) and valves; sinuses and ostia are left out', async () => {
    const scene = await loadAppLikeScene();
    for (const n of WALLS) expect(classifyValveModeRole(scene.getObjectByName(n)!), n).toBe('wall');
    for (const n of VALVES) expect(classifyValveModeRole(scene.getObjectByName(n)!), n).toBe('valve');
    for (const n of ['aortic_sinuses_of_valsalva', 'pulmonary_sinuses', 'right_coronary_ostium', 'coronary_lad_artery', 'mitral_anterolateral_papillary_muscle']) {
      expect(classifyValveModeRole(scene.getObjectByName(n)!), n).toBeNull();
    }
  });

  it('on: walls with low opacity and no depthWrite; opaque and highlighted valves', async () => {
    const scene = await loadAppLikeScene();
    const state = buildValveModeState(scene);
    applyValveMode(state, true);
    expect(state.active).toBe(true);
    expect(VALVE_MODE_WALL_OPACITY).toBeGreaterThanOrEqual(0.12);
    expect(VALVE_MODE_WALL_OPACITY).toBeLessThanOrEqual(0.25);
    for (const n of WALLS) {
      const m = matOf(scene, n);
      expect(m.transparent, n).toBe(true);
      expect(m.opacity, n).toBeCloseTo(VALVE_MODE_WALL_OPACITY, 6);
      expect(m.depthWrite, n).toBe(false);
    }
    for (const n of VALVES) {
      const m = matOf(scene, n);
      expect(m.transparent, n).toBe(false);
      expect(m.opacity, n).toBe(1);
      expect(m.depthWrite, n).toBe(true);
      expect(m.emissive.getHex(), n).not.toBe(0);
    }
  });

  it('off: exactly restores all materials, including after turning on twice', async () => {
    const scene = await loadAppLikeScene();
    const original = snapAll(scene);
    const state = buildValveModeState(scene);
    applyValveMode(state, true);
    applyValveMode(state, true);
    applyValveMode(state, false);
    expect(state.active).toBe(false);
    const restored = snapAll(scene);
    expect(restored.size).toBe(original.size);
    for (const [m, s] of original) expect(restored.get(m)).toEqual(s);
    // The semitransparent sinus of the semilunar component is not touched
    const sinus = matOf(scene, 'pulmonary_sinuses');
    expect(sinus.transparent).toBe(true);
    expect(sinus.depthWrite).toBe(false);
  });
});
