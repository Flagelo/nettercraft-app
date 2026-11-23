/**
 * Contratos compartilhados entre todos os módulos do simulador.
 * Ver skill: .agents/skills/medical-sim-core-architecture/SKILL.md
 *
 * Regras:
 *  - `ClinicalParams` = baixa frequência (UI). Pode re-renderizar painéis.
 *  - `LiveState` = alta frequência. Objeto MUTÁVEL, nunca substituído, NUNCA passa por `set()`.
 *  - Unidades: mmHg, mL, mL/s, s, mm, cm/s, HU.
 */
import type { EventRing } from '../signals/EventRing';

// ───────────────────────────── Parâmetros clínicos ─────────────────────────────

/** 1 = normal, 2 = hipocinético, 3 = acinético, 4 = discinético/aneurismático */
export type WallMotionScore = 1 | 2 | 3 | 4;
export type Rhythm = 'sinus' | 'af' | 'flutter';
export type BundleBranchBlock = 'none' | 'lbbb' | 'rbbb';
export type CoronaryTerritory = 'none' | 'lad' | 'lcx' | 'rca';
export type VentilationMode = 'spontaneous' | 'mechanical';

export interface EchoParams {
  /** Fração de ejeção do VE (%) */
  lvef: number;
  /** Diâmetro diastólico do VE (mm) */
  lvedd: number;
  /** Diâmetro sistólico do VE (mm) */
  lvesd: number;
  /** Espessura do septo interventricular (mm) */
  septum: number;
  /** Espessura da parede posterior (mm) */
  posteriorWall: number;
  /** Escore de motilidade dos 17 segmentos AHA (índice 0 = segmento 1) */
  wallMotion: WallMotionScore[];
  /** Área efetiva do orifício aórtico (cm²) — normal 3–4; estenose grave < 1 */
  aorticEOA: number;
  /** Área do orifício regurgitante aórtico (cm²) — 0 normal; grave ≥ 0.3 */
  aorticROA: number;
  /** Área efetiva mitral (cm²) — normal 4–6; estenose grave < 1 */
  mitralEOA: number;
  /** Área do orifício regurgitante mitral (cm²) — 0 normal; grave ≥ 0.4 */
  mitralROA: number;
}

export interface EcgParams {
  /** FC intrínseca/alvo (bpm) — o barorreflexo e drogas modulam a FC efetiva */
  heartRate: number;
  rhythm: Rhythm;
  /** Condução AV no flutter (2:1, 3:1, 4:1) */
  flutterConduction: 2 | 3 | 4;
  bundleBranchBlock: BundleBranchBlock;
  /** QTc alvo (s) */
  qtc: number;
  /** Território isquêmico (corrente de lesão) */
  ischemiaTerritory: CoronaryTerritory;
  /** true = transmural (supra de ST); false = subendocárdica (infra de ST) */
  ischemiaTransmural: boolean;
}

export interface DrugParams {
  /** µg/kg/min */
  norepinephrine: number;
  /** µg/kg/min */
  dobutamine: number;
  /** µg/kg/min */
  nitroprusside: number;
  /** mg (dose cumulativa em bolus) */
  furosemide: number;
  /** mg (dose cumulativa IV) */
  metoprolol: number;
}

export interface VentilationParams {
  mode: VentilationMode;
  /** irpm */
  respRate: number;
  /** cmH2O (apenas mecânica) */
  peep: number;
  /** Pressão inspiratória acima da PEEP (cmH2O) — mecânica */
  drivingPressure: number;
  /** Esforço inspiratório espontâneo (queda de Ppl, mmHg) */
  spontaneousEffort: number;
}

export interface CirculationParams {
  /** Volume sanguíneo total (mL) */
  bloodVolume: number;
  /** Multiplicador da resistência vascular sistêmica */
  svrScale: number;
  /** Multiplicador da resistência vascular pulmonar */
  pvrScale: number;
  baroreflex: boolean;
}

export interface ClinicalParams {
  echo: EchoParams;
  ecg: EcgParams;
  drugs: DrugParams;
  ventilation: VentilationParams;
  circulation: CirculationParams;
}

// ───────────────────────────── Estado em tempo real ─────────────────────────────

