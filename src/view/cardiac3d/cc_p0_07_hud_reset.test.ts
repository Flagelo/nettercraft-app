import { afterEach, expect, it, vi } from 'vitest';

// Execute the real component and its draw callback. Only the React hook host and
// canvas/GPU surface are substituted; store reset subscriptions remain real.
const host = vi.hoisted(() => ({ refs: [] as any[], cleanups: [] as (() => void)[], draw: null as any }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<any>();
  const hooks = {
    useRef: (value: any) => { const ref = { current: value }; host.refs.push(ref); return ref; },
    useState: (value: any) => [typeof value === 'function' ? value() : value, vi.fn()],
    useEffect: (fn: () => any) => { const cleanup = fn(); if (cleanup) host.cleanups.push(cleanup); },
  };
  return { ...actual, ...hooks, default: { ...actual.default, ...hooks } };
});
vi.mock('../../controller/usePhysiologyStore', async importOriginal => {
  const actual = await importOriginal<any>();
  const store = Object.assign((selector: any) => selector(actual.usePhysiologyStore.getState()), actual.usePhysiologyStore);
  return { ...actual, usePhysiologyStore: store };
});
vi.mock('../../controller/useRafLoop', () => ({ useCanvas2D: (draw: any) => { host.draw = draw; return { current: null }; } }));
vi.mock('@react-three/fiber', () => ({ Canvas: () => null }));
vi.mock('@react-three/drei', () => ({ OrbitControls: () => null }));
vi.mock('./HeartMesh17', () => ({ HeartElectromechanicalScene: () => null }));
vi.mock('./AhaBullseye', () => ({ AhaBullseye: () => null }));

import { CardiacViewport } from '.';
import { usePhysiologyStore as store } from '../../controller/usePhysiologyStore';

function mountHud() {
  function find(node: any): any {
    if (!node) return;
    if (Array.isArray(node)) { for (const child of node) { const found = find(child); if (found) return found; } }
    if (node.type?.name === 'FrankVcgHudCanvas') return node.type;
    return find(node.props?.children);
  }
  find(CardiacViewport())();
  const ctx = { fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    arc: vi.fn(), fill: vi.fn(), fillText: vi.fn() };
  return { ctx, draw: () => { ctx.lineTo.mockClear(); host.draw(ctx, 220, 102); },
    arrays: () => host.refs.map(r => r.current).filter(v => v instanceof Float32Array) as Float32Array[] };
}

afterEach(() => { host.cleanups.splice(0).forEach(fn => fn()); host.refs.length = 0; host.draw = null; });

it('C3 clears actual HUD history synchronously on paused reset; draw cannot refill it until a new step', () => {
  const h = mountHud(), live = store.getState().live;
  for (let i = 0; i < 240; i++) { live.clock.t += 0.016; live.electro.vector.set([0.2,0.3,0.4]); h.draw(); }
  expect(h.arrays().some(a => a.some(v => v !== 0))).toBe(true);
  store.getState().setRunning(false); live.clock.t = 0; live.electro.vector.fill(0); store.getState().requestReset();
  expect(h.arrays().every(a => a.every(v => v === 0))).toBe(true);
  for (let i = 0; i < 6; i++) { h.draw(); expect(h.ctx.lineTo).toHaveBeenCalledTimes(4); } // axes only, zero history
  store.getState().setRunning(true); live.clock.t = 0.001; live.electro.vector.set([0.5,0.6,0.7]); h.draw();
  expect(h.arrays().some(a => a.some(v => v !== 0))).toBe(true);
  live.clock.t = 0.002; h.draw(); expect(h.ctx.lineTo).toHaveBeenCalledTimes(6); // two 2-point curves + axes
});

it('C3 repeated reset while paused remains empty and unmount removes its subscription', () => {
  const h = mountHud(), live = store.getState().live;
  live.clock.t += 1; live.electro.vector.set([1,1,1]); h.draw(); store.getState().setRunning(false);
  for (let i = 0; i < 6; i++) { store.getState().requestReset(); h.draw(); expect(h.ctx.lineTo).toHaveBeenCalledTimes(4); }
  const arrays = h.arrays(); host.cleanups.splice(0).forEach(fn => fn()); arrays.forEach(a => a.fill(7));
  store.getState().requestReset(); expect(arrays.every(a => a.every(v => v === 7))).toBe(true);
});
