import type { CoronaryTerritory, SimContext, SimSystem } from '../contracts/types';
import { AHA_SEGMENT_NAMES, AHA_SEGMENT_TERRITORY, LEAD_NAMES } from '../contracts/types';

/**
 * Eletrofisiologia Cardíaca 3D:
 *  - 17 Dipolos Regionais da AHA/ASE (p_i(t))
 *  - Vetor Cardíaco Resultante 3D P(t) = (X, Y, Z) no referencial de Frank
 *    (X: esquerda, Y: inferior, Z: posterior)
 *  - Simulação de Ritmo Sinusal, Fibrilação Atrial (ondas f caóticas), Flutter Atrial (ondas F em dente de serra),
 *    BRE (LBBB: QS profundo em V1 e R largo entalhado em torre em V6/DI com T discordante) e
 *    BRD (RBBB: trifásico rSR' clássico em V1 e onda S empastada terminal em V6/DI)
 *  - Corrente de Lesão Isquêmica (Supradesnivelamento de ST territorial DA/CX/CD com imagem em espelho recíproca)
 *  - Projeção pela Matriz de Dower (1988) + Leis de Einthoven/Goldberger para as 12 derivações do ECG
 */

export interface AhaSegmentSpec {
  /** 1..17 */
  id: number;
  name: string;
  territory: Exclude<CoronaryTerritory, 'none'>;
  level: 'basal' | 'mid' | 'apical' | 'apex';
  /** intervalo circunferencial θ (rad), 0 = anterior, anti-horário visto do ápice */
  theta0: number;
  theta1: number;
  /** intervalo longitudinal ν ∈ [0, 1], 0 = ápice, 1 = base */
  nu0: number;
  nu1: number;
  /** vetor normal unitário no espaço VCG de Frank (X esq, Y inf, Z post) */
  nx: number;
  ny: number;
  nz: number;
  /** tempo de ativação endocárdica basal em condução normal (s após início do QRS) */
  tActNormal: number;
  /** fração de massa relativa do VE */
  mass: number;
}

const DEG = Math.PI / 180;

export const AHA_SEGMENTS: readonly AhaSegmentSpec[] = buildAhaSegments();

