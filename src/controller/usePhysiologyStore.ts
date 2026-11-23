import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { ClinicalParams, LiveElectro, LiveHemo, LiveState, WallMotionScore } from '../model/contracts/types';
import { HemoEventKind } from '../model/contracts/types';
import { EventRing } from '../model/signals/EventRing';
import { SignalBank } from '../model/signals/SignalBank';

/**
 * usePhysiologyStore — Zustand com TRANSIENT UPDATES.
 *
 *  • `params`   → baixa frequência; alterar via `patch()`. Componentes podem assinar com o hook.
 *  • `live`     → objeto MUTÁVEL de alta frequência. Mutado in-place pelo SimulationLoop.
 *                 NUNCA use `usePhysiologyStore(s => s.live.hemo.pAo)` (não re-renderiza e é anti-padrão).
 *                 Leia `usePhysiologyStore.getState().live` dentro de `useFrame` / rAF.
 *  • `bank`     → séries temporais (500 Hz, 10 s) para Canvas 2D.
 */

export type ViewId = 'hub' | 'cardio' | 'pocus' | 'radiology' | 'exam_mode';
export type PocusScenarioId = 'vascular' | 'echo_plax' | 'ivc' | 'fast_morison';
export type RadiologyContrastMode = 0 | 1 | 2 | 3; // 0 = TC (HU), 1 = RM T1, 2 = RM T2, 3 = RM FLAIR
export type DrawerSliderId =
  | 'hr'
  | 'norepinephrine'
  | 'dobutamine'
  | 'furosemide'
  | 'bloodVolume';

export interface PhysiologyStore {
  params: ClinicalParams;
  live: LiveState;
  bank: SignalBank;
  running: boolean;
  timeScale: number;
  view: ViewId;
  pocusScenario: PocusScenarioId;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  bottomDrawerOpen: boolean;
  /** Parâmetros radiológicos globais (Window Width / Window Level + Transfer Function 1D + NIfTI URL) */
  radiologyWw: number;
  radiologyWl: number;
  radiologyContrastMode: RadiologyContrastMode;
  radiologyVascularThresholdHu: number;
  radiologyBoneThresholdHu: number;
  radiologyOpacityScale: number;
  radiologyNiftiUrl: string | null;
  radiologyCrosshair: [number, number, number];
  /** Estado do Modo Prova (ExamChallengeHub): null = Sandbox livre */
  activeExamCaseId: string | null;
  activeExamAllowedSliders: DrawerSliderId[] | null;
  /** incrementado quando o loop é resetado (componentes podem limpar caches) */
  resetToken: number;
  /** Segmento AHA selecionado (1..17 ou null) sincronizado entre viewport 3D e painéis */
  selectedSegment: number | null;
  setSelectedSegment(segId: number | null): void;

  patch<K extends keyof ClinicalParams>(group: K, partial: Partial<ClinicalParams[K]>): void;
  setWallMotion(segmentIndex: number, score: WallMotionScore): void;
  loadPreset(params: ClinicalParams): void;
  setRunning(running: boolean): void;
  setTimeScale(scale: number): void;
  setView(view: ViewId): void;
  setPocusScenario(scenario: PocusScenarioId): void;
  setRadiologyWindow(ww: number, wl: number, contrastMode?: RadiologyContrastMode): void;
  setRadiologyTransferParams(partial: {
    vascularThresholdHu?: number;
    boneThresholdHu?: number;
    opacityScale?: number;
  }): void;
  setRadiologyNiftiUrl(url: string | null): void;
  setRadiologyCrosshair(crosshair: [number, number, number]): void;
  startExamCase(config: {
    caseId: string;
    targetView: ViewId;
    allowedSliders: DrawerSliderId[];
    params: ClinicalParams;
    pocusScenario?: PocusScenarioId;
    radiologyNiftiUrl?: string | null;
    radiologyWw?: number;
    radiologyWl?: number;
  }): void;
  exitExamMode(returnToExamHub?: boolean): void;
  toggleLeftPanel(): void;
  toggleRightPanel(): void;
  toggleBottomDrawer(): void;
  requestReset(): void;
}

