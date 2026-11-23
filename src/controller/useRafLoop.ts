import { useEffect, useRef } from 'react';

/**
 * Runs `cb` on every video frame (or limited to `hz`), without React re-render.
 * Basis for transient LiveState reads in DOM/Canvas 2D components.
 */
export function useRafLoop(cb: (dt: number, now: number) => void, hz = 0): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    let id = 0;
    let last = performance.now();
    let acc = 0;
    const period = hz > 0 ? 1000 / hz : 0;
    const tick = (now: number) => {
      id = requestAnimationFrame(tick);
      const dt = now - last;
      last = now;
      if (period > 0) {
        acc += dt;
        if (acc < period) return;
        acc %= period;
      }
      cbRef.current(dt / 1000, now);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [hz]);
}

/** Canvas 2D sized by ResizeObserver × devicePixelRatio. */
export function useCanvas2D(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) => void,
  hz = 0,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      size.current = { w: r.width, h: r.height, dpr };
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useRafLoop(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h, dpr } = size.current;
    if (w === 0 || h === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, w, h, dpr);
  }, hz);

  return canvasRef;
}