/** Estado do MasterPhysiologyClock (mutado in-place a cada passo de 1 ms). */
export interface ClockState {
  /** tempo simulado (s) */
  t: number;
  /** fase cardíaca contínua ∈ [0,1); 0 = início da onda P (ou do ciclo, em FA) */
  phi: number;
  /** fase respiratória ∈ [0,1); 0 = início da inspiração */
  phiResp: number;
  beatIndex: number;
  /** RR do batimento atual (s) */
  rr: number;
  /** FC instantânea (bpm) = 60/rr */
  hr: number;
  /** duração da sístole mecânica do batimento (s) — Fridericia */
  ts: number;
  /** QT do batimento (s) — Fridericia */
  qt: number;
  /** intervalo PR do batimento (s) */
  pr: number;
  /** tempo desde o início do batimento (s) = phi·rr */
  tInBeat: number;
  /** tempo desde o último QRS (s) — contínuo, não reinicia na troca de fase */
  tSinceQRS: number;
  /** tempo desde a última onda P / ativação atrial (s) */
  tSinceP: number;
  /** RR que precedeu o último QRS (s) */
  lastRR: number;
  /** fase atrial ∈ [0,1) (útil para ondas F do flutter e fibrilação) */
  atrialPhi: number;
  /** false em FA (sem contração atrial organizada) */
  atrialActive: boolean;
  isInspiration: boolean;
  /** fração inspiratória do ciclo respiratório (I:E) */
  inspFraction: number;
}

export enum HemoEventKind {
  BeatStart = 0,
  PWave = 1,
  QRS = 2,
  MitralOpen = 10,
  MitralClose = 11,
  AorticOpen = 12,
  AorticClose = 13,
  TricuspidOpen = 14,
  TricuspidClose = 15,
  PulmonaryOpen = 16,
  PulmonaryClose = 17,
  /** fim do enchimento rápido (pico/desaceleração da onda E) — B3 */
  RapidFillingEnd = 20,
  /** contração atrial — B4 */
  AtrialKick = 21,
}

/**
 * R1–R6: contrato de observação de PPV/VCI, separado das grandezas físicas.
 * Os campos numéricos legados continuam existindo, mas não são uma medida válida
 * quando `valid=false`. Em FR=0 o último valor é apenas histórico.
 */
export interface RespiratoryObservation {
  valid: boolean;
  status: 'awaiting-window' | 'partial-window' | 'resp-rate-zero' | 'valid';
  source: 'initial' | 'measured' | 'historical';
  /** Intervalo de aferição do último ciclo completo, tempo simulado em segundos. */
  windowStart: number | null;
  windowEnd: number | null;
  publishedAt: number | null;
  /** Tempo simulado desde a última publicação; null até a primeira medição. */
  ageSeconds: number | null;
  sampleCount: number;
  beatCount: number;
  respiratoryRate: number;
  mode: VentilationMode;
}

/** Saídas do motor hemodinâmico (hemodynamic-0d-lumped-engine). */
export interface LiveHemo {
  // Pressões cavitárias absolutas (incluem Ppl quando intratorácicas), mmHg
  pLV: number; pLA: number; pRV: number; pRA: number;
  /** pressão na raiz da aorta (após Zc) */
  pAo: number;
  pSA: number; pSV: number; pPA: number; pPV: number;
  /** pressão pleural/intratorácica, mmHg */
  pPl: number;
  // Volumes, mL
  vLV: number; vLA: number; vRV: number; vRA: number;
  // Fluxos valvares (mL/s, positivo = anterógrado)
  qMitral: number; qAortic: number; qTricuspid: number; qPulmonary: number;
  qVenousReturn: number;
  // Abertura valvar ζ ∈ [0,1]
  zMitral: number; zAortic: number; zTricuspid: number; zPulmonary: number;
  // Gradiente instantâneo (montante − jusante), mmHg
  dpMitral: number; dpAortic: number; dpTricuspid: number; dpPulmonary: number;
  // Ativação ∈ [0,1]
  eLV: number; eRV: number; eLA: number; eRA: number;
  // Parâmetros correntes das relações P-V do VE (para desenho da alça PV)
  lvEes: number; lvV0: number; lvA: number; lvB: number;
  /** Elastância arterial efetiva (mmHg/mL) */
  ea: number;
  // Métricas por batimento
  sbp: number; dbp: number; map: number;
  sv: number; co: number; lvef: number; edv: number; esv: number; lvedp: number;
  cvp: number; papMean: number; pcwp: number;
  /** variação de pressão de pulso (%) */
  ppv: number;
  /** RVS (dyn·s·cm⁻⁵) */
  svr: number;
  // VCI
  ivcDiameter: number; ivcDmin: number; ivcDmax: number;
  /** colapsabilidade (espontânea) ou distensibilidade (VM), % */
  ivcIndex: number;
  /** Observador separado das saídas numéricas legadas; válido apenas se valid=true. */
  respObservation?: RespiratoryObservation;
  /** FC comandada pelo barorreflexo + drogas (bpm). 0 = sem motor (usa params). */
  hrCommand: number;
  /** Eventos valvares/elétricos com timestamp (s) — consumidos por áudio/3D/ECG */
  events: EventRing;
}

