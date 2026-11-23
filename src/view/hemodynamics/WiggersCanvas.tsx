import { getBank, getLive } from '../../controller/usePhysiologyStore';
import { HemoEventKind } from '../../model/contracts/types';
import { useCanvas2D } from '../../controller/useRafLoop';

interface Props {
  seconds?: number;
  height?: number;
}

/**
 * Complete Wiggers diagram at 60 FPS in HTML5 Canvas 2D.
 * Renders:
 *  - Upper band (56%): Aortic Pressure (P_Ao with dicrotic notch), LV Pressure (P_LV), LA Pressure (P_LA with a, c, v waves)
 *  - Middle band (24%): LV Volume (V_LV in mL)
 *  - Lower band (20%): synchronized lead II ECG + Phonocardiogram
 *  - Vertical markers of mitral and aortic valve opening/closing
 */
export function WiggersCanvas({ seconds = 3.6, height = 275 }: Props) {
  const ref = useCanvas2D((ctx, w, h) => {
    const bank = getBank();
    const live = getLive();

    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, w, h);

    const padL = 34;
    const padR = 8;
    const plotW = Math.max(10, w - padL - padR);

    // Vertical divisions of the 3 bands
    const yP0 = 6;
    const yP1 = Math.round(h * 0.54);
    const yV0 = yP1 + 6;
    const yV1 = Math.round(h * 0.78);
    const yE0 = yV1 + 6;
    const yE1 = h - 4;

    // Background grid
    ctx.strokeStyle = '#111923';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const cols = Math.round(seconds * 5);
    for (let i = 0; i <= cols; i++) {
      const x = padL + (i / cols) * plotW;
      ctx.moveTo(x, yP0);
      ctx.lineTo(x, yE1);
    }
    // Horizontal pressure lines (0, 40, 80, 120, 160 mmHg)
    const pMax = Math.max(150, Math.ceil((live.hemo.sbp + 20) / 20) * 20);
    for (let p = 0; p <= pMax; p += 40) {
      const y = yP1 - (p / pMax) * (yP1 - yP0);
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
    }
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = '#6e8094';
    ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace';
    ctx.textAlign = 'right';
    for (let p = 0; p <= pMax; p += 40) {
      const y = yP1 - (p / pMax) * (yP1 - yP0);
      ctx.fillText(String(p), padL - 4, y + 3);
    }
    ctx.fillStyle = '#2dd4bf';
    ctx.fillText('mL', padL - 4, (yV0 + yV1) * 0.5 + 3);
    ctx.fillStyle = '#00ff6a';
    ctx.fillText('ECG', padL - 4, (yE0 + yE1) * 0.5 + 3);
    ctx.textAlign = 'left';

    const totalSamples = Math.floor(seconds * bank.sampleRate);
    const n = Math.min(bank.count, totalSamples);
    if (n < 4) return;

    const chPAo = bank.read('pAo');
    const chPLV = bank.read('pLV');
    const chPLA = bank.read('pLA');
    const chVLV = bank.read('vLV');
    const chEcg = bank.read('ecg_II');
    const chPhono = bank.read('phono');
    const chT = bank.read('t');

    // Dynamic LV volume scale
    const vMin = Math.max(10, Math.floor((live.hemo.esv - 15) / 10) * 10);
    const vMax = Math.max(vMin + 60, Math.ceil((live.hemo.edv + 20) / 10) * 10);

    // Valve event markers in the visible time window
    const tNewest = chT ? chT[bank.indexAgo(0)] : live.clock.t;
    const tOldest = tNewest - seconds;
    const ev = live.hemo.events;
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ev.forEachSince(Math.max(0, ev.seq - 64), (kind, tEv) => {
      if (tEv < tOldest || tEv > tNewest) return;
      if (
        kind !== HemoEventKind.AorticOpen &&
        kind !== HemoEventKind.AorticClose &&
        kind !== HemoEventKind.MitralOpen &&
        kind !== HemoEventKind.MitralClose
      ) {
        return;
      }
      const x = padL + ((tEv - tOldest) / seconds) * plotW;
      ctx.strokeStyle =
        kind === HemoEventKind.AorticOpen || kind === HemoEventKind.AorticClose
          ? 'rgba(255, 90, 90, 0.28)'
          : 'rgba(59, 176, 255, 0.28)';
      ctx.beginPath();
      ctx.moveTo(x, yP0);
      ctx.lineTo(x, yV1);
      ctx.stroke();
    });
    ctx.restore();

    // Helper function to draw a continuous channel (scrolling left to right)
    const drawScrolling = (
      buf: Float32Array | undefined,
      color: string,
      yTop: number,
      yBot: number,
      minVal: number,
      maxVal: number,
      lineWidth = 1.6,
    ) => {
      if (!buf) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      const span = Math.max(1e-6, maxVal - minVal);
      for (let k = n - 1; k >= 0; k--) {
        const v = buf[bank.indexAgo(k)];
        const x = padL + ((totalSamples - 1 - k) / (totalSamples - 1)) * plotW;
        const norm = clamp01((v - minVal) / span);
        const y = yBot - norm * (yBot - yTop);
        if (k === n - 1) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    // 1. Pressures: LA (blue), LV (white), Aorta (red)
    drawScrolling(chPLA, '#3bb0ff', yP0, yP1, 0, pMax, 1.4);
    drawScrolling(chPLV, '#e6edf3', yP0, yP1, 0, pMax, 1.5);
    drawScrolling(chPAo, '#ff3b3b', yP0, yP1, 0, pMax, 1.9);

    // 2. LV Volume
    drawScrolling(chVLV, '#2dd4bf', yV0, yV1, vMin, vMax, 1.7);

    // 3. Lead II ECG + Phonocardiogram
    drawScrolling(chEcg, '#00ff6a', yE0, yE1, -1.2, 1.8, 1.4);
    if (chPhono) {
      drawScrolling(chPhono, 'rgba(251, 191, 36, 0.85)', yE0, yE1, -1.0, 1.0, 1.1);
    }

    // Compact legend at the top
    ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace';
    const items: [string, string][] = [
      [`P Ao ${live.hemo.sbp}/${live.hemo.dbp}`, '#ff3b3b'],
      [`P VE (PD2 ${live.hemo.lvedp})`, '#e6edf3'],
      [`P AE (${live.hemo.pcwp})`, '#3bb0ff'],
      [`V VE ${live.hemo.esv}–${live.hemo.edv} mL`, '#2dd4bf'],
    ];
    let lx = padL + 4;
    for (const [txt, col] of items) {
      ctx.fillStyle = col;
      ctx.fillText(txt, lx, yP0 + 10);
      lx += ctx.measureText(txt).width + 12;
    }
  });

  return <canvas ref={ref} className="strip-canvas" style={{ height }} />;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
