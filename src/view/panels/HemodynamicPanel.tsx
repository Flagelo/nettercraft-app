import { useState } from 'react';
import { WiggersView, PVLoopView } from '../hemodynamics';
import { Ecg12View } from '../ecg';

type HemoTabId = 'hemo' | 'ecg' | 'combined';

interface HemodynamicPanelProps {
  ecgWideMode?: boolean;
  onToggleEcgWide?: () => void;
}

/**
  * Right Panel of CardioCraft (60 FPS on HTML5 Canvas 2D — ArtCraft Standard):
  * Replaces the long vertical scroll with 3 Straight Tabs at the Top of the Right Panel:
  *  - Tab 1: HEMODYNAMICS (WIGGERS + PV LOOP) — large, no need to scroll
  *  - Tab 2: 12-LEAD ECG (MILLIMETER PAPER) — wide screen + horizontal expand button
  *  - Tab 3: COMBINED VIEW (COMPACT)
 */
export function HemodynamicPanel({
  ecgWideMode = false,
  onToggleEcgWide,
}: HemodynamicPanelProps = {}) {
  const [activeTab, setActiveTab] = useState<HemoTabId>('hemo');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="hemo-tabs-bar" role="tablist" aria-label="Abas do Monitor Multiparamétrico">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'hemo'}
          className={`hemo-tab-btn ${activeTab === 'hemo' ? 'active' : ''}`}
          onClick={() => setActiveTab('hemo')}
        >
          HEMODINÂMICA (WIGGERS + PV)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'ecg'}
          className={`hemo-tab-btn ${activeTab === 'ecg' ? 'active' : ''}`}
          onClick={() => setActiveTab('ecg')}
        >
          ECG 12 DERIVAÇÕES
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'combined'}
          className={`hemo-tab-btn ${activeTab === 'combined' ? 'active' : ''}`}
          onClick={() => setActiveTab('combined')}
        >
          VISÃO COMBINADA
        </button>
      </div>

      <section className="hemo-panel">
        {activeTab === 'hemo' && (
          <>
            <div className="hemo-card">
              <div className="subpanel-header">
                <span>DIAGRAMA DE WIGGERS (AO / VE / AE · VOLUME · ECG · FONO)</span>
                <small>RK4 · H = 1 MS</small>
              </div>
              <WiggersView height={270} />
            </div>

            <div className="hemo-card">
              <div className="subpanel-header">
                <span>ALÇA PRESSÃO-VOLUME (PV LOOP) — ESPVR · EDPVR · EA</span>
                <small>SUGA &amp; SAGAWA</small>
              </div>
              <PVLoopView height={250} />
            </div>
          </>
        )}

        {activeTab === 'ecg' && (
          <div className="hemo-card">
            <div className="subpanel-header">
              <span>ECG DE 12 DERIVAÇÕES (PAPEL MILIMETRADO · MATRIZ DE DOWER 3D)</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <small>25 MM/S · 10 MM/MV</small>
                {onToggleEcgWide && (
                  <button
                    type="button"
                    className={`btn-chip ${ecgWideMode ? 'active' : ''}`}
                    style={{ padding: '2px 6px', fontSize: 9.5 }}
                    onClick={onToggleEcgWide}
                  >
                    {ecgWideMode ? '[ REDUZIR PAINEL ]' : '[ EXPANDIR LARGURA ]'}
                  </button>
                )}
              </div>
            </div>
            <Ecg12View height={470} />
          </div>
        )}

        {activeTab === 'combined' && (
          <>
            <div className="hemo-card">
              <div className="subpanel-header">
                <span>DIAGRAMA DE WIGGERS</span>
                <small>RK4 · H = 1 MS</small>
              </div>
              <WiggersView height={185} />
            </div>

            <div className="hemo-card">
              <div className="subpanel-header">
                <span>ALÇA PRESSÃO-VOLUME (PV LOOP)</span>
                <small>SUGA &amp; SAGAWA</small>
              </div>
              <PVLoopView height={175} />
            </div>

            <div className="hemo-card">
              <div className="subpanel-header">
                <span>ECG 12 DERIVAÇÕES (DOWER 3D)</span>
                <small>25 MM/S · 10 MM/MV</small>
              </div>
              <Ecg12View height={225} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
