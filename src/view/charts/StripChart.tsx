import { getBank } from '../../controller/usePhysiologyStore';
import { useCanvas2D } from '../../controller/useRafLoop';

export interface StripTrace {
  channel: string;
  color: string;
  label: string;
  min: number;
  max: number;
  unit?: string;
}

interface Props {
  traces: StripTrace[];
  /** displayed time window (s) */
  seconds?: number;
  height?: number | string;
  grid?: boolean;
}

/**
 * Multiparameter monitor trace (Canvas 2D, sweep with erase bar).
 * Reads the SignalBank directly every frame — zero re-render.
 */
export function StripChart({ traces, seconds = 6, height = 120, grid = true }: Props) {
  const ref = useCanvas2D((ctx, w, h) => {
    const bank = getBank();
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, w, h);
    if (grid) {
      ctx.strokeStyle = '#111a22';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x += w / (seconds * 5)) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = 0; y < h; y += h / 4) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();
    }
    const n = Math.min(bank.count, Math.floor(seconds * bank.sampleRate));
    if (n < 2) return;
    const total = Math.floor(seconds * bank.sampleRate);
    // sweep mode: x position = (global sample mod total)
    const sweepPos = bank.total % total;
    const gap = Math.floor(total * 0.02);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    for (const tr of traces) {
      const buf = bank.read(tr.channel);
      if (!buf) continue;
      ctx.strokeStyle = tr.color;
      ctx.beginPath();
      let pen = false;
      for (let k = n - 1; k >= 0; k--) {
        const globalIdx = bank.total - 1 - k;
        const xs = ((globalIdx % total) + total) % total;
        // erases the region just ahead of the sweep
        const ahead = (xs - sweepPos + total) % total;
        if (ahead < gap) {
          pen = false;
          continue;
        }
        const v = buf[bank.indexAgo(k)];
        const x = (xs / total) * w;
        const y = h - ((v - tr.min) / (tr.max - tr.min)) * h;
        if (!pen || xs === 0) {
          ctx.moveTo(x, y);
          pen = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // legends
    ctx.font = '10px ui-monospace, Consolas, monospace';
    let lx = 6;
    for (const tr of traces) {
      ctx.fillStyle = tr.color;
      const txt = `${tr.label}${tr.unit ? ` (${tr.unit})` : ''}`;
      ctx.fillText(txt, lx, 12);
      lx += ctx.measureText(txt).width + 12;
    }
  });
  return <canvas ref={ref} className="strip-canvas" style={{ height }} />;
}
