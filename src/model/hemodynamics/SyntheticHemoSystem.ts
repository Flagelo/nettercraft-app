import type { SimSystem } from '../contracts/types';
import { HemoEventKind } from '../contracts/types';

/**
 * SyntheticHemoSystem — ANALYTICAL waveform generator, used only when
 * no real hemodynamic engine (id 'hemodynamics') is registered.
 * Allows developing/visualizing 3D, ECG, audio and POCUS independently.
 * It is NOT physiology: replaced by the RK4 solver in src/physiology.
 */
export const syntheticHemoSystem: SimSystem = {
  id: 'synthetic-hemo',
  order: 10,
  step(_h, ctx) {
    const c = ctx.clock;
    const h = ctx.live.hemo;
    const t = c.tSinceQRS;
    const ts = c.ts;
    // ventricular activation (half-sine during systole)
    const e = t < ts ? Math.sin((Math.PI * t) / ts) ** 2 : 0;
    const prevZAo = h.zAortic;
    const prevZMi = h.zMitral;
    h.eLV = e;
    h.eRV = e;
    const ta = c.tSinceP;
    h.eLA = c.atrialActive && ta < 0.12 ? Math.sin((Math.PI * ta) / 0.12) ** 2 : 0;
    h.eRA = h.eLA;
    const edv = 120;
    const esv = 50;
    const ejecting = t > 0.05 && t < ts;
    const ejFrac = ejecting ? (1 - Math.cos((Math.PI * (t - 0.05)) / (ts - 0.05))) / 2 : t >= ts ? 1 : 0;
    const fillT = t - ts - 0.06;
    const fill = fillT > 0 ? 1 - Math.exp(-fillT / 0.12) : 0;
    h.vLV = t < ts + 0.06 ? edv - (edv - esv) * ejFrac : esv + (edv - esv) * fill;
    h.pLV = 8 + 112 * e;
    const decay = 80 * Math.exp(-Math.max(0, t - ts) / 1.2);
    h.pAo = ejecting ? Math.max(h.pLV, 80) : Math.max(decay, 70) + (t > ts && t < ts + 0.03 ? -4 : 0);
    h.pLA = 8 + 4 * h.eLA + 3 * e;
    h.pRV = 4 + 21 * e;
    h.pRA = 4 + 3 * h.eRA;
    h.pPA = ejecting ? Math.max(h.pRV, 12) : 12;
    h.zAortic = ejecting ? 1 : 0;
    h.zPulmonary = h.zAortic;
    h.zMitral = !ejecting && t > ts + 0.06 ? 1 : 0;
    h.zTricuspid = h.zMitral;
    h.qAortic = ejecting ? 400 * Math.sin((Math.PI * (t - 0.05)) / (ts - 0.05)) : 0;
    h.qMitral = h.zMitral ? 300 * Math.exp(-Math.max(0, fillT) / 0.1) : 0;
    h.dpAortic = ejecting ? 6 : -60;
    h.dpMitral = h.zMitral ? 3 : -100;
    h.pPl = c.isInspiration ? -5 - 3 * Math.sin((Math.PI * c.phiResp) / c.inspFraction) : -5;
    const now = c.t;
    if (prevZAo < 0.5 && h.zAortic >= 0.5) h.events.push(HemoEventKind.AorticOpen, now);
    if (prevZAo >= 0.5 && h.zAortic < 0.5) {
      h.events.push(HemoEventKind.AorticClose, now);
      h.events.push(HemoEventKind.PulmonaryClose, now + 0.02);
    }
    if (prevZMi < 0.5 && h.zMitral >= 0.5) h.events.push(HemoEventKind.MitralOpen, now);
    if (prevZMi >= 0.5 && h.zMitral < 0.5) {
      h.events.push(HemoEventKind.MitralClose, now);
      h.events.push(HemoEventKind.TricuspidClose, now + 0.02);
    }
    h.sbp = 120; h.dbp = 80; h.map = 93; h.sv = 70; h.co = (70 * c.hr) / 1000;
    h.lvef = 58; h.edv = edv; h.esv = esv; h.lvedp = 10; h.cvp = 5; h.papMean = 15; h.pcwp = 10;
    h.ivcDiameter = 18 - 4 * (c.isInspiration ? Math.sin((Math.PI * c.phiResp) / c.inspFraction) : 0);
  },
  sample(bank, ctx) {
    const h = ctx.live.hemo;
    bank.set('pAo', h.pAo);
    bank.set('pLV', h.pLV);
    bank.set('pLA', h.pLA);
    bank.set('vLV', h.vLV);
    bank.set('pRA', h.pRA);
    bank.set('pPA', h.pPA);
    bank.set('pPl', h.pPl);
  },
};
