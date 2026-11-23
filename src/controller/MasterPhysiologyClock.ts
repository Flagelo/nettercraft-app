import type { ClockState, Rhythm } from '../model/contracts/types';

/**
 * MasterPhysiologyClock — relógio fisiológico mestre.
 *
 * Acumulador de fase contínua (nunca `t mod RR`):
 *   φ_{k+1} = φ_k + h / RR_k,            φ ∈ [0,1)
 *   φresp_{k+1} = φresp_k + h · FR / 60,  φresp ∈ [0,1)
 *
 * Escalonamento sístole × diástole (Fridericia, padrão; Bazett opcional):
 *   QT = QTc · RR^(1/3)        Ts = Ts_ref · RR^(1/3)        Td = RR − PR − Ts
 * ⇒ a taquicardia encurta predominantemente a diástole.
 *
 * Eventos: início do batimento (φ = 0 ≡ início da onda P), QRS (tInBeat ≥ PR).
 * Em FA não há onda P organizada (atrialActive = false) e o RR é irregular.
 * No flutter, o ciclo atrial é fixo (~200 ms) e o RR = ciclo atrial × condução.
 */
export type QtFormula = 'fridericia' | 'bazett';

export interface ClockCommand {
  hr: number;
  rhythm: Rhythm;
  flutterConduction: number;
  qtc: number;
  respRate: number;
  /** fração inspiratória (I:E 1:2 → 1/3) */
  inspFraction: number;
}

export interface ClockListener {
  onBeatStart?(clock: ClockState): void;
  onQRS?(clock: ClockState): void;
}

const TS_REF = 0.3; // sístole mecânica de referência a 60 bpm (s)
const FLUTTER_ATRIAL_CYCLE = 0.2; // 300/min
const AF_ATRIAL_CYCLE = 0.16; // ondas f ~ 375/min (só para visual)

export class MasterPhysiologyClock {
  readonly state: ClockState;
  formula: QtFormula = 'fridericia';
  private listeners: ClockListener[] = [];
  private qrsFired = false;
  private rng: () => number;

  constructor(private readonly seed = 1234567) {
    this.rng = mulberry32(seed);
    this.state = createInitialClockState();
  }

  addListener(l: ClockListener): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  reset(cmd: ClockCommand): void {
    const s = this.state;
    // Reinício por configuração/seed; mantém o objeto público e os listeners.
    Object.assign(s, createInitialClockState());
    this.rng = mulberry32(this.seed);
    s.inspFraction = cmd.inspFraction;
    s.isInspiration = s.phiResp < s.inspFraction;
    this.qrsFired = false;
    this.beginBeat(cmd);
  }

  /** Durações dependentes do RR (Fridericia/Bazett). */
  scaleIntervals(rr: number, qtc: number): { ts: number; qt: number; pr: number } {
    const f = this.formula === 'bazett' ? Math.sqrt(rr) : Math.cbrt(rr);
    const qt = qtc * f;
    const pr = clamp(0.16 * Math.pow(rr, 0.25), 0.12, 0.2);
    // Sístole mecânica escala como QT; limitada para sempre deixar diástole mínima
    const ts = Math.min(TS_REF * f, 0.7 * rr);
    return { ts, qt, pr };
  }

  private sampleRR(cmd: ClockCommand): number {
    const meanRR = 60 / clamp(cmd.hr, 20, 250);
    switch (cmd.rhythm) {
      case 'af': {
        // RR irregularmente irregular: gaussiana limitada CV ~11 %, piso 0.42 s para preservar enchimento diastólico
        const g = clamp(gaussian(this.rng), -1.6, 1.6);
        return Math.max(0.42, meanRR * (1 + 0.11 * g));
      }
      case 'flutter':
        return FLUTTER_ATRIAL_CYCLE * clamp(Math.round(cmd.flutterConduction), 1, 8);
      default:
        return meanRR;
    }
  }

  private beginBeat(cmd: ClockCommand): void {
    const s = this.state;
    s.rr = this.sampleRR(cmd);
    if (cmd.rhythm === 'af') {
      const instHr = 60 / s.rr;
      s.hr = s.beatIndex <= 1 ? cmd.hr : s.hr + (instHr - s.hr) * 0.35;
    } else {
      s.hr = 60 / s.rr;
    }
    const iv = this.scaleIntervals(s.rr, cmd.qtc);
    s.ts = iv.ts;
    s.qt = iv.qt;
    s.atrialActive = cmd.rhythm === 'sinus';
    // Sem onda P em FA/flutter: QRS logo no início do ciclo
    s.pr = s.atrialActive ? iv.pr : 0.04;
    if (s.atrialActive) s.tSinceP = 0;
    this.qrsFired = false;
    for (const l of this.listeners) l.onBeatStart?.(s);
  }

  /** Avança h segundos. SEM alocação. */
  step(h: number, cmd: ClockCommand): void {
    const s = this.state;
    s.t += h;
    s.tSinceQRS += h;
    s.tSinceP += h;

    // Ritmo sinusal: RR e intervalos QT/Ts acompanham a FC comandada continuamente
    if (cmd.rhythm === 'sinus') {
      const target = 60 / clamp(cmd.hr, 20, 250);
      s.rr += (target - s.rr) * Math.min(1, h / 0.5); // suavização ~0.5 s
      s.hr = 60 / s.rr;
      const iv = this.scaleIntervals(s.rr, cmd.qtc);
      s.ts = iv.ts;
      s.qt = iv.qt;
    }

    s.phi += h / s.rr;
    s.tInBeat = s.phi * s.rr;

    if (!this.qrsFired && s.tInBeat >= s.pr) {
      this.qrsFired = true;
      s.lastRR = s.tSinceQRS;
      s.tSinceQRS = 0;
      for (const l of this.listeners) l.onQRS?.(s);
    }

    if (s.phi >= 1) {
      s.phi -= 1;
      s.beatIndex++;
      this.beginBeat(cmd);
      s.tInBeat = s.phi * s.rr;
    }

    // Atividade atrial (ondas F/f para visual e ECG)
    const atrialCycle = cmd.rhythm === 'flutter' ? FLUTTER_ATRIAL_CYCLE : cmd.rhythm === 'af' ? AF_ATRIAL_CYCLE : s.rr;
    if (cmd.rhythm === 'sinus') s.atrialPhi = s.phi;
    else {
      s.atrialPhi += h / atrialCycle;
      if (s.atrialPhi >= 1) s.atrialPhi -= 1;
    }

    // Respiração
    s.inspFraction = cmd.inspFraction;
    s.phiResp += (h * clamp(cmd.respRate, 0, 60)) / 60;
    if (s.phiResp >= 1) s.phiResp -= 1;
    s.isInspiration = s.phiResp < s.inspFraction;
  }
}

function createInitialClockState(): ClockState {
  return {
    t: 0, phi: 0, phiResp: 0, beatIndex: 0, rr: 0.8, hr: 75,
    ts: TS_REF, qt: 0.4, pr: 0.16, tInBeat: 0, tSinceQRS: 0.5,
    tSinceP: 0, lastRR: 0.8, atrialPhi: 0, atrialActive: true,
    isInspiration: true, inspFraction: 1 / 3,
  };
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
