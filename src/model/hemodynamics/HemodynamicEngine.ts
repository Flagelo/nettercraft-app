import type { ClinicalParams, SimContext, SimSystem } from '../contracts/types';
import { HemoEventKind } from '../contracts/types';

/**
 * Hemodynamic 0D Lumped-Parameter Engine (RK4, h = 1 ms)
 * Segue rigorosamente a skill `.agents/skills/hemodynamic-0d-lumped-engine/SKILL.md`.
 *
 * Vetor de estado y (16 variáveis):
 *   0: V_la   1: V_lv   2: V_ra   3: V_rv     (mL)
 *   4: V_sa   5: V_sv   6: V_pa   7: V_pv     (mL)
 *   8: Q_mi   9: Q_ao  10: Q_tr  11: Q_pu     (mL/s)
 *  12: z_mi  13: z_ao  14: z_tr  15: z_pu     (abertura valvar ζ ∈ [0,1])
 */

const N_STATE = 16;

// Constantes da função de ativação Double-Hill (Stergiopulos 1996)
const M1 = 1.32;
const M2 = 27.4;
const K_HILL = 1.672; // normaliza max(e(t)) = 1.0

export function doubleHill(t: number, ts: number): number {
  if (t <= 0 || t >= ts * 1.35 || ts <= 0.05) return 0;
  const tau1 = 0.269 * ts;
  const tau2 = 0.452 * ts;
  const g1 = Math.pow(t / tau1, M1);
  const g2 = Math.pow(t / tau2, M2);
  const e = K_HILL * (g1 / (1 + g1)) * (1 / (1 + g2));
  return e > 1 ? 1 : e < 0 ? 0 : e;
}

/**
 * Atraso eletromecânico interatrial (RA-LA activation lead): o AD ativa no início da onda P,
 * e o AE ativa 27 ms depois (26,9 ± 13,7 ms em normais; Hosseinsabet 2015, PMID 26574761).
 */
export const RA_LA_ACTIVATION_LEAD_S = 0.027;

/*
 * Ativação ventricular (double-Hill de Stergiopulos 1996). Na referência, as constantes de tempo são frações
 * do PERÍODO de ativação T, e não da sístole Ts. O átrio continua com doubleHill(t, 0.115) acima.
 *   T = min(LV_ACT_T_REF·√RR, RR/0,6): o limite garante e ≈ 0 antes do próximo QRS.
 *   τ1 = 0,46·T (subida mais lenta que a original 0,269, reduz o pico de fluxo e o gradiente VE–Ao),
 *   τ2 = 0,452·T, M1 = 1,32 e M2 = 27,4 (Stergiopulos).
 * A dependência √RR foi calibrada para a LVET (C4, PROVISÓRIO: Weissler não verificado), e não tirada de uma fonte.
 */
const LV_ACT_T_REF = 1.0; // s, período de ativação para RR = 1 s
const LV_TAU1 = 0.46;
const LV_TAU2 = 0.452;
const LV_K_HILL = (() => {
  // normalização exata: máx(e) = 1 (cálculo único no carregamento do módulo, fora do hot path)
  let mx = 0;
  for (let i = 1; i < 20000; i++) {
    const x = i / 10000;
    const g1 = Math.pow(x / LV_TAU1, M1);
    const g2 = Math.pow(x / LV_TAU2, M2);
    const v = (g1 / (1 + g1)) / (1 + g2);
    if (v > mx) mx = v;
  }
  return 1 / mx;
})();

/** Período de ativação ventricular T(RR) em segundos. */
export function ventricularActivationPeriod(rr: number): number {
  const t = LV_ACT_T_REF * Math.sqrt(Math.max(0.2, rr));
  const tMax = rr / 0.6;
  return t < tMax ? t : tMax;
}

/** Elastância ventricular normalizada e(t) ∈ [0,1], com t = tempo desde o QRS (s). */
export function ventricularElastance(t: number, rr: number): number {
  if (t <= 0) return 0;
  const T = ventricularActivationPeriod(rr);
  if (t >= T * 1.35) return 0;
  const g1 = Math.pow(t / (LV_TAU1 * T), M1);
  const g2 = Math.pow(t / (LV_TAU2 * T), M2);
  const e = LV_K_HILL * (g1 / (1 + g1)) * (1 / (1 + g2));
  return e > 1 ? 1 : e < 0 ? 0 : e;
}

/** Fórmula de Teichholz: D (mm) -> Volume (mL) */
export function teichholzVolume(dMm: number): number {
  const dCm = Math.max(1.0, dMm / 10);
  return (7.0 / (2.4 + dCm)) * (dCm * dCm * dCm);
}

interface DerivedModelParams {
  // LV
  lvEes: number;
  lvV0: number;
  lvA: number;
  lvB: number;
  // RV
  rvEes: number;
  rvV0: number;
  rvA: number;
  rvB: number;
  // LA
  laEes: number;
  laV0: number;
  laA: number;
  laB: number;
  // RA
  raEes: number;
  raV0: number;
  raA: number;
  raB: number;
  // Vasos
  rSA: number;
  zC: number;
  cSA: number;
  cSV: number;
  rVR: number;
  rPA: number;
  zCP: number;
  cPA: number;
  cPV: number;
  vuSA: number;
  vuSV: number;
  vuPA: number;
  vuPV: number;
  // Valvas (cm²)
  aoAmin: number;
  aoAmax: number;
  miAmin: number;
  miAmax: number;
  trAmin: number;
  trAmax: number;
  puAmin: number;
  puAmax: number;
  // Atrasos de condução ventricular (s)
  lvDelay: number;
  rvDelay: number;
}

export class HemodynamicEngine implements SimSystem {
  readonly id = 'hemodynamics';
  readonly order = 10;

  // Vetor de estado e buffers scratch RK4 (zero alocação no hot path)
  readonly y = new Float64Array(N_STATE);
  private readonly k1 = new Float64Array(N_STATE);
  private readonly k2 = new Float64Array(N_STATE);
  private readonly k3 = new Float64Array(N_STATE);
  private readonly k4 = new Float64Array(N_STATE);
  private readonly yTmp = new Float64Array(N_STATE);

