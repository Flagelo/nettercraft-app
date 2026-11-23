import { beforeAll, describe, expect, it } from 'vitest';
import { MasterPhysiologyClock } from '../../controller/MasterPhysiologyClock';
import { defaultParams, createLiveState } from '../../controller/usePhysiologyStore';
import { HemoEventKind } from '../contracts/types';
import type { SimContext } from '../contracts/types';
import { HemodynamicEngine } from './HemodynamicEngine';

/**
  * Systolic/diastolic reference criteria of the 0D engine (normal profile, defaultParams).
  * Measurement: HR fixed on the clock (cmd.hr = target), default baroreflex, 20 s after reset(),
  * median of 8 QRS→QRS cycles.
 *
  * Definitions:
  *  - LVET = AorticOpen → AorticClose (z_ao = 0.25 crossing)
  *  - LVEDP = pLV at the step immediately before the QRS
  *  - Ees = maximum elastance of the model (hemo.lvEes); Ea = Pes / SV, with Pes = pLV at AorticClose
  *  - Gradient = LVPmax − SAP (peak to peak in the cycle)
 *
  * Status of the sources:
  *  C1 LVEDP 3–10 mmHg: REPORT from the Taskmaster (Kato 2003, doi 10.1016/s0735-1097(03)00573-4, 6.5 ± 1.7);
  *     the DOI did not resolve in PubMed in this session → value NOT VERIFIED by the executor.
  *  C2 Ees/Ea 1.87–2.32: VERIFIED in the PubMed abstract (Obata 2024, doi 10.1186/s12871-024-02452-6;
  *     1.87–2.04 men, 1.98–2.32 women; non-invasive method, different from the model's Ees).
  *  C3 LVEF 55–65%: VERIFIED in the PubMed abstract (Rahman 2024, doi 10.1111/cpf.12910; 59.9 ± 2.8%).
  *  C4 LVET 260–310 ms at 75 bpm and slope −1.2 to −2.2 ms/bpm (60–120 bpm): PROVISIONAL
  *     (Weissler coefficients NOT verified).
  *  C5 LVPmax − SAP ≤ 5 mmHg at 75 bpm (no aortic stenosis): PHYSIOLOGICAL INFERENCE, no source.
  *  C6 regression guards at 75 bpm (aorta 100–130/60–85, SV 60–100, CO 4–8): defined by the Taskmaster.
  *  Plausibility guards at the other HRs: INFERENCE (wide ranges, only coarse anti-regression).
 */

