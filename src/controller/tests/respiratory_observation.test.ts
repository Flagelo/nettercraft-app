import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClinicalParams } from '../../model/contracts/types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Observation = {
  valid: boolean;
  status: 'awaiting-window' | 'partial-window' | 'resp-rate-zero' | 'valid';
  source: 'initial' | 'measured' | 'historical';
  windowStart: number | null;
  windowEnd: number | null;
  publishedAt: number | null;
  ageSeconds: number | null;
  sampleCount: number;
  beatCount: number;
  respiratoryRate: number;
};
async function boot(setup: (p: ClinicalParams) => void = () => {}) {
  vi.resetModules();
  const { usePhysiologyStore: store, defaultParams } = await import('../usePhysiologyStore');
  const { getSimulationLoop } = await import('../SimulationLoop');
  const { HemodynamicEngine } = await import('../../model/hemodynamics/HemodynamicEngine');
  const loop = getSimulationLoop();
  loop.register(new HemodynamicEngine());
  const p = defaultParams(); setup(p);
  store.getState().loadPreset(p); loop.reset();
  return { loop, store, params: p };
}
type Harness = Awaited<ReturnType<typeof boot>>;
const metadata = (h: Harness) =>
  (h.loop.context.live.hemo as unknown as { respObservation?: Observation }).respObservation;
const ivc = (pRA: number, pPl: number) =>
  6 + 18.5 / (1 + Math.exp(-((pRA - 0.85 * pPl - 2) - 3.5) / 2.6));

const scenarios: { name: string; setup: (p: ClinicalParams) => void }[] = [
  { name: 'nominal', setup: () => {} },
  { name: 'VM4000NPS3', setup: p => {
    p.ecg.heartRate = 95; p.circulation.bloodVolume = 4000;
    p.drugs.nitroprusside = 3; p.ventilation.mode = 'mechanical';
    p.ventilation.peep = 12; p.ventilation.drivingPressure = 20;
  } },
  { name: 'FA92', setup: p => { p.ecg.rhythm = 'af'; p.ecg.heartRate = 92; } },
  { name: 'flutter3:1', setup: p => { p.ecg.rhythm = 'flutter'; p.ecg.flutterConduction = 3; } },
];