  // Parâmetros físicos derivados (atualizados sem alocação)
  private readonly mp: DerivedModelParams = {
    lvEes: 2.5, lvV0: 10, lvA: 0.35, lvB: 0.033,
    rvEes: 0.65, rvV0: 20, rvA: 0.25, rvB: 0.023,
    laEes: 0.30, laV0: 10, laA: 0.32, laB: 0.048,
    raEes: 0.20, raV0: 10, raA: 0.25, raB: 0.042,
    rSA: 0.95, zC: 0.032, cSA: 1.65, cSV: 50.0, rVR: 0.036,
    rPA: 0.09, zCP: 0.02, cPA: 4.2, cPV: 14.0,
    vuSA: 700, vuSV: 2840, vuPA: 100, vuPV: 320,
    aoAmin: 0, aoAmax: 3.5,
    miAmin: 0, miAmax: 5.0,
    trAmin: 0, trAmax: 6.0,
    puAmin: 0, puAmax: 3.8,
    lvDelay: 0, rvDelay: 0,
  };

  // Compartimentos de efeito farmacológico (Concentrações efetivas Ce)
  private ceNora = 0;
  private ceDobu = 0;
  private ceNps = 0;
  private ceFuro = 0;
  private ceMeto = 0;

  // Contabilidade de intervenções de volemia, separada do erro numérico do circuito.
  #volumeTarget = 5000;
  #volumePending = 0;
  #volumeFlow = 0;

  // Estados do barorreflexo autonômico (Ursino)
  private mapFiltered = 92;
  private baroHR = 0;
  private baroEes = 1;
  private baroRsa = 1;
  private baroVu = 0;
  private efServoGain = 1.0;
  private targetEfFrac = 0.6;

  // Acumuladores de métricas por batimento
  private lastBeatIndex = -1;
  private beatPaoMax = 120;
  private beatPaoMin = 80;
  private beatPaoSum = 0;
  private beatVlvMax = 120;
  private beatVlvMin = 50;
  private beatPlvEndDiast = 10;
  private beatPraSum = 0;
  private beatPpaSum = 0;
  private beatPlaSum = 0;
  private beatSamples = 0;
  private rapidFillingFired = false;
  private atrialKickFired = false;

  // Observador respiratório pós-reset. Não interfere na integração RK4.
  // O primeiro batimento visto depois do reset/mudança pode estar incompleto:
  // só batimentos iniciados na nova época entram no oráculo de PPV.
  private lastRespPhi = 0;
  private respPPMax = -Infinity;
  private respPPMin = Infinity;
  private respIvcMax = -Infinity;
  private respIvcMin = Infinity;
  private respBeatPaoMax = -Infinity;
  private respBeatPaoMin = Infinity;
  private respBeatSamples = 0;
  private respBeatIndex = -1;
  private respBeatComplete = false;
  private respCycleBeats = 0;
  private respCycleSamples = 0;
  private respWindowStart = 0;
  private respWindowAligned = false;
  private respObservedRate = 14;
  private respObservedMode: 'spontaneous' | 'mechanical' = 'spontaneous';

  // Estados anteriores de abertura valvar para disparar eventos
  private prevZMi = 0;
  private prevZAo = 0;
  private prevZTr = 0;
  private prevZPu = 0;
  private warmingUp = false;

  reset(ctx: SimContext): void {
    // Volumes iniciais em equilíbrio (soma = 5000 mL)
    // V_la=45, V_lv=120, V_ra=50, V_rv=125, V_sa=815, V_sv=3150, V_pa=160, V_pv=535
    this.y[0] = 45;
    this.y[1] = 120;
    this.y[2] = 50;
    this.y[3] = 125;
    this.y[4] = 815;
    this.y[5] = 3150;
    this.y[6] = 160;
    this.y[7] = 535;
    // Fluxos
    this.y[8] = 0;
    this.y[9] = 0;
    this.y[10] = 0;
    this.y[11] = 0;
    // Aberturas valvares
    this.y[12] = 0.8;
    this.y[13] = 0;
    this.y[14] = 0.8;
    this.y[15] = 0;

    // Detectores partem das condições valvares, não da história anterior.
    this.prevZMi = this.y[12];
    this.prevZAo = this.y[13];
    this.prevZTr = this.y[14];
    this.prevZPu = this.y[15];
    this.rapidFillingFired = false;
    this.atrialKickFired = false;

    this.ceNora = ctx.params.drugs.norepinephrine;
    this.ceDobu = ctx.params.drugs.dobutamine;
    this.ceNps = ctx.params.drugs.nitroprusside;
    this.ceFuro = ctx.params.drugs.furosemide;
    this.ceMeto = ctx.params.drugs.metoprolol;

    this.#volumeTarget = NaN;
    this.#volumePending = 0;
    this.#volumeFlow = 0;

    this.mapFiltered = 92;
    this.baroHR = 0;
    this.baroEes = 1;
    this.baroRsa = 1;
    this.baroVu = 0;
    this.efServoGain = 1.0;
    this.targetEfFrac = clamp(ctx.params.echo.lvef / 100, 0.15, 0.80);

    this.lastBeatIndex = ctx.clock.beatIndex;
    this.beatPaoMax = 120;
    this.beatPaoMin = 80;
    this.beatPaoSum = 0;
    this.beatVlvMax = 120;
    this.beatVlvMin = 48;
    this.beatPlvEndDiast = 9;
    this.beatPraSum = 0;
    this.beatPpaSum = 0;
    this.beatPlaSum = 0;
    this.beatSamples = 0;

    // Campos legados recomeçam com placeholders, nunca com janela medida.
    // Acumuladores observacionais serão zerados DEPOIS do warmup.
    ctx.live.hemo.ppv = 0;
    ctx.live.hemo.ivcDmin = 15;
    ctx.live.hemo.ivcDmax = 20;
    ctx.live.hemo.ivcIndex = 25;

    this.updateDerivedParams(0.001, ctx.params);
    // Pré-aquece exatamente 4 ciclos cardíacos completos (4·RR) avançando o relógio para convergir volumes e FEVE.
    // O número de passos acompanha o RR: com 3200 passos fixos o aquecimento terminava no meio da ejeção
    // (ex.: 60 bpm → φ = 0,2, valva aórtica aberta), incoerente com o relógio restaurado (NaN no 8º passo).
    const savedClock = { ...ctx.clock };
    const rrWarm = 60 / clamp(ctx.params.ecg.heartRate, 40, 180);
    const warmSteps = Math.round(4 * rrWarm * 1000);
    // A estabilização física não publica eventos na época observável pós-reset.
    // Não limpar o ring aqui: consumidores podem já ter um cursor inicializado.
    this.warmingUp = true;
    for (let i = 0; i < warmSteps; i++) {
      ctx.clock.t += 0.001;
      ctx.clock.phi += 0.001 / rrWarm;
      if (ctx.clock.phi >= 1) {
        ctx.clock.phi -= 1;
        ctx.clock.beatIndex++;
      }
      ctx.clock.tInBeat = ctx.clock.phi * rrWarm;
      ctx.clock.tSinceP = ctx.clock.tInBeat;
      ctx.clock.tSinceQRS =
        ctx.clock.tInBeat >= ctx.clock.pr
          ? ctx.clock.tInBeat - ctx.clock.pr
          : rrWarm - ctx.clock.pr + ctx.clock.tInBeat;
      this.step(0.001, ctx);
    }
    Object.assign(ctx.clock, savedClock);
    this.warmingUp = false;
    // V0 é a massa preparada: comandos fixos não continuam a preparação após t0.
    this.#volumePending = 0;
    this.#volumeFlow = 0;
    // t0 conserva a física aquecida; os observadores começam uma nova época.
    this.rapidFillingFired = false;
    this.atrialKickFired = false;
    this.lastBeatIndex = ctx.clock.beatIndex;
    this.resetRespObservation(ctx);
  }