function buildAhaSegments(): AhaSegmentSpec[] {
  const specs: AhaSegmentSpec[] = [];

  // 6 ângulos para Basal (1..6) e Médio (7..12):
  // 1/7 Anterior (0°), 2/8 Anterosseptal (60°), 3/9 Inferosseptal (120°),
  // 4/10 Inferior (180°), 5/11 Inferolateral (240°), 6/12 Anterolateral (300°)
  // No referencial de Frank (X=esq, Y=inf, Z=post):
  //   Anterior -> Z negativo (-0.85), X levemente esq (+0.35), Y dep do nível
  //   Septal   -> X negativo (-0.55) e Z negativo/neutro
  //   Inferior -> Y positivo (+0.88), Z levemente post (+0.25)
  //   Lateral  -> X positivo (+0.88), Z post (+0.45)
  const ring6Normals: [number, number, number][] = [
    [0.42, -0.38, -0.82],  // 1/7 Anterior (aponta ant-sup-esq -> V2-V4, DI, aVL; espelho em DIII, aVF)
    [-0.18, -0.28, -0.94], // 2/8 Anterosseptal (aponta ant-sup -> V1-V3)
    [-0.38, 0.78, 0.49],   // 3/9 Inferosseptal (aponta inf-dir -> DII, DIII, aVF)
    [-0.12, 0.92, 0.36],   // 4/10 Inferior (aponta inf -> DII, DIII, aVF; espelho em DI, aVL)
    [0.74, 0.48, 0.62],    // 5/11 Inferolateral
    [0.92, -0.22, 0.42],   // 6/12 Anterolateral
  ];

  // Basal: segmentos 1..6 (nu: 0.68..1.00), ativação mais tardia (~42..55 ms)
  for (let k = 0; k < 6; k++) {
    const [bx, by, bz] = ring6Normals[k];
    const [nx, ny, nz] = normalize3(bx, by - 0.15, bz);
    specs.push({
      id: k + 1,
      name: AHA_SEGMENT_NAMES[k],
      territory: AHA_SEGMENT_TERRITORY[k],
      level: 'basal',
      theta0: k * 60 * DEG,
      theta1: (k + 1) * 60 * DEG,
      nu0: 0.68,
      nu1: 1.0,
      nx, ny, nz,
      tActNormal: 0.042 + (k === 4 || k === 5 ? 0.010 : 0),
      mass: 1.05,
    });
  }

  // Médio: segmentos 7..12 (nu: 0.36..0.68), ativação intermediária (~24..36 ms)
  for (let k = 0; k < 6; k++) {
    const idx = 6 + k;
    const [bx, by, bz] = ring6Normals[k];
    const [nx, ny, nz] = normalize3(bx, by, bz);
    specs.push({
      id: idx + 1,
      name: AHA_SEGMENT_NAMES[idx],
      territory: AHA_SEGMENT_TERRITORY[idx],
      level: 'mid',
      theta0: k * 60 * DEG,
      theta1: (k + 1) * 60 * DEG,
      nu0: 0.36,
      nu1: 0.68,
      nx, ny, nz,
      tActNormal: 0.024 + (k === 4 || k === 5 ? 0.008 : 0),
      mass: 1.0,
    });
  }

  // Apical: segmentos 13..16 (4 × 90°, nu: 0.14..0.36), ativação precoce (~18..26 ms)
  const ring4Normals: [number, number, number][] = [
    [0.48, -0.22, -0.85],  // 13 Apical anterior
    [-0.15, -0.18, -0.96], // 14 Apical septal
    [-0.10, 0.92, 0.32],   // 15 Apical inferior
    [0.88, 0.15, 0.35],    // 16 Apical lateral
  ];
  for (let k = 0; k < 4; k++) {
    const idx = 12 + k;
    const [bx, by, bz] = ring4Normals[k];
    const [nx, ny, nz] = normalize3(bx, by, bz);
    specs.push({
      id: idx + 1,
      name: AHA_SEGMENT_NAMES[idx],
      territory: AHA_SEGMENT_TERRITORY[idx],
      level: 'apical',
      theta0: (k * 90 - 15) * DEG,
      theta1: ((k + 1) * 90 - 15) * DEG,
      nu0: 0.14,
      nu1: 0.36,
      nx, ny, nz,
      tActNormal: 0.019 + (k === 3 ? 0.006 : 0),
      mass: 0.85,
    });
  }

  // Segmento 17: Ápice (nu: 0..0.14) — aponta para esquerda e anterior
  {
    const [nx, ny, nz] = normalize3(0.68, -0.12, -0.72);
    specs.push({
      id: 17,
      name: AHA_SEGMENT_NAMES[16],
      territory: AHA_SEGMENT_TERRITORY[16],
      level: 'apex',
      theta0: 0,
      theta1: Math.PI * 2,
      nu0: 0,
      nu1: 0.14,
      nx, ny, nz,
      tActNormal: 0.016,
      mass: 0.75,
    });
  }

  return specs;
}

/**
 * Matriz Inversa de Dower (1988): projeta (X, Y, Z) de Frank nas 8 derivações independentes
 * [I, II, V1, V2, V3, V4, V5, V6].
 */
const DOWER_8X3 = [
  0.632, -0.235, 0.059,   // I
  0.235, 1.066, -0.132,   // II
  -0.515, 0.157, -0.917,  // V1
  0.044, 0.164, -1.387,   // V2
  0.882, 0.098, -1.277,   // V3
  1.213, 0.127, -0.601,   // V4
  1.125, 0.127, -0.086,   // V5
  0.831, 0.076, 0.230,    // V6
] as const;

export function projectDower12(vx: number, vy: number, vz: number, out12: Float32Array): void {
  const I = DOWER_8X3[0] * vx + DOWER_8X3[1] * vy + DOWER_8X3[2] * vz;
  const II = DOWER_8X3[3] * vx + DOWER_8X3[4] * vy + DOWER_8X3[5] * vz;
  const III = II - I;
  const aVR = -0.5 * (I + II);
  const aVL = I - 0.5 * II;
  const aVF = II - 0.5 * I;

  out12[0] = I;
  out12[1] = II;
  out12[2] = III;
  out12[3] = aVR;
  out12[4] = aVL;
  out12[5] = aVF;

  for (let k = 0; k < 6; k++) {
    const base = (k + 2) * 3;
    out12[6 + k] = DOWER_8X3[base] * vx + DOWER_8X3[base + 1] * vy + DOWER_8X3[base + 2] * vz;
  }
}

export class ElectroEngine implements SimSystem {
  readonly id = 'electrophysiology';
  readonly order = 20;

  reset(ctx: SimContext): void {
    ctx.live.electro.vector.fill(0);
    ctx.live.electro.leads.fill(0);
    ctx.live.electro.segmentDepol.fill(0);
    ctx.live.electro.segmentDipoles.fill(0);
  }

