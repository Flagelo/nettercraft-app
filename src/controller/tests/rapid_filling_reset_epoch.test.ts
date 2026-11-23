import { afterEach, describe, expect, it, vi } from 'vitest';
import { HemodynamicEngine } from '../../model/hemodynamics/HemodynamicEngine';
import { AuscultationSynth } from '../../model/auscultation/AuscultationSynth';
import { ElectroEngine } from '../../model/electrophysiology/ElectroEngine';
import { HemoEventKind as K } from '../../model/contracts/types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type Event = { kind: K; t: number };
const scenarios = [
  { name: 'sinus', rhythm: 'sinus' as const },
  { name: 'fibrilação atrial', rhythm: 'af' as const },
  { name: 'flutter 3:1', rhythm: 'flutter' as const },
  { name: 'ventilação mecânica', rhythm: 'sinus' as const, mechanical: true },
  { name: 'frequência respiratória zero', rhythm: 'sinus' as const, respZero: true },
];

describe('CC-P0-02-B3 — rapid filling trigger after observable QRS', () => {
  for (const scenario of scenarios) {
    it(`does not publish B3 before the first QRS and preserves post-QRS B3: ${scenario.name}`, async () => {
      vi.resetModules();
      const { usePhysiologyStore: store, defaultParams } = await import('../usePhysiologyStore');
      const { getSimulationLoop } = await import('../SimulationLoop');
      const loop = getSimulationLoop();
      const audio = new AuscultationSynth();
      loop.register(new HemodynamicEngine(), new ElectroEngine(), audio);

      const p = defaultParams();
      p.ecg.rhythm = scenario.rhythm;
      p.ecg.heartRate = 72;
      p.ecg.flutterConduction = 3;
      p.echo.lvef = 25; // condition that enables B3 in the existing synthesis
      p.echo.septum = 14;
      p.echo.posteriorWall = 14;
      if ('mechanical' in scenario) {
        p.ventilation.mode = 'mechanical';
        p.ventilation.peep = 12;
      }
      if ('respZero' in scenario) p.ventilation.respRate = 0;

      const b3SynthesisTimes: number[] = [];
      const audioProbe = audio as unknown as {
        triggerHeartSound: (frequency: number, tau: number, amplitude: number, delay?: number) => void;
      };
      vi.spyOn(audioProbe, 'triggerHeartSound').mockImplementation((frequency) => {
        if (frequency === 28) b3SynthesisTimes.push(loop.clock.state.t);
      });

      store.getState().loadPreset(p);
      loop.reset();
      expect(loop.context.live.hemo.events.seq).toBe(0);
      const observed: Event[] = [];
      let cursor = 0;
      for (let i = 0; i < 3000; i++) {
        loop.advance(0.001);
        cursor = loop.context.live.hemo.events.forEachSince(cursor, (kind, t) => {
          observed.push({ kind, t });
        });
      }

      const qrs = observed.filter(e => e.kind === K.QRS);
      const rapid = observed.filter(e => e.kind === K.RapidFillingEnd);
      expect(qrs.length).toBeGreaterThanOrEqual(2);
      expect(rapid.length).toBeGreaterThan(0);

      let latestQrs = -1;
      let b3InBeat = 0;
      for (const e of observed) {
        if (e.kind === K.QRS) {
          latestQrs = e.t;
          b3InBeat = 0;
        } else if (e.kind === K.RapidFillingEnd) {
          expect(latestQrs, 'evento de B3 anterior ao primeiro QRS').toBeGreaterThanOrEqual(0);
          expect(e.t - latestQrs, 'B3 deve ocorrer na diástole após QRS').toBeGreaterThan(0.16);
          b3InBeat++;
          expect(b3InBeat, 'duplicação de B3 no mesmo intervalo QRS–QRS').toBe(1);
        }
      }
      expect(b3SynthesisTimes).toEqual(rapid.map(e => e.t));
      expect(rapid[0].t).toBeGreaterThan(qrs[0].t);

      const atrial = observed.filter(e => e.kind === K.AtrialKick);
      if (scenario.rhythm === 'sinus') expect(atrial.length).toBeGreaterThan(0);
      else expect(atrial).toHaveLength(0);
      // Do not infer respiratory validity from the defaults or from this test.
      expect('respMetrics' in loop.context.live.hemo).toBe(false);
    });
  }
});