  /** Inicia uma época de observação distinta do aquecimento físico. */
  private resetRespObservation(ctx: SimContext): void {
    const c = ctx.clock;
    const v = ctx.params.ventilation;
    this.lastRespPhi = c.phiResp;
    this.respObservedRate = v.respRate;
    this.respObservedMode = v.mode;
    this.respWindowAligned = v.respRate > 0 && c.phiResp === 0;
    this.respWindowStart = c.t;
    this.respPPMax = -Infinity;
    this.respPPMin = Infinity;
    this.respIvcMax = -Infinity;
    this.respIvcMin = Infinity;
    this.respBeatPaoMax = -Infinity;
    this.respBeatPaoMin = Infinity;
    this.respBeatSamples = 0;
    this.respBeatIndex = c.beatIndex;
    this.respBeatComplete = false;
    this.respCycleBeats = 0;
    this.respCycleSamples = 0;
    const obs = ctx.live.hemo.respObservation ?? (ctx.live.hemo.respObservation = {
      valid: false, status: 'awaiting-window', source: 'initial',
      windowStart: null, windowEnd: null, publishedAt: null, ageSeconds: null,
      sampleCount: 0, beatCount: 0, respiratoryRate: v.respRate, mode: v.mode,
    });
    obs.valid = false;
    obs.status = v.respRate > 0 ? 'awaiting-window' : 'resp-rate-zero';
    obs.source = 'initial';
    obs.windowStart = null;
    obs.windowEnd = null;
    obs.publishedAt = null;
    obs.ageSeconds = null;
    obs.sampleCount = 0;
    obs.beatCount = 0;
    obs.respiratoryRate = v.respRate;
    obs.mode = v.mode;
  }

