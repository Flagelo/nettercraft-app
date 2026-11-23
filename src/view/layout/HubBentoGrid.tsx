import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { CLINICAL_PRESETS } from '../../model/hemodynamics/clinicalPresets';
import {
  defaultParams,
  type PocusScenarioId,
  usePhysiologyStore,
  type ViewId,
} from '../../controller/usePhysiologyStore';
import { AHA_SEGMENT_TERRITORY, type WallMotionScore } from '../../model/contracts/types';
import { EXAM_CASES } from '../../model/exams/examCases';
import { POCUS_ENABLED } from '../pocusModule';

type FilterTabId = 'all' | 'simulators' | 'exams' | 'presets';
type SortMode = 'suite' | 'alpha' | 'module';

interface DropdownAction {
  label: string;
  tag: string;
  onSelect: () => void;
}

interface ModuleCardSpec {
  num: '01' | '02' | '03' | '04';
  id: ViewId;
  category: 'simulator' | 'exam';
  color: string;
  prefix: string;
  subtitle: string;
  badges: [string, string];
  versionLine: string;
  guidelineLabel: string;
  docsLabel: string;
  keywords: string;
  actions: DropdownAction[];
}

/**
 * ArtCraft Launcher ('Industrial Technical Brutalism' — 100vw x 100vh):
 * Replaces the old Hub Bento Grid with a modular suite of square corners (0px),
 * Frank H. Netter-style anatomical thumbnail (#F5F0E6) on each card and dropdown [...] menus
 * for immediate triggering of pathophysiological states.
 */
