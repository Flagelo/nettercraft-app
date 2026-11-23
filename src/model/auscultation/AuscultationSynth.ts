import type { SimContext, SimSystem } from '../contracts/types';
import { HemoEventKind } from '../contracts/types';

/**
 * Cardiac Auscultation Synthesizer via Web Audio API (clinical-audio-semiologia-synth).
 *
 * Generates:
 *  - S1 (M1 + T1 at mitral/tricuspid closure)
 *  - S2 (A2 + P2 with physiological splitting on inspiration, wide in RBBB and paradoxical in LBBB/AS)
 *  - S3 (ventricular gallop in HFrEF / volume overload)
 *  - S4 (atrial gallop in HFpEF / left ventricular hypertrophy in sinus rhythm)
 *  - Systolic and diastolic murmurs modulated in real time by the gradient (ΔP) and flow (Q) of the valves:
 *      • Aortic Stenosis (systolic crescendo-decrescendo diamond)
 *      • Mitral Regurgitation (holosystolic plateau)
 *      • Aortic Regurgitation (diastolic decrescendo blowing)
 *      • Mitral Stenosis (low-frequency diastolic rumble)
 *  - Continuous Phonocardiogram trace ('phono' in the SignalBank) for synchronized display.
 */

export type AuscultationFocus = 'aortic' | 'pulmonary' | 'tricuspid' | 'mitral';
export type StethoscopePiece = 'diaphragm' | 'bell';

/**
 * Provisional timing constants for S1 (M1 and T1) after the electrical QRS.
 * NOTE: Provisional engineering values subject to ongoing clinical review.
 */
export const M1_DELAY_AFTER_QRS_MS = 18;
export const T1_OFFSET_MS = 22;

const FOCUS_WEIGHTS: Record<
  AuscultationFocus,
  { b1: number; a2: number; p2: number; b3b4: number; aoSys: number; aoDia: number; miSys: number; miDia: number }
> = {
  aortic: { b1: 0.45, a2: 1.0, p2: 0.35, b3b4: 0.2, aoSys: 1.0, aoDia: 0.85, miSys: 0.25, miDia: 0.15 },
  pulmonary: { b1: 0.45, a2: 0.55, p2: 1.0, b3b4: 0.25, aoSys: 0.55, aoDia: 0.9, miSys: 0.25, miDia: 0.15 },
  tricuspid: { b1: 0.85, a2: 0.45, p2: 0.5, b3b4: 0.65, aoSys: 0.35, aoDia: 0.65, miSys: 0.55, miDia: 0.4 },
  mitral: { b1: 1.0, a2: 0.5, p2: 0.25, b3b4: 1.0, aoSys: 0.4, aoDia: 0.35, miSys: 1.0, miDia: 1.0 },
};

export class AuscultationSynth implements SimSystem {
  readonly id = 'auscultation';
  readonly order = 30;

  enabled = false;
  monitorBeepEnabled = false;
  volume = 0.7;
  focus: AuscultationFocus = 'mitral';
  piece: StethoscopePiece = 'diaphragm';

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private monitorGain: GainNode | null = null;
  private pieceFilter: BiquadFilterNode | null = null;
  private murmurFilter: BiquadFilterNode | null = null;
  private murmurGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private murmurSource: AudioBufferSourceNode | null = null;
  private murmurResumeAfter = 0;
  private scheduledSources = new Map<AudioScheduledSourceNode, AudioNode | null>();