describe('CC-P0-05 — respiratory observer after reset, contract R1–R6', () => {
  for (const scenario of scenarios) {
    it(`first two new windows agree with independent oracle: ${scenario.name}`, async () => {
      const h = await boot(scenario.setup);
      const hemo = h.loop.context.live.hemo;
      expect(metadata(h)?.valid, 'sementes não são publicações válidas em t0').toBe(false);
      expect(metadata(h)?.source).toBe('initial');
      let beatIndex = h.loop.clock.state.beatIndex;
      let prevRespPhi = h.loop.clock.state.phiResp;
      let maxPAo = -Infinity, minPAo = Infinity, beatSamples = 0, fullBeat = false;
      let minIvc = Infinity, maxIvc = -Infinity, pp: number[] = [];
      let windows = 0;
      for (let i = 0; i < 10_000; i++) {
        h.loop.advance(0.001);
        const clock = h.loop.clock.state;
        if (clock.beatIndex !== beatIndex) {
          if (fullBeat && beatSamples > 50) pp.push(Math.max(5, maxPAo - minPAo));
          beatIndex = clock.beatIndex;
          maxPAo = hemo.pAo; minPAo = hemo.pAo; beatSamples = 0; fullBeat = true;
        } else {
          maxPAo = Math.max(maxPAo, hemo.pAo);
          minPAo = Math.min(minPAo, hemo.pAo);
          beatSamples++;
        }
        const diameter = ivc(hemo.pRA, hemo.pPl);
        minIvc = Math.min(minIvc, diameter);
        maxIvc = Math.max(maxIvc, diameter);
        if (clock.phiResp < prevRespPhi) {
          windows++;
          expect(pp.length, 'oráculo: batimentos inteiros pós-reset').toBeGreaterThan(0);
          const pmax = Math.max(...pp), pmin = Math.min(...pp);
          const expectedPpv = Math.round(200 * (pmax - pmin) / Math.max(2, pmax + pmin));
          const expectedIndex = Math.round(100 * (maxIvc - minIvc)
            / Math.max(1, h.params.ventilation.mode === 'spontaneous' ? maxIvc : minIvc));
          const obs = metadata(h);
          expect(obs?.valid, 'janela respiratória completa').toBe(true);
          expect(obs?.status).toBe('valid');
          expect(obs?.source).toBe('measured');
          expect(obs?.sampleCount).toBeGreaterThan(0);
          expect(obs?.beatCount).toBe(pp.length);
          expect(obs?.windowEnd).toBeCloseTo(clock.t, 3);
          expect(Math.abs(hemo.ppv - expectedPpv)).toBeLessThanOrEqual(1);
          expect(Math.abs(hemo.ivcDmin - Number(minIvc.toFixed(1)))).toBeLessThanOrEqual(0.10001);
          expect(Math.abs(hemo.ivcDmax - Number(maxIvc.toFixed(1)))).toBeLessThanOrEqual(0.10001);
          expect(Math.abs(hemo.ivcIndex - expectedIndex)).toBeLessThanOrEqual(1);
          pp = []; minIvc = Infinity; maxIvc = -Infinity;
        }
        prevRespPhi = clock.phiResp;
      }
      expect(windows).toBe(2);
    }, 30_000);
  }

  it('RR0 from reset: does not publish initial number as a measured index', async () => {
    const h = await boot(p => { p.ventilation.respRate = 0; });
    const v = h.loop.context.live.hemo;
    expect(metadata(h)?.status).toBe('resp-rate-zero');
    expect(metadata(h)?.valid).toBe(false);
    expect(metadata(h)?.publishedAt).toBeNull();
    const seed = [v.ppv, v.ivcDmin, v.ivcDmax, v.ivcIndex];
    h.loop.advance(6);
    expect(metadata(h)?.status).toBe('resp-rate-zero');
    expect(metadata(h)?.valid).toBe(false);
    expect(metadata(h)?.publishedAt).toBeNull();
    expect([v.ppv, v.ivcDmin, v.ivcDmax, v.ivcIndex]).toEqual(seed);
  }, 30_000);

  it('RR14→0 keeps last value as INVALID history, with age; return does not authenticate a partial window', async () => {
    const h = await boot();
    const v = h.loop.context.live.hemo;
    h.loop.advance(5);
    expect(metadata(h)?.valid).toBe(true);
    const at = metadata(h)!.publishedAt!;
    const before = [v.ppv, v.ivcDmin, v.ivcDmax, v.ivcIndex];
    h.store.getState().patch('ventilation', { respRate: 0 });
    h.loop.advance(0.001);
    expect(metadata(h)?.valid).toBe(false);
    expect(metadata(h)?.status).toBe('resp-rate-zero');
    expect(metadata(h)?.source).toBe('historical');
    h.loop.advance(6);
    expect(metadata(h)?.publishedAt).toBe(at);
    expect(metadata(h)?.ageSeconds).toBeGreaterThan(6);
    expect([v.ppv, v.ivcDmin, v.ivcDmax, v.ivcIndex]).toEqual(before);
    h.store.getState().patch('ventilation', { respRate: 14 });
    h.loop.advance(0.001);
    expect(metadata(h)?.valid).toBe(false);
    expect(metadata(h)?.status).toBe('partial-window');
    h.loop.advance(10);
    expect(metadata(h)?.valid).toBe(true);
    expect(metadata(h)?.windowStart).toBeGreaterThan(at);
  }, 30_000);

  it('previous history and reset do not contaminate fresh/reused metadata', async () => {
    const fresh = await boot();
    fresh.loop.advance(5);
    const expected = structuredClone({ m: metadata(fresh), ppv: fresh.loop.context.live.hemo.ppv });
    const reused = await boot();
    reused.store.getState().patch('ventilation', { mode: 'mechanical', peep: 12 });
    reused.store.getState().patch('ecg', { rhythm: 'af', heartRate: 130 });
    reused.loop.reset(); reused.loop.advance(3);
    reused.store.getState().loadPreset(reused.params); reused.loop.reset(); reused.loop.advance(5);
    expect(structuredClone({ m: metadata(reused), ppv: reused.loop.context.live.hemo.ppv })).toEqual(expected);
  }, 30_000);

  it('respiratory mode change invalidates the old contract without erasing legacy fields', async () => {
    const h = await boot();
    h.loop.advance(5);
    const t = metadata(h)?.publishedAt;
    expect(metadata(h)?.valid).toBe(true);
    const oldPpv = h.loop.context.live.hemo.ppv;
    h.store.getState().patch('ventilation', { mode: 'mechanical' });
    h.loop.advance(0.001);
    expect(metadata(h)?.valid).toBe(false);
    expect(metadata(h)?.status).toBe('partial-window');
    expect(metadata(h)?.publishedAt).toBe(t);
    expect(h.loop.context.live.hemo.ppv).toBe(oldPpv);
  }, 30_000);
});


