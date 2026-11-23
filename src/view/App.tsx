import { useEffect, useState } from 'react';
import { getSimulationLoop } from '../controller/SimulationLoop';
import { usePhysiologyStore } from '../controller/usePhysiologyStore';
import { physiologySystems } from '../controller/modules/hemodynamicsModule';
import { electroSystems } from '../controller/modules/electrophysiologyModule';
import { audioSystems } from '../controller/modules/auscultationModule';
import { CardiacViewport } from './cardiac3d';
import { PocusViewport } from './pocusModule';
import { RadiologyViewport } from './radiology';
import { ExamChallengeHub, ExamSidebar } from './exams';
import { TopBar } from './layout/TopBar';
import { HubBentoGrid } from './layout/HubBentoGrid';
import { ClinicalPanel } from './panels/ClinicalPanel';
import { HemodynamicPanel } from './panels/HemodynamicPanel';
import { BottomQuickDrawer } from './layout/BottomQuickDrawer';

/**
 * Definitive App Shell — ArtCraft Launcher Pattern & Modular Isolation:
 *  - When `view === 'hub'`: renders only the ArtCraft Launcher in full screen (100vw x 100vh),
 *    with no cardiac TopBar, no LeftToolDock and no BottomQuickDrawer.
 *  - When inside any module ('cardio', 'pocus', 'radiology', 'exam_mode'):
 *    shows the unified Session Top Bar (44px) and isolates cardiac telemetry and the BottomQuickDrawer
 *    strictly to `view === 'cardio'`.
 */
export function App() {
  const view = usePhysiologyStore((s) => s.view);
  const leftPanelOpen = usePhysiologyStore((s) => s.leftPanelOpen);
  const rightPanelOpen = usePhysiologyStore((s) => s.rightPanelOpen);
  const activeExamCaseId = usePhysiologyStore((s) => s.activeExamCaseId);

  const toggleLeftPanel = usePhysiologyStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = usePhysiologyStore((s) => s.toggleRightPanel);
  const [ecgWideMode, setEcgWideMode] = useState(false);

  useEffect(() => {
    const loop = getSimulationLoop();
    loop.register(...physiologySystems, ...electroSystems, ...audioSystems);
    loop.start();
    return () => loop.stop();
  }, []);

  // Step 2: When view === 'hub', renders the ArtCraft Launcher 100vw x 100vh without cardiac bars
  if (view === 'hub') {
    return <HubBentoGrid />;
  }

  const isExamActive = activeExamCaseId !== null && view !== 'exam_mode';

  // Side panels exclusive to CardioCraft (or ExamSidebar during an exam)
  const showSandboxLeftInspector = !isExamActive && leftPanelOpen && view === 'cardio';
  const showExamCardioMonitorLeft = isExamActive && view === 'cardio';
  const showSandboxRightMonitor = !isExamActive && rightPanelOpen && view === 'cardio';

  return (
    <div className="nc-studio-shell">
      <TopBar />

      <div className="nc-spatial-workspace">
        {/* Left Column: Clinical Inspector (Cardio Sandbox) or Hemodynamic Monitor (Cardio Exam) */}
        {showSandboxLeftInspector && (
          <div className="nc-floating-left-panel">
            <div className="nc-panel-top-strip">
              <span>PARÂMETROS ECO / ECG / DROGAS</span>
              <button
                type="button"
                className="nc-panel-collapse-btn"
                onClick={toggleLeftPanel}
                title="Recolher Coluna Esquerda"
              >
                ✕
              </button>
            </div>
            <ClinicalPanel />
          </div>
        )}
        {showExamCardioMonitorLeft && (
          <div className="nc-floating-left-panel exam-monitor">
            <HemodynamicPanel
              ecgWideMode={ecgWideMode}
              onToggleEcgWide={() => setEcgWideMode((v) => !v)}
            />
          </div>
        )}

        {/* Center Column: Dedicated Viewport + Bottom Drawer exclusive to the cardiac session */}
        <div className="nc-stage-column">
          <main className="nc-stage">
            {view === 'cardio' && <CardiacViewport />}
            {view === 'pocus' && <PocusViewport />}
            {view === 'radiology' && <RadiologyViewport />}
            {view === 'exam_mode' && <ExamChallengeHub />}
          </main>

          {/* Step 3.2: BottomQuickDrawer is ONLY rendered when view === 'cardio' */}
          {view === 'cardio' && <BottomQuickDrawer />}
        </div>

        {/* Right Column: Tabbed Hemodynamic Monitor (Cardio Sandbox) or ExamSidebar (Exam Mode) */}
        {showSandboxRightMonitor && (
          <div className={`nc-floating-right-panel ${ecgWideMode ? 'ecg-expanded' : ''}`}>
            <div className="nc-panel-top-strip">
              <span>MONITOR MULTIPARAMÉTRICO 60 FPS</span>
              <button
                type="button"
                className="nc-panel-collapse-btn"
                onClick={toggleRightPanel}
                title="Recolher Monitor Direito"
              >
                ✕
              </button>
            </div>
            <HemodynamicPanel
              ecgWideMode={ecgWideMode}
              onToggleEcgWide={() => setEcgWideMode((v) => !v)}
            />
          </div>
        )}
        {isExamActive && (
          <div className="nc-floating-right-panel exam-sidebar-panel">
            <ExamSidebar />
          </div>
        )}
      </div>
    </div>
  );
}
