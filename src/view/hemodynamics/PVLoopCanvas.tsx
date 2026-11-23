import { getBank, getLive } from '../../controller/usePhysiologyStore';
import { useCanvas2D } from '../../controller/useRafLoop';

interface Props {
  height?: number;
}

/**
 * Left Ventricle Pressure-Volume Loop (PV Loop) at 60 FPS in HTML5 Canvas 2D.
 * Shows:
 *  - P_LV × V_LV loop in real time (last 2.5 s of history)
 *  - ESPVR line: P_es(V) = E_es · (V - V_0)
 *  - Exponential EDPVR curve: P_ed(V) = A · (exp(B · (V - V_0)) - 1) + P_pl
 *  - Effective Arterial Elastance line (E_a): connects (EDV, 0) to the end-systolic point (ESV, P_es)
 */
export function PVLoopCanvas({ height = 240 }: Props) {
  const ref = useCanvas2D((ctx, w, h) => {
    const bank = getBank();
    const live = getLive();
    const hemo = live.hemo;

    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, w, h);

    const padL = 42;
    const padR = 16;
    const padT = 26;
    const padB = 30;
    const plotW = Math.max(20, w - padL - padR);
    const plotH = Math.max(20, h - padT - padB);

    const vMax = Math.max(180, Math.ceil((hemo.edv + 40) / 20) * 20);
    const pMax = Math.max(160, Math.ceil((hemo.sbp + 30) / 20) * 20);

    const vx = (v: number) => padL + (v / vMax) * plotW;
    const py = (p: number) => padT + plotH - (p / pMax) * plotH;

    // Top band dedicated to the ventricular-arterial coupling legend (without colliding with curves)
    ctx.fillStyle = 'rgba(13, 19, 28, 0.85)';
    ctx.fillRect(0, 0, w, padT - 4);
    ctx.textAlign = 'left';
    ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Consolas, monospace';

    let lx = padL;
    const drawLegendItem = (color: string, text: string) => {
      ctx.fillStyle = color;
      ctx.fillText(text, lx, 15);
      lx += ctx.measureText(text).width + 14;
    };
    drawLegendItem('#ff6b6b', `ESPVR Ees=${hemo.lvEes.toFixed(2)}`);
    drawLegendItem('#ffd23b', `Ea=${hemo.ea.toFixed(2)}`);
    drawLegendItem('#3bb0ff', `EDPVR V0=${Math.round(hemo.lvV0)}mL`);
    drawLegendItem(
      '#2dd4bf',
      `VDF=${Math.round(hemo.edv)} VSF=${Math.round(hemo.esv)}mL (FE ${Math.round(hemo.lvef)}%)`,
    );

    // Grid
    ctx.strokeStyle = '#111923';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let v = 0; v <= vMax; v += 40) {
      const x = vx(v);
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
    }
    for (let p = 0; p <= pMax; p += 40) {
      const y = py(p);
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
    }
    ctx.stroke();

    // Plot area frame
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(padL, padT, plotW, plotH);

    // Axes and labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace';
    ctx.textAlign = 'right';
    for (let p = 0; p <= pMax; p += 40) {
      ctx.fillText(String(p), padL - 5, py(p) + 3);
    }
    ctx.textAlign = 'center';
    for (let v = 0; v <= vMax; v += 40) {
      ctx.fillText(String(v), vx(v), padT + plotH + 12);
    }
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText('Volume VE (mL)', padL + plotW * 0.5, padT + plotH + 25);

    // Vertical Y-axis label (Pressure mmHg)
    ctx.save();
    ctx.translate(11, padT + plotH * 0.5);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('P_VE (mmHg)', 0, 0);
    ctx.restore();

    // 1. EDPVR curve: P = A*(exp(B*(V - V0)) - 1) + Ppl
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();

    ctx.strokeStyle = '#3bb0ff';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let v = 0; v <= vMax; v += 3) {
      const dv = Math.max(0, v - hemo.lvV0);
      const p = hemo.lvA * (Math.exp(Math.min(6.5, hemo.lvB * dv)) - 1) + Math.max(-4, hemo.pPl);
      const x = vx(v);
      const y = py(p);
      if (v === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 2. ESPVR line: P = Ees * (V - V0)
    ctx.strokeStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.moveTo(vx(hemo.lvV0), py(0));
    const vTop = hemo.lvV0 + pMax / Math.max(0.2, hemo.lvEes);
    ctx.lineTo(vx(vTop), py(pMax));
    ctx.stroke();

    // 3. Effective Arterial Elastance line (Ea): from (EDV, 0) to (ESV, Pes)
    if (hemo.edv > hemo.esv) {
      const pEs = hemo.lvEes * Math.max(0, hemo.esv - hemo.lvV0);
      ctx.strokeStyle = '#ffd23b';
      ctx.beginPath();
      ctx.moveTo(vx(hemo.edv), py(0));
      ctx.lineTo(vx(hemo.esv), py(Math.min(pMax, Math.max(hemo.sbp * 0.9, pEs))));
      ctx.stroke();
    }

    // 4. Dynamic trace of the PV Loop (last ~2.2 s)
    ctx.setLineDash([]);
    const chV = bank.read('vLV');
    const chP = bank.read('pLV');
    const n = Math.min(bank.count, Math.floor(2.2 * bank.sampleRate));
    if (chV && chP && n > 4) {
      // Filled shadow of the most recent cycle (~1 beat)
      const nBeat = Math.min(n, Math.floor(live.clock.rr * bank.sampleRate));
      ctx.fillStyle = 'rgba(45, 212, 191, 0.12)';
      ctx.beginPath();
      for (let k = nBeat - 1; k >= 0; k--) {
        const idx = bank.indexAgo(k);
        const x = vx(chV[idx]);
        const y = py(chP[idx]);
        if (k === nBeat - 1) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();

      // Main trace
      ctx.strokeStyle = '#2dd4bf';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      for (let k = n - 1; k >= 0; k--) {
        const idx = bank.indexAgo(k);
        const x = vx(chV[idx]);
        const y = py(chP[idx]);
        if (k === k && k === n - 1) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Instantaneous point (V_LV, P_LV)
      const cx = vx(hemo.vLV);
      const cy = py(hemo.pLV);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  });

  return <canvas ref={ref} className="strip-canvas" style={{ height }} />;
}