export function defaultParams(): ClinicalParams {
  return {
    echo: {
      lvef: 60,
      lvedd: 48,
      lvesd: 31,
      septum: 9,
      posteriorWall: 9,
      wallMotion: Array.from({ length: 17 }, () => 1 as WallMotionScore),
      aorticEOA: 3.5,
      aorticROA: 0,
      mitralEOA: 5,
      mitralROA: 0,
    },
    ecg: {
      heartRate: 72,
      rhythm: 'sinus',
      flutterConduction: 2,
      bundleBranchBlock: 'none',
      qtc: 0.41,
      ischemiaTerritory: 'none',
      ischemiaTransmural: true,
    },
    drugs: { norepinephrine: 0, dobutamine: 0, nitroprusside: 0, furosemide: 0, metoprolol: 0 },
    ventilation: { mode: 'spontaneous', respRate: 14, peep: 5, drivingPressure: 12, spontaneousEffort: 3 },
    circulation: { bloodVolume: 5000, svrScale: 1, pvrScale: 1, baroreflex: true },
  };
}

function createLiveHemo(): LiveHemo {
  return {
    pLV: 0, pLA: 0, pRV: 0, pRA: 0, pAo: 0, pSA: 0, pSV: 0, pPA: 0, pPV: 0, pPl: 0,
    vLV: 120, vLA: 50, vRV: 130, vRA: 60,
    qMitral: 0, qAortic: 0, qTricuspid: 0, qPulmonary: 0, qVenousReturn: 0,
    zMitral: 0, zAortic: 0, zTricuspid: 0, zPulmonary: 0,
    dpMitral: 0, dpAortic: 0, dpTricuspid: 0, dpPulmonary: 0,
    eLV: 0, eRV: 0, eLA: 0, eRA: 0,
    lvEes: 2.5, lvV0: 10, lvA: 0.35, lvB: 0.033, ea: 2,
    sbp: 0, dbp: 0, map: 0, sv: 0, co: 0, lvef: 0, edv: 0, esv: 0, lvedp: 0,
    cvp: 0, papMean: 0, pcwp: 0, ppv: 0, svr: 0,
    ivcDiameter: 18, ivcDmin: 15, ivcDmax: 20, ivcIndex: 25,
    respObservation: {
      valid: false, status: 'awaiting-window', source: 'initial',
      windowStart: null, windowEnd: null, publishedAt: null, ageSeconds: null,
      sampleCount: 0, beatCount: 0, respiratoryRate: 14, mode: 'spontaneous',
    },
    hrCommand: 0,
    events: new EventRing(512),
  };
}

function createLiveElectro(): LiveElectro {
  return {
    vector: new Float32Array(3),
    leads: new Float32Array(12),
    segmentDepol: new Float32Array(17),
    segmentDipoles: new Float32Array(17 * 3),
  };
}

export function createLiveState(): LiveState {
  return {
    clock: {
      t: 0, phi: 0, phiResp: 0, beatIndex: 0, rr: 0.83, hr: 72, ts: 0.3, qt: 0.4, pr: 0.16,
      tInBeat: 0, tSinceQRS: 0.5, tSinceP: 0, lastRR: 0.83, atrialPhi: 0, atrialActive: true,
      isInspiration: true, inspFraction: 1 / 3,
    },
    hemo: createLiveHemo(),
    electro: createLiveElectro(),
  };
}

