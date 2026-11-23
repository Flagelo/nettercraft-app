import {
  Activity,
  ArrowUpRight,
  Award,
  BookOpen,
  GraduationCap,
  HeartPulse,
  Layers,
  Lock,
  ScanLine,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { usePhysiologyStore } from '../../controller/usePhysiologyStore';
import { EXAM_CASES, type ExamCase } from '../../model/exams/examCases';

/**
 * Step 1 — ExamChallengeHub Gallery ('netter-artcraft-ui-shell'):
 *  - 'Obsidian Radiology' background (#0A0C10 with radial dotted grid)
 *  - Clinical case cards (SES-PE and ENARE) with Glassmorphism (backdrop-blur-xl, border-white/10)
 *  - Accent colors 'Arterial Crimson' (#C82829 — Cardiology/Clinical) and 'Venous Cobalt' (#2B6CB0 — Trauma/Surgery)
 */
export function ExamChallengeHub() {
  const startExamCase = usePhysiologyStore((s) => s.startExamCase);
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');

  const categories = [
    { id: 'ALL', label: 'Todos os Simulados (ENARE + SES-PE)', badgeColor: 'neutral' },
    {
      id: 'Emergências Clínicas — ENARE',
      label: 'Cardiologia & Emergências Clínicas — ENARE',
      badgeColor: 'crimson',
    },
    {
      id: 'Trauma e Cirurgia — SES-PE',
      label: 'Trauma, Cirurgia & Radiologia — SES-PE',
      badgeColor: 'cobalt',
    },
  ];

  const filteredCases =
    selectedCategory === 'ALL'
      ? EXAM_CASES
      : EXAM_CASES.filter((c) => c.category === selectedCategory);

  const handleStartCase = (exam: ExamCase) => {
    startExamCase({
      caseId: exam.id,
      targetView: exam.targetView,
      allowedSliders: exam.allowedSliders,
      params: exam.initialParams,
      pocusScenario: exam.pocusScenario,
      radiologyNiftiUrl: exam.radiologyNiftiUrl,
      radiologyWw: exam.radiologyWw,
      radiologyWl: exam.radiologyWl,
    });
  };

  return (
    <div className="nc-hub-scroll nc-exam-obsidian-bg">
      <div className="nc-hub-container">
        {/* Netter-ArtCraft Editorial Header */}
        <header className="nc-hero-header">
          <div className="nc-hero-badge-row">
            <span className="nc-edition-pill">
              <GraduationCap size={14} color="#F5F0E6" />
              <span>NETTER-ARTCRAFT EXAM SHELL · RESIDÊNCIA MÉDICA PRÁTICA</span>
            </span>
            <span className="nc-engine-pill">
              <ShieldCheck size={12} color="#00E676" />
              <span>DiSSS Active Recall + 6-Layer Clinical Stack</span>
            </span>
          </div>

          <h1 className="nc-hero-title">
            Simulados Baseados em Intervenção Clínica (ENARE &amp; SES-PE)
          </h1>
          <p className="nc-hero-sub">
            Selecione uma estação prática. O simulador abrirá em <strong>Modo Prova</strong> com a
            vinheta em pergaminho Netter à direita e os controles da gaveta inferior bloqueados —
            mantendo iluminados apenas os parâmetros necessários para a sua conduta.
          </p>

          {/* Category Filters with Arterial Crimson & Venous Cobalt accents */}
          <div className="nc-exam-filter-bar">
            {categories.map((cat) => {
              const active = selectedCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  className={`nc-exam-filter-pill ${cat.badgeColor} ${active ? 'active' : ''}`}
                  onClick={() => setSelectedCategory(cat.id)}
                >
                  {cat.badgeColor === 'crimson' && <span className="nc-dot crimson" />}
                  {cat.badgeColor === 'cobalt' && <span className="nc-dot cobalt" />}
                  {cat.badgeColor === 'neutral' && <Sparkles size={12} />}
                  <span>{cat.label}</span>
                </button>
              );
            })}
          </div>
        </header>

        {/* Glassmorphism Gallery (backdrop-blur-xl, border-white/10) */}
        <div className="nc-exam-gallery-grid">
          {filteredCases.map((exam) => {
            const isCardio = exam.board === 'ENARE';
            // 'Arterial Crimson' (#C82829) for ENARE and 'Venous Cobalt' (#2B6CB0) for SES-PE
            const themeTone = isCardio ? 'crimson' : 'cobalt';
            const categoryLabel = exam.yearTag.toUpperCase();

            const ModuleIcon =
              exam.targetView === 'pocus'
                ? ScanLine
                : exam.targetView === 'radiology'
                  ? Layers
                  : HeartPulse;

            return (
              <article
                key={exam.id}
                className={`nc-bento-card nc-exam-glass-card tone-${themeTone}`}
              >
                <div className="nc-card-plate-row">
                  <span className={`nc-plate-tag ${themeTone}`}>{categoryLabel}</span>
                  <span className="nc-exam-module-tag">
                    <ModuleIcon size={13} />
                    <span>
                      {exam.targetView === 'pocus'
                        ? exam.pocusScenario === 'vascular'
                          ? 'POCUS Vascular (Shader GLSL)'
                          : 'POCUS E-FAST (Shader GLSL)'
                        : exam.targetView === 'radiology'
                          ? 'Slicer MPR 3D (NIfTI)'
                          : 'Cardiac Twin 3D + Wiggers'}
                    </span>
                  </span>
                </div>

                <h2 className="nc-card-title">{exam.title}</h2>

                {/* Vital Signs in JetBrains Mono */}
                <div className="nc-exam-vitals-preview">
                  <Activity size={13} color="#00E676" />
                  <span>{exam.vitalsHeader}</span>
                </div>

                <p className="nc-card-desc">{exam.vignette}</p>

                <div className="nc-exam-card-meta-row">
                  <span className="nc-exam-meta-chip">
                    <Lock size={11} />
                    <span>
                      Controles c/ Glow:{' '}
                      {exam.allowedSliders.length > 0
                        ? exam.allowedSliders.join(' · ')
                        : 'Janelamento WW/WL & Crosshair 3D'}
                    </span>
                  </span>
                  <span className="nc-exam-meta-chip">
                    <BookOpen size={11} />
                    <span>{exam.disss.selection.guidelineName}</span>
                  </span>
                  <span className="nc-exam-meta-chip">
                    <Award size={11} />
                    <span>{exam.difficulty}</span>
                  </span>
                </div>

                <div className="nc-exam-card-footer">
                  <button
                    type="button"
                    className={`nc-launch-btn ${themeTone}`}
                    onClick={() => handleStartCase(exam)}
                    style={{ width: '100%', justifyContent: 'center', padding: '10px 16px' }}
                  >
                    <span>Iniciar Estação Prática ({exam.board})</span>
                    <ArrowUpRight size={16} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
