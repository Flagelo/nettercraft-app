import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { getLive, usePhysiologyStore } from '../../controller/usePhysiologyStore';
import { useCanvas2D } from '../../controller/useRafLoop';
import { HeartElectromechanicalScene, type HeartColorMode } from './HeartMesh17';
import { AhaBullseye } from './AhaBullseye';

export { AhaBullseye };

// ============================================================================
// Step 1: Canvas Stabilization (Anti-Remount)
// Static configs and callbacks hoisted outside the component to prevent
// new object references from destroying and recreating the WebGLRenderer.
// ============================================================================

const CANVAS_CAMERA = { position: [0, 0.3, 4.6] as [number, number, number], fov: 44 };
const CANVAS_DPR: [number, number] = [1, 2];
const CANVAS_GL: THREE.WebGLRendererParameters = {
  powerPreference: 'high-performance',
  antialias: true,
  preserveDrawingBuffer: false,
};

const handleCanvasCreated = ({ gl }: { gl: THREE.WebGLRenderer }) => {
  gl.localClippingEnabled = true;
};

interface Cardiac3DCanvasProps {
  colorMode: HeartColorMode;
  cutaway: boolean;
  cutDepth: number;
  cutAngle: number;
  showDipoles: boolean;
  showVcgLoop: boolean;
  valveMode: boolean;
  selectedSegment: number | null;
  onSelectSegment: (segId: number | null) => void;
}

/**
  * 3D Canvas root isolated with React.memo.
  * Never unmounts/remounts on layout changes (e.g. bullseye drawer or left panel).
 */
export const Cardiac3DCanvas = React.memo(function Cardiac3DCanvas({
  colorMode,
  cutaway,
  cutDepth,
  cutAngle,
  showDipoles,
  showVcgLoop,
  valveMode,
  selectedSegment,
  onSelectSegment,
}: Cardiac3DCanvasProps) {
  return (
    <Canvas
      camera={CANVAS_CAMERA}
      dpr={CANVAS_DPR}
      gl={CANVAS_GL}
      onCreated={handleCanvasCreated}
    >
      <color attach="background" args={['#05070a']} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 6, 5]} intensity={1.3} />
      <directionalLight position={[-4, -3, -4]} intensity={0.45} color="#38bdf8" />
      <HeartElectromechanicalScene
        colorMode={colorMode}
        cutaway={cutaway}
        cutDepth={cutDepth}
        cutAngle={cutAngle}
        showDipoles={showDipoles}
        showVcgLoop={showVcgLoop}
        valveMode={valveMode}
        selectedSegment={selectedSegment}
        onSelectSegment={onSelectSegment}
      />
      <OrbitControls makeDefault enablePan={false} minDistance={2.4} maxDistance={8.5} />
    </Canvas>
  );
});