export function HubBentoGrid() {
  const loadPreset = usePhysiologyStore((s) => s.loadPreset);
  const setView = usePhysiologyStore((s) => s.setView);
  const setPocusScenario = usePhysiologyStore((s) => s.setPocusScenario);
  const setRadiologyWindow = usePhysiologyStore((s) => s.setRadiologyWindow);
  const startExamCase = usePhysiologyStore((s) => s.startExamCase);

  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [filterTab, setFilterTab] = useState<FilterTabId>('all');
  const [sortMode, setSortMode] = useState<SortMode>('suite');
  const [searchQuery, setSearchQuery] = useState('');
  const [openMenuCard, setOpenMenuCard] = useState<string | null>(null);
  const [infoModal, setInfoModal] = useState<{ title: string; body: string } | null>(null);

  // Closes the dropdown [...] menu when clicking outside
  useEffect(() => {
    const onWinClick = () => setOpenMenuCard(null);
    window.addEventListener('click', onWinClick);
    return () => window.removeEventListener('click', onWinClick);
  }, []);

  // CardioCraft quick presets
  const launchCardioPreset = (
    presetKey: 'normal' | 'hfref25' | 'hfpef' | 'aortic_stenosis' | 'stemi_lad' | 'bbb',
  ) => {
    const p = defaultParams();
    if (presetKey === 'hfref25') {
      p.echo.lvef = 25;
      p.echo.lvedd = 66;
      p.echo.lvesd = 56;
      p.echo.wallMotion = Array.from({ length: 17 }, () => 2 as WallMotionScore);
      p.ecg.heartRate = 96;
    } else if (presetKey === 'hfpef') {
      p.echo.lvef = 62;
      p.echo.septum = 15;
      p.echo.posteriorWall = 14;
      p.echo.lvedd = 45;
      p.echo.lvesd = 28;
    } else if (presetKey === 'aortic_stenosis') {
      p.echo.aorticEOA = 0.7;
      p.echo.septum = 14;
      p.echo.posteriorWall = 13;
      p.echo.lvef = 58;
    } else if (presetKey === 'stemi_lad') {
      p.echo.lvef = 36;
      p.echo.wallMotion = AHA_SEGMENT_TERRITORY.map((t) => (t === 'lad' ? 3 : 1));
      p.echo.wallMotion[16] = 4;
      p.ecg.ischemiaTerritory = 'lad';
      p.ecg.ischemiaTransmural = true;
      p.ecg.heartRate = 92;
    } else if (presetKey === 'bbb') {
      p.ecg.bundleBranchBlock = 'lbbb';
    }
    loadPreset(p);
    setView('cardio');
  };

  // PocusCraft quick presets
  const launchPocusScenario = (scenario: PocusScenarioId) => {
    if (!POCUS_ENABLED) return;
    setPocusScenario(scenario);
    setView('pocus');
  };

  const visibleExamCases = POCUS_ENABLED
    ? EXAM_CASES
    : EXAM_CASES.filter((ec) => ec.targetView !== 'pocus');

  const allModules: ModuleCardSpec[] = [
    {
      num: '01',
      id: 'cardio',
      category: 'simulator',
      color: '#FF5733',
      prefix: 'Cardio',
      subtitle: 'Eletromecânica 3D 17-AHA, Wiggers & ECG 12D',
      badges: ['INSTALADO', 'CALIBRADO RK4'],
      versionLine: 'Versão 2.4.0 · Motor Fisiológico 60 FPS',
      guidelineLabel: 'DIRETRIZ SBC ↗',
      docsLabel: 'DOCS ↗',
      keywords: 'cardiocraft coracao 3d wiggers pv loop ecg 12d dower icfer icfep iam bre brd',
      actions: [
        {
          label: 'Fisiologia Normal',
          tag: 'FEVE 60%',
          onSelect: () => launchCardioPreset('normal'),
        },
        {
          label: 'ICFER (FEVE 25%)',
          tag: 'DDVE 66mm',
          onSelect: () => launchCardioPreset('hfref25'),
        },
        {
          label: 'ICFEP (Hipertrofia)',
          tag: 'PD2 ↑↑ · B4',
          onSelect: () => launchCardioPreset('hfpef'),
        },
        {
          label: 'Estenose Aórtica Grave',
          tag: 'EOA 0.7cm²',
          onSelect: () => launchCardioPreset('aortic_stenosis'),
        },
        {
          label: 'IAM Anterior (DA)',
          tag: 'Supra V1-V4',
          onSelect: () => launchCardioPreset('stemi_lad'),
        },
        {
          label: 'BRE / BRD',
          tag: 'QRS ≥ 130ms',
          onSelect: () => launchCardioPreset('bbb'),
        },
      ],
    },
    {
      num: '02',
      id: 'pocus',
      category: 'simulator',
      color: '#3B82F6',
      prefix: 'Pocus',
      subtitle: 'Ultrassonografia point-of-care, punção & Doppler',
      badges: ['INSTALADO', 'CALIBRADO RK4'],
      versionLine: 'Versão 2.4.0 · Motor Fisiológico 60 FPS',
      guidelineLabel: 'DIRETRIZ ATLS ↗',
      docsLabel: 'DOCS ↗',
      keywords: 'pocuscraft ultrassom acesso venoso jugular carotida doppler plax vci fast morison',
      actions: [
        {
          label: 'Acesso Venoso Cervical (VJI)',
          tag: 'Linear 10MHz',
          onSelect: () => launchPocusScenario('vascular'),
        },
        {
          label: 'Eco POCUS (PLAX)',
          tag: 'Setorial',
          onSelect: () => launchPocusScenario('echo_plax'),
        },
        {
          label: 'Veia Cava Inferior (VCI)',
          tag: 'Subcostal',
          onSelect: () => launchPocusScenario('ivc'),
        },
        {
          label: 'E-FAST Trauma (Morison)',
          tag: 'Convexo 3.5MHz',
          onSelect: () => launchPocusScenario('fast_morison'),
        },
      ],
    },
    {
      num: '03',
      id: 'radiology',
      category: 'simulator',
      color: '#10B981',
      prefix: 'Radio',
      subtitle: 'Slicer MPR DICOM/NIfTI, Hounsfield & Raymarching',
      badges: ['INSTALADO', 'CALIBRADO RK4'],
      versionLine: 'Versão 2.4.0 · Motor Fisiológico 60 FPS',
      guidelineLabel: 'ACR / COUINAUD ↗',
      docsLabel: 'DOCS ↗',
      keywords: 'radiocraft tomografia dicom nifti mpr hounsfield raymarching figado couinaud neuro',
      actions: [
        {
          label: 'Phantom Angio-TC Tórax/Fígado',
          tag: 'W:350 L:50',
          onSelect: () => {
            setRadiologyWindow(350, 50, 0);
            setView('radiology');
          },
        },
        {
          label: 'Phantom Neuro TC/RM',
          tag: 'W:80 L:40',
          onSelect: () => {
            setRadiologyWindow(80, 40, 0);
            setView('radiology');
          },
        },
        {
          label: 'Importar Arquivo NIfTI (.nii.gz)',
          tag: 'WEBGL2 3D',
          onSelect: () => setView('radiology'),
        },
      ],
    },
    {
      num: '04',
      id: 'exam_mode',
      category: 'exam',
      color: '#F59E0B',
      prefix: 'Exam',
      subtitle: 'Simulados práticos ENARE & SES-PE (DiSSS Recall)',
      badges: ['INSTALADO', `${visibleExamCases.length} ESTAÇÕES ATIVAS`],
      versionLine: 'Versão 2.4.0 · Motor Fisiológico 60 FPS',
      guidelineLabel: 'ENARE / SES-PE ↗',
      docsLabel: 'DOCS ↗',
      keywords: 'examcraft provas residencia enare ses-pe trauma cardiologia disss recall',
      actions: visibleExamCases.map((ec) => ({
        label: ec.title,
        tag: ec.board,
        onSelect: () =>
          startExamCase({
            caseId: ec.id,
            targetView: ec.targetView,
            allowedSliders: ec.allowedSliders,
            params: ec.initialParams,
            pocusScenario: ec.pocusScenario,
            radiologyNiftiUrl: ec.radiologyNiftiUrl,
            radiologyWw: ec.radiologyWw,
            radiologyWl: ec.radiologyWl,
          }),
      })),
    },
  ];

  const modules = POCUS_ENABLED
    ? allModules
    : allModules.filter((m) => m.id !== 'pocus');

  const qNorm = searchQuery.trim().toLowerCase();

  const filteredModules = modules
    .filter((m) => {
      if (filterTab === 'simulators' && m.category !== 'simulator') return false;
      if (filterTab === 'exams' && m.category !== 'exam') return false;
      if (!qNorm) return true;
      return (
        m.prefix.toLowerCase().includes(qNorm) ||
        m.subtitle.toLowerCase().includes(qNorm) ||
        m.keywords.includes(qNorm)
      );
    })
    .sort((a, b) => {
      if (sortMode === 'alpha') return a.prefix.localeCompare(b.prefix);
      if (sortMode === 'module') return b.num.localeCompare(a.num);
      return a.num.localeCompare(b.num);
    });

  const filteredPresets = CLINICAL_PRESETS.filter((pr) => {
    if (!qNorm) return true;
    return (
      pr.label.toLowerCase().includes(qNorm) || pr.summary.toLowerCase().includes(qNorm)
    );
  });

  return (
    <div className="artcraft-launcher">
      {/* 1. TOP BAR 1: LAUNCHER TITLEBAR (height: 44px) */}
      <header className="artcraft-titlebar">
        <div className="artcraft-titlebar-left">
          <span className="artcraft-logo">NETTERCRAFT</span>
          <span className="artcraft-launcher-badge">LAUNCHER</span>
          <span className="artcraft-suite-sub">CLINICAL SIMULATION SUITE</span>
        </div>

        <div className="artcraft-titlebar-right">
          <div className="artcraft-view-switch" role="group" aria-label="Modo de visualização">
            <button
              type="button"
              className={`artcraft-view-btn ${viewMode === 'cards' ? 'active' : ''}`}
              onClick={() => setViewMode('cards')}
            >
              CARDS
            </button>
            <button
              type="button"
              className={`artcraft-view-btn ${viewMode === 'table' ? 'active' : ''}`}
              onClick={() => setViewMode('table')}
            >
              TABELA
            </button>
          </div>

          <div className="artcraft-status-indicator">
            <span className="artcraft-status-dot" />
            <span>WEBGL2 · RK4 ATIVO</span>
          </div>
        </div>
      </header>

      {/* 2. TOP BAR 2: FILTER AND SEARCH SUB-BAR (height: 48px) */}
      <div className="artcraft-subbar">
        <div className="artcraft-filter-tabs">
          <button
            type="button"
            className={`artcraft-filter-tab ${filterTab === 'all' ? 'active' : ''}`}
            onClick={() => setFilterTab('all')}
          >
            <span>TODOS</span>
            <span className="artcraft-filter-count">{modules.length}</span>
          </button>
          <button
            type="button"
            className={`artcraft-filter-tab ${filterTab === 'simulators' ? 'active' : ''}`}
            onClick={() => setFilterTab('simulators')}
          >
            <span>SIMULADORES</span>
            <span className="artcraft-filter-count">
              {modules.filter((m) => m.category === 'simulator').length}
            </span>
          </button>
          <button
            type="button"
            className={`artcraft-filter-tab ${filterTab === 'exams' ? 'active' : ''}`}
            onClick={() => setFilterTab('exams')}
          >
            <span>PROVAS &amp; CASOS</span>
            <span className="artcraft-filter-count">
              {modules.filter((m) => m.category === 'exam').length}
            </span>
          </button>
          <button
            type="button"
            className={`artcraft-filter-tab ${filterTab === 'presets' ? 'active' : ''}`}
            onClick={() => setFilterTab('presets')}
          >
            <span>PRESETS CLÍNICOS</span>
            <span className="artcraft-filter-count">{CLINICAL_PRESETS.length}</span>
          </button>
        </div>

        <div className="artcraft-subbar-right">
          <div className="artcraft-sort-box">
            <span>ORDENAR</span>
            <select
              className="artcraft-sort-select"
              aria-label="Ordenar módulos"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
            >
              <option value="suite">Ordem da suíte ▾</option>
              <option value="alpha">Ordem alfabética (A–Z)</option>
              <option value="module">Ordem reversa (04–01)</option>
            </select>
          </div>

          <div className="artcraft-search-box">
            <Search size={13} />
            <input
              type="text"
              className="artcraft-search-input"
              placeholder="Buscar módulos ou patologias..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* 3. CENTRAL CONTENT: 3-COLUMN GRID OF ARTCRAFT CARDS (or Presets / Table) */}
      <main className="artcraft-main">
        {filterTab === 'presets' ? (
          <div className="artcraft-presets-grid">
            {filteredPresets.map((pr, idx) => (
              <div key={pr.id} className="artcraft-preset-card">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    borderBottom: '1px solid #262626',
                    paddingBottom: 6,
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#FF5733',
                    }}
                  >
                    PRESET #{String(idx + 1).padStart(2, '0')}
                  </span>
                  <span className="artcraft-status-badge">PRONTO RK4</span>
                </div>
                <strong style={{ fontSize: 15, color: '#FFFFFF' }}>{pr.label}</strong>
                <p style={{ fontSize: 12, color: '#8E8E93', lineHeight: 1.4 }}>{pr.summary}</p>
                <button
                  type="button"
                  className="artcraft-open-btn"
                  style={{ marginTop: 6 }}
                  onClick={() => {
                    loadPreset(pr.build());
                    setView('cardio');
                  }}
                >
                  APLICAR &amp; ABRIR CARDIOCRAFT
                </button>
              </div>
            ))}
          </div>
        ) : viewMode === 'table' ? (
          <div className="artcraft-table-wrap">
            <table className="artcraft-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>MÓDULO</th>
                  <th>DESCRIÇÃO TÉCNICA</th>
                  <th>STATUS</th>
                  <th>VERSÃO</th>
                  <th>AÇÃO</th>
                </tr>
              </thead>
              <tbody>
                {filteredModules.map((mod) => (
                  <tr key={mod.num}>
                    <td>
                      <span
                        className="artcraft-card-num"
                        style={{ backgroundColor: mod.color, width: 28, height: 28 }}
                      >
                        {mod.num}
                      </span>
                    </td>
                    <td>
                      <strong style={{ fontSize: 15 }}>
                        <span style={{ color: mod.color }}>{mod.prefix}</span>
                        <span style={{ color: '#FFFFFF' }}>Craft</span>
                      </strong>
                    </td>
                    <td style={{ color: '#8E8E93', fontSize: 13 }}>{mod.subtitle}</td>
                    <td>
                      <div className="artcraft-badge-row">
                        <span className="artcraft-status-badge">{mod.badges[0]}</span>
                        <span className="artcraft-status-badge">{mod.badges[1]}</span>
                      </div>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#8E8E93' }}>
                      2.4.0 (60 FPS)
                    </td>
                    <td>
                      <button
                        type="button"
                        className="artcraft-open-btn"
                        style={{ height: 30, padding: '0 14px' }}
                        onClick={() => setView(mod.id)}
                      >
                        ABRIR
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="artcraft-grid">
            {filteredModules.map((mod) => {
              const isDropdownOpen = openMenuCard === mod.num;
              return (
                <article key={mod.num} className="artcraft-card">
                  {/* TIER 1: Card Header (36px) */}
                  <div className="artcraft-card-header">
                    <span
                      className="artcraft-card-num"
                      style={{ backgroundColor: mod.color }}
                    >
                      {mod.num}
                    </span>

                    <div className="artcraft-card-links">
                      <button
                        type="button"
                        className="artcraft-card-link"
                        onClick={() =>
                          setInfoModal({
                            title: `${mod.prefix}Craft — Referencial Clínico (${mod.guidelineLabel.replace(' ↗', '')})`,
                            body: `Módulo ${mod.num} (${mod.prefix}Craft) calibrado segundo as diretrizes vigentes (SBC / AHA / ASE / ATLS 10ª Ed / ACR) e integrado em malha fechada ao Solver Cardiovascular 0D Runge-Kutta de 4ª ordem (h = 1 ms).`,
                          })
                        }
                      >
                        {mod.guidelineLabel}
                      </button>
                      <button
                        type="button"
                        className="artcraft-card-link"
                        onClick={() =>
                          setInfoModal({
                            title: `Documentação de Engenharia — ${mod.prefix}Craft`,
                            body: `${mod.subtitle}. ${mod.versionLine}. Clique em ABRIR para iniciar a estação dedicata em tela cheia ou use o botão [...] para carregar um preset clínico instantaneamente.`,
                          })
                        }
                      >
                        {mod.docsLabel}
                      </button>
                    </div>
                  </div>

                  {/* TIER 2: Identity + Netter-Style Illustration (padding: 20px) */}
                  <div className="artcraft-card-identity">
                    <div className="artcraft-netter-thumb">
                      <NetterEngravingThumb moduleNum={mod.num} />
                    </div>

                    <div className="artcraft-card-titles">
                      <h2 className="artcraft-card-title">
                        <span style={{ color: mod.color }}>{mod.prefix}</span>
                        <span style={{ color: '#FFFFFF' }}>Craft</span>
                      </h2>
                      <p className="artcraft-card-subtitle">{mod.subtitle}</p>
                    </div>
                  </div>

                  {/* TIER 3: Status Badges and Metadata (padding: 0 20px 16px) */}
                  <div className="artcraft-card-meta">
                    <div className="artcraft-badge-row">
                      <span className="artcraft-status-badge">{mod.badges[0]}</span>
                      <span className="artcraft-status-badge">{mod.badges[1]}</span>
                    </div>
                    <div className="artcraft-version-line">{mod.versionLine}</div>
                  </div>

                  {/* TIER 4: Action Footer (padding: 0 20px 20px; display: flex; gap: 8px) */}
                  <div className="artcraft-card-actions">
                    <button
                      type="button"
                      className="artcraft-open-btn"
                      onClick={() => setView(mod.id)}
                    >
                      ABRIR
                    </button>

                    <button
                      type="button"
                      className={`artcraft-more-btn ${isDropdownOpen ? 'active' : ''}`}
                      aria-label={`Presets rápidos de ${mod.prefix}Craft`}
                      title="Presets Rápidos do Módulo"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuCard((prev) => (prev === mod.num ? null : mod.num));
                      }}
                    >
                      ...
                    </button>

                    {isDropdownOpen && (
                      <div
                        className="artcraft-dropdown"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="artcraft-dropdown-header">
                          PRESETS RÁPIDOS · {mod.prefix.toUpperCase()}CRAFT
                        </div>
                        {mod.actions.map((act) => (
                          <button
                            key={act.label}
                            type="button"
                            className="artcraft-dropdown-item"
                            onClick={() => {
                              setOpenMenuCard(null);
                              act.onSelect();
                            }}
                          >
                            <span>{act.label}</span>
                            <small style={{ color: mod.color, fontWeight: 700 }}>
                              {act.tag}
                            </small>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {/* Square Informational Modal for GUIDELINE / DOCS */}
      {infoModal && (
        <div
          className="nc-exam-modal-backdrop"
          onClick={() => setInfoModal(null)}
        >
          <div
            className="nc-exam-modal"
            style={{ maxWidth: 520, padding: 20, background: '#121212', border: '1px solid #444' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                borderBottom: '1px solid #262626',
                paddingBottom: 10,
                marginBottom: 12,
              }}
            >
              <strong style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#FFF' }}>
                {infoModal.title}
              </strong>
              <button
                type="button"
                className="nc-panel-collapse-btn"
                onClick={() => setInfoModal(null)}
              >
                ✕
              </button>
            </div>
            <p style={{ fontSize: 13, color: '#CCCCCC', lineHeight: 1.55 }}>{infoModal.body}</p>
          </div>
        </div>
      )}

      {/* 4. LAUNCHER FIXED FOOTER BAR (height: 32px) */}
      <footer className="artcraft-footerbar">
        <span>SOLVER RK4 (H = 1MS) · VERIFICADO · ZERO RE-RENDERS</span>
        <span>DIRETRIZES SBC · ATLS 10ª ED · ENARE / SES-PE · BUILD 2026</span>
      </footer>
    </div>
  );
}

/**
 * Square Artistic Thumbnail (68x68px, Anatomical Parchment #F5F0E6 background):
 * Vector medical engraving in the style of Frank H. Netter (fine india-ink line + anatomical watercolor)
 * specific to each of the 4 modules.
 */
function NetterEngravingThumb({ moduleNum }: { moduleNum: '01' | '02' | '03' | '04' }) {
  if (moduleNum === '01') {
    // 01: Heart, Aortic Arch and Coronary Arteries (LAD, LCX, RCA)
    return (
      <svg width="68" height="68" viewBox="0 0 68 68" aria-hidden="true">
        <rect width="68" height="68" fill="#F5F0E6" />
        {/* Classic plate frame */}
        <rect x="3" y="3" width="62" height="62" fill="none" stroke="#8C7A6B" strokeWidth="0.7" />
        {/* Superior Vena Cava (Cobalt Blue) */}
        <path
          d="M20 11 C20 19, 21 24, 21 29 L26 29 C26 24, 26 19, 25 11 Z"
          fill="#4A7BB7"
          stroke="#1E1815"
          strokeWidth="1.1"
        />
        {/* Aortic Arch and Supra-aortic Branches (Arterial Crimson) */}
        <path
          d="M31 28 C30 16, 42 13, 46 21 C48 25, 46 31, 43 33 L38 30 C40 27, 40 22, 36 21 C34 21, 34 25, 35 28 Z"
          fill="#C83E3B"
          stroke="#1E1815"
          strokeWidth="1.1"
        />
        <path d="M35 15 L34 9 M39 14 L40 8 M43 16 L45 10" stroke="#1E1815" strokeWidth="1.2" />
        {/* Biventricular Ventricular Cone (Myocardial Watercolor) */}
        <path
          d="M21 27 C14 31, 14 44, 23 53 C30 59, 41 61, 46 56 C52 49, 53 35, 44 28 C38 24, 27 24, 21 27 Z"
          fill="#D45B53"
          stroke="#1E1815"
          strokeWidth="1.25"
        />
        {/* Netter Engraving Hatched Shading */}
        <path
          d="M27 54 C34 57, 41 57, 45 53"
          fill="none"
          stroke="#7A2021"
          strokeWidth="1.5"
        />
        {/* Left Anterior Descending (LAD) and Circumflex (LCX) Coronary Arteries */}
        <path
          d="M35 28 C34 36, 36 45, 42 56 M35 31 C41 33, 46 36, 49 41 M34 38 L28 43 M36 44 L31 49"
          fill="none"
          stroke="#8B1113"
          strokeWidth="1.35"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (moduleNum === '02') {
    // 02: Cervical Neurovascular Bundle (IJV, Carotid and SCM) + Acoustic Beam
    return (
      <svg width="68" height="68" viewBox="0 0 68 68" aria-hidden="true">
        <rect width="68" height="68" fill="#F5F0E6" />
        <rect x="3" y="3" width="62" height="62" fill="none" stroke="#8C7A6B" strokeWidth="0.7" />
        {/* Translucent Acoustic Beam of the Linear Transducer */}
        <polygon
          points="18,12 50,12 58,60 10,60"
          fill="rgba(59, 130, 246, 0.16)"
          stroke="#3B82F6"
          strokeWidth="0.9"
          strokeDasharray="2 2"
        />
        {/* Linear Transducer at the Top */}
        <rect x="17" y="7" width="34" height="6" fill="#2A2E35" stroke="#1E1815" strokeWidth="1.1" />
        {/* Sternocleidomastoid Muscle (SCM) */}
        <path
          d="M10 19 Q34 15 58 21 L56 27 Q34 22 12 26 Z"
          fill="#C96A5B"
          stroke="#1E1815"
          strokeWidth="1"
        />
        {/* Common Carotid Artery (Medial, Circular and Thick Wall) */}
        <circle cx="24" cy="42" r="8.5" fill="#C82829" stroke="#1E1815" strokeWidth="1.25" />
        <circle cx="24" cy="42" r="5.2" fill="#6E1114" stroke="#1E1815" strokeWidth="0.8" />
        {/* Internal Jugular Vein (Lateral, Elliptical and Thin Wall) */}
        <ellipse cx="44" cy="41" rx="10.5" ry="7.2" fill="#2B6CB0" stroke="#1E1815" strokeWidth="1.2" />
        <ellipse cx="44" cy="41" rx="8.8" ry="5.6" fill="#173D6E" />
        {/* Vagus Nerve (Cranial Nerve X) in the Posterior Groove */}
        <circle cx="33.5" cy="49" r="2.3" fill="#EAB308" stroke="#1E1815" strokeWidth="0.9" />
        {/* 18G Metal Needle + Hyperechoic Dot */}
        <line x1="54" y1="14" x2="44" y2="40" stroke="#1E1815" strokeWidth="1.6" />
        <circle cx="44" cy="40" r="2" fill="#FFFFFF" stroke="#1E1815" strokeWidth="0.8" />
      </svg>
    );
  }

  if (moduleNum === '03') {
    // 03: Couinaud Hepatic Segments and Axial Tomographic Slice + MPR Crosshair
    return (
      <svg width="68" height="68" viewBox="0 0 68 68" aria-hidden="true">
        <rect width="68" height="68" fill="#F5F0E6" />
        <rect x="3" y="3" width="62" height="62" fill="none" stroke="#8C7A6B" strokeWidth="0.7" />
        {/* Thoracoabdominal Axial Outline */}
        <ellipse
          cx="34"
          cy="36"
          rx="26"
          ry="20"
          fill="#E5D8C5"
          stroke="#1E1815"
          strokeWidth="1.2"
        />
        {/* Liver (Right Lobe / Couinaud Segments V, VI, VII, VIII) */}
        <path
          d="M11 32 C11 21, 26 19, 36 24 C40 26, 42 32, 34 38 C25 44, 12 45, 11 32 Z"
          fill="#A64B3C"
          stroke="#1E1815"
          strokeWidth="1.2"
        />
        {/* Couinaud Portal/Venular Divisions */}
        <path
          d="M16 30 L32 31 M23 23 L24 39"
          stroke="#3B82F6"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
        {/* Vertebral Body + Posterior Spinal Canal */}
        <circle cx="34" cy="48" r="4.8" fill="#FAF6EE" stroke="#1E1815" strokeWidth="1.1" />
        {/* Abdominal Aorta (Red) & IVC (Blue) */}
        <circle cx="37" cy="40" r="3" fill="#C82829" stroke="#1E1815" strokeWidth="1" />
        <circle cx="29" cy="39" r="3.2" fill="#2B6CB0" stroke="#1E1815" strokeWidth="1" />
        {/* Contralateral Spleen */}
        <path
          d="M49 34 C56 32, 57 44, 50 47 C46 48, 45 38, 49 34 Z"
          fill="#7C3AED"
          stroke="#1E1815"
          strokeWidth="1"
        />
        {/* Orthogonal MPR Crosshairs */}
        <line x1="6" y1="31" x2="62" y2="31" stroke="#10B981" strokeWidth="0.9" strokeDasharray="3 2" />
        <line x1="24" y1="8" x2="24" y2="60" stroke="#10B981" strokeWidth="0.9" strokeDasharray="3 2" />
      </svg>
    );
  }

  // 04: Classic Stethoscope and Surgical Scalpel Crossed over Academic Plate
  return (
    <svg width="68" height="68" viewBox="0 0 68 68" aria-hidden="true">
      <rect width="68" height="68" fill="#F5F0E6" />
      <rect x="3" y="3" width="62" height="62" fill="none" stroke="#8C7A6B" strokeWidth="0.7" />
      {/* Background Anatomical Plate */}
      <rect
        x="14"
        y="10"
        width="40"
        height="48"
        fill="#EFE6D5"
        stroke="#1E1815"
        strokeWidth="1.1"
      />
      <line x1="20" y1="18" x2="48" y2="18" stroke="#8C7A6B" strokeWidth="1" />
      <line x1="20" y1="24" x2="44" y2="24" stroke="#8C7A6B" strokeWidth="1" />
      {/* Stylized ECG Trace in Crimson on the Plate */}
      <polyline
        points="18,34 25,34 28,27 31,42 34,22 37,38 40,32 49,32"
        fill="none"
        stroke="#C82829"
        strokeWidth="1.5"
      />
      {/* Diagonal Surgical Scalpel */}
      <path
        d="M16 52 L42 26 L46 30 L20 56 Z"
        fill="#94A3B8"
        stroke="#1E1815"
        strokeWidth="1.1"
      />
      <path d="M42 26 L52 16 L49 29 Z" fill="#E2E8F0" stroke="#1E1815" strokeWidth="1.1" />
      {/* Stethoscope Chestpiece */}
      <circle cx="43" cy="46" r="7" fill="#D97706" stroke="#1E1815" strokeWidth="1.2" />
      <circle cx="43" cy="46" r="3.5" fill="#FEF3C7" stroke="#1E1815" strokeWidth="0.9" />
    </svg>
  );
}