  private eventCursor = 0;
  private lastAlarmTime = -10;
  private lastQrsBeatIndex = -1;
  // Analytic phonocardiogram state (for the 'phono' channel of the SignalBank)
  private phonoEnv = 0;
  private phonoPhase = 0;
  private pendingSecondB2Time = -1;
  private pendingSecondB2Amp = 0;
  private pendingSecondB2Freq = 58;

  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  toggleEnabled(): void {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.ensureAudioContext();
      this.ctx?.resume();
      if (this.masterGain && this.ctx) {
        this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
      }
    } else if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
    }
    this.notify();
  }

  toggleMonitorBeep(): void {
    this.monitorBeepEnabled = !this.monitorBeepEnabled;
    if (this.monitorBeepEnabled) {
      this.ensureAudioContext();
      this.ctx?.resume();
      if (this.monitorGain && this.ctx) {
        this.monitorGain.gain.setTargetAtTime(this.volume * 0.45, this.ctx.currentTime, 0.02);
      }
    } else if (this.monitorGain && this.ctx) {
      this.monitorGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
    }
    this.notify();
  }

  setFocus(f: AuscultationFocus): void {
    this.focus = f;
    this.notify();
  }

  setPiece(p: StethoscopePiece): void {
    this.piece = p;
    if (this.pieceFilter && this.ctx) {
      this.pieceFilter.type = p === 'bell' ? 'lowpass' : 'highpass';
      this.pieceFilter.frequency.setTargetAtTime(p === 'bell' ? 165 : 42, this.ctx.currentTime, 0.03);
    }
    this.notify();
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && this.ctx && this.enabled) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
    if (this.monitorGain && this.ctx && this.monitorBeepEnabled) {
      this.monitorGain.gain.setTargetAtTime(this.volume * 0.45, this.ctx.currentTime, 0.02);
    }
    this.notify();
  }

  private ensureAudioContext(): void {
    if (this.ctx) return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.enabled ? this.volume : 0;

    const monitor = ctx.createGain();
    monitor.gain.value = this.monitorBeepEnabled ? this.volume * 0.45 : 0;
    monitor.connect(ctx.destination);
    this.monitorGain = monitor;

    const pieceFilter = ctx.createBiquadFilter();
    pieceFilter.type = this.piece === 'bell' ? 'lowpass' : 'highpass';
    pieceFilter.frequency.value = this.piece === 'bell' ? 165 : 42;

    // Continuous white noise generator for murmurs
    const bufLen = ctx.sampleRate * 2;
    const noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = noiseBuf;

    const murmurFilter = ctx.createBiquadFilter();
    murmurFilter.type = 'bandpass';
    murmurFilter.frequency.value = 260;
    murmurFilter.Q.value = 2.0;

    const murmurGain = ctx.createGain();
    murmurGain.gain.value = 0;

    murmurFilter.connect(murmurGain);
    murmurGain.connect(pieceFilter);
    pieceFilter.connect(master);
    master.connect(ctx.destination);

    this.masterGain = master;
    this.pieceFilter = pieceFilter;
    this.murmurFilter = murmurFilter;
    this.murmurGain = murmurGain;
    this.startMurmurSource();
  }

  private trackSource(source: AudioScheduledSourceNode, output: AudioNode | null = null): void {
    this.scheduledSources.set(source, output);
    source.onended = () => {
      if (!this.scheduledSources.delete(source)) return;
      source.disconnect?.();
      output?.disconnect?.();
      source.onended = null;
    };
  }

  private startMurmurSource(): void {
    if (!this.ctx || !this.noiseBuffer || !this.murmurFilter || this.murmurSource) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    source.connect(this.murmurFilter);
    this.trackSource(source);
    this.murmurSource = source;
    source.start();
  }

  frame(_dtReal: number, ctx: SimContext): void {
    // Recreate only the disposable noise source, after physics has resumed.
    // The fixed graph, noise buffer and AudioContext survive the reset.
    if (this.enabled && !this.murmurSource && ctx.clock.t > this.murmurResumeAfter) this.startMurmurSource();
  }

  /** Fires a damped transient (heart sound) in the Web Audio API. */
  private triggerHeartSound(freq: number, tauSec: number, gainAmp: number, delaySec = 0): void {
    if (!this.enabled || !this.ctx || !this.pieceFilter || gainAmp <= 0.01) return;
    const now = this.ctx.currentTime + Math.max(0, delaySec);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 1.25, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(18, freq * 0.72), now + tauSec * 2.6);

    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(Math.min(1.2, gainAmp), now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0008, now + tauSec * 3.2);

    osc.connect(g);
    g.connect(this.pieceFilter);
    this.trackSource(osc, g);
    osc.start(now);
    osc.stop(now + tauSec * 3.4);
  }

  /**
   * Report item 7.4: Beep synchronized to the QRS (ICU Multiparameter Monitor) with pitch
   * modulated by perfusion/MAP (pulse-oximeter style: higher-pitched in normotension, lower-pitched in hypotension).
   */
  private triggerMonitorQrsBeep(mapMmHg: number): void {
    if (!this.monitorBeepEnabled || !this.ctx || !this.monitorGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const pitch = clamp(540 + (mapMmHg - 55) * 4.2, 420, 880);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitch, now);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.28, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.055);
    osc.connect(g);
    g.connect(this.monitorGain);
    this.trackSource(osc, g);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  /**
   * Acoustic clinical alarm (IEC 60601-1-8) triggered upon critical hemodynamic deterioration
   * (MAP < 65 mmHg, severe pulmonary congestion LVEDP ≥ 22 mmHg or extreme tachyarrhythmia HR > 135 bpm).
   */
  private triggerMonitorAlarm(): void {
    if (!this.monitorBeepEnabled || !this.ctx || !this.monitorGain) return;
    const now = this.ctx.currentTime;
    const notes = [880, 660];
    notes.forEach((freq, idx) => {
      if (!this.ctx || !this.monitorGain) return;
      const t0 = now + idx * 0.14;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.22, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.11);
      osc.connect(g);
      g.connect(this.monitorGain);
      this.trackSource(osc, g);
      osc.start(t0);
      osc.stop(t0 + 0.12);
    });
  }

  reset(ctx: SimContext): void {
    for (const [source, output] of this.scheduledSources) {
      source.onended = null;
      // A source may have ended before its queued onended callback runs.
      try { source.stop?.(0); } catch { /* Still disconnect it and the remaining sources. */ }
      source.disconnect?.();
      output?.disconnect?.();
    }
    this.scheduledSources.clear();
    this.murmurSource = null;
    this.murmurResumeAfter = ctx.clock.t;
    if (this.ctx && this.murmurGain) {
      this.murmurGain.gain.cancelScheduledValues?.(this.ctx.currentTime);
      this.murmurGain.gain.setValueAtTime(0, this.ctx.currentTime);
    }
    this.eventCursor = ctx.live.hemo.events.seq;
    this.phonoEnv = 0;
    this.phonoPhase = 0;
    this.pendingSecondB2Time = -1;
    this.pendingSecondB2Amp = 0;
    this.pendingSecondB2Freq = 58;
    this.lastAlarmTime = -10;
    this.lastQrsBeatIndex = -1;
  }

  step(h: number, ctx: SimContext): void {
    const { echo, ecg } = ctx.params;
    const hemo = ctx.live.hemo;
    const c = ctx.clock;
    const fw = FOCUS_WEIGHTS[this.focus];
    const bellBoost = this.piece === 'bell' ? 1.45 : 0.75;

    // 0. Multiparameter Monitor Alarm (Item 7.4)
    if (this.monitorBeepEnabled && c.t - this.lastAlarmTime >= 3.2) {
      const isCritical = hemo.map < 65 || hemo.lvedp >= 22 || c.hr > 135;
      if (isCritical) {
        this.lastAlarmTime = c.t;
        this.triggerMonitorAlarm();
      }
    }

    // 1. Consumes valve events for S1 (and QRS beep), S2 (with A2-P2 splitting), S3 and S4
    this.eventCursor = hemo.events.forEachSince(this.eventCursor, (kind) => {
      if (kind === HemoEventKind.QRS) {
        // Guarantees exactly 1 firing per cycle even in the presence of duplicate events
        if (c.beatIndex !== this.lastQrsBeatIndex) {
          this.lastQrsBeatIndex = c.beatIndex;

          this.triggerMonitorQrsBeep(hemo.map);
          // S1 (M1 + T1): hypophonetic in systolic dysfunction, hyperphonetic in mild/moderate mitral stenosis
          const b1Amp = clamp(0.65 * (hemo.lvEes / 2.2), 0.25, 1.1) * fw.b1;

          const lvDelayMs = ecg.bundleBranchBlock === 'lbbb' ? 48 : 0;
          const rvDelayMs = ecg.bundleBranchBlock === 'rbbb' ? 45 : 0;

          const m1DelayMs = M1_DELAY_AFTER_QRS_MS + lvDelayMs;
          const t1DelayMs = m1DelayMs + T1_OFFSET_MS + (rvDelayMs - lvDelayMs);

          this.triggerHeartSound(52, 0.022, b1Amp, m1DelayMs / 1000);
          this.triggerHeartSound(46, 0.020, b1Amp * 0.45, t1DelayMs / 1000);
          this.phonoEnv = Math.max(this.phonoEnv, 0.85 * fw.b1);
        }
      } else if (kind === HemoEventKind.AorticClose) {
        // Physiological computation of S2 splitting (A2 vs P2):
        // - Spontaneous inspiration increases venous return to the RV -> delays P2 (+38 ms)
        // - RBBB delays RV activation -> wide splitting (+52 ms)
        // - LBBB or severe Aortic Stenosis delays LV ejection -> P2 precedes A2 (paradoxical splitting, which narrows on inspiration!)
        const inspFactor = c.isInspiration ? Math.sin((Math.PI * c.phiResp) / c.inspFraction) : 0;
        const a2Attenuation = clamp(echo.aorticEOA / 2.5, 0.25, 1.0); // hypophonetic A2 in severe AS
        const a2Amp = 0.72 * a2Attenuation * fw.a2;
        const p2Amp = 0.62 * clamp(hemo.papMean / 15, 0.6, 1.5) * fw.p2;

        if (ecg.bundleBranchBlock === 'lbbb' || echo.aorticEOA < 1.1) {
          // Paradoxical splitting: P2 occurs first, A2 comes after (greater distance on expiration!)
          const splitSec = Math.max(0.012, 0.055 - 0.038 * inspFactor);
          this.triggerHeartSound(54, 0.018, p2Amp, 0);
          this.triggerHeartSound(64, 0.018, a2Amp, splitSec);
          this.phonoEnv = Math.max(this.phonoEnv, 0.65);
          this.pendingSecondB2Time = c.t + splitSec;
          this.pendingSecondB2Amp = a2Amp * 0.85;
          this.pendingSecondB2Freq = 64;
        } else {
          // Normal or RBBB (wide): A2 first, P2 after
          const baseSplit = ecg.bundleBranchBlock === 'rbbb' ? 0.050 : 0.016;
          const splitSec = baseSplit + 0.036 * inspFactor;
          this.triggerHeartSound(64, 0.018, a2Amp, 0);
          this.triggerHeartSound(54, 0.018, p2Amp, splitSec);
          this.phonoEnv = Math.max(this.phonoEnv, 0.75);
          this.pendingSecondB2Time = c.t + splitSec;
          this.pendingSecondB2Amp = p2Amp * 0.85;
          this.pendingSecondB2Freq = 54;
        }
      } else if (kind === HemoEventKind.RapidFillingEnd) {
        // S3: present in HFrEF (LVEF < 42%), LV dilation (LVEDD > 58 mm) or severe mitral regurgitation
        const hasB3 = echo.lvef < 42 || echo.lvedd >= 58 || echo.mitralROA >= 0.25;
        if (hasB3) {
          const b3Amp = 0.55 * fw.b3b4 * bellBoost;
          this.triggerHeartSound(28, 0.034, b3Amp, 0);
          this.phonoEnv = Math.max(this.phonoEnv, 0.42 * fw.b3b4);
        }
      } else if (kind === HemoEventKind.AtrialKick) {
        // S4: present in HFpEF / LVH (septum or PW ≥ 12 mm or LVEDP > 16 mmHg), absent in AF/Flutter
        const wallMean = 0.5 * (echo.septum + echo.posteriorWall);
        const hasB4 = c.atrialActive && (wallMean >= 12 || hemo.lvedp >= 16);
        if (hasB4) {
          const b4Amp = 0.50 * fw.b3b4 * bellBoost;
          this.triggerHeartSound(30, 0.030, b4Amp, 0);
          this.phonoEnv = Math.max(this.phonoEnv, 0.38 * fw.b3b4);
        }
      }
    });

    // Fires the second component of S2 on the visual phonocardiogram when the time arrives
    if (this.pendingSecondB2Time > 0 && c.t >= this.pendingSecondB2Time) {
      this.phonoEnv = Math.max(this.phonoEnv, this.pendingSecondB2Amp);
      this.pendingSecondB2Time = -1;
    }

    // 2. Continuous murmur modulation by gradient (ΔP = 4v²) and instantaneous valve flow
    let murmurAmp = 0;
    let murmurFreq = 240;

    // (a) Aortic Stenosis (systole: qAortic > 0 and aorticEOA < 2.5 cm²) -> crescendo-decrescendo diamond
    if (echo.aorticEOA < 2.5 && hemo.qAortic > 20) {
      const vJet = Math.sqrt(Math.max(0, hemo.dpAortic) / 4); // m/s (Bernoulli)
      const severity = clamp((2.5 - echo.aorticEOA) / 1.8, 0, 1);
      const env = clamp((vJet / 4.2) * severity, 0, 1) * fw.aoSys;
      if (env > murmurAmp) {
        murmurAmp = env;
        murmurFreq = 190 + 85 * vJet;
      }
    }

    // (b) Mitral Regurgitation (systole: mitralROA > 0 and pLV > pLA) -> holosystolic plateau
    if (echo.mitralROA > 0.02 && hemo.dpMitral < -15) {
      const vReg = Math.sqrt(Math.max(0, -hemo.dpMitral) / 4);
      const severity = clamp(echo.mitralROA / 0.45, 0, 1);
      const env = clamp((vReg / 5.0) * severity * 0.9, 0, 0.95) * fw.miSys;
      if (env > murmurAmp) {
        murmurAmp = env;
        murmurFreq = 320 + 60 * vReg;
      }
    }

    // (c) Aortic Regurgitation (diastole: aorticROA > 0 and pAo > pLV) -> high-pitched decrescendo blowing
    if (echo.aorticROA > 0.02 && hemo.dpAortic < -10) {
      const vReg = Math.sqrt(Math.max(0, -hemo.dpAortic) / 4);
      const severity = clamp(echo.aorticROA / 0.35, 0, 1);
      const env = clamp((vReg / 4.2) * severity * 0.85, 0, 0.9) * fw.aoDia;
      if (env > murmurAmp) {
        murmurAmp = env;
        murmurFreq = 420 + 70 * vReg;
      }
    }

    // (d) Mitral Stenosis (diastole: mitralEOA < 2.5 cm² and qMitral > 15) -> low-pitched rumble
    if (echo.mitralEOA < 2.5 && hemo.qMitral > 15) {
      const vMi = Math.sqrt(Math.max(0, hemo.dpMitral) / 4);
      const severity = clamp((2.5 - echo.mitralEOA) / 1.6, 0, 1);
      const env = clamp((vMi / 2.2) * severity * 0.85, 0, 0.85) * fw.miDia * bellBoost;
      if (env > murmurAmp) {
        murmurAmp = env;
        murmurFreq = 95 + 35 * vMi;
      }
    }

    if (this.enabled && this.ctx && this.murmurGain && this.murmurFilter) {
      const now = this.ctx.currentTime;
      this.murmurGain.gain.setTargetAtTime(murmurAmp * 0.38, now, 0.012);
      this.murmurFilter.frequency.setTargetAtTime(murmurFreq, now, 0.015);
    }

    // Evolution of the phonocardiogram signal for the 2D Canvas
    this.phonoEnv *= Math.exp(-h / 0.018);
    this.phonoPhase += h * (this.pendingSecondB2Freq || 58) * Math.PI * 2;
  }

  sample(bank: import('../contracts/types').SignalBankLike, ctx: SimContext): void {
    const hemo = ctx.live.hemo;
    const { echo } = ctx.params;
    // Visual murmur noise if there is active valvulopathy
    let murmurOsc = 0;
    if (echo.aorticEOA < 2.5 && hemo.qAortic > 20) {
      murmurOsc = 0.38 * Math.sin(this.phonoPhase * 3.7) * clamp((hemo.qAortic - 20) / 350, 0, 1);
    } else if (echo.mitralROA > 0.02 && hemo.dpMitral < -15) {
      murmurOsc = 0.34 * Math.sin(this.phonoPhase * 4.3) * clamp(echo.mitralROA / 0.4, 0, 1);
    } else if (echo.aorticROA > 0.02 && hemo.dpAortic < -10) {
      murmurOsc = 0.30 * Math.sin(this.phonoPhase * 5.1) * clamp((-hemo.dpAortic) / 80, 0, 1);
    } else if (echo.mitralEOA < 2.5 && hemo.qMitral > 15) {
      murmurOsc = 0.30 * Math.sin(this.phonoPhase * 1.9) * clamp(hemo.qMitral / 250, 0, 1);
    }
    const val = this.phonoEnv * Math.sin(this.phonoPhase) + murmurOsc;
    bank.set('phono', clamp(val, -1, 1));
  }
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