export function CardiacViewport() {
  const leftPanelOpen = usePhysiologyStore((s) => s.leftPanelOpen);
  const selectedSegment = usePhysiologyStore((s) => s.selectedSegment);
  const setSelectedSegment = usePhysiologyStore((s) => s.setSelectedSegment);

  const [colorMode, setColorMode] = useState<HeartColorMode>('depolarization');
  const [cutaway, setCutaway] = useState(false);
  const [cutDepth, setCutDepth] = useState(0.08);
  const [cutAngle, setCutAngle] = useState(0);
  const [showDipoles, setShowDipoles] = useState(true);
  const [showVcgLoop, setShowVcgLoop] = useState(true);
  // VALVE MODE off by default: the app's default visual does not change
  const [valveMode, setValveMode] = useState(false);
  // Starts collapsed if the left Clinical Inspector is already open (avoids duplication/overlap — Fixes 2.3)
  const [bullseyeExpanded, setBullseyeExpanded] = useState<boolean>(!leftPanelOpen);

  return (
    <div className="viewport-container">
      {/* Top toolbar of the Cardiac 3D Viewport (single lean row, height: 34px) */}
      <div className="viewport-OverlayTop">
        <div className="btn-group">
          <button
            type="button"
            className={`btn-chip ${colorMode === 'depolarization' ? 'active' : ''}`}
            onClick={() => setColorMode('depolarization')}
          >
            ⚡ DESPOLARIZAÇÃO
          </button>
          <button
            type="button"
            className={`btn-chip ${colorMode === 'coronary' ? 'active' : ''}`}
            onClick={() => setColorMode('coronary')}
          >
            🩸 CORONÁRIAS (DA/CX/CD)
          </button>
          <button
            type="button"
            className={`btn-chip ${colorMode === 'motility' ? 'active' : ''}`}
            onClick={() => setColorMode('motility')}
          >
            🎯 MOTILIDADE 17-AHA
          </button>
        </div>

        <div className="btn-group">
          <button
            type="button"
            className={`btn-chip ${cutaway ? 'active' : ''}`}
            onClick={() => setCutaway((v) => !v)}
          >
            🔪 CORTE ENDOCÁRDICO
          </button>
          <button
            type="button"
            className={`btn-chip ${showVcgLoop ? 'active' : ''}`}
            onClick={() => setShowVcgLoop((v) => !v)}
          >
            🌀 ALÇA VCG 3D
          </button>
          <button
            type="button"
            className={`btn-chip ${showDipoles ? 'active' : ''}`}
            onClick={() => setShowDipoles((v) => !v)}
          >
            ↗ 17 DIPOLOS
          </button>
          <button
            type="button"
            className={`btn-chip ${valveMode ? 'active' : ''}`}
            onClick={() => setValveMode((v) => !v)}
            aria-pressed={valveMode}
            title="Paredes de vasos e câmaras semitransparentes; valvas opacas e realçadas"
          >
            ◎ MODO VALVAS
          </button>
        </div>
      </div>

      {/* Dynamic Depth and Angle Controls of the Endocardial Cut (R4) */}
      {cutaway && (
        <div
          style={{
            position: 'absolute',
            top: 48,
            left: 12,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'rgba(10, 15, 25, 0.92)',
            border: '1px solid #1e293b',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            color: '#cbd5e1',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(6px)',
          }}
        >
          <span style={{ color: '#38bdf8', fontWeight: 700 }}>🔪 CORTE:</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>Prof:</span>
            <input
              type="range"
              min={-0.6}
              max={0.8}
              step={0.02}
              value={cutDepth}
              onChange={(e) => setCutDepth(parseFloat(e.target.value))}
              style={{ width: 68, height: 4, accentColor: '#38bdf8', cursor: 'pointer' }}
            />
            <span style={{ minWidth: 28 }}>{cutDepth > 0 ? `+${cutDepth.toFixed(2)}` : cutDepth.toFixed(2)}</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>Ângulo:</span>
            <input
              type="range"
              min={-60}
              max={60}
              step={2}
              value={cutAngle}
              onChange={(e) => setCutAngle(parseFloat(e.target.value))}
              style={{ width: 68, height: 4, accentColor: '#38bdf8', cursor: 'pointer' }}
            />
            <span style={{ minWidth: 28 }}>{cutAngle}°</span>
          </label>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className="btn-chip"
              style={{ padding: '1px 5px', fontSize: 9 }}
              onClick={() => { setCutAngle(0); setCutDepth(0.08); }}
            >
              Coronal
            </button>
            <button
              type="button"
              className="btn-chip"
              style={{ padding: '1px 5px', fontSize: 9 }}
              onClick={() => { setCutAngle(45); setCutDepth(0.12); }}
            >
              Oblíquo
            </button>
            <button
              type="button"
              className="btn-chip"
              style={{ padding: '1px 5px', fontSize: 9 }}
              onClick={() => { setCutAngle(-45); setCutDepth(0.12); }}
            >
              Septal
            </button>
          </div>
        </div>
      )}

      {/* Interactive, collapsible Bullseye Polar Map at the bottom-left corner of the Viewport (Fixes 2.3) */}
      <div className="viewport-OverlayBottomLeft">
        <button
          type="button"
          onClick={() => setBullseyeExpanded((v) => !v)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            background: 'transparent',
            border: 'none',
            color: '#F5F0E6',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            fontWeight: 700,
            cursor: 'pointer',
            padding: '2px 4px',
          }}
        >
          <span>🎯 BULL&apos;S-EYE 17-AHA</span>
          <span style={{ color: '#38bdf8' }}>{bullseyeExpanded ? '▾ Minimizar' : '▸ Expandir'}</span>
        </button>
        {bullseyeExpanded && (
          <div style={{ marginTop: 4 }}>
            <AhaBullseye
              selectedSegment={selectedSegment}
              onSelectSegment={setSelectedSegment}
              compact
            />
          </div>
        )}
      </div>

      {/* Frank Vectorcardiographic Monitor (Frontal XY & Horizontal XZ planes) attached to the 3D VCG Loop button (Fixes 2.1) */}
      {showVcgLoop && (
        <div
          style={{
            position: 'absolute',
            bottom: 10,
            right: 10,
            zIndex: 10,
            background: '#121212',
            border: '1px solid #262626',
            padding: 8,
            width: 228,
          }}
        >
          <div className="overlay-card-title" style={{ color: '#00E676' }}>
            ALÇA VETOCARDIOGRÁFICA DE FRANK (XY / XZ)
          </div>
          <FrankVcgHudCanvas />
        </div>
      )}

      <Cardiac3DCanvas
        colorMode={colorMode}
        cutaway={cutaway}
        cutDepth={cutDepth}
        cutAngle={cutAngle}
        showDipoles={showDipoles}
        showVcgLoop={showVcgLoop}
        valveMode={valveMode}
        selectedSegment={selectedSegment}
        onSelectSegment={setSelectedSegment}
      />
    </div>
  );
}

