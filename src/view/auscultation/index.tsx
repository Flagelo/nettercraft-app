import { useEffect, useState } from 'react';
import { usePhysiologyStore } from '../../controller/usePhysiologyStore';
import type { AuscultationFocus, StethoscopePiece } from '../../model/auscultation/AuscultationSynth';
import { auscultationSynth } from '../../controller/modules/auscultationModule';

const FOCUS_LABELS: { id: AuscultationFocus; label: string; pos: string }[] = [
  { id: 'aortic', label: 'Aórtico', pos: '2º EIC Dir.' },
  { id: 'pulmonary', label: 'Pulmonar', pos: '2º EIC Esq.' },
  { id: 'tricuspid', label: 'Tricúspide', pos: '4º EIC Borda Est.' },
  { id: 'mitral', label: 'Mitral (Ictus)', pos: '5º EIC LHC' },
];

export function AuscultationControls() {
  const [, setTick] = useState(0);
  const echo = usePhysiologyStore((s) => s.params.echo);
  const ecg = usePhysiologyStore((s) => s.params.ecg);

  useEffect(() => auscultationSynth.subscribe(() => setTick((t) => t + 1)), []);

  // Automatic semiological summary based on the current physiology
  const findings: string[] = ['B1 normofonética'];
  if (ecg.bundleBranchBlock === 'lbbb' || echo.aorticEOA < 1.1) {
    findings.push('B2 com desdobramento PARADOXAL (P2 → A2)');
  } else if (ecg.bundleBranchBlock === 'rbbb') {
    findings.push('B2 com desdobramento AMPLO persistente');
  } else {
    findings.push('B2 com desdobramento fisiológico inspiratório');
  }
  if (echo.lvef < 42 || echo.lvedd >= 58 || echo.mitralROA >= 0.25) {
    findings.push('B3 (galope ventricular)');
  }
  if (ecg.rhythm === 'sinus' && (0.5 * (echo.septum + echo.posteriorWall) >= 12)) {
    findings.push('B4 (galope atrial pré-sistólico)');
  }
  if (echo.aorticEOA < 2.5) {
    findings.push(`Sopro sistólico ejetivo em diamante (EAo ${echo.aorticEOA.toFixed(1)} cm²)`);
  }
  if (echo.mitralROA > 0.05) {
    findings.push(`Sopro holossistólico regurgitativo (IM ROA ${echo.mitralROA.toFixed(2)} cm²)`);
  }
  if (echo.aorticROA > 0.05) {
    findings.push(`Sopro diastólico aspirativo decrescendo (IAo)`);
  }
  if (echo.mitralEOA < 2.5) {
    findings.push(`Ruflar diastólico mitral (EM ${echo.mitralEOA.toFixed(1)} cm²)`);
  }

  return (
    <div className="ausc-card">
      <div className="ausc-header">
        <button
          type="button"
          className={`btn-toggle ${auscultationSynth.enabled ? 'active' : ''}`}
          onClick={() => auscultationSynth.toggleEnabled()}
        >
          {auscultationSynth.enabled ? '🔊 Ausculta Ativa' : '🔇 Ativar Ausculta'}
        </button>
        <button
          type="button"
          className={`btn-toggle ${auscultationSynth.monitorBeepEnabled ? 'active' : ''}`}
          onClick={() => auscultationSynth.toggleMonitorBeep()}
          title="Ativa Bip de QRS modulado pela PAM e Alarme Clínico de UTI (PAM < 65 mmHg / PD2 ≥ 22 mmHg)"
        >
          {auscultationSynth.monitorBeepEnabled ? '🔔 Bip UTI Ativo' : '🔕 Bip Monitor UTI'}
        </button>
        <div className="ausc-piece-group">
          {(['diaphragm', 'bell'] as StethoscopePiece[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`btn-chip ${auscultationSynth.piece === p ? 'active' : ''}`}
              onClick={() => auscultationSynth.setPiece(p)}
            >
              {p === 'diaphragm' ? 'Diafragma' : 'Campânula (B3/B4)'}
            </button>
          ))}
        </div>
      </div>

      <div className="ausc-foci">
        {FOCUS_LABELS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`btn-focus ${auscultationSynth.focus === f.id ? 'active' : ''}`}
            onClick={() => auscultationSynth.setFocus(f.id)}
          >
            <span>{f.label}</span>
            <small>{f.pos}</small>
          </button>
        ))}
      </div>

      <div className="ausc-vol-row">
        <span>Volume</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.02}
          value={auscultationSynth.volume}
          onChange={(e) => auscultationSynth.setVolume(parseFloat(e.target.value))}
        />
        <span>{Math.round(auscultationSynth.volume * 100)}%</span>
      </div>

      <div className="ausc-findings">
        {findings.map((txt, i) => (
          <span key={i} className="finding-badge">
            {txt}
          </span>
        ))}
      </div>
    </div>
  );
}
