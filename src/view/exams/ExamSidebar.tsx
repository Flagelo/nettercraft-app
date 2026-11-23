import {
  Activity,
  CheckCircle2,
  ClipboardCheck,
  GraduationCap,
  Lock,
  LogOut,
  Sliders,
} from 'lucide-react';
import { useState } from 'react';
import { usePhysiologyStore } from '../../controller/usePhysiologyStore';
import { type ExamActionOption, getExamCaseById } from '../../model/exams/examCases';
import { ExamFeedbackModal } from './ExamFeedbackModal';

/**
 * Step 2 — Question Panel (`src/view/exams/ExamSidebar.tsx`):
 *  - Fixed right side panel with a vignette card in 'Warm Netter Parchment' (#F5F0E6)
 *    and classic serif typography (Playfair Display / Instrument Serif).
 *  - Admission vital signs in a monospaced font (JetBrains Mono).
 *  - Management-based interaction coupled to the simulator state.
 */
export function ExamSidebar() {
  const activeExamCaseId = usePhysiologyStore((s) => s.activeExamCaseId);
  const params = usePhysiologyStore((s) => s.params);
  const patch = usePhysiologyStore((s) => s.patch);
  const exitExamMode = usePhysiologyStore((s) => s.exitExamMode);

  const [selectedOption, setSelectedOption] = useState<ExamActionOption | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const examCase = getExamCaseById(activeExamCaseId);
  if (!examCase) return null;

  const sliderRequirementMet = examCase.sliderRequirement
    ? examCase.sliderRequirement.check(params)
    : true;

  const handleSelectAction = (opt: ExamActionOption) => {
    if (opt.applyStoreIntervention) {
      opt.applyStoreIntervention();
    }
    // If the chosen option already prescribes the correct pharmacological management (Case 2 STEMI / Case 3 HFpEF),
    // we automatically titrate the therapeutic dose in the RK4 engine if the student has not yet dragged the manual slider (Fixes 7.2)
    if (
      opt.isCorrect &&
      examCase.sliderRequirement &&
      !sliderRequirementMet &&
      examCase.sliderRequirement.quickFixDrugPatch
    ) {
      patch('drugs', examCase.sliderRequirement.quickFixDrugPatch);
    }
    setSelectedOption(opt);
    setModalOpen(true);
  };

  return (
    <>
      <aside className="nc-floating-inspector right nc-exam-sidebar" aria-label="Questão Modo Prova">
        <div className="nc-inspector-header nc-exam-sidebar-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <GraduationCap size={16} color="#F5F0E6" />
            <span>ESTAÇÃO DE PROVA · {examCase.board}</span>
          </div>
          <button
            type="button"
            className="nc-inspector-close"
            onClick={() => exitExamMode(true)}
            title="Sair do Modo Prova e voltar à Galeria"
            style={{ width: 'auto', padding: '0 9px', gap: 5, fontSize: 10.5 }}
          >
            <LogOut size={12} />
            <span>Encerrar Prova</span>
          </button>
        </div>

        <div className="nc-inspector-scroll nc-exam-sidebar-body">
          {/* Category Tags (Arterial Crimson / Venous Cobalt) and Exam Mode */}
          <div className="nc-exam-meta-badges">
            <span
              className={`nc-exam-board-pill ${
                examCase.board === 'ENARE' ? 'enare' : 'ses-pe'
              }`}
            >
              {examCase.yearTag}
            </span>
            <span className="nc-exam-lock-pill">
              <Lock size={11} />
              <span>Modo Prova</span>
            </span>
          </div>

          <h3 className="nc-exam-sidebar-title">{examCase.title}</h3>

          {/* Admission Vital Signs in Monospaced Font (JetBrains Mono) */}
          <div className="nc-exam-vitals-strip">
            <Activity size={14} color="#00E676" />
            <span>{examCase.vitalsHeader}</span>
          </div>

          {/* Editorial Sheet 'Warm Netter Parchment' (#F5F0E6) with Classic Serif Font */}
          <div className="nc-exam-parchment-sheet">
            <span className="nc-parchment-kicker">
              VINHETA CLÍNICA OFICIAL · {examCase.board}
            </span>
            <p className="nc-parchment-serif-body">{examCase.vignette}</p>
          </div>

          {/* Slider Status with Glow in the Bottom Drawer */}
          {examCase.sliderRequirement && (
            <div
              className={`nc-exam-slider-req-box ${sliderRequirementMet ? 'met' : 'pending'}`}
            >
              <div className="nc-exam-req-head">
                {sliderRequirementMet ? (
                  <CheckCircle2 size={14} color="#00E676" />
                ) : (
                  <Sliders size={14} color="#f59e0b" />
                )}
                <strong>CONTROLE COM GLOW ATIVO NA GAVETA INFERIOR:</strong>
              </div>
              <p>{examCase.sliderRequirement.description}</p>
              <div className="nc-exam-req-status">
                <span>
                  {examCase.sliderRequirement.statusLabel
                    ? examCase.sliderRequirement.statusLabel(params)
                    : `Furosemida IV atual: ${params.drugs.furosemide} mg`}
                </span>
                {!sliderRequirementMet && (
                  <button
                    type="button"
                    className="nc-quick-titrate-btn"
                    onClick={() =>
                      patch(
                        'drugs',
                        examCase.sliderRequirement?.quickFixDrugPatch ?? { furosemide: 60 },
                      )
                    }
                  >
                    {examCase.sliderRequirement.quickFixLabel ?? 'Titular 60 mg IV Agora'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Question Prompt & Management-Based Actions */}
          <div className="nc-exam-actions-section">
            <span className="nc-exam-section-label">
              <ClipboardCheck size={13} />
              <span>{examCase.taskPrompt}</span>
            </span>

            <div className="nc-exam-options-list">
              {examCase.options.map((opt) => {
                const isSelected = selectedOption?.id === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`nc-exam-conduct-btn ${isSelected ? 'selected' : ''}`}
                    onClick={() => handleSelectAction(opt)}
                  >
                    <div className="nc-exam-conduct-main">{opt.label}</div>
                    <div className="nc-exam-conduct-sub">{opt.subtitle}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {selectedOption && !modalOpen && (
            <button
              type="button"
              className="nc-exam-reopen-modal-btn"
              onClick={() => setModalOpen(true)}
            >
              📖 Reabrir Modal DiSSS &amp; Active Recall Stack
            </button>
          )}
        </div>
      </aside>

      {modalOpen && selectedOption && (
        <ExamFeedbackModal
          examCase={examCase}
          selectedOption={selectedOption}
          sliderRequirementMet={sliderRequirementMet}
          onCloseModal={() => setModalOpen(false)}
          onExitToExamHub={() => {
            setModalOpen(false);
            exitExamMode(true);
          }}
        />
      )}
    </>
  );
}