export const usePhysiologyStore = create<PhysiologyStore>()(
  subscribeWithSelector((set, get) => ({
    params: defaultParams(),
    live: createLiveState(),
    bank: new SignalBank(5000, 500),
    running: true,
    timeScale: 1,
    view: 'hub',
    pocusScenario: 'vascular',
    leftPanelOpen: false,
    rightPanelOpen: false,
    bottomDrawerOpen: false,
    radiologyWw: 350,
    radiologyWl: 50,
    radiologyContrastMode: 0,
    radiologyVascularThresholdHu: 150,
    radiologyBoneThresholdHu: 400,
    radiologyOpacityScale: 1.0,
    radiologyNiftiUrl: null,
    radiologyCrosshair: [0.38, 0.52, 0.42],
    activeExamCaseId: null,
    activeExamAllowedSliders: null,
    resetToken: 0,
    selectedSegment: null,
    setSelectedSegment: (selectedSegment) => set({ selectedSegment }),

    patch: (group, partial) =>
      set((s) => ({ params: { ...s.params, [group]: { ...s.params[group], ...partial } } })),

    setWallMotion: (i, score) => {
      const wm = get().params.echo.wallMotion.slice();
      wm[i] = score;
      get().patch('echo', { wallMotion: wm });
    },

    loadPreset: (params) => set({ params: structuredClone(params) }),
    setRunning: (running) => set({ running }),
    setTimeScale: (timeScale) => set({ timeScale }),
    setView: (view) =>
      set((s) => {
        const isLeavingToExamHub = view === 'exam_mode';
        const isExamStillActive = !isLeavingToExamHub && s.activeExamCaseId !== null;
        return {
          view,
          activeExamCaseId: isLeavingToExamHub ? null : s.activeExamCaseId,
          activeExamAllowedSliders: isLeavingToExamHub ? null : s.activeExamAllowedSliders,
          // Ao entrar em CardioCraft, inicia com leftPanelOpen = false e rightPanelOpen = true (Etapa 4.1)
          leftPanelOpen: false,
          rightPanelOpen: isExamStillActive ? false : view === 'cardio',
          bottomDrawerOpen: isExamStillActive
            ? (s.activeExamAllowedSliders?.length ?? 0) > 0
            : false,
        };
      }),
    setPocusScenario: (pocusScenario) => set({ pocusScenario }),
    setRadiologyWindow: (radiologyWw, radiologyWl, contrastMode) =>
      set((s) => ({
        radiologyWw,
        radiologyWl,
        radiologyContrastMode: contrastMode !== undefined ? contrastMode : s.radiologyContrastMode,
      })),
    setRadiologyTransferParams: (partial) =>
      set((s) => ({
        radiologyVascularThresholdHu:
          partial.vascularThresholdHu ?? s.radiologyVascularThresholdHu,
        radiologyBoneThresholdHu: partial.boneThresholdHu ?? s.radiologyBoneThresholdHu,
        radiologyOpacityScale: partial.opacityScale ?? s.radiologyOpacityScale,
      })),
    setRadiologyNiftiUrl: (radiologyNiftiUrl) => set({ radiologyNiftiUrl }),
    setRadiologyCrosshair: (radiologyCrosshair) => set({ radiologyCrosshair }),
    startExamCase: (cfg) =>
      set((s) => ({
        activeExamCaseId: cfg.caseId,
        activeExamAllowedSliders: cfg.allowedSliders,
        params: structuredClone(cfg.params),
        view: cfg.targetView,
        pocusScenario: cfg.pocusScenario ?? s.pocusScenario,
        radiologyNiftiUrl:
          cfg.radiologyNiftiUrl !== undefined ? cfg.radiologyNiftiUrl : s.radiologyNiftiUrl,
        radiologyWw: cfg.radiologyWw ?? s.radiologyWw,
        radiologyWl: cfg.radiologyWl ?? s.radiologyWl,
        // No Modo Prova, ocultamos os inspectores de resposta do Sandbox e abrimos apenas os sliders permitidos (se houver)
        leftPanelOpen: false,
        rightPanelOpen: false,
        bottomDrawerOpen: cfg.allowedSliders.length > 0,
        resetToken: s.resetToken + 1,
      })),
    exitExamMode: (returnToExamHub = true) =>
      set({
        activeExamCaseId: null,
        activeExamAllowedSliders: null,
        radiologyNiftiUrl: null,
        view: returnToExamHub ? 'exam_mode' : 'hub',
        leftPanelOpen: false,
        rightPanelOpen: false,
        bottomDrawerOpen: false,
      }),
    toggleLeftPanel: () => set((s) => ({ leftPanelOpen: !s.leftPanelOpen })),
    toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
    toggleBottomDrawer: () => set((s) => ({ bottomDrawerOpen: !s.bottomDrawerOpen })),
    requestReset: () => set((s) => ({ resetToken: s.resetToken + 1 })),
  })),
);

/** Atalho para leitura transiente (hot path). */
export const getLive = (): LiveState => usePhysiologyStore.getState().live;
export const getBank = (): SignalBank => usePhysiologyStore.getState().bank;

export { HemoEventKind };
