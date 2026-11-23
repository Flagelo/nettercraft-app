import {
  Activity,
  GraduationCap,
  HeartPulse,
  Layers,
  LayoutGrid,
  PanelBottom,
  RotateCcw,
  ScanLine,
  Sliders,
} from 'lucide-react';
import { usePhysiologyStore, type ViewId } from '../../controller/usePhysiologyStore';

interface DockItem {
  id: ViewId;
  label: string;
  subtitle: string;
  icon: typeof LayoutGrid;
}

const DOCK_VIEWS: readonly DockItem[] = [
  {
    id: 'hub',
    label: 'Hub Bento Grid',
    subtitle: 'Atlas Clínico & Módulos',
    icon: LayoutGrid,
  },
  {
    id: 'cardio',
    label: 'Cardiac Twin 3D',
    subtitle: '17-AHA · Wiggers · ECG 12D',
    icon: HeartPulse,
  },
  {
    id: 'pocus',
    label: 'POCUS Simulator',
    subtitle: 'Punção VJI · GLSL · Doppler',
    icon: ScanLine,
  },
  {
    id: 'radiology',
    label: 'Radiology Slicer',
    subtitle: 'DICOM/NIfTI · MPR · Raymarch',
    icon: Layers,
  },
  {
    id: 'exam_mode',
    label: 'Exam Challenge Hub',
    subtitle: 'Simulados ENARE & SES-PE',
    icon: GraduationCap,
  },
];

/**
 * Left Floating Tool Dock ('Netter-Craft Studio Aesthetic').
  * Switches between the Sandbox modes ('hub', 'cardio', 'pocus', 'radiology') and the
  * ExamChallengeHub ('exam_mode' — mortarboard/diploma icon).
 */
export function LeftToolDock() {
  const view = usePhysiologyStore((s) => s.view);
  const setView = usePhysiologyStore((s) => s.setView);
  const activeExamCaseId = usePhysiologyStore((s) => s.activeExamCaseId);
  const exitExamMode = usePhysiologyStore((s) => s.exitExamMode);
  const leftPanelOpen = usePhysiologyStore((s) => s.leftPanelOpen);
  const toggleLeftPanel = usePhysiologyStore((s) => s.toggleLeftPanel);
  const rightPanelOpen = usePhysiologyStore((s) => s.rightPanelOpen);
  const toggleRightPanel = usePhysiologyStore((s) => s.toggleRightPanel);
  const bottomDrawerOpen = usePhysiologyStore((s) => s.bottomDrawerOpen);
  const toggleBottomDrawer = usePhysiologyStore((s) => s.toggleBottomDrawer);
  const requestReset = usePhysiologyStore((s) => s.requestReset);

  const handleSelectView = (targetView: ViewId) => {
    if (targetView !== 'exam_mode' && activeExamCaseId !== null) {
      // Clicking any Sandbox tool ends Exam Mode and returns full freedom
      exitExamMode(false);
    }
    setView(targetView);
  };

  return (
    <nav className="nc-left-dock" aria-label="Dock de Ferramentas e Módulos">
      <div className="nc-dock-section">
        {DOCK_VIEWS.map((item) => {
          const Icon = item.icon;
          const isExamBtn = item.id === 'exam_mode';
          const active =
            view === item.id || (isExamBtn && activeExamCaseId !== null);
          return (
            <button
              key={item.id}
              type="button"
              className={`nc-dock-btn ${active ? 'active' : ''} ${
                isExamBtn && activeExamCaseId !== null ? 'exam-running' : ''
              }`}
              onClick={() => handleSelectView(item.id)}
              title={`${item.label} — ${item.subtitle}`}
            >
              <Icon size={19} strokeWidth={1.9} />
              <span className="nc-dock-tooltip">
                <strong>{item.label}</strong>
                <small>{item.subtitle}</small>
              </span>
            </button>
          );
        })}
      </div>

      <div className="nc-dock-divider" />

      {/* Floating Panel Controls (Clinical Inspector, Wiggers/PV/ECG Monitor and Quick Drawer) */}
      <div className="nc-dock-section">
        <button
          type="button"
          className={`nc-dock-btn secondary ${leftPanelOpen ? 'panel-on' : ''}`}
          onClick={() => toggleLeftPanel()}
          disabled={activeExamCaseId !== null}
          title={
            activeExamCaseId !== null
              ? 'Bloqueado durante o Modo Prova'
              : 'Inspetor de Parâmetros Clínicos (Eco, ECG, Drogas, Ventilação)'
          }
        >
          <Sliders size={18} strokeWidth={1.8} />
          <span className="nc-dock-tooltip">
            <strong>Inspetor Clínico</strong>
            <small>
              {activeExamCaseId !== null
                ? 'Bloqueado no Modo Prova'
                : leftPanelOpen
                  ? 'Ocultar painel esquerdo'
                  : 'Abrir laudo Eco/ECG/Drogas'}
            </small>
          </span>
        </button>

        <button
          type="button"
          className={`nc-dock-btn secondary ${rightPanelOpen ? 'panel-on' : ''}`}
          onClick={() => toggleRightPanel()}
          disabled={activeExamCaseId !== null}
          title="Monitor Hemodinâmico de Alta Frequência (Wiggers, Alça PV e ECG 12 Derivações)"
        >
          <Activity size={18} strokeWidth={1.8} />
          <span className="nc-dock-tooltip">
            <strong>Monitor Wiggers &amp; PV</strong>
            <small>
              {activeExamCaseId !== null
                ? 'Substituído pela Questão no Modo Prova'
                : rightPanelOpen
                  ? 'Ocultar gráficos 60 FPS'
                  : 'Abrir Wiggers, Alça PV e ECG'}
            </small>
          </span>
        </button>

        <button
          type="button"
          className={`nc-dock-btn secondary ${bottomDrawerOpen ? 'panel-on' : ''}`}
          onClick={() => toggleBottomDrawer()}
          title="Gaveta Inferior de Parâmetros Rápidos (FC, Drogas Vasoativas, Volemia e Ausculta)"
        >
          <PanelBottom size={18} strokeWidth={1.8} />
          <span className="nc-dock-tooltip">
            <strong>Gaveta Rápida Inferior</strong>
            <small>{bottomDrawerOpen ? 'Recolher controles rápidos' : 'Expandir sliders globais'}</small>
          </span>
        </button>

        <button
          type="button"
          className="nc-dock-btn secondary"
          onClick={() => requestReset()}
          title="Reiniciar estado hemodinâmico (RK4)"
        >
          <RotateCcw size={17} strokeWidth={1.8} />
          <span className="nc-dock-tooltip">
            <strong>Resetar Solver RK4</strong>
            <small>Restaurar equilíbrio inicial</small>
          </span>
        </button>
      </div>
    </nav>
  );
}
