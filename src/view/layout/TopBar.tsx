import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { CLINICAL_PRESETS } from '../../model/hemodynamics/clinicalPresets';
import { getLive, usePhysiologyStore, type ViewId } from '../../controller/usePhysiologyStore';
import { auscultationSynth } from '../../controller/modules/auscultationModule';
import { useRafLoop } from '../../controller/useRafLoop';

const SESSION_TABS: readonly {
  id: ViewId;
  num: string;
  label: string;
  color: string;
}[] = [
  { id: 'cardio', num: '01', label: 'CARDIOCRAFT', color: '#FF5733' },
  { id: 'pocus', num: '02', label: 'POCUSCRAFT', color: '#3B82F6' },
  { id: 'radiology', num: '03', label: 'RADIOCRAFT', color: '#10B981' },
  { id: 'exam_mode', num: '04', label: 'EXAMCRAFT', color: '#F59E0B' },
];

export function TopBar() {
  const view = usePhysiologyStore((s) => s.view);
  const setView = usePhysiologyStore((s) => s.setView);
  const activeExamCaseId = usePhysiologyStore((s) => s.activeExamCaseId);
  const exitExamMode = usePhysiologyStore((s) => s.exitExamMode);
  const leftPanelOpen = usePhysiologyStore((s) => s.leftPanelOpen);
  const rightPanelOpen = usePhysiologyStore((s) => s.rightPanelOpen);
  const toggleLeftPanel = usePhysiologyStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = usePhysiologyStore((s) => s.toggleRightPanel);
  const running = usePhysiologyStore((s) => s.running);
  const setRunning = usePhysiologyStore((s) => s.setRunning);
  const timeScale = usePhysiologyStore((s) => s.timeScale);
  const setTimeScale = usePhysiologyStore((s) => s.setTimeScale);
  const loadPreset = usePhysiologyStore((s) => s.loadPreset);
  const requestReset = usePhysiologyStore((s) => s.requestReset);
  const [, setAudioTick] = useState(0);

  useEffect(() => auscultationSynth.subscribe(() => setAudioTick((t) => t + 1)), []);

  // DOM references for transient update of the vital signs (10 Hz, 0 React re-renders)
  const hrRef = useRef<HTMLSpanElement>(null);
  const bpRef = useRef<HTMLSpanElement>(null);
  const coRef = useRef<HTMLSpanElement>(null);
  const efRef = useRef<HTMLSpanElement>(null);
  const pd2Ref = useRef<HTMLSpanElement>(null);
  const ivcRef = useRef<HTMLSpanElement>(null);

  const isCardioSession = view === 'cardio';
  const isExamActive = activeExamCaseId !== null && view !== 'exam_mode';

  useRafLoop(() => {
    if (!isCardioSession) return;
    const { clock, hemo } = getLive();
    if (hrRef.current) hrRef.current.textContent = `${Math.round(clock.hr)} BPM`;
    if (bpRef.current) bpRef.current.textContent = `${hemo.sbp}/${hemo.dbp} (${hemo.map})`;
    if (coRef.current) coRef.current.textContent = `${hemo.co.toFixed(1)} L/M · ${hemo.sv} ML`;
    if (efRef.current) efRef.current.textContent = `${hemo.lvef}% (${hemo.edv}/${hemo.esv})`;
    if (pd2Ref.current) pd2Ref.current.textContent = `${hemo.lvedp} / PVC ${hemo.cvp}`;
    if (ivcRef.current) {
      const obs = hemo.respObservation;
      // The current diameter is instantaneous; the index requires a complete window.
      const index = obs?.valid ? `${hemo.ivcIndex}%` : '—';
      ivcRef.current.textContent = `${hemo.ivcDiameter.toFixed(1)} MM (${index})`;
      ivcRef.current.title = obs?.valid
        ? `Índice VCI medido; janela ${obs.windowStart?.toFixed(2)}–${obs.windowEnd?.toFixed(2)} s`
        : obs?.status === 'resp-rate-zero'
          ? 'Índice VCI indisponível: FR=0. Último número armazenado é histórico.'
          : 'Índice VCI indisponível: aguardando ciclo respiratório completo.';
    }
  }, 10);

  const handleReturnLauncher = () => {
    if (activeExamCaseId !== null) {
      exitExamMode(false);
    } else {
      setView('hub');
    }
  };

  const handleSwitchModule = (target: ViewId) => {
    if (target !== 'exam_mode' && activeExamCaseId !== null) {
      exitExamMode(false);
    }
    setView(target);
  };

  return (
    <header>
      {/* UNIFIED SESSION TOP BAR (height: 44px, bottom border #262626) */}
      <div className="nc-session-topbar">
        <div className="nc-session-nav-left">
          <button
            type="button"
            className="nc-back-launcher-btn"
            onClick={handleReturnLauncher}
            title="Voltar ao ArtCraft Launcher"
          >
            ← LAUNCHER
          </button>

          <nav className="nc-session-tabs" aria-label="Navegação entre Módulos">
            {SESSION_TABS.map((tab) => {
              const active =
                view === tab.id || (tab.id === 'exam_mode' && activeExamCaseId !== null);
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`nc-session-tab ${active ? 'active' : ''}`}
                  style={
                    active
                      ? { borderBottom: `2px solid ${tab.color}` }
                      : undefined
                  }
                  onClick={() => handleSwitchModule(tab.id)}
                >
                  <span
                    className="nc-session-tab-num"
                    style={{ backgroundColor: tab.color }}
                  >
                    {tab.num}
                  </span>
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Column Controls (CardioCraft) + RK4 Clock */}
        <div className="nc-session-right-controls">
          {isCardioSession && !isExamActive && (
            <>
              <button
                type="button"
                className={`btn-chip ${leftPanelOpen ? 'active' : ''}`}
                onClick={toggleLeftPanel}
                title="Retrair ou expandir coluna esquerda de parâmetros Eco/ECG/Drogas"
              >
                [ PARÂMETROS ECO/ECG ]
              </button>
              <button
                type="button"
                className={`btn-chip ${rightPanelOpen ? 'active' : ''}`}
                onClick={toggleRightPanel}
                title="Retrair ou expandir coluna direita com Wiggers, Alça PV e ECG 12D"
              >
                [ MONITOR WIGGERS / 12D ]
              </button>
            </>
          )}

          <button
            type="button"
            className={`btn-chip ${running ? 'active' : ''}`}
            onClick={() => setRunning(!running)}
            title={running ? 'Pausar simulação RK4' : 'Retomar simulação RK4'}
          >
            {running ? <Pause size={12} /> : <Play size={12} />}
            <span>{running ? 'PAUSAR' : 'RODAR'}</span>
          </button>

          {[0.25, 0.5, 1].map((s) => (
            <button
              key={s}
              type="button"
              className={`btn-chip ${timeScale === s ? 'active' : ''}`}
              onClick={() => setTimeScale(s)}
            >
              {s}×
            </button>
          ))}

          <button
            type="button"
            className="btn-chip"
            onClick={() => requestReset()}
            title="Reiniciar ciclo hemodinâmico"
          >
            <RotateCcw size={12} />
          </button>
        </div>
      </div>

      {/* CARDIAC TELEMETRY EXCLUSIVE TO THE CARDIAC TAB (view === 'cardio') */}
      {isCardioSession && (
        <div className="nc-cardio-telemetry-bar">
          <div className="vitals-strip">
            <div className="vital-box vital-ecg">
              <small>FC / RITMO</small>
              <span ref={hrRef}>72 BPM</span>
            </div>
            <div className="vital-box vital-bp">
              <small>PA (MMHG)</small>
              <span ref={bpRef}>120/80 (93)</span>
            </div>
            <div className="vital-box vital-co">
              <small>DC / VS</small>
              <span ref={coRef}>5.0 L/M · 70 ML</span>
            </div>
            <div className="vital-box vital-ef">
              <small>FEVE (SIMPSON)</small>
              <span ref={efRef}>60% (120/48)</span>
            </div>
            <div className="vital-box vital-pd2">
              <small>PCP / PVC (MMHG)</small>
              <span ref={pd2Ref}>9 / PVC 5</span>
            </div>
            <div className="vital-box vital-ivc">
              <small>VCI (ÍNDICE)</small>
              <span ref={ivcRef}>— MM (—)</span>
            </div>
          </div>

          <div className="topbar-actions">
            {!isExamActive && (
              <select
                className="preset-select"
                aria-label="Selecionar Caso Clínico"
                defaultValue="normal"
                onChange={(e) => {
                  const found = CLINICAL_PRESETS.find((p) => p.id === e.target.value);
                  if (found) loadPreset(found.build());
                }}
              >
                {CLINICAL_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label.toUpperCase()}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              className={`btn-chip ${auscultationSynth.monitorBeepEnabled ? 'active' : ''}`}
              onClick={() => auscultationSynth.toggleMonitorBeep()}
              title="Alternar Bip de QRS e Alarme Clínico IEC 60601-1-8"
            >
              {auscultationSynth.monitorBeepEnabled ? <Volume2 size={12} /> : <VolumeX size={12} />}
              <span>BIP UTI</span>
            </button>

            <button
              type="button"
              className={`btn-chip ${auscultationSynth.enabled ? 'active' : ''}`}
              onClick={() => auscultationSynth.toggleEnabled()}
              title="Ativar/Silenciar Sintetizador de Ausculta Cardíaca (B1, B2, B3, B4 e Sopros)"
            >
              {auscultationSynth.enabled ? <Volume2 size={12} /> : <VolumeX size={12} />}
              <span>AUSCULTA</span>
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
