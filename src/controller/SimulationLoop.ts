import { MasterPhysiologyClock, type ClockCommand } from './MasterPhysiologyClock';
import { usePhysiologyStore } from './usePhysiologyStore';
import type { ClinicalParams, SimContext, SimSystem } from '../model/contracts/types';
import { HemoEventKind } from '../model/contracts/types';

/**
 * SimulationLoop — the ONLY time driver of the application.
 *
 * "Fixed timestep accumulator" pattern:
 *   acc += dtReal · timeScale
 *   while (acc ≥ h && n < MAX_SUBSTEPS) { clock.step(h); systems.step(h); acc −= h }
 * h = 1 ms (RK4 in the hemodynamic engine). SignalBank sampling at 500 Hz.
 * No Zustand `set()` happens here — only in-place mutation of `live`.
 */
export const FIXED_H = 0.001;
const MAX_SUBSTEPS = 250;

class SimulationLoopImpl {
  readonly clock: MasterPhysiologyClock;
  private systems: SimSystem[] = [];
  private acc = 0;
  private lastNow = 0;
  private rafId = 0;
  private stepCounter = 0;
  private sampleEvery: number;
  private ctx: SimContext;
  private cmd: ClockCommand;
  private started = false;
  /** average cost (ms) of the physics block per frame — telemetry */
  physicsMs = 0;
  /** steps executed in the last frame */
  lastSubsteps = 0;

  constructor() {
    const store = usePhysiologyStore.getState();
    this.clock = new MasterPhysiologyClock();
    // The store's ClockState IS the clock state (same reference).
    store.live.clock = this.clock.state;
    this.ctx = { clock: this.clock.state, live: store.live, params: store.params };
    this.sampleEvery = Math.max(1, Math.round(1 / (FIXED_H * store.bank.sampleRate)));
    this.cmd = { hr: 72, rhythm: 'sinus', flutterConduction: 2, qtc: 0.41, respRate: 14, inspFraction: 1 / 3 };

    this.clock.addListener({
      onBeatStart: (c) => {
        if (c.atrialActive) this.ctx.live.hemo.events.push(HemoEventKind.PWave, c.t);
        this.ctx.live.hemo.events.push(HemoEventKind.BeatStart, c.t);
      },
      onQRS: (c) => this.ctx.live.hemo.events.push(HemoEventKind.QRS, c.t),
    });

    usePhysiologyStore.subscribe(
      (s) => s.params,
      (params, prev) => {
        this.ctx.params = params;
        for (const sys of this.systems) sys.onParamsChanged?.(params, prev, this.ctx);
      },
    );
    usePhysiologyStore.subscribe(
      (s) => s.resetToken,
      () => this.reset(),
    );
  }

  get context(): SimContext {
    return this.ctx;
  }

  register(...systems: SimSystem[]): void {
    for (const sys of systems) {
      if (this.systems.some((s) => s.id === sys.id)) continue;
      this.systems.push(sys);
      sys.reset?.(this.ctx);
    }
    this.systems.sort((a, b) => a.order - b.order);
  }

  unregister(id: string): void {
    this.systems = this.systems.filter((s) => s.id !== id);
  }

  hasSystem(id: string): boolean {
    return this.systems.some((s) => s.id === id);
  }

  private updateCommand(p: ClinicalParams): void {
    const hemo = this.ctx.live.hemo;
    this.cmd.hr = hemo.hrCommand > 0 ? hemo.hrCommand : p.ecg.heartRate;
    this.cmd.rhythm = p.ecg.rhythm;
    this.cmd.flutterConduction = p.ecg.flutterConduction;
    this.cmd.qtc = p.ecg.qtc;
    this.cmd.respRate = p.ventilation.respRate;
    this.cmd.inspFraction = 1 / 3;
  }

  reset(): void {
    const store = usePhysiologyStore.getState();
    this.updateCommand(store.params);
    // The previous feedback is not a clinical initial condition.
    this.cmd.hr = store.params.ecg.heartRate;
    this.clock.reset(this.cmd);
    store.bank.clear();
    store.live.hemo.events.clear();
    this.acc = 0;
    this.stepCounter = 0;
    this.physicsMs = 0;
    this.lastSubsteps = 0;
    for (const sys of this.systems) sys.reset?.(this.ctx);
    this.lastNow = performance.now();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reset();
    const tick = (now: number) => {
      this.rafId = requestAnimationFrame(tick);
      this.frame(now);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.started = false;
  }

  /** Advances the simulation manually (tests / headless mode). */
  advance(seconds: number): void {
    const n = Math.round(seconds / FIXED_H);
    for (let i = 0; i < n; i++) this.substep();
  }

  private substep(): void {
    const ctx = this.ctx;
    this.updateCommand(ctx.params);
    this.clock.step(FIXED_H, this.cmd);
    const systems = this.systems;
    for (let i = 0; i < systems.length; i++) systems[i].step?.(FIXED_H, ctx);
    if (++this.stepCounter >= this.sampleEvery) {
      this.stepCounter = 0;
      const bank = usePhysiologyStore.getState().bank;
      const c = ctx.clock;
      bank.set('t', c.t);
      bank.set('phi', c.phi);
      bank.set('phiResp', c.phiResp);
      for (let i = 0; i < systems.length; i++) systems[i].sample?.(bank, ctx);
      bank.commit();
    }
  }

  private frame(now: number): void {
    const store = usePhysiologyStore.getState();
    let dtReal = (now - this.lastNow) / 1000;
    this.lastNow = now;
    if (dtReal > 0.25) dtReal = 0.25; // tab in background
    if (store.running) {
      const t0 = performance.now();
      this.acc += dtReal * store.timeScale;
      let n = 0;
      while (this.acc >= FIXED_H && n < MAX_SUBSTEPS) {
        this.substep();
        this.acc -= FIXED_H;
        n++;
      }
      if (n === MAX_SUBSTEPS) this.acc = 0; // avoids spiral of death
      this.lastSubsteps = n;
      this.physicsMs = this.physicsMs * 0.9 + (performance.now() - t0) * 0.1;
    }
    const systems = this.systems;
    for (let i = 0; i < systems.length; i++) systems[i].frame?.(dtReal, this.ctx);
  }
}

export type SimulationLoop = SimulationLoopImpl;

let instance: SimulationLoopImpl | null = null;
export function getSimulationLoop(): SimulationLoopImpl {
  if (!instance) instance = new SimulationLoopImpl();
  return instance;
}
