import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MasterPhysiologyClock } from '../../controller/MasterPhysiologyClock';
import { defaultParams, createLiveState } from '../../controller/usePhysiologyStore';
import type { SimContext } from '../contracts/types';
import { HemodynamicEngine } from '../hemodynamics/HemodynamicEngine';
import * as rv from './rvContraction';
import { applyRvProceduralGeometry } from './rvGeometry';
import { applyTricuspidApparatusPose } from './tricuspidApparatusPose';

// RV pending items 1 and 3 (07/11/2026):
//  P1: RV emissive glow by (1 − rvRig.fill), zero glow without rig.
//  P3: wireframe RV with its own volume tracker and scale by (1 − fill), coefficients 0.18 and 0.08.
// The helpers are read from the namespace so that, on the old code (without them), each test fails by assertion.

const R = rv as any;

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

async function readSource(rel: string): Promise<string> {
  const fsName = 'f' + 's';
  const pathName = 'p' + 'a' + 't' + 'h';
  const fsMod: any = await import(/* @vite-ignore */ fsName);
  const pathMod: any = await import(/* @vite-ignore */ pathName);
  return fsMod.readFileSync(pathMod.resolve(rel), 'utf8');
}

async function buildRig(): Promise<rv.RvContractionRig> {
  const scene = await loadGlbScene();
  scene.updateMatrixWorld(true);
  // Phase 4: rig on the procedural wall and the posed annulus, as in HeartMesh17
  applyRvProceduralGeometry(scene);
  applyTricuspidApparatusPose(scene);
  const rig = rv.setupRvContraction(
    scene.getObjectByName('right_ventricle') as THREE.Mesh,
    scene.getObjectByName('tricuspid_annulus') as THREE.Mesh,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, 0),
  );
  if (!rig) throw new Error('rig do VD não inicializado');
  return rig;
}

interface Trace {
  vRV: number[];
  zTr: number[];
  zPu: number[];
  tSinceQRS: number[];
  beat: number[];
  glowR: number[];
  glowG: number[];
  glowB: number[];
  wfXZ: number[];
  wfY: number[];
  wfFill: number[];
}

/** Engine + clock at 1 ms (75 bpm by default); at each step applies rig, glow and wireframe as in useFrame. */
function run(rig: rv.RvContractionRig | null, seconds: number, recordFrom: number, bbb: 'none' | 'rbbb' = 'none'): Trace {
  const clock = new MasterPhysiologyClock();
  const params = defaultParams();
  params.ecg.bundleBranchBlock = bbb;
  const live = createLiveState();
  live.clock = clock.state;
  const ctx: SimContext = { clock: clock.state, live, params };
  const cmd = () => ({
    hr: live.hemo.hrCommand > 0 ? live.hemo.hrCommand : params.ecg.heartRate,
    rhythm: params.ecg.rhythm,
    flutterConduction: params.ecg.flutterConduction,
    qtc: params.ecg.qtc,
    respRate: params.ventilation.respRate,
    inspFraction: 1 / 3,
  });
  clock.reset(cmd());
  const engine = new HemodynamicEngine();
  engine.reset(ctx);
  if (rig) {
    rig.tracker = rv.createRvVolumeTracker();
    rig.refVolume = 0;
    rig.lastT = NaN;
  }
  const emissive = new THREE.Color();
  const wfScale = new THREE.Vector3(1, 1, 1);
  const wf = typeof R.createRvWireframeDriver === 'function' ? R.createRvWireframeDriver() : null;
  const tr: Trace = { vRV: [], zTr: [], zPu: [], tSinceQRS: [], beat: [], glowR: [], glowG: [], glowB: [], wfXZ: [], wfY: [], wfFill: [] };
  const steps = Math.round(seconds * 1000);
  const rec0 = Math.round(recordFrom * 1000);
  for (let i = 0; i < steps; i++) {
    clock.step(0.001, cmd());
    engine.step(0.001, ctx);
    if (rig) rv.updateRvDriver(rig, live.hemo.vRV, clock.state.beatIndex, clock.state.t);
    if (typeof R.applyRvChamberEmissive === 'function') R.applyRvChamberEmissive(emissive, rig);
    if (wf) R.updateRvWireframe(wf, live.hemo.vRV, clock.state.beatIndex, wfScale);
    if (i >= rec0) {
      tr.vRV.push(live.hemo.vRV);
      tr.zTr.push(live.hemo.zTricuspid);
      tr.zPu.push(live.hemo.zPulmonary);
      tr.tSinceQRS.push(clock.state.tSinceQRS);
      tr.beat.push(clock.state.beatIndex);
      tr.glowR.push(emissive.r);
      tr.glowG.push(emissive.g);
      tr.glowB.push(emissive.b);
      tr.wfXZ.push(wfScale.x);
      tr.wfY.push(wfScale.y);
      tr.wfFill.push(wf ? wf.fill : NaN);
    }
  }
  return tr;
}

