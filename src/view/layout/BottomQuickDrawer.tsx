import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Droplets,
  HeartPulse,
  Lock,
  Pill,
  Sparkles,
  Syringe,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import {
  type DrawerSliderId,
  usePhysiologyStore,
} from '../../controller/usePhysiologyStore';
import { auscultationSynth } from '../../controller/modules/auscultationModule';

/**
 * Bottom Quick-Parameter Drawer ('netter-artcraft-ui-shell'):
 *  - In Sandbox Mode: shows all global sliders freely.
 *  - In Exam Mode (activeExamCaseId !== null): visually blocks non-essential controls
 *    (`is-locked`, `disabled`) and applies a subtle glow (`is-allowed-glow`) only on the controls
 *    allowed to intervene in that case (e.g. IV Furosemide).
 */
export function BottomQuickDrawer() {
  const open = usePhysiologyStore((s) => s.bottomDrawerOpen);
  const toggleOpen = usePhysiologyStore((s) => s.toggleBottomDrawer);
  const activeExamCaseId = usePhysiologyStore((s) => s.activeExamCaseId);
  const allowedSliders = usePhysiologyStore((s) => s.activeExamAllowedSliders);

  const heartRate = usePhysiologyStore((s) => s.params.ecg.heartRate);
  const rhythm = usePhysiologyStore((s) => s.params.ecg.rhythm);
  const flutterConduction = usePhysiologyStore((s) => s.params.ecg.flutterConduction);
  const norepinephrine = usePhysiologyStore((s) => s.params.drugs.norepinephrine);
  const dobutamine = usePhysiologyStore((s) => s.params.drugs.dobutamine);
  const furosemide = usePhysiologyStore((s) => s.params.drugs.furosemide);
  const bloodVolume = usePhysiologyStore((s) => s.params.circulation.bloodVolume);
  const patch = usePhysiologyStore((s) => s.patch);

  const [, setAudioTick] = useState(0);
  useEffect(() => auscultationSynth.subscribe(() => setAudioTick((t) => t + 1)), []);

  const isExamMode = activeExamCaseId !== null;
  const effectiveHr =
    rhythm === 'flutter' ? Math.round(300 / flutterConduction) : heartRate;

  const isSliderAllowed = (id: DrawerSliderId): boolean => {
    if (!isExamMode || !allowedSliders) return true;
    return allowedSliders.includes(id);
  };

  const sliderClass = (id: DrawerSliderId): string => {
    if (!isExamMode) return 'nc-quick-slider';
    return isSliderAllowed(id)
      ? 'nc-quick-slider is-allowed-glow'
      : 'nc-quick-slider is-locked';
  };

  return (
    <div className={`nc-bottom-drawer ${open ? 'open' : 'collapsed'}`}>
      <div className="nc-drawer-handle-row">
        <button
          type="button"
          className="nc-drawer-tab"
          onClick={() => toggleOpen()}
          aria-expanded={open}
        >
          {isExamMode && <Sparkles size={13} color="#00E676" />}
          <span className="nc-drawer-title">
            {isExamMode
              ? 'MODO PROVA · CONTROLES EM GLOW DISPONÍVEIS PARA INTERVENÇÃO'
              : 'CONTROLE FISIOLÓGICO RÁPIDO & INTERVENÇÃO VASOATIVA'}
          </span>
          {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>

        {/* Direct Mute/Unmute toggle of the AuscultationSynth */}
        <button
          type="button"
          className={`nc-audio-pill ${auscultationSynth.enabled ? 'active' : ''}`}
          onClick={() => auscultationSynth.toggleEnabled()}
          title="Ativar/Silenciar Sintetizador de Ausculta Cardíaca (B1, B2, B3, B4 e Sopros)"
        >
          {auscultationSynth.enabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
          <span>
            {auscultationSynth.enabled
              ? `Ausculta Ativa (${auscultationSynth.focus.toUpperCase()})`
              : 'Ausculta Silenciada'}
          </span>
        </button>
      </div>

      {open && (
        <div className="nc-drawer-grid">
          {/* 1. Heart Rate (bpm) */}
          <div className={sliderClass('hr')}>
            <div className="nc-qs-head">
              <span className="nc-qs-label">
                {!isSliderAllowed('hr') ? (
                  <Lock size={12} className="icon-locked" />
                ) : (
                  <HeartPulse size={13} className="icon-crimson" />
                )}{' '}
                {rhythm === 'flutter' ? `FC (Flutter ${flutterConduction}:1)` : 'Frequência Cardíaca'}
              </span>
              <strong className="nc-mono-val">{effectiveHr} bpm</strong>
            </div>
            <input
              type="range"
              min={38}
              max={185}
              step={1}
              value={effectiveHr}
              disabled={!isSliderAllowed('hr')}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (rhythm === 'flutter') {
                  const nearest: 2 | 3 | 4 = v >= 125 ? 2 : v >= 88 ? 3 : 4;
                  patch('ecg', { flutterConduction: nearest, heartRate: Math.round(300 / nearest) });
                } else {
                  patch('ecg', { heartRate: v });
                }
              }}
            />
          </div>

          {/* 2. Norepinephrine Infusion (µg/kg/min) */}
          <div className={sliderClass('norepinephrine')}>
            <div className="nc-qs-head">
              <span className="nc-qs-label">
                {!isSliderAllowed('norepinephrine') ? (
                  <Lock size={12} className="icon-locked" />
                ) : (
                  <Syringe size={13} className="icon-crimson" />
                )}{' '}
                Noradrenalina
              </span>
              <strong className="nc-mono-val">{norepinephrine.toFixed(2)} µg/kg/m</strong>
            </div>
            <input
              type="range"
              min={0}
              max={1.0}
              step={0.02}
              value={norepinephrine}
              disabled={!isSliderAllowed('norepinephrine')}
              onChange={(e) => patch('drugs', { norepinephrine: parseFloat(e.target.value) })}
            />
          </div>

          {/* 3. Dobutamine Infusion (µg/kg/min) */}
          <div className={sliderClass('dobutamine')}>
            <div className="nc-qs-head">
              <span className="nc-qs-label">
                {!isSliderAllowed('dobutamine') ? (
                  <Lock size={12} className="icon-locked" />
                ) : (
                  <Zap size={13} className="icon-phosphor" />
                )}{' '}
                Dobutamina
              </span>
              <strong className="nc-mono-val">{dobutamine.toFixed(1)} µg/kg/m</strong>
            </div>
            <input
              type="range"
              min={0}
              max={20}
              step={0.5}
              value={dobutamine}
              disabled={!isSliderAllowed('dobutamine')}
              onChange={(e) => patch('drugs', { dobutamine: parseFloat(e.target.value) })}
            />
          </div>

          {/* 4. Furosemide (mg IV) */}
          <div className={sliderClass('furosemide')}>
            <div className="nc-qs-head">
              <span className="nc-qs-label">
                {!isSliderAllowed('furosemide') ? (
                  <Lock size={12} className="icon-locked" />
                ) : (
                  <Pill size={13} className="icon-cobalt" />
                )}{' '}
                Furosemida IV
              </span>
              <strong className="nc-mono-val">{furosemide} mg</strong>
            </div>
            <input
              type="range"
              min={0}
              max={120}
              step={10}
              value={furosemide}
              disabled={!isSliderAllowed('furosemide')}
              onChange={(e) => patch('drugs', { furosemide: parseFloat(e.target.value) })}
            />
          </div>

          {/* 5. Blood Volume Control (mL) */}
          <div className={sliderClass('bloodVolume')}>
            <div className="nc-qs-head">
              <span className="nc-qs-label">
                {!isSliderAllowed('bloodVolume') ? (
                  <Lock size={12} className="icon-locked" />
                ) : (
                  <Droplets size={13} className="icon-cobalt" />
                )}{' '}
                Volume Sanguíneo
              </span>
              <strong className="nc-mono-val">{bloodVolume} mL</strong>
            </div>
            <input
              type="range"
              min={3400}
              max={6400}
              step={50}
              value={bloodVolume}
              disabled={!isSliderAllowed('bloodVolume')}
              onChange={(e) => patch('circulation', { bloodVolume: parseFloat(e.target.value) })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