  /**
   * Converte laudo de Eco + Farmacologia + Barorreflexo em parâmetros físicos concentrados.
   */
  private updateDerivedParams(h: number, params: ClinicalParams): void {
    const { echo, ecg, drugs, circulation } = params;
    const mp = this.mp;

    // 1. Cinética de compartimento de efeito das drogas (ke0 ~ 0.35 s^-1 para resposta rápida interativa)
    const alphaFast = Math.min(1, h * 0.45);
    const alphaSlow = Math.min(1, h * 0.18);
    this.ceNora += (drugs.norepinephrine - this.ceNora) * alphaFast;
    this.ceDobu += (drugs.dobutamine - this.ceDobu) * alphaFast;
    this.ceNps += (drugs.nitroprusside - this.ceNps) * alphaFast;
    this.ceFuro += (drugs.furosemide - this.ceFuro) * alphaSlow;
    this.ceMeto += (drugs.metoprolol - this.ceMeto) * alphaSlow;

    // Curvas Hill/Emax
    const effNora = (1.5 * Math.pow(this.ceNora, 1.2)) / (Math.pow(0.25, 1.2) + Math.pow(this.ceNora, 1.2) + 1e-9);
    const effDobu = (1.0 * Math.pow(this.ceDobu, 1.15)) / (Math.pow(5.5, 1.15) + Math.pow(this.ceDobu, 1.15) + 1e-9);
    const effNps = (0.62 * Math.pow(this.ceNps, 1.2)) / (Math.pow(1.2, 1.2) + Math.pow(this.ceNps, 1.2) + 1e-9);
    const effFuro = (1.0 * this.ceFuro) / (40 + this.ceFuro + 1e-9);
    const effMeto = (1.0 * this.ceMeto) / (6.0 + this.ceMeto + 1e-9);

    // 2. Barorreflexo autonômico (Ursino 1998 simplificado)
    if (circulation.baroreflex) {
      const errP = this.mapFiltered - 92; // positivo = hipertensão, negativo = hipotensão
      const symp = Math.tanh(-errP / 18); // [-1, +1]
      const targetHR = symp * 24;
      const targetEes = 1 + symp * 0.25;
      const targetRsa = 1 + symp * 0.32;
      const targetVu = -symp * 180; // venoconstrição na hipotensão

      this.baroHR += (targetHR - this.baroHR) * Math.min(1, h / 1.5);
      this.baroEes += (targetEes - this.baroEes) * Math.min(1, h / 3.0);
      this.baroRsa += (targetRsa - this.baroRsa) * Math.min(1, h / 2.5);
      this.baroVu += (targetVu - this.baroVu) * Math.min(1, h / 4.0);
    } else {
      this.baroHR = 0;
      this.baroEes = 1;
      this.baroRsa = 1;
      this.baroVu = 0;
    }

    // 3. Mapeamento do Ecocardiograma -> Geometria e Rigidez do VE
    const edvTarget = teichholzVolume(echo.lvedd); // 48 mm -> ~108 mL; 68 mm -> ~240 mL
    const esvTarget = teichholzVolume(echo.lvesd); // 31 mm -> ~38 mL
    const remodelRatio = edvTarget / 110;

    // V0 desloca-se para a direita em ventrículos dilatados (remodelamento excêntrico)
    // Intercepto V0 = 14 mL no VE normal (antes 8): com FE fixada pelo servo, Ees/Ea ≈ VS/(VSF − V0) (C2)
    mp.lvV0 = clamp(14 + 0.30 * (edvTarget - 108) + 0.12 * (esvTarget - 38), 5, 110);

    // Espessura média da parede (septo + PP)/2 -> rigidez diastólica B (ICFEP / HVE)
    const wallMean = 0.5 * (echo.septum + echo.posteriorWall);
    const hRatio = wallMean / 9.0; // normal = 1.0
    // Em ventrículos dilatados (remodelamento excêntrico), B diminui para acomodar maior EDV;
    // na hipertrofia concêntrica (hRatio > 1.2), B cresce exponencialmente (eleva PD2 e onda 'a')
    // Coeficiente 0.0273 (antes 0.035, ×0.78): EDPVR do VE normal rígida demais (PDFVE 16,6 mmHg com VDF 122 mL; C1)
    mp.lvB = clamp((0.0273 / Math.pow(remodelRatio, 0.72)) * Math.pow(hRatio, 2.35), 0.012, 0.095);
    mp.lvA = clamp(0.36 * Math.pow(hRatio, 0.75) / Math.pow(remodelRatio, 0.35), 0.15, 1.4);

    // Escore de motilidade regional dos 17 segmentos AHA (sem dupla penalização com echo.lvef!)
    let wmSum = 0;
    const wm = echo.wallMotion;
    for (let i = 0; i < 17; i++) {
      const s = wm[i] ?? 1;
      wmSum += s === 1 ? 1.0 : s === 2 ? 0.58 : s === 3 ? 0.20 : -0.05;
    }
    const wmFactor = clamp(wmSum / 17, 0.30, 1.0);

    // Se echo.lvef já foi reduzido (< 55%), ele já representa a disfunção global do laudo.
    // Se echo.lvef está >= 55% mas há hipocinesia/acinesia regional ou oclusão coronária aguda, aplica-se a redução proporcional única.
    const territoryMod =
      ecg.ischemiaTerritory === 'lad'
        ? 0.76
        : ecg.ischemiaTerritory === 'lcx' || ecg.ischemiaTerritory === 'rca'
          ? 0.86
          : 1.0;
    const rawEchoEf = clamp(echo.lvef / 100, 0.15, 0.80);
    const effectiveEf =
      echo.lvef < 55
        ? rawEchoEf
        : clamp(rawEchoEf * (0.48 + 0.52 * wmFactor) * (wmFactor < 0.99 ? 1.0 : territoryMod), 0.24, 0.80);

    // Modulação farmacológica aguda sobre a FEVE alvo efetiva
    const drugEfMod =
      (1 + 0.22 * effDobu + 0.06 * effNps) *
      (1 - 0.14 * effMeto - 0.05 * Math.max(0, effNora - 0.4));
    this.targetEfFrac = clamp(effectiveEf * drugEfMod, 0.15, 0.82);

    // Equação inversa exata de Suga & Sagawa: EF = (1 - V0/EDV) * Ees / (Ees + Ea)
    const edvEst = Math.max(75, this.beatVlvMax || 120);
    const v0Ratio = clamp(mp.lvV0 / edvEst, 0.04, 0.38);
    const activeEf = clamp(this.targetEfFrac / (1 - v0Ratio), 0.18, 0.88);
    const eaRef = 1.62;
    const baseEes = eaRef * (activeEf / Math.max(0.08, 1 - activeEf));
    const inotropy = this.baroEes * (1 + 0.75 * effDobu + 0.18 * effNora) * (1 - 0.25 * effMeto);
    mp.lvEes = clamp(baseEes * this.efServoGain * inotropy, 0.45, 8.0);

    // Átrio esquerdo hipertrofia secundariamente à rigidez do VE (gera onda 'a' vigorosa na ICFEP)
    const laBooster = hRatio > 1.15 ? 1 + 0.45 * (hRatio - 1.0) : 1.0;
    mp.laEes = 0.32 * laBooster;

    // 4. Vasos e Volemia
    const rvrBase = 0.95 * circulation.svrScale;
    mp.rSA = clamp(
      rvrBase * this.baroRsa * (1 + effNora) * (1 - effNps) * (1 - 0.15 * effDobu),
      0.3,
      3.8,
    );
    mp.cSA = clamp(1.65 / (1 + 0.25 * Math.max(0, hRatio - 1)), 0.6, 2.4);
    mp.rPA = clamp(0.09 * circulation.pvrScale * (1 - 0.3 * effNps), 0.04, 0.45);

    // Volume sanguíneo: ajustado por circulation.bloodVolume e Furosemida / venodilatação
    const volDelta = (circulation.bloodVolume - 5000) - 420 * effFuro;
    const currentTotal =
      this.y[0] + this.y[1] + this.y[2] + this.y[3] +
      this.y[4] + this.y[5] + this.y[6] + this.y[7];
    const targetTotal = clamp(5000 + volDelta, 3400, 6800);
    if (this.warmingUp || Number.isNaN(this.#volumeTarget)) {
      // Preserva a preparação histórica; ela não integra a época medida pós-reset.
      this.y[5] += (targetTotal - currentTotal) * Math.min(1, h * 2.0);
      this.#volumeTarget = targetTotal;
      this.#volumeFlow = 0;
    } else {
      this.#volumePending += targetTotal - this.#volumeTarget;
      this.#volumeTarget = targetTotal;
      // Mesmo ganho e limite do controlador existente; fluxo constante neste passo.
      const volumeStep = this.#volumePending * Math.min(1, h * 2.0);
      this.#volumeFlow = h > 0 ? volumeStep / h : 0;
      this.#volumePending -= volumeStep;
    }

    // Volume não-estressado venoso (venoconstrição da Nora / venodilatação do NPS e Furosemida)
    mp.vuSV = clamp(
      2840 + this.baroVu - 260 * effNora + 280 * effNps + 150 * effFuro,
      2100,
      3450,
    );

    // 5. Valvas (EOA e ROA do Eco)
    mp.aoAmax = clamp(echo.aorticEOA, 0.25, 5.0);
    mp.aoAmin = clamp(echo.aorticROA, 0, Math.min(1.2, mp.aoAmax * 0.6));
    mp.miAmax = clamp(echo.mitralEOA, 0.4, 7.0);
    mp.miAmin = clamp(echo.mitralROA, 0, Math.min(1.5, mp.miAmax * 0.6));

    // 6. Atrasos de condução (BRE / BRD)
    mp.lvDelay = ecg.bundleBranchBlock === 'lbbb' ? 0.048 : 0;
    mp.rvDelay = ecg.bundleBranchBlock === 'rbbb' ? 0.045 : 0;
  }

  /** Pressão intratorácica Ppl(t) em mmHg (espontânea vs ventilação mecânica com PEEP). */
  private computePpl(ctx: SimContext): number {
    const { ventilation } = ctx.params;
    const c = ctx.clock;
    const fInsp = c.inspFraction;
    let wave = 0;
    if (c.phiResp < fInsp) {
      wave = Math.sin((Math.PI * c.phiResp) / fInsp);
      wave *= wave;
    } else {
      const expPhi = (c.phiResp - fInsp) / (1 - fInsp);
      wave = Math.exp(-expPhi * 4.5) * 0.08;
    }

    if (ventilation.mode === 'spontaneous') {
      return -4.0 - ventilation.spontaneousEffort * wave;
    } else {
      // Conversão cmH2O -> mmHg (× 0.735) × transmissão pleuropulmonar (~0.65)
      const peepMmHg = ventilation.peep * 0.48;
      const driveMmHg = ventilation.drivingPressure * 0.42;
      return -2.0 + peepMmHg + driveMmHg * wave;
    }
  }

  /** Pressão elástica + passiva exponencial de uma câmara (Suga & Sagawa + EDPVR). */
  private chamberPressure(v: number, e: number, ees: number, v0: number, a: number, b: number, pExt: number): number {
    const dv = v - v0;
    const pAct = e * ees * dv;
    const expArg = clamp(b * Math.max(0, dv), 0, 6.5);
    const pPas = a * (Math.exp(expArg) - 1) + (dv < 0 ? 0.08 * dv : 0);
    return pAct + (1 - e) * pPas + pExt;
  }

  /** Calcula dydt(t, y) in-place sem nenhuma alocação. */
  private derivatives(
    y: Float64Array,
    dydt: Float64Array,
    eLV: number,
    eRV: number,
    eLA: number,
    eRA: number,
    pPl: number,
  ): void {
    const mp = this.mp;

    const vLA = Math.max(2, y[0]);
    const vLV = Math.max(2, y[1]);
    const vRA = Math.max(2, y[2]);
    const vRV = Math.max(2, y[3]);
    const vSA = Math.max(50, y[4]);
    const vSV = Math.max(200, y[5]);
    const vPA = Math.max(20, y[6]);
    const vPV = Math.max(50, y[7]);

    const qMi = y[8];
    const qAo = y[9];
    const qTr = y[10];
    const qPu = y[11];

    const zMi = clamp(y[12], 0, 1);
    const zAo = clamp(y[13], 0, 1);
    const zTr = clamp(y[14], 0, 1);
    const zPu = clamp(y[15], 0, 1);

    // Pressões cavitárias (intratorácicas recebem pPl)
    const pLA = this.chamberPressure(vLA, eLA, mp.laEes, mp.laV0, mp.laA, mp.laB, pPl);
    const pLV = this.chamberPressure(vLV, eLV, mp.lvEes, mp.lvV0, mp.lvA, mp.lvB, pPl);
    const pRA = this.chamberPressure(vRA, eRA, mp.raEes, mp.raV0, mp.raA, mp.raB, pPl);
    const pRV = this.chamberPressure(vRV, eRV, mp.rvEes, mp.rvV0, mp.rvA, mp.rvB, pPl);

    // Pressões vasculares
    const pSA = Math.max(5, (vSA - mp.vuSA) / mp.cSA);
    const pSV = Math.max(1, (vSV - mp.vuSV) / mp.cSV); // extratorácico
    const pPA = Math.max(2, (vPA - mp.vuPA) / mp.cPA + pPl);
    const pPV = Math.max(1, (vPV - mp.vuPV) / mp.cPV + pPl);

    // Fluxos sistêmico, venoso e pulmonar
    const qSA = (pSA - pSV) / mp.rSA;
    const qVR = (pSV - pRA) / mp.rVR;
    const qPA = (pPA - pPV) / mp.rPA;

    // Balanço de volumes (conservação exata: ∑ dV/dt = 0)
    dydt[0] = qPV_to_LA(pPV, pLA) - qMi;
    dydt[1] = qMi - qAo;
    dydt[2] = qVR - qTr;
    dydt[3] = qTr - qPu;
    dydt[4] = qAo - qSA;
    dydt[5] = qSA - qVR;
    if (this.#volumeFlow !== 0) dydt[5] += this.#volumeFlow;
    dydt[6] = qPu - qPA;
    dydt[7] = qPA - qPV_to_LA(pPV, pLA);

    // Dinâmica das 4 valvas (modelo de Mynard: Bernoulli + inertância + abertura ζ)
    // 1. Mitral (LA -> LV)
    const dpMi = pLA - pLV;
    stepValve(dpMi, qMi, zMi, mp.miAmin, mp.miAmax, dydt, 8, 12);

    // 2. Aórtica (LV -> SA, incluindo impedância característica Zc)
    const pAoRoot = pSA + mp.zC * Math.max(0, qAo);
    const dpAo = pLV - pAoRoot;
    stepValve(dpAo, qAo, zAo, mp.aoAmin, mp.aoAmax, dydt, 9, 13);

    // 3. Tricúspide (RA -> RV)
    const dpTr = pRA - pRV;
    stepValve(dpTr, qTr, zTr, mp.trAmin, mp.trAmax, dydt, 10, 14);

    // 4. Pulmonar (RV -> PA)
    const pPaRoot = pPA + mp.zCP * Math.max(0, qPu);
    const dpPu = pRV - pPaRoot;
    stepValve(dpPu, qPu, zPu, mp.puAmin, mp.puAmax, dydt, 11, 15);
  }

  private rk4Step(h: number, ctx: SimContext): void {
    const c = ctx.clock;
    const mp = this.mp;

    // Ativações elásticas no instante atual
    const tLV = c.tSinceQRS - mp.lvDelay;
    const tRV = c.tSinceQRS - mp.rvDelay;
    const eLV = ventricularElastance(tLV, c.rr);
    const eRV = ventricularElastance(tRV, c.rr);
    const eRA = c.atrialActive ? doubleHill(c.tSinceP, 0.115) : 0;
    // Atraso eletromecânico interatrial: AE atrasado 27 ms (Hosseinsabet 2015, PMID 26574761)
    const eLA = c.atrialActive ? doubleHill(c.tSinceP - RA_LA_ACTIVATION_LEAD_S, 0.115) : 0;
    const pPl = this.computePpl(ctx);

    const y = this.y;
    const k1 = this.k1;
    const k2 = this.k2;
    const k3 = this.k3;
    const k4 = this.k4;
    const yTmp = this.yTmp;

    this.derivatives(y, k1, eLV, eRV, eLA, eRA, pPl);
    for (let i = 0; i < N_STATE; i++) yTmp[i] = y[i] + 0.5 * h * k1[i];
    clampValveStates(yTmp);

    this.derivatives(yTmp, k2, eLV, eRV, eLA, eRA, pPl);
    for (let i = 0; i < N_STATE; i++) yTmp[i] = y[i] + 0.5 * h * k2[i];
    clampValveStates(yTmp);

    this.derivatives(yTmp, k3, eLV, eRV, eLA, eRA, pPl);
    for (let i = 0; i < N_STATE; i++) yTmp[i] = y[i] + h * k3[i];
    clampValveStates(yTmp);

    this.derivatives(yTmp, k4, eLV, eRV, eLA, eRA, pPl);
    const h6 = h / 6;
    for (let i = 0; i < N_STATE; i++) {
      y[i] += h6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    }
    clampValveStates(y);
  }

  step(h: number, ctx: SimContext): void {
    this.updateDerivedParams(h, ctx.params);
    this.rk4Step(h, ctx);

    // Publica variáveis instantâneas no LiveState.hemo
    const c = ctx.clock;
    const mp = this.mp;
    const hemo = ctx.live.hemo;
    const y = this.y;

    const eLV = ventricularElastance(c.tSinceQRS - mp.lvDelay, c.rr);
    const eRV = ventricularElastance(c.tSinceQRS - mp.rvDelay, c.rr);
    const eRA = c.atrialActive ? doubleHill(c.tSinceP, 0.115) : 0;
    // Atraso eletromecânico interatrial: AE atrasado 27 ms (Hosseinsabet 2015, PMID 26574761)
    const eLA = c.atrialActive ? doubleHill(c.tSinceP - RA_LA_ACTIVATION_LEAD_S, 0.115) : 0;
    const pPl = this.computePpl(ctx);

    const vLA = y[0];
    const vLV = y[1];
    const vRA = y[2];
    const vRV = y[3];
    const vSA = y[4];
    const vSV = y[5];
    const vPA = y[6];
    const vPV = y[7];

    const qMi = y[8];
    const qAo = y[9];
    const qTr = y[10];
    const qPu = y[11];

    const zMi = y[12];
    const zAo = y[13];
    const zTr = y[14];
    const zPu = y[15];

    const pLABase = this.chamberPressure(vLA, eLA, mp.laEes, mp.laV0, mp.laA, mp.laB, pPl);
    const pLV = this.chamberPressure(vLV, eLV, mp.lvEes, mp.lvV0, mp.lvA, mp.lvB, pPl);
    const pRA = this.chamberPressure(vRA, eRA, mp.raEes, mp.raV0, mp.raA, mp.raB, pPl);
    const pRV = this.chamberPressure(vRV, eRV, mp.rvEes, mp.rvV0, mp.rvA, mp.rvB, pPl);

    const pSA = Math.max(5, (vSA - mp.vuSA) / mp.cSA);
    const pSV = Math.max(1, (vSV - mp.vuSV) / mp.cSV);
    const pPA = Math.max(2, (vPA - mp.vuPA) / mp.cPA + pPl);
    const pPV = Math.max(1, (vPV - mp.vuPV) / mp.cPV + pPl);

    // Incisura dicrótica real na raiz da aorta (acoplamento Zc com o fechamento dinâmico da valva)
    const pAo = pSA + mp.zC * qAo;
    // Onda 'c' atrial (abaulamento do folheto mitral durante a contração isovolumétrica)
    const isovolWaveC = c.tSinceQRS > 0 && c.tSinceQRS < 0.065 ? 2.4 * Math.sin((Math.PI * c.tSinceQRS) / 0.065) : 0;
    const pLA = pLABase + isovolWaveC;

    hemo.pLV = pLV;
    hemo.pLA = pLA;
    hemo.pRV = pRV;
    hemo.pRA = pRA;
    hemo.pAo = pAo;
    hemo.pSA = pSA;
    hemo.pSV = pSV;
    hemo.pPA = pPA;
    hemo.pPV = pPV;
    hemo.pPl = pPl;

    hemo.vLA = vLA;
    hemo.vLV = vLV;
    hemo.vRA = vRA;
    hemo.vRV = vRV;

    hemo.qMitral = qMi;
    hemo.qAortic = qAo;
    hemo.qTricuspid = qTr;
    hemo.qPulmonary = qPu;
    hemo.qVenousReturn = (pSV - pRA) / mp.rVR;

    hemo.zMitral = zMi;
    hemo.zAortic = zAo;
    hemo.zTricuspid = zTr;
    hemo.zPulmonary = zPu;

    hemo.dpMitral = pLA - pLV;
    hemo.dpAortic = pLV - pAo;
    hemo.dpTricuspid = pRA - pRV;
    hemo.dpPulmonary = pRV - pPA;

    hemo.eLV = eLV;
    hemo.eRV = eRV;
    hemo.eLA = eLA;
    hemo.eRA = eRA;

    hemo.lvEes = mp.lvEes;
    hemo.lvV0 = mp.lvV0;
    hemo.lvA = mp.lvA;
    hemo.lvB = mp.lvB;
    hemo.svr = Math.round(mp.rSA * 80);

    // Eventos valvares para Áudio, ECG e 3D
    const now = c.t;
    if (!this.warmingUp) {
      if (this.prevZMi < 0.25 && zMi >= 0.25) hemo.events.push(HemoEventKind.MitralOpen, now);
      if (this.prevZMi >= 0.25 && zMi < 0.25) hemo.events.push(HemoEventKind.MitralClose, now);
      if (this.prevZAo < 0.25 && zAo >= 0.25) hemo.events.push(HemoEventKind.AorticOpen, now);
      if (this.prevZAo >= 0.25 && zAo < 0.25) hemo.events.push(HemoEventKind.AorticClose, now);
      if (this.prevZTr < 0.25 && zTr >= 0.25) hemo.events.push(HemoEventKind.TricuspidOpen, now);
      if (this.prevZTr >= 0.25 && zTr < 0.25) hemo.events.push(HemoEventKind.TricuspidClose, now);
      if (this.prevZPu < 0.25 && zPu >= 0.25) hemo.events.push(HemoEventKind.PulmonaryOpen, now);
      if (this.prevZPu >= 0.25 && zPu < 0.25) hemo.events.push(HemoEventKind.PulmonaryClose, now);

      // Gatilhos para B3 (fim do enchimento rápido ~140 ms após abertura mitral) e B4 (contração atrial)
      // tSinceQRS inicia em 0.5s por convenção; antes do QRS do ciclo atual não há B3.
      // O relógio emite o QRS ao alcançar PR no próprio batimento.
      if (!this.rapidFillingFired && c.tInBeat >= c.pr && c.tSinceQRS > c.ts + 0.16) {
        this.rapidFillingFired = true;
        hemo.events.push(HemoEventKind.RapidFillingEnd, now);
      }
      if (!this.atrialKickFired && c.atrialActive && c.tSinceP > 0.05 && c.tSinceP < 0.08) {
        this.atrialKickFired = true;
        hemo.events.push(HemoEventKind.AtrialKick, now);
      }
    }

    // Também acompanha a abertura estabilizada durante o warmup.
    this.prevZMi = zMi;
    this.prevZAo = zAo;
    this.prevZTr = zTr;
    this.prevZPu = zPu;

    // PD2 (LVEDP): capturado imediatamente antes do QRS
    if (c.tSinceQRS < 0.005) {
      this.beatPlvEndDiast = pLV;
    }

    // Acumulação batimento a batimento
    if (c.beatIndex !== this.lastBeatIndex) {
      if (this.beatSamples > 50) {
        hemo.sbp = Math.round(this.beatPaoMax);
        hemo.dbp = Math.round(this.beatPaoMin);
        hemo.map = Math.round(this.beatPaoSum / this.beatSamples);
        this.mapFiltered += (hemo.map - this.mapFiltered) * 0.35;

        hemo.edv = Math.round(this.beatVlvMax);
        hemo.esv = Math.round(this.beatVlvMin);
        hemo.sv = Math.max(1, Math.round(this.beatVlvMax - this.beatVlvMin));
        hemo.co = Number(((hemo.sv * c.hr) / 1000).toFixed(2));
        const rawEf = (this.beatVlvMax - this.beatVlvMin) / Math.max(1, this.beatVlvMax);
        hemo.lvef = Math.round(rawEf * 100);
        // Ajuste proporcional-integral suave do acoplamento ventrículo-arterial para convergir à FEVE alvo sem oscilação
        const efErr = this.targetEfFrac - rawEf;
        this.efServoGain = clamp(this.efServoGain * (1 + 0.58 * efErr), 0.55, 2.45);
        hemo.lvedp = Math.round(this.beatPlvEndDiast);
        hemo.ea = Number(((0.9 * this.beatPaoMax) / Math.max(1, hemo.sv)).toFixed(2));
        hemo.cvp = Math.round(this.beatPraSum / this.beatSamples);
        hemo.papMean = Math.round(this.beatPpaSum / this.beatSamples);
        hemo.pcwp = Math.round(this.beatPlaSum / this.beatSamples);

      }
      this.lastBeatIndex = c.beatIndex;
      this.beatPaoMax = pAo;
      this.beatPaoMin = pAo;
      this.beatPaoSum = 0;
      this.beatVlvMax = vLV;
      this.beatVlvMin = vLV;
      this.beatPraSum = 0;
      this.beatPpaSum = 0;
      this.beatPlaSum = 0;
      this.beatSamples = 0;
      this.rapidFillingFired = false;
      this.atrialKickFired = false;
    } else {
      if (pAo > this.beatPaoMax) this.beatPaoMax = pAo;
      if (pAo < this.beatPaoMin) this.beatPaoMin = pAo;
      if (vLV > this.beatVlvMax) this.beatVlvMax = vLV;
      if (vLV < this.beatVlvMin) this.beatVlvMin = vLV;
      this.beatPaoSum += pAo;
      this.beatPraSum += pRA;
      this.beatPpaSum += pPA;
      this.beatPlaSum += pLA;
      this.beatSamples++;
    }

    // Dinâmica da Veia Cava Inferior (VCI) acoplada à pressão transmural (Pra - Ppl)
    const pTransmuralIvc = pRA - pPl * 0.85 - 2.0;
    const sig = 1 / (1 + Math.exp(-(pTransmuralIvc - 3.5) / 2.6));
    const ivcD = 6.0 + 18.5 * sig;
    hemo.ivcDiameter = Number(ivcD.toFixed(1));

    // Estatísticas apenas da época observada, nunca dos 4 RR de warmup.
    // Os campos físicos instantâneos (pAo/pRA/pPl/ivcDiameter) seguem intactos.
    if (!this.warmingUp) {
      const v = ctx.params.ventilation;
      const obs = hemo.respObservation;
      if (obs) {
        // Alterações de FR/modo invalidam a janela parcial anterior, mas
        // preservam números legados e a idade da última publicação.
        if (v.respRate !== this.respObservedRate || v.mode !== this.respObservedMode) {
          const stoppedAtZeroPhase = this.respObservedRate <= 0 && this.lastRespPhi === 0;
          this.respObservedRate = v.respRate;
          this.respObservedMode = v.mode;
          this.respWindowAligned = v.respRate > 0 && stoppedAtZeroPhase;
          this.respWindowStart = c.t;
          this.respPPMax = -Infinity;
          this.respPPMin = Infinity;
          this.respIvcMax = -Infinity;
          this.respIvcMin = Infinity;
          this.respBeatPaoMax = -Infinity;
          this.respBeatPaoMin = Infinity;
          this.respBeatSamples = 0;
          this.respBeatIndex = c.beatIndex;
          this.respBeatComplete = false;
          this.respCycleBeats = 0;
          this.respCycleSamples = 0;
          obs.valid = false;
          obs.status = v.respRate > 0 ? 'partial-window' : 'resp-rate-zero';
          obs.source = obs.publishedAt === null ? 'initial' : 'historical';
          obs.respiratoryRate = v.respRate;
          obs.mode = v.mode;
        }
        if (v.respRate > 0) {
          if (c.beatIndex !== this.respBeatIndex) {
            if (this.respBeatComplete && this.respBeatSamples > 50) {
              const pp = Math.max(5, this.respBeatPaoMax - this.respBeatPaoMin);
              if (pp > this.respPPMax) this.respPPMax = pp;
              if (pp < this.respPPMin) this.respPPMin = pp;
              this.respCycleBeats++;
            }
            this.respBeatIndex = c.beatIndex;
            this.respBeatPaoMax = pAo;
            this.respBeatPaoMin = pAo;
            this.respBeatSamples = 0;
            this.respBeatComplete = true;
          } else {
            if (pAo > this.respBeatPaoMax) this.respBeatPaoMax = pAo;
            if (pAo < this.respBeatPaoMin) this.respBeatPaoMin = pAo;
            this.respBeatSamples++;
          }
          if (ivcD > this.respIvcMax) this.respIvcMax = ivcD;
          if (ivcD < this.respIvcMin) this.respIvcMin = ivcD;
          this.respCycleSamples++;
          // A amostra de rollover pertence ao ciclo encerrado (contrato PR #10).
          if (c.phiResp < this.lastRespPhi) {
            if (this.respWindowAligned && this.respCycleBeats > 0
                && this.respCycleSamples > 0) {
              const ppMean = Math.max(1, 0.5 * (this.respPPMax + this.respPPMin));
              hemo.ppv = Math.round(((this.respPPMax - this.respPPMin) / ppMean) * 100);
              hemo.ivcDmax = Number(this.respIvcMax.toFixed(1));
              hemo.ivcDmin = Number(this.respIvcMin.toFixed(1));
              const denominator = v.mode === 'spontaneous' ? this.respIvcMax : this.respIvcMin;
              hemo.ivcIndex = Math.round(100 * (this.respIvcMax - this.respIvcMin) / Math.max(1, denominator));
              obs.valid = true;
              obs.status = 'valid';
              obs.source = 'measured';
              obs.windowStart = this.respWindowStart;
              obs.windowEnd = c.t;
              obs.publishedAt = c.t;
              obs.sampleCount = this.respCycleSamples;
              obs.beatCount = this.respCycleBeats;
            } else {
              obs.valid = false;
              obs.status = 'partial-window';
              obs.source = obs.publishedAt === null ? 'initial' : 'historical';
            }
            this.respWindowAligned = true;
            this.respWindowStart = c.t;
            this.respPPMax = -Infinity;
            this.respPPMin = Infinity;
            this.respIvcMax = -Infinity;
            this.respIvcMin = Infinity;
            this.respCycleBeats = 0;
            this.respCycleSamples = 0;
          }
        } else {
          // FR=0: não há novos ciclos; manter histórico explicitamente inválido.
          obs.valid = false;
          obs.status = 'resp-rate-zero';
        }
        obs.ageSeconds = obs.publishedAt === null ? null : Math.max(0, c.t - obs.publishedAt);
      }
      this.lastRespPhi = c.phiResp;
    }

    // FC comandada (intrínseca + barorreflexo + dobutamina - metoprolol)
    const effDobuHR = (28 * Math.pow(this.ceDobu, 1.15)) / (Math.pow(5.5, 1.15) + Math.pow(this.ceDobu, 1.15) + 1e-9);
    const effMetoHR = (26 * this.ceMeto) / (6.0 + this.ceMeto + 1e-9);
    hemo.hrCommand = clamp(
      ctx.params.ecg.heartRate + this.baroHR + effDobuHR - effMetoHR,
      32,
      210,
    );
  }

  sample(bank: import('../contracts/types').SignalBankLike, ctx: SimContext): void {
    const h = ctx.live.hemo;
    bank.set('pAo', h.pAo);
    bank.set('pLV', h.pLV);
    bank.set('pLA', h.pLA);
    bank.set('vLV', h.vLV);
    bank.set('pRA', h.pRA);
    bank.set('pRV', h.pRV);
    bank.set('pPA', h.pPA);
    bank.set('pPl', h.pPl);
    bank.set('qAo', h.qAortic);
    bank.set('qMi', h.qMitral);
    bank.set('ivcD', h.ivcDiameter);
  }
}

/** Fluxo venoso pulmonar -> AE (baixa resistência ~0.015 mmHg·s/mL). */
function qPV_to_LA(pPV: number, pLA: number): number {
  return (pPV - pLA) / 0.015;
}

/**
 * Equação valvar de Mynard (2012) com Bernoulli + inertância + abertura ζ.
 * Preenche dydt[qIdx] = dQ/dt e dydt[zIdx] = dζ/dt sem alocações.
 */
function stepValve(
  dp: number,
  q: number,
  z: number,
  aMin: number,
  aMax: number,
  dydt: Float64Array,
  qIdx: number,
  zIdx: number,
): void {
  // Dinâmica de abertura/fechamento (ζ ∈ [0,1])
  const kVo = 18.0; // velocidade de abertura (mmHg·s)^-1
  const kVc = 24.0; // velocidade de fechamento
  let dz = 0;
  if (dp > 0) {
    dz = (1 - z) * kVo * dp;
  } else {
    dz = z * kVc * dp;
  }
  dydt[zIdx] = dz;

  const aEff = aMin + (aMax - aMin) * z;
  if (aEff < 1e-3 && z < 0.01) {
    // Valva competente fechada: amortecimento rápido do fluxo residual
    dydt[qIdx] = -q * 450;
    return;
  }
  // Coeficiente de Bernoulli Bv = 4e-4 / Aeff² (mmHg·s²/mL²)
  const aSafe = Math.max(0.03, aEff);
  const bV = 4.0e-4 / (aSafe * aSafe);
  // Inertância sanguínea Lv (mmHg·s²/mL), piso 7e-4 para estabilidade RK4 com h = 1 ms
  const lV = Math.max(7.0e-4, 0.0014 / (aSafe + 0.1));
  dydt[qIdx] = (dp - bV * q * Math.abs(q)) / lV;
}

function clampValveStates(y: Float64Array): void {
  for (let i = 0; i < 8; i++) {
    if (y[i] < 1) {
      // Projeção conservativa: cada mL reposto sai de outro compartimento.
      // Usa primeiro o reservatório venoso; o piso de 1 mL é o já existente.
      let deficit = 1 - y[i];
      for (let j = 0; j < 8 && deficit > 0; j++) {
        const donor = (j + 5) % 8;
        if (donor === i) continue;
        const transfer = Math.min(deficit, Math.max(0, y[donor] - 1));
        y[donor] -= transfer;
        y[i] += transfer;
        deficit -= transfer;
      }
      // Se a soma for < 8 mL, o piso é inviável: não fabricar massa.
    }
  }
  for (let i = 12; i < 16; i++) {
    if (y[i] < 0) y[i] = 0;
    else if (y[i] > 1) y[i] = 1;
    // Se a valva fechou e não há insuficiência significativa, trava refluxo numérico
  }
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
