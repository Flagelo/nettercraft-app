import {
  AlertTriangle,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  Layers,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import {
  getBank,
  getLive,
  usePhysiologyStore,
  type ViewId,
} from '../../controller/usePhysiologyStore';
import type { ExamActionOption, ExamCase } from '../../model/exams/examCases';
import { useCanvas2D } from '../../controller/useRafLoop';

interface ExamFeedbackModalProps {
  examCase: ExamCase;
  selectedOption: ExamActionOption;
  sliderRequirementMet: boolean;
  onCloseModal: () => void;
  onExitToExamHub: () => void;
}

type DisssSectionId = 'deconstruction' | 'selection' | 'sequencing' | 'stakes';

/**
 * Step 3 — DiSSS Feedback Modal (`src/view/exams/ExamFeedbackModal.tsx`):
 *  - Central modal with background blur (backdrop-blur)
 *  - Expandable blocks (Accordions) for the 4 sections of the Active Recall Stack
 *    (Deconstruction, Selection, Sequencing, Stakes) + accordions in the 6 inner layers
 *  - `quickLinkView` buttons next to each explanation that open a Quick Overlay
 *    of the Wiggers diagram, POCUS or MPR Slicer with the pathology highlighted in the image!
 */
export function ExamFeedbackModal({
  examCase,
  selectedOption,
  sliderRequirementMet,
  onCloseModal,
  onExitToExamHub,
}: ExamFeedbackModalProps) {
  const setView = usePhysiologyStore((s) => s.setView);

  // Main accordions of the 4 DiSSS pillars (start open for immediate review)
  const [openSections, setOpenSections] = useState<Record<DisssSectionId, boolean>>({
    deconstruction: true,
    selection: true,
    sequencing: true,
    stakes: true,
  });

  // Individual accordions of the 6 layers of the Sequencing Stack
  const [revealedLayers, setRevealedLayers] = useState<Record<number, boolean>>({
    1: true,
    2: true,
    3: true,
    4: true,
    5: true,
    6: true,
  });

  const allRevealed =
    Object.values(openSections).every(Boolean) &&
    Object.values(revealedLayers).every(Boolean);

  // Quick Overlay state (Wiggers / POCUS / MPR Slicer with the pathology highlighted)
  const [spotlightOverlay, setSpotlightOverlay] = useState<{
    view: ViewId;
    title: string;
  } | null>(null);

  const overallSuccess = selectedOption.isCorrect && sliderRequirementMet;
  const { disss } = examCase;

  const toggleSection = (id: DisssSectionId) => {
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleLayer = (num: number) => {
    setRevealedLayers((prev) => ({ ...prev, [num]: !prev[num] }));
  };

  const setAllRecall = (revealAll: boolean) => {
    setOpenSections({
      deconstruction: revealAll,
      selection: revealAll,
      sequencing: true, // keeps the container visible so each layer L1..L6 can be clicked in Active Recall mode
      stakes: revealAll,
    });
    setRevealedLayers({
      1: revealAll,
      2: revealAll,
      3: revealAll,
      4: revealAll,
      5: revealAll,
      6: revealAll,
    });
  };

  return (
    <div className="nc-exam-modal-backdrop" role="dialog" aria-modal="true">
      <div className="nc-exam-modal">
        {/* Management Assessment Header */}
        <header
          className={`nc-exam-modal-header ${overallSuccess ? 'is-correct' : 'is-wrong'}`}
        >
          <div className="nc-exam-verdict-row">
            {overallSuccess ? (
              <CheckCircle2 size={28} color="#00E676" />
            ) : (
              <XCircle size={28} color="#ef4444" />
            )}
            <div style={{ flex: 1 }}>
              <span className="nc-exam-verdict-tag">
                {overallSuccess
                  ? 'CONDUTA CLÍNICA CORRETA · PADRÃO OURO DE RESIDÊNCIA'
                  : selectedOption.isCorrect && !sliderRequirementMet
                    ? 'CONDUTA PARCIAL · FALTOU AJUSTAR O SLIDER ILUMINADO NA GAVETA INFERIOR'
                    : 'CONDUTA INADEQUADA · ESTUDO DIRIGIDO DiSSS & 6-LAYER ACTIVE RECALL'}
              </span>
              <h2 className="nc-exam-modal-title">{examCase.title}</h2>
            </div>

            <div className="btn-group">
              <button
                type="button"
                className={`btn-chip ${!allRevealed ? 'active' : ''}`}
                onClick={() => setAllRecall(false)}
                title="Ocultar explicações e camadas L1-L6 para forçar a lembrança ativa (Active Recall)"
              >
                🧠 Modo Active Recall (Ocultar Respostas)
              </button>
              <button
                type="button"
                className={`btn-chip ${allRevealed ? 'active' : ''}`}
                onClick={() => setAllRecall(true)}
                title="Expandir todas as explicações e as 6 camadas do gabarito comentado"
              >
                📖 Gabarito Completo (Revelar Tudo)
              </button>
            </div>
          </div>

          <div className="nc-exam-selected-summary">
            <span>Conduta selecionada:</span> <strong>{selectedOption.label}</strong>
            {examCase.sliderRequirement && (
              <span
                className={`nc-slider-check-badge ${sliderRequirementMet ? 'ok' : 'pending'}`}
              >
                {sliderRequirementMet
                  ? '✓ Intervenção no Slider Validada'
                  : `⚠ Pendente: ${examCase.sliderRequirement.description}`}
              </span>
            )}
          </div>
        </header>

        <div className="nc-exam-modal-body">
          {/* ═══════════ ACCORDION 1: DECONSTRUCTION ═══════════ */}
          <section className="nc-disss-card deconstruction">
            <button
              type="button"
              className="nc-disss-accordion-trigger"
              onClick={() => toggleSection('deconstruction')}
              aria-expanded={openSections.deconstruction}
            >
              <div className="nc-disss-section-head" style={{ marginBottom: 0 }}>
                <Sparkles size={15} color="#00E676" />
                <span>1. DECONSTRUCTION — DIAGNÓSTICO EXATO &amp; GATILHO DA IMAGEM</span>
              </div>
              <div className="nc-accordion-right">
                <span className="nc-recall-hint">
                  {openSections.deconstruction ? 'Ocultar' : 'Forçar Lembrança → Revelar'}
                </span>
                {openSections.deconstruction ? (
                  <ChevronUp size={15} />
                ) : (
                  <ChevronDown size={15} />
                )}
              </div>
            </button>

            {openSections.deconstruction && (
              <div className="nc-disss-accordion-content">
                <h3 className="nc-disss-diag">{disss.deconstruction.diagnosis}</h3>
                <div className="nc-disss-trigger-box">
                  <div style={{ flex: 1 }}>
                    <strong>Gatilho Visual/Fisiológico:</strong>{' '}
                    {disss.deconstruction.imageOrSignalTrigger}
                  </div>
                  <button
                    type="button"
                    className="nc-layer-jump-btn"
                    onClick={() =>
                      setSpotlightOverlay({
                        view: examCase.targetView,
                        title: `Destaque Patológico — ${examCase.title}`,
                      })
                    }
                  >
                    <Eye size={13} />
                    <span>Abrir Overlay com Patologia Destacada</span>
                  </button>
                </div>
                <p className="nc-disss-text">{disss.deconstruction.summary}</p>
              </div>
            )}
          </section>

          {/* ═══════════ ACCORDION 2: SELECTION (THE PRACTICAL RULE) ═══════════ */}
          <section className="nc-disss-card selection">
            <button
              type="button"
              className="nc-disss-accordion-trigger"
              onClick={() => toggleSection('selection')}
              aria-expanded={openSections.selection}
            >
              <div className="nc-disss-section-head" style={{ marginBottom: 0 }}>
                <BookOpen size={15} color="#60a5fa" />
                <span>2. SELECTION (A REGRA PRÁTICA) — {disss.selection.guidelineName}</span>
              </div>
              <div className="nc-accordion-right">
                <span className="nc-recall-hint">
                  {openSections.selection ? 'Ocultar' : 'Qual diretriz ditou a conduta? → Revelar'}
                </span>
                {openSections.selection ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </div>
            </button>

            {openSections.selection && (
              <div className="nc-disss-accordion-content">
                <p className="nc-disss-rule">{disss.selection.practicalRule}</p>
              </div>
            )}
          </section>

          {/* ═══════════ ACCORDION 3: SEQUENCING (6-LAYER ACTIVE RECALL STACK) ═══════════ */}
          <section className="nc-disss-card sequencing">
            <button
              type="button"
              className="nc-disss-accordion-trigger"
              onClick={() => toggleSection('sequencing')}
              aria-expanded={openSections.sequencing}
            >
              <div className="nc-disss-section-head" style={{ marginBottom: 0 }}>
                <Layers size={15} color="#f59e0b" />
                <span>
                  3. SEQUENCING — 6-LAYER ACTIVE RECALL STACK (FISIOPATOLOGIA &amp; DIFERENCIAIS)
                </span>
              </div>
              <div className="nc-accordion-right">
                <span className="nc-recall-hint">
                  {openSections.sequencing ? 'Recolher Pilha' : 'Expandir 6 Camadas'}
                </span>
                {openSections.sequencing ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </div>
            </button>

            {openSections.sequencing && (
              <div className="nc-disss-accordion-content">
                <div className="nc-layers-grid">
                  {disss.sequencingLayers.map((layer) => {
                    const isOpen = revealedLayers[layer.layerNumber] ?? false;
                    return (
                      <div
                        key={layer.layerNumber}
                        className={`nc-layer-item ${isOpen ? 'open' : 'masked'}`}
                      >
                        <button
                          type="button"
                          className="nc-layer-header-btn"
                          onClick={() => toggleLayer(layer.layerNumber)}
                        >
                          <span className="nc-layer-num">L{layer.layerNumber}</span>
                          <span className="nc-layer-title">{layer.layerTitle}</span>
                          <small>{isOpen ? 'Ocultar' : 'Revelar Recall'}</small>
                        </button>
                        {isOpen && (
                          <div className="nc-layer-content">
                            <p>{layer.content}</p>
                            {layer.quickLinkView && (
                              <div className="nc-layer-actions-row">
                                <button
                                  type="button"
                                  className="nc-layer-jump-btn"
                                  onClick={() =>
                                    setSpotlightOverlay({
                                      view: layer.quickLinkView!,
                                      title: `${layer.layerTitle} — ${examCase.title}`,
                                    })
                                  }
                                >
                                  <Eye size={13} />
                                  <span>
                                    {layer.quickLinkLabel ?? 'Overlay da Patologia'}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className="nc-layer-jump-btn secondary"
                                  onClick={() => {
                                    setView(layer.quickLinkView!);
                                    onCloseModal();
                                  }}
                                >
                                  <span>Ir ao Módulo</span>
                                  <ArrowUpRight size={12} />
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          {/* ═══════════ ACCORDION 4: STAKES (EDGE CASES) ═══════════ */}
          <section className="nc-disss-card stakes">
            <button
              type="button"
              className="nc-disss-accordion-trigger"
              onClick={() => toggleSection('stakes')}
              aria-expanded={openSections.stakes}
            >
              <div className="nc-disss-section-head" style={{ marginBottom: 0 }}>
                <ShieldAlert size={16} color="#f87171" />
                <span>4. STAKES (EDGE CASES) — {disss.stakesEdgeCases.title}</span>
              </div>
              <div className="nc-accordion-right">
                <span className="nc-recall-hint">
                  {openSections.stakes ? 'Ocultar' : 'Quando a conduta padrão falha? → Revelar'}
                </span>
                {openSections.stakes ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </div>
            </button>

            {openSections.stakes && (
              <div className="nc-disss-accordion-content">
                <p className="nc-disss-text">
                  <strong>Cenário Limítrofe:</strong> {disss.stakesEdgeCases.scenario}
                </p>
                <div className="nc-stakes-alt">
                  <AlertTriangle size={14} color="#fbbf24" />
                  <span>
                    <strong>Conduta de Resgate:</strong>{' '}
                    {disss.stakesEdgeCases.alternativeManagement}
                  </span>
                </div>
              </div>
            )}
          </section>
        </div>

        <footer className="nc-exam-modal-footer">
          <button type="button" className="nc-exam-btn secondary" onClick={onCloseModal}>
            <RotateCcw size={14} />
            <span>Voltar ao Paciente Simulado</span>
          </button>
          <button type="button" className="nc-exam-btn primary" onClick={onExitToExamHub}>
            <span>Voltar à Galeria de Simulados (ENARE / SES-PE)</span>
          </button>
        </footer>

        {/* ═══════════ QUICK OVERLAY OF THE WIGGERS DIAGRAM, POCUS OR MPR SLICER WITH PATHOLOGY HIGHLIGHTED ═══════════ */}
        {spotlightOverlay && (
          <QuickPathologySpotlightOverlay
            view={spotlightOverlay.view}
            title={spotlightOverlay.title}
            examCase={examCase}
            onClose={() => setSpotlightOverlay(null)}
            onOpenFullViewport={() => {
              const target = spotlightOverlay.view;
              setSpotlightOverlay(null);
              setView(target);
              onCloseModal();
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Quick Overlay that renders live the Wiggers diagram/PV Loop, POCUS (Morison's pouch) or MPR Slicer
 * graphically highlighting the question's pathological trigger without leaving the review modal.
 */
function QuickPathologySpotlightOverlay({
  view,
  title,
  examCase,
  onClose,
  onOpenFullViewport,
}: {
  view: ViewId;
  title: string;
  examCase: ExamCase;
  onClose: () => void;
  onOpenFullViewport: () => void;
}) {
  const canvasRef = useCanvas2D((ctx, w, h) => {
    const live = getLive();
    const bank = getBank();

    ctx.fillStyle = '#060910';
    ctx.fillRect(0, 0, w, h);

    if (view === 'cardio') {
      // Draws the Wiggers Diagram (left) + PV Loop (right) with the pathology highlighted
      const splitX = w * 0.56;
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(splitX, 10);
      ctx.lineTo(splitX, h - 10);
      ctx.stroke();

      const nSamples = 650;
      const drawCurve = (chName: string, col: string, lw: number) => {
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.beginPath();
        for (let i = 0; i < nSamples; i++) {
          const val = bank.latest(chName, nSamples - 1 - i);
          const x = 16 + (i / (nSamples - 1)) * (splitX - 32);
          const y = h - 24 - (val / 175) * (h - 54);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      drawCurve('pAo', '#C82829', 2.0); // P_Ao
      drawCurve('pLV', '#F5F0E6', 1.8); // P_LV
      drawCurve('pLA', '#2B6CB0', 1.4); // P_LA

      // PV Loop on the right
      const pvLeft = splitX + 24;
      const pvW = w - pvLeft - 24;
      // EDPVR curve highlighted in amber if HFpEF
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (let v = 25; v <= 165; v += 5) {
        const pEd = live.hemo.lvA * Math.expm1(live.hemo.lvB * Math.max(0, v - live.hemo.lvV0));
        const x = pvLeft + ((v - 20) / 160) * pvW;
        const y = h - 24 - (Math.min(165, pEd) / 175) * (h - 54);
        if (v === 25) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Active PV Loop
      ctx.strokeStyle = '#00E676';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (let i = 0; i < 480; i++) {
        const p = bank.latest('pLV', 480 - 1 - i);
        const v = bank.latest('vLV', 480 - 1 - i);
        const x = pvLeft + ((v - 20) / 160) * pvW;
        const y = h - 24 - (p / 175) * (h - 54);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Highlighted Pathology Callout
      ctx.fillStyle = 'rgba(200, 40, 41, 0.22)';
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(pvLeft + 10, h - 78, pvW - 20, 44);
      ctx.fillRect(pvLeft + 10, h - 78, pvW - 20, 44);
      ctx.fillStyle = '#F5F0E6';
      ctx.font = 'bold 11px JetBrains Mono, monospace';
      ctx.fillText(
        `GATILHO: PD2VE ${Math.round(live.hemo.lvedp)} mmHg · FEVE ${Math.round(live.hemo.lvef)}% · Ees ${live.hemo.lvEes.toFixed(2)}`,
        pvLeft + 18,
        h - 52,
      );
    } else if (view === 'pocus') {
      // Draws the E-FAST Window of Morison's pouch with the anechoic hemoperitoneum stripe highlighted
      const cx = w * 0.5;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, 12);
      ctx.arc(cx, 12, h - 24, Math.PI * 0.28, Math.PI * 0.72);
      ctx.closePath();
      ctx.fillStyle = '#111824';
      ctx.fill();
      ctx.clip();

      // Anterosuperior liver
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.ellipse(cx - 35, h * 0.42, 130, 52, 0.18, 0, Math.PI * 2);
      ctx.fill();

      // Posteroinferior right kidney
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx + 35, h * 0.68, 78, 36, 0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // ANECHOIC STRIPE IN MORISON'S POUCH (HEMOPERITONEUM HIGHLIGHTED!)
      ctx.fillStyle = '#020408';
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(cx - 75, h * 0.46);
      ctx.quadraticCurveTo(cx + 5, h * 0.54, cx + 88, h * 0.56);
      ctx.quadraticCurveTo(cx + 10, h * 0.63, cx - 75, h * 0.49);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Arrow and Highlight Label
      ctx.fillStyle = '#fca5a5';
      ctx.font = 'bold 12px JetBrains Mono, monospace';
      ctx.fillText(
        '⬅ FAIXA ANECOICA NO ESPAÇO DE MORISON (HEMOPERITÔNIO TRAUMÁTICO)',
        cx - 195,
        h - 14,
      );
    } else {
      // Draws the MPR Sectional Cut with the Netter Watercolor Highlight of Liver Segment VI and the IVC
      const cx = w * 0.5;
      const cy = h * 0.5;
      // Axial body contour
      ctx.fillStyle = '#161d2a';
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.34, h * 0.38, 0, 0, Math.PI * 2);
      ctx.fill();

      // Right Hepatic Lobe + Segment VI highlighted in Netter Watercolor
      ctx.fillStyle = 'rgba(189, 97, 66, 0.45)';
      ctx.beginPath();
      ctx.ellipse(cx - w * 0.14, cy + 8, w * 0.16, h * 0.24, -0.2, 0, Math.PI * 2);
      ctx.fill();

      // Posteroinferior Segment VI (pulsing highlight)
      const pulse = 0.65 + 0.25 * Math.sin(live.clock.t * 5);
      ctx.fillStyle = `rgba(210, 115, 62, ${pulse})`;
      ctx.strokeStyle = '#F5F0E6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx - w * 0.18, cy + h * 0.14, w * 0.08, h * 0.11, 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Inferior Vena Cava (IVC)
      ctx.fillStyle = 'rgba(43, 108, 176, 0.88)';
      ctx.strokeStyle = '#93c5fd';
      ctx.beginPath();
      ctx.arc(cx - w * 0.05, cy + h * 0.05, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Synchronized MPR crosshairs
      ctx.strokeStyle = 'rgba(0, 230, 118, 0.75)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.18, 16);
      ctx.lineTo(cx - w * 0.18, h - 16);
      ctx.moveTo(24, cy + h * 0.14);
      ctx.lineTo(w - 24, cy + h * 0.14);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#00E676';
      ctx.font = 'bold 11.5px JetBrains Mono, monospace';
      ctx.fillText(
        'DESTAQUE NETTER: Segmento VI de Couinaud (+68 HU) & VCI Supra-Hepática (+215 HU)',
        24,
        h - 12,
      );
    }
  });

  return (
    <div className="nc-spotlight-overlay">
      <div className="nc-spotlight-card">
        <div className="nc-spotlight-head">
          <div>
            <span className="nc-plate-tag phosphor">OVERLAY DE INSPEÇÃO FISIOPATOLÓGICA</span>
            <h4>{title}</h4>
          </div>
          <div className="btn-group">
            <button type="button" className="nc-layer-jump-btn" onClick={onOpenFullViewport}>
              <span>Abrir Módulo Interativo em Tela Cheia</span>
              <ArrowUpRight size={13} />
            </button>
            <button type="button" className="nc-inspector-close" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="nc-spotlight-canvas-wrap">
          <canvas ref={canvasRef} className="strip-canvas" style={{ height: 250 }} />
        </div>
        <p className="nc-spotlight-caption">
          <strong>Correlação Direta:</strong> {examCase.disss.deconstruction.imageOrSignalTrigger}
        </p>
      </div>
    </div>
  );
}