/**
  * Renders at 60 FPS the dual orthogonal projection of the Vectorcardiographic Loop (Frank VCG):
  *  - Left: Frontal Plane (X × Y)
  *  - Right: Horizontal/Transverse Plane (X × Z)
 */
function FrankVcgHudCanvas() {
  const N = 220;
  const histX = useRef<Float32Array>(new Float32Array(N));
  const histY = useRef<Float32Array>(new Float32Array(N));
  const histZ = useRef<Float32Array>(new Float32Array(N));
  const headRef = useRef(0);
  const countRef = useRef(0);
  const lastSampleTimeRef = useRef(getLive().clock.t);

  useEffect(() => usePhysiologyStore.subscribe(
    (s) => s.resetToken,
    () => {
      histX.current.fill(0);
      histY.current.fill(0);
      histZ.current.fill(0);
      headRef.current = 0;
      countRef.current = 0;
      lastSampleTimeRef.current = 0;
    },
  ), []);

  const canvasRef = useCanvas2D((ctx, w, h) => {
    const live = getLive();
    const vec = live.electro.vector;
    const vx = vec[0];
    const vy = vec[1];
    const vz = vec[2];

    if (usePhysiologyStore.getState().running && live.clock.t > lastSampleTimeRef.current) {
      const hIdx = headRef.current;
      histX.current[hIdx] = vx;
      histY.current[hIdx] = vy;
      histZ.current[hIdx] = vz;
      headRef.current = (hIdx + 1) % N;
      countRef.current = Math.min(N, countRef.current + 1);
      lastSampleTimeRef.current = live.clock.t;
    }

    ctx.fillStyle = '#05080d';
    ctx.fillRect(0, 0, w, h);

    const halfW = w * 0.5;
    const cy = h * 0.52;
    const cx1 = halfW * 0.5;
    const cx2 = halfW + halfW * 0.5;
    const scale = Math.min(halfW, h) * 0.34;

    // Axes of the two planes (Frontal XY and Horizontal XZ)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(6, cy);
    ctx.lineTo(halfW - 6, cy);
    ctx.moveTo(cx1, 14);
    ctx.lineTo(cx1, h - 14);
    ctx.moveTo(halfW + 6, cy);
    ctx.lineTo(w - 6, cy);
    ctx.moveTo(cx2, 14);
    ctx.lineTo(cx2, h - 14);
    ctx.stroke();

    // Frontal Loop (X vs Y)
    ctx.strokeStyle = '#00E676';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < countRef.current; i++) {
      const idx = (headRef.current - countRef.current + i + N) % N;
      const px = cx1 + histX.current[idx] * scale;
      const py = cy + histY.current[idx] * scale;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Horizontal Loop (X vs Z)
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < countRef.current; i++) {
      const idx = (headRef.current - countRef.current + i + N) % N;
      const px = cx2 + histX.current[idx] * scale;
      const pz = cy + histZ.current[idx] * scale;
      if (i === 0) ctx.moveTo(px, pz);
      else ctx.lineTo(px, pz);
    }
    ctx.stroke();

    // Instantaneous vector P(t)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx1 + vx * scale, cy + vy * scale, 2.8, 0, Math.PI * 2);
    ctx.arc(cx2 + vx * scale, cy + vz * scale, 2.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '9px ui-monospace, SFMono-Regular, Consolas, monospace';
    ctx.fillStyle = '#00E676';
    ctx.fillText('Frontal (XY)', 6, 11);
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('Horiz (XZ)', halfW + 6, 11);
    const magMv = Math.hypot(vx, vy, vz).toFixed(2);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(`|P|=${magMv}mV`, 6, h - 4);
  });

  return <canvas ref={canvasRef} className="strip-canvas" style={{ height: 102 }} />;
}