/** Maximum drift of a series in the RV isovolumetric phases (tricuspid and pulmonary closed, z < 0.25). */
function isovolumetricDrift(tr: Trace, series: number[]): { drift: number; n: number } {
  let drift = 0;
  let n = 0;
  let start = -1;
  for (let i = 0; i < series.length; i++) {
    const closed = tr.zTr[i] < 0.25 && tr.zPu[i] < 0.25 && tr.tSinceQRS[i] < 0.5;
    if (closed) {
      if (start < 0) start = i;
      drift = Math.max(drift, Math.abs(series[i] - series[start]));
      n++;
    } else start = -1;
  }
  return { drift, n };
}

/** Per full beat of the window: series value at EDV (max vRV) and at ESV (min vRV). */
function atEdEs(tr: Trace, series: number[]): { ed: number[]; es: number[]; beatMin: number[]; beatMax: number[] } {
  const ed: number[] = [];
  const es: number[] = [];
  const beatMin: number[] = [];
  const beatMax: number[] = [];
  let i = 0;
  while (i < tr.beat.length) {
    const b = tr.beat[i];
    let j = i;
    let iMax = i;
    let iMin = i;
    let sMin = Infinity;
    let sMax = -Infinity;
    while (j < tr.beat.length && tr.beat[j] === b) {
      if (tr.vRV[j] > tr.vRV[iMax]) iMax = j;
      if (tr.vRV[j] < tr.vRV[iMin]) iMin = j;
      if (series[j] < sMin) sMin = series[j];
      if (series[j] > sMax) sMax = series[j];
      j++;
    }
    // only whole beats inside the window
    if (i > 0 && j < tr.beat.length) {
      ed.push(series[iMax]);
      es.push(series[iMin]);
      beatMin.push(sMin);
      beatMax.push(sMax);
    }
    i = j;
  }
  return { ed, es, beatMin, beatMax };
}

// The fill uses EDV/ESV of the previous beat (tracker); with the respiratory variation of vRV, the EDV of a
// beat may be a few % below the previous one, so the glow at EDV does not reach exactly zero.
// Measured at 75 bpm on 07/11/2026: up to 8.2% of the excursion. Absolute tolerance: 15%.
const RESP_TOL = 0.15;

const GLOW_R = 0.28;
const GLOW_G = 0.14;
const GLOW_B = 0.04;

