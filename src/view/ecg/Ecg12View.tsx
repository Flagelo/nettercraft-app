import { getBank, getLive } from '../../controller/usePhysiologyStore';
import { LEAD_NAMES } from '../../model/contracts/types';
import { useCanvas2D } from '../../controller/useRafLoop';

interface Props {
  height?: number;
}

/**
 * Real-time 12-Lead Monitor / Electrocardiograph (60 FPS Canvas 2D).
 * Clinical layout 3 rows × 4 columns (I, II, III | aVR, aVL, aVF | V1, V2, V3 | V4, V5, V6)
 * + Long lead II rhythm strip at the bottom, over a dark millimeter grid.
 */
const GRID_LAYOUT: readonly (readonly (typeof LEAD_NAMES)[number][])[] = [
  ['I', 'aVR', 'V1', 'V4'],
  ['II', 'aVL', 'V2', 'V5'],
  ['III', 'aVF', 'V3', 'V6'],
];

export function Ecg12View({ height = 295 }: Props) {
  const ref = useCanvas2D((ctx, w, h) => {
    const bank = getBank();
    const live = getLive();

    ctx.fillStyle = '#05080c';
    ctx.fillRect(0, 0, w, h);

    // 1. Minor 1 mm subdivisions (4 px = 0.04 s × 0.1 mV)
    ctx.strokeStyle = 'rgba(0, 230, 118, 0.055)';
    ctx.lineWidth = 0.65;
    ctx.beginPath();
    for (let x = 4; x < w; x += 4) {
      if (x % 20 === 0) continue;
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = 4; y < h; y += 4) {
      if (y % 20 === 0) continue;
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();

    // 2. Large 5 mm squares (20 px = 0.20 s × 0.5 mV)
    ctx.strokeStyle = 'rgba(0, 230, 118, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x += 20) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = 0; y < h; y += 20) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();

    const rows = 4; // 3 rows of 4 leads + 1 long lead II row
    const cols = 4;
    const cellW = w / cols;
    const cellH = h / rows;

    // Cell dividers
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = 1; r < rows; r++) {
      ctx.moveTo(0, r * cellH);
      ctx.lineTo(w, r * cellH);
    }
    for (let c = 1; c < cols; c++) {
      ctx.moveTo(c * cellW, 0);
      ctx.lineTo(c * cellW, 3 * cellH);
    }
    ctx.stroke();

    const secPerCell = 2.2;
    const samplesPerCell = Math.floor(secPerCell * bank.sampleRate);
    const nCell = Math.min(bank.count, samplesPerCell);
    const mvRange = 2.05; // Enlarged 10 mm/mV gain scale so P, QRS and T waves are clearly visible

    ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Consolas, monospace';
    ctx.lineJoin = 'round';

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const lead = GRID_LAYOUT[r][c];
        const x0 = c * cellW;
        const y0 = r * cellH;
        const yZero = y0 + cellH * 0.58;

        // Reference isoelectric line (makes ST elevation/depression easy to see)
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
        ctx.lineWidth = 0.85;
        ctx.beginPath();
        ctx.moveTo(x0 + 4, yZero);
        ctx.lineTo(x0 + cellW - 4, yZero);
        ctx.stroke();

        const buf = bank.read(`ecg_${lead}`);
        if (buf && nCell > 2) {
          ctx.strokeStyle = '#00ff6a';
          ctx.lineWidth = 1.55;
          ctx.beginPath();
          for (let k = nCell - 1; k >= 0; k--) {
            const v = buf[bank.indexAgo(k)];
            const x = x0 + 4 + ((samplesPerCell - 1 - k) / (samplesPerCell - 1)) * (cellW - 8);
            const y = Math.max(
              y0 + 3,
              Math.min(y0 + cellH - 3, yZero - (v / mvRange) * (cellH * 0.88)),
            );
            if (k === nCell - 1) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }

        // Lead name with a subtle pill for contrast
        ctx.fillStyle = 'rgba(5, 8, 12, 0.72)';
        ctx.fillRect(x0 + 4, y0 + 2, 26, 13);
        ctx.fillStyle = '#a5f3fc';
        ctx.fillText(lead, x0 + 6, y0 + 12);
      }
    }

    // 4th row: long lead II (5.5 seconds) + 1 mV rectangular calibration pulse
    const yRhythm0 = 3 * cellH;
    const yRhythmZero = yRhythm0 + cellH * 0.60;
    const secLong = 5.5;
    const samplesLong = Math.floor(secLong * bank.sampleRate);
    const nLong = Math.min(bank.count, samplesLong);
    const bufII = bank.read('ecg_II');

    // Standard 1 mV calibration pulse at the left of the rhythm strip
    const calH = (1.0 / mvRange) * (cellH * 0.88);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(6, yRhythmZero);
    ctx.lineTo(9, yRhythmZero);
    ctx.lineTo(9, yRhythmZero - calH);
    ctx.lineTo(19, yRhythmZero - calH);
    ctx.lineTo(19, yRhythmZero);
    ctx.lineTo(22, yRhythmZero);
    ctx.stroke();

    if (bufII && nLong > 2) {
      ctx.strokeStyle = '#00ff6a';
      ctx.lineWidth = 1.65;
      ctx.beginPath();
      for (let k = nLong - 1; k >= 0; k--) {
        const v = bufII[bank.indexAgo(k)];
        const x = 26 + ((samplesLong - 1 - k) / (samplesLong - 1)) * (w - 32);
        const y = Math.max(
          yRhythm0 + 4,
          Math.min(h - 3, yRhythmZero - (v / mvRange) * (cellH * 0.88)),
        );
        if (k === nLong - 1) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    const rrSec = Math.max(0.25, live.clock.rr);
    const qtMs = Math.round(live.clock.qt * 1000);
    const qtcFridMs = Math.round((live.clock.qt / Math.cbrt(rrSec)) * 1000);

    ctx.fillStyle = 'rgba(5, 8, 12, 0.78)';
    ctx.fillRect(24, yRhythm0 + 2, Math.min(w - 30, 415), 13);
    ctx.fillStyle = '#00ff6a';
    ctx.fillText(
      `DII LONGO (25 mm/s · 10 mm/mV · 1□=40ms/0.1mV) · FC ${Math.round(live.clock.hr)} bpm · QT ${qtMs} ms (QTc ${qtcFridMs} ms)`,
      26,
      yRhythm0 + 12,
    );
  });

  return <canvas ref={ref} className="strip-canvas" style={{ height }} />;
}