interface Med {
  lvet: number; plvMax: number; paoMax: number; paoMin: number; lvedp: number;
  edv: number; sv: number; ef: number; co: number; eesEa: number;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

function measure(hr: number, warmSeconds = 20, nCycles = 8): Med {
  const clock = new MasterPhysiologyClock();
  const params = defaultParams();
  params.ecg.heartRate = hr;
  const live = createLiveState();
  live.clock = clock.state;
  const ctx: SimContext = { clock: clock.state, live, params };
  const cmd = {
    hr, rhythm: params.ecg.rhythm, flutterConduction: params.ecg.flutterConduction,
    qtc: params.ecg.qtc, respRate: params.ventilation.respRate, inspFraction: 1 / 3,
  };
  let qrsCount = -1;
  let qrsFlag = false;
  clock.addListener({ onQRS: () => { qrsFlag = true; } });
  clock.reset(cmd);
  const engine = new HemodynamicEngine();
  engine.reset(ctx);
  for (let i = 0; i < warmSeconds * 1000; i++) { clock.step(0.001, cmd); engine.step(0.001, ctx); }

  const rows: Med[] = [];
  let cursor = live.hemo.events.seq;
  let prevPLV = live.hemo.pLV;
  let cur = { tAo: NaN, tAc: NaN, pes: NaN, plvMax: -Infinity, paoMax: -Infinity, paoMin: Infinity, vMax: -Infinity, vMin: Infinity, lvedp: NaN, t0: 0 };
  let guard = 0;
  while (rows.length < nCycles && guard++ < 40000) {
    clock.step(0.001, cmd);
    engine.step(0.001, ctx);
    const h = live.hemo;
    if (qrsFlag) {
      qrsFlag = false;
      qrsCount++;
      if (qrsCount > 0) {
        const sv = cur.vMax - cur.vMin;
        const rr = clock.state.t - cur.t0;
        rows.push({
          lvet: (cur.tAc - cur.tAo) * 1000, plvMax: cur.plvMax, paoMax: cur.paoMax, paoMin: cur.paoMin,
          lvedp: cur.lvedp, edv: cur.vMax, sv, ef: (100 * sv) / cur.vMax, co: (sv * 60) / rr / 1000,
          eesEa: h.lvEes / (cur.pes / sv),
        });
      }
      cur = { tAo: NaN, tAc: NaN, pes: NaN, plvMax: -Infinity, paoMax: -Infinity, paoMin: Infinity, vMax: -Infinity, vMin: Infinity, lvedp: prevPLV, t0: clock.state.t };
    }
    cursor = h.events.forEachSince(cursor, (k: number, t: number) => {
      if (k === HemoEventKind.AorticOpen && Number.isNaN(cur.tAo)) cur.tAo = t;
      if (k === HemoEventKind.AorticClose && !Number.isNaN(cur.tAo) && Number.isNaN(cur.tAc)) { cur.tAc = t; cur.pes = h.pLV; }
    });
    if (h.pLV > cur.plvMax) cur.plvMax = h.pLV;
    if (h.pAo > cur.paoMax) cur.paoMax = h.pAo;
    if (h.pAo < cur.paoMin) cur.paoMin = h.pAo;
    if (h.vLV > cur.vMax) cur.vMax = h.vLV;
    if (h.vLV < cur.vMin) cur.vMin = h.vLV;
    prevPLV = h.pLV;
  }
  const out = {} as Med;
  for (const k of Object.keys(rows[0]) as (keyof Med)[]) out[k] = median(rows.map((r) => r[k]));
  return out;
}

const HRS = [50, 60, 75, 90, 100, 120];
const R: Record<number, Med> = {};

describe('Systolic/diastolic reference of the 0D engine (normal profile)', () => {
  beforeAll(() => {
    for (const hr of HRS) R[hr] = measure(hr);
  }, 120000);

  it('C1 — LVEDP 3–10 mmHg at 75 bpm [REPORT; Kato 2003, doi 10.1016/s0735-1097(03)00573-4, NOT VERIFIED]', () => {
    expect(R[75].lvedp).toBeGreaterThanOrEqual(3);
    expect(R[75].lvedp).toBeLessThanOrEqual(10);
  });

  it('C2 — Ees/Ea 1.87–2.32 at 75 bpm [VERIFIED; Obata 2024, doi 10.1186/s12871-024-02452-6]', () => {
    expect(R[75].eesEa).toBeGreaterThanOrEqual(1.87);
    expect(R[75].eesEa).toBeLessThanOrEqual(2.32);
  });

  it('C3 — LVEF 55–65% at 75 bpm [VERIFIED; Rahman 2024, doi 10.1111/cpf.12910]', () => {
    expect(R[75].ef).toBeGreaterThanOrEqual(55);
    expect(R[75].ef).toBeLessThanOrEqual(65);
  });

  it('C4 — LVET 260–310 ms at 75 bpm and slope −1.2 to −2.2 ms/bpm at 60–120 bpm [PROVISIONAL; Weissler NOT verified]', () => {
    expect(R[75].lvet).toBeGreaterThanOrEqual(260);
    expect(R[75].lvet).toBeLessThanOrEqual(310);
    const xs = [60, 75, 90, 100, 120];
    const ys = xs.map((x) => R[x].lvet);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const slope = num / den;
    expect(slope).toBeLessThanOrEqual(-1.2);
    expect(slope).toBeGreaterThanOrEqual(-2.2);
  });

  // Provisional decision (07/11/2026): C5 applied at rest (50 and 75 bpm). At 100/120 bpm the gradient
  // grows with flow (Bernoulli at the aortic valve) and there is no source for the 5 mmHg limit in tachycardia;
  // the measured values (7.7 and 9.9 mmHg) are documented in MOTOR_SISTOLE_FASE1_20261107.md §8A/§8B.
  it('C5 — LVPmax − SAP ≤ 5 mmHg at rest (50 and 75 bpm), no stenosis [PHYSIOLOGICAL INFERENCE, no source]', () => {
    for (const hr of [50, 75]) {
      expect({ hr, ok: R[hr].plvMax - R[hr].paoMax <= 5 }).toEqual({ hr, ok: true });
    }
  });

  it('C6 — regression guards at 75 bpm: aorta 100–130/60–85, SV 60–100, CO 4–8', () => {
    const m = R[75];
    expect(m.paoMax).toBeGreaterThanOrEqual(100);
    expect(m.paoMax).toBeLessThanOrEqual(130);
    expect(m.paoMin).toBeGreaterThanOrEqual(60);
    expect(m.paoMin).toBeLessThanOrEqual(85);
    expect(m.sv).toBeGreaterThanOrEqual(60);
    expect(m.sv).toBeLessThanOrEqual(100);
    expect(m.co).toBeGreaterThanOrEqual(4);
    expect(m.co).toBeLessThanOrEqual(8);
  });

  it('plausibility guards at 50/60/90/100/120 bpm [INFERENCE]', () => {
    for (const hr of [50, 60, 90, 100, 120]) {
      const m = R[hr];
      for (const v of Object.values(m)) expect(Number.isFinite(v)).toBe(true);
      expect(m.ef).toBeGreaterThanOrEqual(50);
      expect(m.ef).toBeLessThanOrEqual(70);
      expect(m.paoMax).toBeGreaterThanOrEqual(90);
      expect(m.paoMax).toBeLessThanOrEqual(150);
      expect(m.paoMin).toBeGreaterThanOrEqual(50);
      expect(m.paoMin).toBeLessThanOrEqual(100);
      expect(m.sv).toBeGreaterThanOrEqual(50);
      expect(m.sv).toBeLessThanOrEqual(110);
      expect(m.co).toBeGreaterThanOrEqual(3);
      expect(m.co).toBeLessThanOrEqual(9);
      expect(m.lvedp).toBeGreaterThanOrEqual(-2);
      expect(m.lvedp).toBeLessThanOrEqual(20);
      expect(m.eesEa).toBeGreaterThanOrEqual(1.2);
      expect(m.eesEa).toBeLessThanOrEqual(3.0);
      expect(m.lvet).toBeGreaterThan(150);
      expect(m.lvet).toBeLessThan(450);
    }
  });
});
