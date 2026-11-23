import { usePhysiologyStore } from '../controller/usePhysiologyStore';

/**
 * Public-edition stub for PocusCraft.
 * Replaced automatically by `scripts/export-public.mjs` so the public snapshot
 * excludes `src/view/pocus/**` without altering store contracts or exam metadata.
 */
export const POCUS_ENABLED = false;

export function PocusViewport() {
  const activeExamCaseId = usePhysiologyStore((s) => s.activeExamCaseId);
  const exitExamMode = usePhysiologyStore((s) => s.exitExamMode);
  const setView = usePhysiologyStore((s) => s.setView);

  const handleBack = () => {
    if (activeExamCaseId !== null) {
      exitExamMode(false);
    } else {
      setView('hub');
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: '32px',
        textAlign: 'center',
        color: '#E5E7EB',
        background: '#0A0C10',
        gap: '14px',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          letterSpacing: '0.08em',
          color: '#3B82F6',
          border: '1px solid #1E3A8A',
          padding: '4px 10px',
        }}
      >
        POCUSCRAFT · EM BREVE
      </span>
      <h2 style={{ margin: 0, fontSize: '20px', color: '#FFFFFF' }}>
        Módulo PocusCraft indisponível nesta vitrine pública
      </h2>
      <p style={{ margin: 0, maxWidth: '460px', fontSize: '13px', color: '#9CA3AF', lineHeight: 1.5 }}>
        O foco atual da versão pública é o módulo CardioCraft. Os simuladores PocusCraft
        e as estações completas serão habilitados em versões futuras.
      </p>
      <button
        type="button"
        className="artcraft-open-btn"
        onClick={handleBack}
        style={{ marginTop: '8px', padding: '8px 18px' }}
      >
        Voltar ao Launcher
      </button>
    </div>
  );
}
