import { useState } from 'react';
import { usePhysiologyStore } from '../../controller/usePhysiologyStore';
import type { BundleBranchBlock, CoronaryTerritory, Rhythm } from '../../model/contracts/types';
import { AhaBullseye } from '../cardiac3d';
import { AuscultationControls } from '../auscultation';

type SectionTab = 'echo' | 'ecg' | 'drugs' | 'vent';

/**
 * Left Panel: Clinical Parameters (Echocardiogram Report, ECG/Ischemia,
 * Vasoactive Drugs, Mechanical Ventilation/PEEP and Semiological Auscultation).
 */
export function ClinicalPanel() {
  const [tab, setTab] = useState<SectionTab>('echo');
  const selectedSeg = usePhysiologyStore((s) => s.selectedSegment);
  const setSelectedSeg = usePhysiologyStore((s) => s.setSelectedSegment);

  const echo = usePhysiologyStore((s) => s.params.echo);
  const ecg = usePhysiologyStore((s) => s.params.ecg);
  const drugs = usePhysiologyStore((s) => s.params.drugs);
  const vent = usePhysiologyStore((s) => s.params.ventilation);
  const circ = usePhysiologyStore((s) => s.params.circulation);
  const patch = usePhysiologyStore((s) => s.patch);

  return (
    <aside className="clinical-panel">
      <div className="panel-tabs">
        <button
          type="button"
          className={`panel-tab ${tab === 'echo' ? 'active' : ''}`}
          onClick={() => setTab('echo')}
        >
          🫀 Eco &amp; Valvas
        </button>
        <button
          type="button"
          className={`panel-tab ${tab === 'ecg' ? 'active' : ''}`}
          onClick={() => setTab('ecg')}
        >
          ⚡ ECG &amp; Isquemia
        </button>
        <button
          type="button"
          className={`panel-tab ${tab === 'drugs' ? 'active' : ''}`}
          onClick={() => setTab('drugs')}
        >
          💊 Drogas &amp; Baro
        </button>
        <button
          type="button"
          className={`panel-tab ${tab === 'vent' ? 'active' : ''}`}
          onClick={() => setTab('vent')}
        >
          🫁 Vent &amp; Som
        </button>
      </div>

      <div className="panel-body">
        {tab === 'echo' && (
          <div className="param-section">
            <h3>Laudo de Ecocardiograma → Física</h3>

            <SliderField
              label="FEVE Alvo"
              unit="%"
              value={echo.lvef}
              min={15}
              max={78}
              step={1}
              warn={echo.lvef < 50}
              onChange={(v) => patch('echo', { lvef: v })}
            />
            <SliderField
              label="DDVE (Diâmetro Diastólico)"
              unit="mm"
              value={echo.lvedd}
              min={36}
              max={74}
              step={1}
              warn={echo.lvedd > 56}
              onChange={(v) => patch('echo', { lvedd: v })}
            />
            <SliderField
              label="DSVE (Diâmetro Sistólico)"
              unit="mm"
              value={echo.lvesd}
              min={22}
              max={62}
              step={1}
              warn={echo.lvesd > 40}
              onChange={(v) => patch('echo', { lvesd: v })}
            />
            <SliderField
              label="Espessura do Septo (SIV)"
              unit="mm"
              value={echo.septum}
              min={6}
              max={22}
              step={0.5}
              warn={echo.septum >= 12}
              onChange={(v) => patch('echo', { septum: v })}
            />
            <SliderField
              label="Parede Posterior (PP)"
              unit="mm"
              value={echo.posteriorWall}
              min={6}
              max={22}
              step={0.5}
              warn={echo.posteriorWall >= 12}
              onChange={(v) => patch('echo', { posteriorWall: v })}
            />

            <h3>Aparelhos Valvares (Gorlin / Bernoulli)</h3>
            <SliderField
              label="Valva Aórtica EOA (Estenose)"
              unit="cm²"
              value={echo.aorticEOA}
              min={0.4}
              max={4.0}
              step={0.1}
              warn={echo.aorticEOA < 1.5}
              onChange={(v) => patch('echo', { aorticEOA: v })}
            />
            <SliderField
              label="Valva Aórtica ROA (Insuf.)"
              unit="cm²"
              value={echo.aorticROA}
              min={0}
              max={0.6}
              step={0.02}
              warn={echo.aorticROA > 0.1}
              onChange={(v) => patch('echo', { aorticROA: v })}
            />
            <SliderField
              label="Valva Mitral EOA (Estenose)"
              unit="cm²"
              value={echo.mitralEOA}
              min={0.6}
              max={5.5}
              step={0.1}
              warn={echo.mitralEOA < 2.0}
              onChange={(v) => patch('echo', { mitralEOA: v })}
            />
            <SliderField
              label="Valva Mitral ROA (Insuf.)"
              unit="cm²"
              value={echo.mitralROA}
              min={0}
              max={0.7}
              step={0.02}
              warn={echo.mitralROA > 0.1}
              onChange={(v) => patch('echo', { mitralROA: v })}
            />

            <h3>Motilidade Segmentar (17 Segmentos AHA)</h3>
            <AhaBullseye selectedSegment={selectedSeg} onSelectSegment={setSelectedSeg} />
          </div>
        )}

        {tab === 'ecg' && (() => {
          const effectiveHr =
            ecg.rhythm === 'flutter' ? Math.round(300 / ecg.flutterConduction) : ecg.heartRate;
          const rrSec = 60 / Math.max(30, effectiveHr);
          const qtAbsMs = Math.round(ecg.qtc * Math.cbrt(rrSec) * 1000);
          const qtcFridMs = Math.round(ecg.qtc * 1000);
          const qtcBazettMs = Math.round(((qtAbsMs / 1000) / Math.sqrt(rrSec)) * 1000);

          return (
            <div className="param-section">
              <h3>Marca-Passo &amp; Escala Bazett/Fridericia</h3>
              <SliderField
                label={
                  ecg.rhythm === 'flutter'
                    ? `FC Ventricular (Flutter ${ecg.flutterConduction}:1)`
                    : ecg.rhythm === 'af'
                      ? 'FC Ventricular Média (FA)'
                      : 'FC Intrínseca (Sinusal)'
                }
                unit="bpm"
                value={effectiveHr}
                min={35}
                max={190}
                step={1}
                warn={effectiveHr < 50 || effectiveHr > 100}
                onChange={(v) => {
                  if (ecg.rhythm === 'flutter') {
                    // Synchronizes the nearest AV conduction or returns to manual command
                    const nearest: 2 | 3 | 4 = v >= 125 ? 2 : v >= 88 ? 3 : 4;
                    patch('ecg', { flutterConduction: nearest, heartRate: Math.round(300 / nearest) });
                  } else {
                    patch('ecg', { heartRate: v });
                  }
                }}
              />
              <SliderField
                label="QTc Alvo (Fridericia)"
                unit="ms"
                value={qtcFridMs}
                min={340}
                max={540}
                step={5}
                warn={ecg.qtc > 0.46 || qtcBazettMs > 460}
                onChange={(v) => patch('ecg', { qtc: v / 1000 })}
              />

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 6,
                  padding: '6px 8px',
                  marginBottom: 8,
                  borderRadius: 6,
                  background: 'rgba(15, 23, 42, 0.75)',
                  border: '1px solid rgba(56, 189, 248, 0.18)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono, monospace)',
                }}
              >
                <div>
                  <span style={{ color: '#94a3b8', display: 'block', fontSize: 9 }}>QT ABSOLUTO</span>
                  <strong style={{ color: '#e2e8f0' }}>{qtAbsMs} ms</strong>
                </div>
                <div>
                  <span style={{ color: '#94a3b8', display: 'block', fontSize: 9 }}>QTc FRIDERICIA</span>
                  <strong style={{ color: qtcFridMs > 460 ? '#f87171' : '#38bdf8' }}>
                    {qtcFridMs} ms
                  </strong>
                </div>
                <div>
                  <span style={{ color: '#94a3b8', display: 'block', fontSize: 9 }}>QTc BAZETT</span>
                  <strong style={{ color: qtcBazettMs > 460 ? '#fbbf24' : '#34d399' }}>
                    {qtcBazettMs} ms
                  </strong>
                </div>
              </div>

              <h3>Ritmo Supraventricular</h3>
              <div className="btn-grid">
                {(
                  [
                    ['sinus', 'Sinusal Normal'],
                    ['af', 'Fibrilação Atrial (FA)'],
                    ['flutter', 'Flutter Atrial (300/min)'],
                  ] as [Rhythm, string][]
                ).map(([id, lbl]) => (
                  <button
                    key={id}
                    type="button"
                    className={`btn-chip ${ecg.rhythm === id ? 'active' : ''}`}
                    onClick={() => {
                      if (id === 'flutter') {
                        patch('ecg', {
                          rhythm: 'flutter',
                          heartRate: Math.round(300 / ecg.flutterConduction),
                        });
                      } else if (id === 'sinus' && ecg.rhythm === 'flutter') {
                        patch('ecg', { rhythm: 'sinus', heartRate: 75 });
                      } else if (id === 'af' && ecg.rhythm !== 'af') {
                        patch('ecg', {
                          rhythm: 'af',
                          heartRate: ecg.heartRate < 95 ? 118 : ecg.heartRate,
                        });
                      } else {
                        patch('ecg', { rhythm: id });
                      }
                    }}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              {ecg.rhythm === 'flutter' && (
                <div className="sub-row">
                  <span>Condução AV do Flutter:</span>
                  <div className="btn-group">
                    {([2, 3, 4] as const).map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`btn-chip ${ecg.flutterConduction === n ? 'active' : ''}`}
                        onClick={() =>
                          patch('ecg', {
                            flutterConduction: n,
                            heartRate: Math.round(300 / n),
                          })
                        }
                      >
                        {n}:1 ({Math.round(300 / n)} bpm)
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <h3>Condução Intraventricular (Ramos His)</h3>
              <div className="btn-grid">
                {(
                  [
                    ['none', 'Normal (QRS Estreito)'],
                    ['lbbb', 'BRE (Bloqueio Ramo Esq.)'],
                    ['rbbb', 'BRD (Bloqueio Ramo Dir.)'],
                  ] as [BundleBranchBlock, string][]
                ).map(([id, lbl]) => (
                  <button
                    key={id}
                    type="button"
                    className={`btn-chip ${ecg.bundleBranchBlock === id ? 'active' : ''}`}
                    onClick={() => patch('ecg', { bundleBranchBlock: id })}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              <h3>Corrente de Lesão Coronária (ST-T)</h3>
              <div className="btn-grid">
                {(
                  [
                    ['none', 'Sem Isquemia Aguda'],
                    ['lad', 'Oclusão DA (Anterior)'],
                    ['lcx', 'Oclusão CX (Lateral)'],
                    ['rca', 'Oclusão CD (Inferior)'],
                  ] as [CoronaryTerritory, string][]
                ).map(([id, lbl]) => (
                  <button
                    key={id}
                    type="button"
                    className={`btn-chip ${ecg.ischemiaTerritory === id ? 'active' : ''}`}
                    onClick={() =>
                      patch('ecg', {
                        ischemiaTerritory: id,
                        ...(id !== 'none' && ecg.ischemiaTerritory === 'none'
                          ? { ischemiaTransmural: true }
                          : {}),
                      })
                    }
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              {ecg.ischemiaTerritory !== 'none' && (
                <div className="btn-group" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className={`btn-chip ${ecg.ischemiaTransmural ? 'active' : ''}`}
                    onClick={() => patch('ecg', { ischemiaTransmural: true })}
                  >
                    Transmural (Supra de ST + Espelho)
                  </button>
                  <button
                    type="button"
                    className={`btn-chip ${!ecg.ischemiaTransmural ? 'active' : ''}`}
                    onClick={() => patch('ecg', { ischemiaTransmural: false })}
                  >
                    Subendocárdica (Infra de ST)
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {tab === 'drugs' && (
          <div className="param-section">
            <h3>Infusão de Drogas Vasoativas &amp; Bolus</h3>
            <SliderField
              label="Noradrenalina (α1 >> β1)"
              unit="µg/kg/min"
              value={drugs.norepinephrine}
              min={0}
              max={1.0}
              step={0.02}
              warn={drugs.norepinephrine > 0}
              onChange={(v) => patch('drugs', { norepinephrine: v })}
            />
            <SliderField
              label="Dobutamina (β1 Inotrópico)"
              unit="µg/kg/min"
              value={drugs.dobutamine}
              min={0}
              max={20}
              step={0.5}
              warn={drugs.dobutamine > 0}
              onChange={(v) => patch('drugs', { dobutamine: v })}
            />
            <SliderField
              label="Nitroprussiato de Sódio"
              unit="µg/kg/min"
              value={drugs.nitroprusside}
              min={0}
              max={5}
              step={0.1}
              warn={drugs.nitroprusside > 0}
              onChange={(v) => patch('drugs', { nitroprusside: v })}
            />
            <SliderField
              label="Furosemida IV (Diurese/Venodil.)"
              unit="mg"
              value={drugs.furosemide}
              min={0}
              max={120}
              step={10}
              warn={drugs.furosemide > 0}
              onChange={(v) => patch('drugs', { furosemide: v })}
            />
            <SliderField
              label="Metoprolol IV (β-Bloqueador)"
              unit="mg"
              value={drugs.metoprolol}
              min={0}
              max={20}
              step={1}
              warn={drugs.metoprolol > 0}
              onChange={(v) => patch('drugs', { metoprolol: v })}
            />
            <button
              type="button"
              className="btn-chip"
              onClick={() =>
                patch('drugs', {
                  norepinephrine: 0,
                  dobutamine: 0,
                  nitroprusside: 0,
                  furosemide: 0,
                  metoprolol: 0,
                })
              }
            >
              Zerar Drogas
            </button>

            <h3>Volemia &amp; Alça de Barorreflexo</h3>
            <div className="btn-group" style={{ marginBottom: 8 }}>
              <button
                type="button"
                className={`btn-chip ${circ.baroreflex ? 'active' : ''}`}
                onClick={() => patch('circulation', { baroreflex: !circ.baroreflex })}
              >
                🧠 Barorreflexo Autonômico: {circ.baroreflex ? 'ATIVO' : 'DESLIGADO'}
              </button>
            </div>

            <SliderField
              label="Volume Sanguíneo Total"
              unit="mL"
              value={circ.bloodVolume}
              min={3600}
              max={6400}
              step={50}
              warn={circ.bloodVolume < 4500 || circ.bloodVolume > 5500}
              onChange={(v) => patch('circulation', { bloodVolume: v })}
            />
            <SliderField
              label="Tônus Vascular Basal (RVS)"
              unit="×"
              value={circ.svrScale}
              min={0.4}
              max={2.2}
              step={0.05}
              warn={circ.svrScale < 0.7 || circ.svrScale > 1.4}
              onChange={(v) => patch('circulation', { svrScale: v })}
            />
          </div>
        )}

        {tab === 'vent' && (
          <div className="param-section">
            <h3>Acoplamento Cardiopulmonar (Ppl &amp; VCI)</h3>
            <div className="btn-group" style={{ marginBottom: 8 }}>
              <button
                type="button"
                className={`btn-chip ${vent.mode === 'spontaneous' ? 'active' : ''}`}
                onClick={() => patch('ventilation', { mode: 'spontaneous' })}
              >
                Espontânea (Ppl Negativa)
              </button>
              <button
                type="button"
                className={`btn-chip ${vent.mode === 'mechanical' ? 'active' : ''}`}
                onClick={() => patch('ventilation', { mode: 'mechanical' })}
              >
                Ventilação Mecânica (PEEP+)
              </button>
            </div>

            <SliderField
              label="Frequência Respiratória"
              unit="irpm"
              value={vent.respRate}
              min={6}
              max={34}
              step={1}
              onChange={(v) => patch('ventilation', { respRate: v })}
            />

            {vent.mode === 'spontaneous' ? (
              <SliderField
                label="Esforço Inspiratório (ΔPpl)"
                unit="mmHg"
                value={vent.spontaneousEffort}
                min={1}
                max={12}
                step={0.5}
                onChange={(v) => patch('ventilation', { spontaneousEffort: v })}
              />
            ) : (
              <>
                <SliderField
                  label="PEEP"
                  unit="cmH₂O"
                  value={vent.peep}
                  min={0}
                  max={22}
                  step={1}
                  warn={vent.peep >= 12}
                  onChange={(v) => patch('ventilation', { peep: v })}
                />
                <SliderField
                  label="Driving Pressure (ΔPinsp)"
                  unit="cmH₂O"
                  value={vent.drivingPressure}
                  min={6}
                  max={26}
                  step={1}
                  onChange={(v) => patch('ventilation', { drivingPressure: v })}
                />
              </>
            )}

            <h3>Sintetizador de Ausculta Cardíaca</h3>
            <AuscultationControls />
          </div>
        )}
      </div>
    </aside>
  );
}

interface SliderFieldProps {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  warn?: boolean;
  onChange: (val: number) => void;
}

function SliderField({ label, unit, value, min, max, step, warn, onChange }: SliderFieldProps) {
  return (
    <div className={`slider-field ${warn ? 'warn' : ''}`}>
      <div className="slider-head">
        <span>{label}</span>
        <strong>
          {Number.isInteger(step) ? value : value.toFixed(step < 0.1 ? 2 : 1)} <small>{unit}</small>
        </strong>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}