/** Saídas eletrofisiológicas (cardiac-3d-electromechanics). */
export interface LiveElectro {
  /** vetor cardíaco resultante (X esquerda, Y inferior, Z posterior) — mV equivalentes */
  vector: Float32Array;
  /** amostra atual das 12 derivações, ordem LEAD_NAMES (mV) */
  leads: Float32Array;
  /** fração despolarizada de cada segmento AHA (17) */
  segmentDepol: Float32Array;
  /** dipolo de cada segmento (17 × xyz) */
  segmentDipoles: Float32Array;
}

export interface LiveState {
  clock: ClockState;
  hemo: LiveHemo;
  electro: LiveElectro;
}

export const LEAD_NAMES = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'] as const;
export type LeadName = (typeof LEAD_NAMES)[number];

/** Nomes oficiais dos 17 segmentos AHA (índice 0 = segmento 1). */
export const AHA_SEGMENT_NAMES = [
  'Basal anterior', 'Basal anterosseptal', 'Basal inferosseptal', 'Basal inferior', 'Basal inferolateral', 'Basal anterolateral',
  'Médio anterior', 'Médio anterosseptal', 'Médio inferosseptal', 'Médio inferior', 'Médio inferolateral', 'Médio anterolateral',
  'Apical anterior', 'Apical septal', 'Apical inferior', 'Apical lateral',
  'Ápice',
] as const;

/** Território coronário de cada segmento (dominância direita). */
export const AHA_SEGMENT_TERRITORY: Exclude<CoronaryTerritory, 'none'>[] = [
  'lad', 'lad', 'rca', 'rca', 'lcx', 'lcx',
  'lad', 'lad', 'rca', 'rca', 'lcx', 'lcx',
  'lad', 'lad', 'rca', 'lcx',
  'lad',
];

// ───────────────────────────── Sistemas de simulação ─────────────────────────────

/** Banco de sinais com escrita alinhada (todas as séries compartilham o mesmo índice). */
export interface SignalBankLike {
  readonly capacity: number;
  readonly sampleRate: number;
  register(name: string): Float32Array;
  set(name: string, value: number): void;
}

export interface SimContext {
  readonly clock: ClockState;
  readonly live: LiveState;
  /** parâmetros clínicos atuais (referência; não mutar) */
  params: ClinicalParams;
}

/**
 * Um subsistema do loop. Ordem de execução crescente por `order`:
 *  0 clock (interno) → 10 hemodinâmica → 20 eletrofisiologia → 30 áudio → 40+ outros.
 */
export interface SimSystem {
  id: string;
  order: number;
  /** chamado ao registrar e ao resetar */
  reset?(ctx: SimContext): void;
  /** passo fixo h = 0.001 s (RK4 etc.). SEM alocação. */
  step?(h: number, ctx: SimContext): void;
  /** amostragem para o banco de sinais (SignalBank.sampleRate Hz) */
  sample?(bank: SignalBankLike, ctx: SimContext): void;
  /** uma vez por frame de vídeo, após os passos (dtReal em s) */
  frame?(dtReal: number, ctx: SimContext): void;
  /** quando `params` muda (baixa frequência) */
  onParamsChanged?(params: ClinicalParams, prev: ClinicalParams, ctx: SimContext): void;
}