describe('P1: RV emissive glow by (1 − rvRig.fill)', () => {
  it('exports applyRvChamberEmissive and the fallback without rig is zero glow', () => {
    expect(typeof R.applyRvChamberEmissive).toBe('function');
    const c = new THREE.Color(0.9, 0.9, 0.9);
    const out = R.applyRvChamberEmissive(c, null);
    expect(out).toBe(c);
    expect(c.r).toBe(0);
    expect(c.g).toBe(0);
    expect(c.b).toBeCloseTo(GLOW_B, 9);
    // material without emissive (undefined): does not throw
    expect(() => R.applyRvChamberEmissive(undefined, null)).not.toThrow();
  });

  it('follows exactly (1 − fill) of the rig', async () => {
    expect(typeof R.applyRvChamberEmissive).toBe('function');
    const rig = await buildRig();
    const c = new THREE.Color();
    for (const fill of [1, 0.75, 0.5, 0.2, 0]) {
      rig.fill = fill;
      R.applyRvChamberEmissive(c, rig);
      expect(c.r).toBeCloseTo(GLOW_R * (1 - fill), 9);
      expect(c.g).toBeCloseTo(GLOW_G * (1 - fill), 9);
      expect(c.b).toBeCloseTo(GLOW_B, 9);
    }
  });

  it('at 75 bpm: still in the isovolumetric phases, minimum at EDV and maximum at ESV', async () => {
    expect(typeof R.applyRvChamberEmissive).toBe('function');
    const rig = await buildRig();
    const tr = run(rig, 8, 4);
    const { drift, n } = isovolumetricDrift(tr, tr.glowR);
    expect(n).toBeGreaterThan(20);
    // same tolerance as the mesh test: < 3% of the excursion (residual leak of the Mynard valves)
    expect(drift / GLOW_R).toBeLessThan(0.03);
    const { ed, es, beatMin, beatMax } = atEdEs(tr, tr.glowR);
    expect(ed.length).toBeGreaterThanOrEqual(3);
    for (let k = 0; k < ed.length; k++) {
      // in each beat: minimum exactly at EDV and maximum exactly at ESV
      expect(ed[k]).toBe(beatMin[k]);
      expect(es[k]).toBe(beatMax[k]);
      expect(ed[k]).toBeLessThan(RESP_TOL * GLOW_R);
      expect(es[k]).toBeGreaterThan((1 - RESP_TOL) * GLOW_R);
    }
    // eslint-disable-next-line no-console
    console.info(`[P1] brilho R: deriva isovolumétrica ${(drift / GLOW_R * 100).toFixed(3)}% (n=${n}) · no VDF máx ${(Math.max(...ed) / GLOW_R * 100).toFixed(2)}% · no VSF mín ${(Math.min(...es) / GLOW_R * 100).toFixed(2)}% da excursão`);
  });
});

describe('P3: wireframe RV with its own tracker and scale by (1 − fill)', () => {
  it('exports the driver; rest at 1 before the first beat; coefficients 0.18 and 0.08', () => {
    expect(typeof R.createRvWireframeDriver).toBe('function');
    expect(typeof R.updateRvWireframe).toBe('function');
    expect(R.RV_WIREFRAME_CONTRACTION_XZ).toBe(0.18);
    expect(R.RV_WIREFRAME_CONTRACTION_Y).toBe(0.08);
    const d = R.createRvWireframeDriver();
    const s = new THREE.Vector3(5, 5, 5);
    R.updateRvWireframe(d, 120, 0, s);
    expect(d.fill).toBe(1);
    expect(s.x).toBe(1);
    expect(s.y).toBe(1);
    expect(s.z).toBe(1);
    // synthetic beats EDV 150 / ESV 60
    for (let b = 1; b <= 2; b++) for (let k = 0; k <= 100; k++) R.updateRvWireframe(d, 60 + 90 * Math.abs(Math.cos((Math.PI * k) / 100)), b, s);
    R.updateRvWireframe(d, 60, 3, s);
    expect(d.fill).toBe(0);
    expect(s.x).toBeCloseTo(1 - 0.18, 12);
    expect(s.y).toBeCloseTo(1 - 0.08, 12);
    expect(s.z).toBeCloseTo(1 - 0.18, 12);
    R.updateRvWireframe(d, 105, 3, s);
    expect(d.fill).toBeCloseTo(0.5, 12);
    expect(s.x).toBeCloseTo(1 - 0.09, 12);
    expect(s.y).toBeCloseTo(1 - 0.04, 12);
  });

  it('at 75 bpm: scale still in the isovolumetric phases; 1 at EDV and minimum at ESV', () => {
    expect(typeof R.createRvWireframeDriver).toBe('function');
    const tr = run(null, 8, 4);
    const dXZ = isovolumetricDrift(tr, tr.wfXZ);
    const dY = isovolumetricDrift(tr, tr.wfY);
    expect(dXZ.n).toBeGreaterThan(20);
    expect(dXZ.drift / 0.18).toBeLessThan(0.03);
    expect(dY.drift / 0.08).toBeLessThan(0.03);
    const { ed, es, beatMin, beatMax } = atEdEs(tr, tr.wfXZ);
    expect(ed.length).toBeGreaterThanOrEqual(3);
    for (let k = 0; k < ed.length; k++) {
      // in each beat: maximum scale (larger RV) at EDV and minimum at ESV
      expect(ed[k]).toBe(beatMax[k]);
      expect(es[k]).toBe(beatMin[k]);
      expect(ed[k]).toBeGreaterThan(1 - RESP_TOL * 0.18);
      expect(es[k]).toBeLessThan(1 - (1 - RESP_TOL) * 0.18);
    }
    // eslint-disable-next-line no-console
    console.info(`[P3] escala XZ: deriva isovolumétrica ${(dXZ.drift / 0.18 * 100).toFixed(3)}% · VDF mín ${Math.min(...ed).toFixed(4)} · VSF máx ${Math.max(...es).toFixed(4)}`);
  });

  it('preserves the RBBB delay: the wireframe scale starts to fall later after the QRS', () => {
    expect(typeof R.createRvWireframeDriver).toBe('function');
    const onset = (bbb: 'none' | 'rbbb') => {
      const tr = run(null, 8, 4, bbb);
      const out: number[] = [];
      for (let i = 1; i < tr.wfXZ.length; i++) {
        // first drop below 2% of the excursion after the QRS
        const thr = 1 - 0.02 * 0.18;
        if (tr.wfXZ[i - 1] >= thr && tr.wfXZ[i] < thr && tr.tSinceQRS[i] < 0.3) out.push(tr.tSinceQRS[i]);
      }
      return out;
    };
    const tN = onset('none');
    const tB = onset('rbbb');
    expect(tN.length).toBeGreaterThanOrEqual(3);
    expect(tB.length).toBeGreaterThanOrEqual(3);
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    expect(mean(tB) - mean(tN)).toBeGreaterThan(0.02);
    // eslint-disable-next-line no-console
    console.info(`[P3] início da queda após o QRS: normal ${(mean(tN) * 1000).toFixed(1)} ms · BRD ${(mean(tB) * 1000).toFixed(1)} ms · atraso ${((mean(tB) - mean(tN)) * 1000).toFixed(1)} ms`);
  });
});