  step(_h: number, ctx: SimContext): void {
    const c = ctx.clock;
    const { echo, ecg } = ctx.params;
    const electro = ctx.live.electro;
    const depol = electro.segmentDepol;
    const dipoles = electro.segmentDipoles;

    const tQRS = c.tSinceQRS;
    const qt = c.qt;
    const bbb = ecg.bundleBranchBlock;

    // Fatores de hipertrofia septal e de parede livre (aumentam amplitude de QRS/sobrecarga)
    const septScale = clamp(echo.septum / 9.0, 0.75, 2.1);
    const pwScale = clamp(echo.posteriorWall / 9.0, 0.75, 2.1);

    let px = 0;
    let py = 0;
    let pz = 0;

    // ═══════════════════ 1. ATIVIDADE ELÉTRICA ATRIAL (P / F / f) ═══════════════════
    if (ecg.rhythm === 'sinus') {
      const tp = c.tSinceP;
      if (tp >= 0 && tp < 0.115) {
        // Componente AD (0..70 ms) + Componente AE (35..110 ms, ampliado se AE sobrecarregado)
        const pRA = Math.exp(-Math.pow((tp - 0.036) / 0.020, 2));
        const laGain = septScale > 1.25 || echo.mitralEOA < 2.2 || echo.mitralROA > 0.2 ? 1.45 : 1.0;
        const pLA = laGain * Math.exp(-Math.pow((tp - 0.070) / 0.024, 2));
        px += 0.14 * pRA + 0.18 * pLA;
        py += 0.20 * pRA + 0.14 * pLA;
        pz += -0.09 * pRA + 0.10 * pLA;
      }
    } else if (ecg.rhythm === 'flutter') {
      // Macrorreentrada cavotricuspídea (300 bpm -> ciclo 0.20 s) — onda F em "dente de serra"
      const phiF = c.atrialPhi;
      const saw = (phiF - 0.5) * 2 - 0.38 * Math.sin(2 * Math.PI * phiF);
      px += 0.05 * saw;
      py += -0.26 * saw; // negativa em DII, DIII, aVF
      pz += -0.14 * saw; // positiva em V1
    } else if (ecg.rhythm === 'af') {
      // Fibrilação atrial: soma de múltiplas wavelets reentrantes caóticas (350–500/min)
      const t = c.t;
      const fWave =
        0.48 * Math.sin(2 * Math.PI * 6.1 * t) +
        0.38 * Math.sin(2 * Math.PI * 7.4 * t + 1.3) +
        0.28 * Math.cos(2 * Math.PI * 8.9 * t + 2.7);
      px += 0.04 * fWave;
      py += 0.10 * fWave;
      pz += -0.08 * fWave;
    }

    // ═══════════════════ 2. OS 17 DIPOLOS REGIONAIS DA AHA & CORRENTE DE LESÃO ST ═══════════════════
    const qrsWidth = bbb === 'lbbb' ? 0.022 : 0.013;
    const tPeak = qt * 0.76;
    const tWidth = qt * 0.135;

    // Janela do platô ST (entre o fim do QRS e o pico da onda T) para corrente de lesão
    const qrsEnd = bbb === 'none' ? 0.088 : 0.132;
    const stPlateau =
      tQRS > qrsEnd * 0.72 && tQRS < qt * 0.90
        ? smoothstep(qrsEnd * 0.68, qrsEnd * 1.02, tQRS) * (1 - smoothstep(qt * 0.70, qt * 0.94, tQRS))
        : 0;

    let injuryVecX = 0;
    let injuryVecY = 0;
    let injuryVecZ = 0;

    for (let i = 0; i < 17; i++) {
      const seg = AHA_SEGMENTS[i];
      const wm = echo.wallMotion[i] ?? 1;
      const isSeptal = i === 1 || i === 2 || i === 7 || i === 8 || i === 13;
      const wallScale = isSeptal ? septScale : pwScale;
      const m = (seg.mass * wallScale) / 17;

      // Tempo de ativação regional ajustado para BRE (atraso progressivo da parede livre esquerda)
      let tAct = seg.tActNormal;
      if (bbb === 'lbbb') {
        const latDelay = Math.max(0, seg.nx) * 0.052 + 0.022;
        tAct += latDelay;
      }

      // Fração de despolarização local ∈ [0, 1] (para mapa de cores 3D no miocárdio)
      const depRise = 1 / (1 + Math.exp(-(tQRS - tAct) / 0.006));
      const repFall = 1 / (1 + Math.exp((tQRS - (tPeak + (0.04 - seg.tActNormal) * 0.5)) / 0.032));
      depol[i] = depRise * repFall;

      // Taxa de frente de despolarização regional (para visualização dos 17 dipolos no 3D)
      const qrsPulse = Math.exp(-Math.pow((tQRS - tAct) / qrsWidth, 2));
      const viableGain = wm === 1 ? 1.0 : wm === 2 ? 0.75 : wm === 3 ? 0.25 : 0.1;
      const depAmp = 1.65 * m * viableGain * qrsPulse;

      const tActRep = tPeak - (seg.tActNormal - 0.03) * 0.4;
      const tPulse = Math.exp(-Math.pow((tQRS - tActRep) / tWidth, 2));
      const tPolarity = bbb === 'lbbb' || wallScale > 1.45 ? -0.28 : 0.34;
      const repAmp = tPolarity * m * tPulse;

      // Corrente de Lesão Isquêmica Aguda: ESTRITAMENTE vinculada a ecg.ischemiaTerritory !== 'none'
      // (Item 5.5 do Laudo: quando "Sem Isquemia Aguda" está selecionado, não há supra/infra de ST agudo!)
      const isTerritoryIschemic =
        ecg.ischemiaTerritory !== 'none' && seg.territory === ecg.ischemiaTerritory;
      let injuryAmp = 0;
      if (isTerritoryIschemic && stPlateau > 0) {
        const sign = ecg.ischemiaTransmural ? 1.0 : -0.75;
        injuryAmp = sign * 0.95 * m * stPlateau;
      }

      const totalSegAmp = depAmp + repAmp + injuryAmp;
      dipoles[i * 3] = totalSegAmp * seg.nx;
      dipoles[i * 3 + 1] = totalSegAmp * seg.ny;
      dipoles[i * 3 + 2] = totalSegAmp * seg.nz;

      injuryVecX += injuryAmp * seg.nx;
      injuryVecY += injuryAmp * seg.ny;
      injuryVecZ += injuryAmp * seg.nz;
    }

    // ═══════════════════ 3. SÍNTESE VETORIAL 3D CALIBRADA DO COMPLEXO QRS E ONDA T ═══════════════════
    // Redução vetorial regional em caso de necrose/acinesia territorial (gera onda Q patológica)
    let antViability = 1.0;
    let infViability = 1.0;
    let latViability = 1.0;
    if (ecg.ischemiaTerritory === 'lad' || (echo.wallMotion[0] >= 3 && echo.wallMotion[6] >= 3)) {
      antViability = 0.45;
    }
    if (ecg.ischemiaTerritory === 'rca' || (echo.wallMotion[3] >= 3 && echo.wallMotion[9] >= 3)) {
      infViability = 0.50;
    }
    if (ecg.ischemiaTerritory === 'lcx' || (echo.wallMotion[4] >= 3 && echo.wallMotion[10] >= 3)) {
      latViability = 0.55;
    }

    if (bbb === 'none') {
      // ─── CONDUÇÃO INTRAVENTRICULAR NORMAL (QRS Estreito ~85 ms) ───
      // Fase 1 (0..22 ms): Vetor Septal (Esquerda -> Direita e Anterior: gera r inicial em V1-V2 e q septal em DI, aVL, V5, V6)
      const wSept = Math.exp(-Math.pow((tQRS - 0.014) / 0.0065, 2)) * septScale * antViability;
      // Fase 2 (20..58 ms): Vetor Principal do VE (Parede Livre Esquerda, Inferior e Posterior:
      //   gera onda S profunda em V1, transição em V3-V4 e onda R alta em DI, DII, V4-V6!)
      const wMainLV = Math.exp(-Math.pow((tQRS - 0.040) / 0.0115, 2)) * pwScale;
      // Fase 3 (52..78 ms): Vetor Basal Posterolateral/Inferior (gera pequena onda s terminal em V1-V2 / DI)
      const wBasal = Math.exp(-Math.pow((tQRS - 0.062) / 0.0085, 2)) * pwScale;

      px += (-0.22 * wSept) + (1.28 * latViability * wMainLV) + (-0.16 * wBasal);
      py += (-0.06 * wSept) + (0.98 * infViability * wMainLV) + (0.22 * infViability * wBasal);
      pz += (-0.30 * wSept) + (0.58 * wMainLV) + (0.34 * wBasal);

      // Onda T fisiológica (concordante com QRS, assimétrica, positiva em DI, DII, V2-V6 e negativa em aVR)
      const wT = Math.exp(-Math.pow((tQRS - tPeak) / tWidth, 2));
      const tInv = pwScale > 1.45 ? -0.65 : 1.0; // inversão secundária se HVE grave (strain)
      px += 0.36 * tInv * wT;
      py += 0.28 * tInv * wT;
      pz += 0.06 * tInv * wT;
    } else if (bbb === 'lbbb') {
      // ─── BLOQUEIO DE RAMO ESQUERDO (BRE / LBBB — QRS ≥ 130 ms) ───
      // 1. Ativação septal invertida (Direita -> Esquerda e Posterior): elimina q septal em DI/V6 e gera QS ou pequeno r em V1
      const wSeptRev = Math.exp(-Math.pow((tQRS - 0.018) / 0.009, 2)) * septScale;
      // 2. Despolarização lenta célula-a-célula do VE com duplo pico entalhado ("torre" / M-shaped em DI, aVL, V5, V6
      //    e complexo QS/rS largo e profundo em V1-V2!)
      const wLbbb1 = Math.exp(-Math.pow((tQRS - 0.048) / 0.018, 2)) * pwScale;
      const wLbbb2 = Math.exp(-Math.pow((tQRS - 0.088) / 0.020, 2)) * pwScale;
      const wLbbb = 0.82 * wLbbb1 + 0.90 * wLbbb2;

      px += 0.32 * wSeptRev + 1.18 * wLbbb;
      py += 0.08 * wSeptRev + 0.24 * wLbbb;
      pz += 0.28 * wSeptRev + 0.88 * wLbbb;

      // 3. Alteração secundária da repolarização no BRE (ST-T discordante do QRS:
      //    supra de ST + onda T positiva em V1-V2; infra de ST + onda T invertida em DI, aVL, V5, V6)
      const wT = Math.exp(-Math.pow((tQRS - tPeak) / (tWidth * 1.1), 2));
      const wStDiscord = stPlateau * 0.45;
      px += -0.38 * wT - 0.22 * wStDiscord;
      py += -0.10 * wT - 0.05 * wStDiscord;
      pz += -0.34 * wT - 0.24 * wStDiscord;
    } else if (bbb === 'rbbb') {
      // ─── BLOQUEIO DE RAMO DIREITO (BRD / RBBB — QRS ≥ 130 ms) ───
      // 1. Fase Septal Normal (0..22 ms): gera onda r inicial em V1 e onda q septal em V6/DI
      const wSept = Math.exp(-Math.pow((tQRS - 0.014) / 0.0065, 2)) * septScale;
      // 2. Fase Ventricular Esquerda (24..56 ms): gera onda S negativa em V1 (abaixo da linha de base!) e onda R alta em V6/DI
      const wLV = Math.exp(-Math.pow((tQRS - 0.040) / 0.011, 2)) * pwScale;
      // 3. Fase Ventricular Direita Tardia e Lenta (62..130 ms): vetor dirigido para Direita (-X) e Anterior (-Z),
      //    gerando a grande onda R' em V1-V2 (padrão rSR' "orelha de coelho") e a onda S larga/empastada em DI, V5, V6!
      const wRVLate = Math.exp(-Math.pow((tQRS - 0.092) / 0.025, 2));

      px += (-0.24 * wSept) + (1.22 * wLV) + (-0.82 * wRVLate);
      py += (-0.05 * wSept) + (0.88 * wLV) + (0.12 * wRVLate);
      pz += (-0.34 * wSept) + (0.48 * wLV) + (-0.78 * wRVLate);

      // 4. Onda T no BRD: invertida secundariamente em V1-V2 (anterior) e positiva em V5-V6/DI/DII
      const wT = Math.exp(-Math.pow((tQRS - tPeak) / tWidth, 2));
      px += 0.34 * wT;
      py += 0.24 * wT;
      pz += 0.28 * wT; // +Z projeta negativamente em V1-V2 e positivamente em V6
    }

    // Soma a corrente de lesão isquêmica aguda territorial
    px += injuryVecX;
    py += injuryVecY;
    pz += injuryVecZ;

    electro.vector[0] = px;
    electro.vector[1] = py;
    electro.vector[2] = pz;

    // 4. Projeção pela Matriz de Dower para as 12 derivações
    projectDower12(px, py, pz, electro.leads);
  }

  sample(bank: import('../contracts/types').SignalBankLike, ctx: SimContext): void {
    const e = ctx.live.electro;
    bank.set('vcgX', e.vector[0]);
    bank.set('vcgY', e.vector[1]);
    bank.set('vcgZ', e.vector[2]);
    for (let i = 0; i < 12; i++) {
      bank.set(`ecg_${LEAD_NAMES[i]}`, e.leads[i]);
    }
  }
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