describe('P1/P3: integration and zero allocation per frame', () => {
  it('the per-frame helpers do not allocate (no new, array/object literals, closures or .map) and reuse the output', () => {
    for (const name of ['applyRvChamberEmissive', 'updateRvWireframe', 'rvFillFraction', 'updateRvVolumeTracker']) {
      const fn = R[name];
      expect(typeof fn).toBe('function');
      const body = String(fn).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(body).not.toMatch(/\bnew\s/);
      expect(body).not.toMatch(/=>/);
      expect(body).not.toMatch(/\bfunction\b[\s\S]*\bfunction\b/);
      expect(body).not.toMatch(/\.(map|filter|reduce|slice|concat)\(/);
      expect(body).not.toMatch(/[=(,]\s*\[/);
      expect(body).not.toMatch(/[=(,]\s*\{/);
    }
    const d = R.createRvWireframeDriver();
    const s = new THREE.Vector3();
    const tracker = d.tracker;
    for (let k = 0; k < 2000; k++) R.updateRvWireframe(d, 100 + 40 * Math.sin(k * 0.01), Math.floor(k / 800), s);
    expect(d.tracker).toBe(tracker);
    const c = new THREE.Color();
    expect(R.applyRvChamberEmissive(c, null)).toBe(c);
  });

  it('HeartMesh17 uses the helpers in place of hemo.eRV (RV glow and wireframe with useRef)', async () => {
    const src = await readSource('src/view/cardiac3d/HeartMesh17.tsx');
    expect(src).not.toMatch(/\beRV\b/);
    expect(src).toMatch(/applyRvChamberEmissive\(\s*material\?\.emissive,\s*rvRig\s*\)/);
    expect(src).toMatch(/useRef<RvWireframeDriver \| null>\(null\)/);
    expect(src).toMatch(/rvWireframeDriver\.current = createRvWireframeDriver\(\)/);
    expect(src).toMatch(/updateRvWireframe\(\s*rvWireframeDriver\.current,\s*hemo\.vRV,\s*clock\.beatIndex,\s*rvMeshRef\.current\.scale\s*\)/);
  });
});
