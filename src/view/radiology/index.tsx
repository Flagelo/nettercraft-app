import { Canvas, ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  type RadiologyContrastMode,
  usePhysiologyStore,
} from '../../controller/usePhysiologyStore';
import {
  ANATOMICAL_LABELS,
  buildBrainNeuroPhantom,
  buildThoraxAngioCtPhantom,
  buildTransferFunction1DLut,
  loadDicomSeries,
  loadNiftiFile,
  loadNiftiFromUrl,
  loadNiftiLabelmapIntoVolume,
  type MedicalVolume,
  voxelToPhysicalMm,
} from '../../model/imaging/volumeLoader';
import {
  MPR_FRAGMENT_SHADER,
  MPR_VERTEX_SHADER,
  RAYMARCH_FRAGMENT_SHADER,
  RAYMARCH_VERTEX_SHADER,
} from './radiologyShaders';

interface WindowPreset {
  id: string;
  label: string;
  ww: number;
  wl: number;
  contrastMode: RadiologyContrastMode;
}

const WINDOW_PRESETS: readonly WindowPreset[] = [
  { id: 'soft', label: 'Partes Moles (350/50)', ww: 350, wl: 50, contrastMode: 0 },
  { id: 'lung', label: 'Pulmão', ww: 1500, wl: -600, contrastMode: 0 },
  { id: 'bone', label: 'Osso', ww: 2000, wl: 400, contrastMode: 0 },
  { id: 'brain', label: 'Cérebro', ww: 80, wl: 40, contrastMode: 0 },
  { id: 'liver', label: 'Fígado Seg.VI', ww: 150, wl: 65, contrastMode: 0 },
  { id: 't1', label: 'RM T1', ww: 400, wl: 40, contrastMode: 1 },
  { id: 't2', label: 'RM T2', ww: 400, wl: 40, contrastMode: 2 },
  { id: 'flair', label: 'RM FLAIR', ww: 400, wl: 40, contrastMode: 3 },
];

export interface HoverAnatomyReadout {
  voxel: [number, number, number];
  mm: [number, number, number];
  hu: number;
  labelId: number;
  name: string;
  system: string;
  color: [number, number, number];
  clientX?: number;
  clientY?: number;
}

export function RadiologyViewport() {
  // Step 2 & 3: Window Width (WW), Window Level (WL) and 1D Transfer Function parameters read from usePhysiologyStore
  const ww = usePhysiologyStore((s) => s.radiologyWw);
  const wl = usePhysiologyStore((s) => s.radiologyWl);
  const contrastMode = usePhysiologyStore((s) => s.radiologyContrastMode);
  const vascularThresholdHu = usePhysiologyStore((s) => s.radiologyVascularThresholdHu);
  const boneThresholdHu = usePhysiologyStore((s) => s.radiologyBoneThresholdHu);
  const opacityScale = usePhysiologyStore((s) => s.radiologyOpacityScale);
  const radiologyNiftiUrl = usePhysiologyStore((s) => s.radiologyNiftiUrl);
  const setRadiologyWindow = usePhysiologyStore((s) => s.setRadiologyWindow);
  const setRadiologyTransferParams = usePhysiologyStore((s) => s.setRadiologyTransferParams);
  const setRadiologyCrosshair = usePhysiologyStore((s) => s.setRadiologyCrosshair);

  const [volume, setVolume] = useState<MedicalVolume>(() => buildThoraxAngioCtPhantom());
  const [crosshair, setCrosshairState] = useState<[number, number, number]>([0.38, 0.52, 0.42]);

  const setCrosshair: React.Dispatch<React.SetStateAction<[number, number, number]>> = (val) => {
    setCrosshairState((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      setRadiologyCrosshair(next);
      return next;
    });
  };

  // Step 4 (Exam Mode): Automatically loads a local anonymized NIfTI volume (Radiopaedia/TCIA) via URL
  useEffect(() => {
    if (!radiologyNiftiUrl) return;
    let cancelled = false;
    loadNiftiFromUrl(radiologyNiftiUrl, `NIfTI Caso Clínico (${radiologyNiftiUrl.split('/').pop()})`)
      .then((loaded) => {
        if (!cancelled) setVolume(loaded);
      })
      .catch(() => {
        // Safe fallback to the phantom if offline in a test environment without an HTTP server
      });
    return () => {
      cancelled = true;
    };
  }, [radiologyNiftiUrl]);
  const [obliqueDeg, setObliqueDeg] = useState(0);
  const [labelOpacity, setLabelOpacity] = useState(0.32);
  const [transferPreset, setTransferPreset] = useState<0 | 1 | 2 | 3>(0);
  const [clipActive, setClipActive] = useState(true);
  const [hoverInfo, setHoverInfo] = useState<HoverAnatomyReadout | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadSuccessMsg, setLoadSuccessMsg] = useState<string | null>(null);

  // Step 1 & 4: WebGL2 Data3DTexture textures (HU Volume + Netter Labelmap) + 32×1 segmentation LUT
  const gpuTextures = useMemo(() => {
    const [nx, ny, nz] = volume.dims;
    const volTex = new THREE.Data3DTexture(volume.huData, nx, ny, nz);
    volTex.format = THREE.RedFormat;
    volTex.type = THREE.FloatType;
    volTex.minFilter = THREE.LinearFilter;
    volTex.magFilter = THREE.LinearFilter;
    volTex.unpackAlignment = 1;
    volTex.needsUpdate = true;

    const lblTex = new THREE.Data3DTexture(volume.labelData, nx, ny, nz);
    lblTex.format = THREE.RedFormat;
    lblTex.type = THREE.UnsignedByteType;
    lblTex.minFilter = THREE.NearestFilter;
    lblTex.magFilter = THREE.NearestFilter;
    lblTex.unpackAlignment = 1;
    lblTex.needsUpdate = true;

    // 32×1 RGBA LUT with the Netter watercolor colors of the anatomical structures
    const lutBytes = new Uint8Array(32 * 4);
    for (let i = 0; i < 32; i++) {
      const info = ANATOMICAL_LABELS[i];
      if (info) {
        lutBytes[i * 4] = Math.round(info.color[0] * 255);
        lutBytes[i * 4 + 1] = Math.round(info.color[1] * 255);
        lutBytes[i * 4 + 2] = Math.round(info.color[2] * 255);
        lutBytes[i * 4 + 3] = i === 0 ? 0 : 255;
      }
    }
    const lutTex = new THREE.DataTexture(lutBytes, 32, 1, THREE.RGBAFormat);
    lutTex.minFilter = THREE.NearestFilter;
    lutTex.magFilter = THREE.NearestFilter;
    lutTex.needsUpdate = true;

    return { volTex, lblTex, lutTex };
  }, [volume]);

  // Step 3: 1D Transfer Function texture (256×1 RGBA) coupled to the UI HU sliders
  const transferLutTex = useMemo(() => {
    const bytes = buildTransferFunction1DLut(
      transferPreset,
      vascularThresholdHu,
      boneThresholdHu,
      opacityScale,
    );
    const tex = new THREE.DataTexture(bytes, 256, 1, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }, [transferPreset, vascularThresholdHu, boneThresholdHu, opacityScale]);

  useEffect(() => {
    return () => {
      gpuTextures.volTex.dispose();
      gpuTextures.lblTex.dispose();
      gpuTextures.lutTex.dispose();
    };
  }, [gpuTextures]);

  useEffect(() => {
    return () => {
      transferLutTex.dispose();
    };
  }, [transferLutTex]);

  // Anatomical and Hounsfield lookup on the CPU from the normalized coordinate [0,1]^3 + 4×4 Affine Matrix
  const probeAtNormalized = (
    tc: [number, number, number],
    clientX?: number,
    clientY?: number,
  ): HoverAnatomyReadout => {
    const [nx, ny, nz] = volume.dims;
    const ix = clampInt(Math.floor(tc[0] * nx), 0, nx - 1);
    const iy = clampInt(Math.floor(tc[1] * ny), 0, ny - 1);
    const iz = clampInt(Math.floor(tc[2] * nz), 0, nz - 1);
    const flat = iz * nx * ny + iy * nx + ix;
    const hu = Math.round(volume.huData[flat] ?? -1000);
    const labelId = volume.labelData[flat] ?? 0;
    const info = ANATOMICAL_LABELS[labelId] ?? {
      id: labelId,
      name: `Estrutura Segmentada #${labelId}`,
      system: 'Segmentação NIfTI',
      color: [0.75, 0.55, 0.35] as [number, number, number],
      typicalHu: hu,
    };
    const mm = voxelToPhysicalMm(volume.affine, ix, iy, iz);
    return {
      voxel: [ix, iy, iz],
      mm,
      hu,
      labelId,
      name: info.name,
      system: info.system,
      color: info.color,
      clientX,
      clientY,
    };
  };

  const applyPreset = (p: WindowPreset) => {
    setRadiologyWindow(p.ww, p.wl, p.contrastMode);
    // Automatically synchronizes the 3D Transfer Function when clicking the window presets (Fixes 4.1)
    if (p.id === 'lung') {
      setTransferPreset(2);
    } else if (p.id === 'bone') {
      setTransferPreset(1);
    } else {
      setTransferPreset(0);
    }
  };

  const handleNiftiUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    isLabelmap = false,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoadError(null);
    setLoadSuccessMsg(`Carregando ${file.name}...`);
    try {
      if (isLabelmap) {
        const updated = await loadNiftiLabelmapIntoVolume(file, volume);
        setVolume(updated);
        setLoadSuccessMsg(`✓ Labelmap Netter injetado: ${file.name}`);
      } else {
        const loaded = await loadNiftiFile(file);
        setVolume(loaded);
        setCrosshair([0.5, 0.5, 0.5]);
        setLoadSuccessMsg(
          `✓ Volume NIfTI carregado: ${file.name} (${loaded.dims.join('×')} voxels · [${Math.round(loaded.huMin)}..+${Math.round(loaded.huMax)} HU])`,
        );
      }
    } catch (err) {
      setLoadSuccessMsg(null);
      setLoadError(err instanceof Error ? err.message : 'Erro ao ler arquivo NIfTI.');
    }
  };

  const handleDicomUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setLoadError(null);
    setLoadSuccessMsg(`Processando ${files.length} fatia(s) DICOM...`);
    try {
      const loaded = await loadDicomSeries(files);
      setVolume(loaded);
      setCrosshair([0.5, 0.5, 0.5]);
      setLoadSuccessMsg(
        `✓ Série DICOM anonimizada carregada (${loaded.dims[2]} fatias · ${loaded.dims[0]}×${loaded.dims[1]})`,
      );
    } catch (err) {
      setLoadSuccessMsg(null);
      setLoadError(err instanceof Error ? err.message : 'Erro ao ler série DICOM.');
    }
  };

  const activeHoverLabel = hoverInfo?.labelId ?? 0;
  const crosshairReadout = probeAtNormalized(crosshair);
  const displayedReadout = hoverInfo ?? crosshairReadout;

  return (
    <div className="radio-layout" style={{ position: 'relative' }}>
      {/* Slim Top Radiology Toolbar (height: 40px) */}
      <div className="radio-toolbar">
        <div className="btn-group" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 700,
              color: '#8E8E93',
              marginRight: 2,
            }}
          >
            VOLUME:
          </span>
          <select
            className="preset-select"
            aria-label="Selecionar Volume Anatômico"
            value={volume.title.startsWith('Neuro') ? 'neuro' : 'angio'}
            onChange={(e) => {
              if (e.target.value === 'neuro') {
                setVolume(buildBrainNeuroPhantom());
                applyPreset(WINDOW_PRESETS[3]);
                setTransferPreset(1);
              } else {
                setVolume(buildThoraxAngioCtPhantom());
                applyPreset(WINDOW_PRESETS[0]);
                setTransferPreset(0);
              }
            }}
          >
            <option value="angio">Phantom Angio-TC Tórax/Fígado ▾</option>
            <option value="neuro">Phantom Neuro TC / RM ▾</option>
          </select>

          <label className="btn-chip file-btn">
            + NIfTI
            <input
              type="file"
              accept=".nii,.gz"
              onChange={(e) => handleNiftiUpload(e, false)}
              hidden
            />
          </label>
          <label className="btn-chip file-btn">
            + Labelmap
            <input
              type="file"
              accept=".nii,.gz"
              onChange={(e) => handleNiftiUpload(e, true)}
              hidden
            />
          </label>
          <label className="btn-chip file-btn">
            + DICOM
            <input type="file" multiple accept=".dcm" onChange={handleDicomUpload} hidden />
          </label>
        </div>

        {/* Clinical HU Windowing Presets connected to usePhysiologyStore */}
        <div className="btn-group" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 700,
              color: '#8E8E93',
              marginRight: 2,
            }}
          >
            JANELA (WW/WL):
          </span>
          {WINDOW_PRESETS.map((pr) => (
            <button
              key={pr.id}
              type="button"
              className={`btn-chip ${
                contrastMode === pr.contrastMode && ww === pr.ww && wl === pr.wl ? 'active' : ''
              }`}
              onClick={() => applyPreset(pr)}
            >
              {pr.label}
            </button>
          ))}
        </div>
      </div>

      {loadError && <div className="radio-error">{loadError}</div>}
      {loadSuccessMsg && (
        <div
          style={{
            background: 'rgba(0, 230, 118, 0.14)',
            border: '1px solid rgba(0, 230, 118, 0.45)',
            color: '#bbf7d0',
            padding: '5px 10px',
            borderRadius: 6,
            fontSize: 11.5,
            fontFamily: 'var(--font-mono)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{loadSuccessMsg}</span>
          <button
            type="button"
            className="btn-chip"
            style={{ padding: '1px 6px', fontSize: 10 }}
            onClick={() => setLoadSuccessMsg(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* Interactive Anatomical Identification Bar (Hover / Crosshair) + Affine Physical Scale */}
      <div className="radio-inspector-bar">
        <div className="inspector-structure">
          <span
            className="structure-dot"
            style={{
              background: `rgb(${displayedReadout.color
                .map((c) => Math.round(c * 255))
                .join(',')})`,
            }}
          />
          <strong>{displayedReadout.name}</strong>
          <span className="sys-tag">{displayedReadout.system}</span>
        </div>
        <div className="inspector-metrics">
          <span>
            Densidade: <strong>{displayedReadout.hu} HU</strong>
          </span>
          <span>
            Voxel: [{displayedReadout.voxel.join(', ')}]
          </span>
          <span>
            Afim (mm): ({displayedReadout.mm.join(', ')}) mm
          </span>
          <span>
            Spacing: {volume.spacing.map((s) => s.toFixed(1)).join('×')} mm
          </span>
          <span>
            Janela Store: <strong>W:{Math.round(ww)} / L:{Math.round(wl)}</strong>
          </span>
        </div>
      </div>

      {/* Step 2 — Grid of 4 Synchronized Quadrants (Axial, Coronal, Sagittal and 3D Volume) */}
      <div className="radio-quadrants">
        {/* Q1: AXIAL (Z) */}
        <MprQuadrant
          title="AXIAL (Z)"
          borderColor="#ff4747"
          axis={0}
          volume={volume}
          textures={gpuTextures}
          crosshair={crosshair}
          setCrosshair={setCrosshair}
          obliqueDeg={obliqueDeg}
          ww={ww}
          wl={wl}
          setWindow={(nextWw, nextWl) => setRadiologyWindow(nextWw, nextWl, 0)}
          contrastMode={contrastMode}
          labelOpacity={labelOpacity}
          hoverLabel={activeHoverLabel}
          onHoverSample={(tc, cx, cy) =>
            setHoverInfo(tc ? probeAtNormalized(tc, cx, cy) : null)
          }
        />

        {/* Q2: CORONAL (Y) */}
        <MprQuadrant
          title="CORONAL (Y)"
          borderColor="#22c55e"
          axis={1}
          volume={volume}
          textures={gpuTextures}
          crosshair={crosshair}
          setCrosshair={setCrosshair}
          obliqueDeg={obliqueDeg}
          ww={ww}
          wl={wl}
          setWindow={(nextWw, nextWl) => setRadiologyWindow(nextWw, nextWl, 0)}
          contrastMode={contrastMode}
          labelOpacity={labelOpacity}
          hoverLabel={activeHoverLabel}
          onHoverSample={(tc, cx, cy) =>
            setHoverInfo(tc ? probeAtNormalized(tc, cx, cy) : null)
          }
        />

        {/* Q3: SAGITTAL (X) */}
        <MprQuadrant
          title="SAGITAL (X)"
          borderColor="#38bdf8"
          axis={2}
          volume={volume}
          textures={gpuTextures}
          crosshair={crosshair}
          setCrosshair={setCrosshair}
          obliqueDeg={obliqueDeg}
          ww={ww}
          wl={wl}
          setWindow={(nextWw, nextWl) => setRadiologyWindow(nextWw, nextWl, 0)}
          contrastMode={contrastMode}
          labelOpacity={labelOpacity}
          hoverLabel={activeHoverLabel}
          onHoverSample={(tc, cx, cy) =>
            setHoverInfo(tc ? probeAtNormalized(tc, cx, cy) : null)
          }
        />

        {/* Q4: 3D VOLUMETRIC RENDERING (DIRECT VOLUME RENDERING — RAYMARCHING + PHONG + 1D TF) */}
        <div className="radio-quad" style={{ borderColor: '#f59e0b' }}>
          <div className="quad-header">
            <span style={{ color: '#f59e0b' }}>
              3D VOLUME RAYMARCHING (Transfer Function 1D + Phong)
            </span>
            <div className="btn-group">
              {(
                [
                  [0, 'Angio-TC + Osso'],
                  [1, 'Osso > 400 HU'],
                  [2, 'Pulmão'],
                  [3, 'MIP'],
                ] as [0 | 1 | 2 | 3, string][]
              ).map(([id, lbl]) => (
                <button
                  key={id}
                  type="button"
                  className={`btn-chip ${transferPreset === id ? 'active' : ''}`}
                  onClick={() => setTransferPreset(id)}
                >
                  {lbl}
                </button>
              ))}
              <button
                type="button"
                className={`btn-chip ${clipActive ? 'active' : ''}`}
                onClick={() => setClipActive((v) => !v)}
              >
                ✂️ Corte Crosshair
              </button>
            </div>
          </div>
          <div
            className="quad-canvas"
            onPointerLeave={() => setHoverInfo(null)}
          >
            <Canvas camera={{ position: [1.22, -1.32, 1.02], fov: 40 }} dpr={[1, 2]}>
              <color attach="background" args={['#04060a']} />
              <RaymarchingVolumeMesh
                volume={volume}
                textures={gpuTextures}
                transferLutTex={transferLutTex}
                crosshair={crosshair}
                transferPreset={transferPreset}
                ww={ww}
                wl={wl}
                clipActive={clipActive}
                hoverLabel={activeHoverLabel}
                vascularThresholdHu={vascularThresholdHu}
                onHoverVoxel3D={(tc, cx, cy) =>
                  setHoverInfo(tc ? probeAtNormalized(tc, cx, cy) : null)
                }
              />
              <OrbitControls makeDefault enablePan={false} minDistance={0.85} maxDistance={3.5} />
            </Canvas>
          </div>
        </div>
      </div>

      {/* Step 2 & 3 — Footer of Controls Connected to usePhysiologyStore (WW/WL + 1D Transfer Function Sliders) */}
      <div className="radio-footer">
        <label className="ctrl-inline">
          <span>WW ({Math.round(ww)} HU)</span>
          <input
            type="range"
            min={20}
            max={2500}
            value={ww}
            onChange={(e) => setRadiologyWindow(parseFloat(e.target.value), wl, 0)}
          />
        </label>
        <label className="ctrl-inline">
          <span>WL ({Math.round(wl)} HU)</span>
          <input
            type="range"
            min={-900}
            max={900}
            value={wl}
            onChange={(e) => setRadiologyWindow(ww, parseFloat(e.target.value), 0)}
          />
        </label>
        <label className="ctrl-inline" title="Limiar de HU para Contraste Vascular (Vermelho/Translúcido na Textura 1D)">
          <span>TF Contraste (&gt;{Math.round(vascularThresholdHu)} HU)</span>
          <input
            type="range"
            min={80}
            max={340}
            step={5}
            value={vascularThresholdHu}
            onChange={(e) =>
              setRadiologyTransferParams({ vascularThresholdHu: parseFloat(e.target.value) })
            }
          />
        </label>
        <label className="ctrl-inline" title="Limiar de HU para Osso Cortical (Branco/Opaco na Textura 1D)">
          <span>TF Osso (&gt;{Math.round(boneThresholdHu)} HU)</span>
          <input
            type="range"
            min={250}
            max={800}
            step={10}
            value={boneThresholdHu}
            onChange={(e) =>
              setRadiologyTransferParams({ boneThresholdHu: parseFloat(e.target.value) })
            }
          />
        </label>
        <label className="ctrl-inline">
          <span>Opacidade 3D ({Math.round(opacityScale * 100)}%)</span>
          <input
            type="range"
            min={0.3}
            max={1.8}
            step={0.05}
            value={opacityScale}
            onChange={(e) =>
              setRadiologyTransferParams({ opacityScale: parseFloat(e.target.value) })
            }
          />
        </label>
        <label className="ctrl-inline">
          <span>Aquarela Netter ({Math.round(labelOpacity * 100)}%)</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={labelOpacity}
            onChange={(e) => setLabelOpacity(parseFloat(e.target.value))}
          />
        </label>
        <span className="anon-badge">🛡️ {volume.anonymizedMeta.Paciente}</span>
      </div>
    </div>
  );
}

interface MprQuadrantProps {
  title: string;
  borderColor: string;
  axis: 0 | 1 | 2;
  volume: MedicalVolume;
  textures: {
    volTex: THREE.Data3DTexture;
    lblTex: THREE.Data3DTexture;
    lutTex: THREE.DataTexture;
  };
  crosshair: [number, number, number];
  setCrosshair: React.Dispatch<React.SetStateAction<[number, number, number]>>;
  obliqueDeg: number;
  ww: number;
  wl: number;
  setWindow: (ww: number, wl: number) => void;
  contrastMode: RadiologyContrastMode;
  labelOpacity: number;
  hoverLabel: number;
  onHoverSample: (
    tc: [number, number, number] | null,
    clientX?: number,
    clientY?: number,
  ) => void;
}

function MprQuadrant({
  title,
  borderColor,
  axis,
  volume,
  textures,
  crosshair,
  setCrosshair,
  obliqueDeg,
  ww,
  wl,
  setWindow,
  contrastMode,
  labelOpacity,
  hoverLabel,
  onHoverSample,
}: MprQuadrantProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragMode = useRef<'none' | 'crosshair' | 'window'>('none');
  const lastMouse = useRef<{ x: number; y: number; ww: number; wl: number }>({
    x: 0,
    y: 0,
    ww: 350,
    wl: 50,
  });

  const sliceAxisIdx = axis === 0 ? 2 : axis === 1 ? 1 : 0;
  const sliceIndex = Math.round(crosshair[sliceAxisIdx] * (volume.dims[sliceAxisIdx] - 1));
  const slicePhysicalMm = (
    crosshair[sliceAxisIdx] * volume.physicalSizeMm[sliceAxisIdx]
  ).toFixed(1);

  const eventToTexCoord = (
    e: React.PointerEvent<HTMLDivElement>,
  ): [number, number, number] | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const u = clamp01((e.clientX - rect.left) / rect.width);
    const v = clamp01(1.0 - (e.clientY - rect.top) / rect.height);
    const rad = (obliqueDeg * Math.PI) / 180;
    const s = Math.sin(rad);

    if (axis === 0) {
      return [u, 1.0 - v, clamp01(crosshair[2] + (v - 0.5) * s * 0.45)];
    } else if (axis === 1) {
      return [u, clamp01(crosshair[1] + (u - 0.5) * s * 0.45), v];
    } else {
      // Sagittal slice: u maps Y (anteroposterior) and v maps Z (craniocaudal), immediately updating Axial (Z) and Coronal (Y)!
      return [clamp01(crosshair[0] + (u - 0.5) * s * 0.45), 1.0 - u, v];
    }
  };

  const updateCrosshairFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const tc = eventToTexCoord(e);
    if (!tc) return;
    setCrosshair(tc);
    onHoverSample(tc, e.clientX, e.clientY);
  };

  return (
    <div className="radio-quad" style={{ borderColor }}>
      <div className="quad-header">
        <span style={{ color: borderColor }}>
          {title} — Fatia {sliceIndex + 1}/{volume.dims[sliceAxisIdx]} ({slicePhysicalMm} mm)
        </span>
        <small>Arraste: Crosshairs 3D · Botão Direito/Shift: WW/WL</small>
      </div>
      <div
        ref={containerRef}
        className="quad-canvas"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          lastMouse.current = { x: e.clientX, y: e.clientY, ww, wl };
          if (e.button === 2 || e.shiftKey) {
            dragMode.current = 'window';
          } else {
            dragMode.current = 'crosshair';
            updateCrosshairFromEvent(e);
          }
        }}
        onPointerMove={(e) => {
          if (dragMode.current === 'window') {
            const dx = e.clientX - lastMouse.current.x;
            const dy = e.clientY - lastMouse.current.y;
            const nextWw = Math.max(20, Math.min(2500, lastMouse.current.ww + dx * 4));
            const nextWl = Math.max(-900, Math.min(900, lastMouse.current.wl - dy * 3));
            setWindow(nextWw, nextWl);
          } else if (dragMode.current === 'crosshair') {
            updateCrosshairFromEvent(e);
          } else {
            onHoverSample(eventToTexCoord(e), e.clientX, e.clientY);
          }
        }}
        onPointerUp={() => {
          dragMode.current = 'none';
        }}
        onPointerLeave={() => {
          dragMode.current = 'none';
          onHoverSample(null);
        }}
        onWheel={(e) => {
          const delta = e.deltaY > 0 ? 1 / 96 : -1 / 96;
          setCrosshair((prev) => {
            const next: [number, number, number] = [...prev];
            next[sliceAxisIdx] = clamp01(next[sliceAxisIdx] + delta);
            return next;
          });
        }}
      >
        <Canvas orthographic camera={{ position: [0, 0, 1], zoom: 1 }} dpr={[1, 2]}>
          <MprSliceQuad
            axis={axis}
            volume={volume}
            textures={textures}
            crosshair={crosshair}
            obliqueDeg={obliqueDeg}
            ww={ww}
            wl={wl}
            contrastMode={contrastMode}
            labelOpacity={labelOpacity}
            hoverLabel={hoverLabel}
          />
        </Canvas>
        {/* Radiological anatomical orientation markers and synchronized reading of the 3D Crosshairs */}
        <div
          style={{
            position: 'absolute',
            inset: 6,
            pointerEvents: 'none',
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            color: 'rgba(245, 240, 230, 0.72)',
          }}
        >
          <span style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)' }}>
            {axis === 0 ? 'A (Anterior)' : 'S (Superior)'}
          </span>
          <span
            style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)' }}
          >
            {axis === 0 ? 'P (Posterior)' : 'I (Inferior)'}
          </span>
          <span style={{ position: 'absolute', left: 2, top: '50%', transform: 'translateY(-50%)' }}>
            {axis === 2 ? 'A' : 'D (R)'}
          </span>
          <span style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)' }}>
            {axis === 2 ? 'P' : 'E (L)'}
          </span>
          <span
            style={{
              position: 'absolute',
              bottom: 0,
              right: 2,
              background: 'rgba(4, 6, 10, 0.78)',
              padding: '1px 5px',
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#93c5fd',
            }}
          >
            XYZ: [{Math.round(crosshair[0] * (volume.dims[0] - 1))},{' '}
            {Math.round(crosshair[1] * (volume.dims[1] - 1))},{' '}
            {Math.round(crosshair[2] * (volume.dims[2] - 1))}]
          </span>
        </div>
      </div>
    </div>
  );
}

function MprSliceQuad({
  axis,
  volume,
  textures,
  crosshair,
  obliqueDeg,
  ww,
  wl,
  contrastMode,
  labelOpacity,
  hoverLabel,
}: {
  axis: 0 | 1 | 2;
  volume: MedicalVolume;
  textures: { volTex: THREE.Data3DTexture; lblTex: THREE.Data3DTexture; lutTex: THREE.DataTexture };
  crosshair: [number, number, number];
  obliqueDeg: number;
  ww: number;
  wl: number;
  contrastMode: RadiologyContrastMode;
  labelOpacity: number;
  hoverLabel: number;
}) {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uVolumeTex: { value: textures.volTex },
      uLabelTex: { value: textures.lblTex },
      uLabelLut: { value: textures.lutTex },
      uAxis: { value: axis },
      uCrosshair: { value: new THREE.Vector3(...crosshair) },
      uObliqueRad: { value: 0 },
      uWindowWidth: { value: ww },
      uWindowLevel: { value: wl },
      uContrastMode: { value: contrastMode },
      uLabelOpacity: { value: labelOpacity },
      uHoverLabel: { value: hoverLabel },
      uVolumeDims: { value: new THREE.Vector3(...volume.dims) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useFrame(() => {
    const mat = matRef.current;
    if (!mat) return;
    mat.uniforms.uVolumeTex.value = textures.volTex;
    mat.uniforms.uLabelTex.value = textures.lblTex;
    mat.uniforms.uLabelLut.value = textures.lutTex;
    mat.uniforms.uAxis.value = axis;
    mat.uniforms.uCrosshair.value.set(crosshair[0], crosshair[1], crosshair[2]);
    mat.uniforms.uObliqueRad.value = (obliqueDeg * Math.PI) / 180;
    mat.uniforms.uWindowWidth.value = ww;
    mat.uniforms.uWindowLevel.value = wl;
    mat.uniforms.uContrastMode.value = contrastMode;
    mat.uniforms.uLabelOpacity.value = labelOpacity;
    mat.uniforms.uHoverLabel.value = hoverLabel;
    mat.uniforms.uVolumeDims.value.set(volume.dims[0], volume.dims[1], volume.dims[2]);
  });

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={MPR_VERTEX_SHADER}
        fragmentShader={MPR_FRAGMENT_SHADER}
        uniforms={uniforms}
      />
    </mesh>
  );
}

function RaymarchingVolumeMesh({
  volume,
  textures,
  transferLutTex,
  crosshair,
  transferPreset,
  ww,
  wl,
  clipActive,
  hoverLabel,
  vascularThresholdHu,
  onHoverVoxel3D,
}: {
  volume: MedicalVolume;
  textures: { volTex: THREE.Data3DTexture; lblTex: THREE.Data3DTexture; lutTex: THREE.DataTexture };
  transferLutTex: THREE.DataTexture;
  crosshair: [number, number, number];
  transferPreset: 0 | 1 | 2 | 3;
  ww: number;
  wl: number;
  clipActive: boolean;
  hoverLabel: number;
  vascularThresholdHu: number;
  onHoverVoxel3D: (
    tc: [number, number, number] | null,
    clientX?: number,
    clientY?: number,
  ) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const { camera } = useThree();
  const invMatrix = useMemo(() => new THREE.Matrix4(), []);
  const camLocal = useMemo(() => new THREE.Vector3(), []);

  // Step 1 — Correct anisotropic physical scale (physicalSizeMm = normalized dims × spacing)
  const boxScale = useMemo(() => {
    const [sx, sy, sz] = volume.physicalSizeMm;
    const maxS = Math.max(sx, sy, sz, 1);
    return [sx / maxS, sy / maxS, sz / maxS] as [number, number, number];
  }, [volume]);

  const uniforms = useMemo(
    () => ({
      uVolumeTex: { value: textures.volTex },
      uLabelTex: { value: textures.lblTex },
      uLabelLut: { value: textures.lutTex },
      uTransferLut: { value: transferLutTex },
      uCameraLocalPos: { value: new THREE.Vector3(0, -1.5, 0) },
      uTransferPreset: { value: transferPreset },
      uWindowWidth: { value: ww },
      uWindowLevel: { value: wl },
      uCrosshair: { value: new THREE.Vector3(...crosshair) },
      uClipActive: { value: clipActive ? 1 : 0 },
      uHoverLabel: { value: hoverLabel },
      uVolumeDims: { value: new THREE.Vector3(...volume.dims) },
      uVoxelSpacing: { value: new THREE.Vector3(...volume.spacing) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useFrame(() => {
    const mesh = meshRef.current;
    const mat = matRef.current;
    if (!mesh || !mat) return;

    invMatrix.copy(mesh.matrixWorld).invert();
    camLocal.copy(camera.position).applyMatrix4(invMatrix);

    mat.uniforms.uVolumeTex.value = textures.volTex;
    mat.uniforms.uLabelTex.value = textures.lblTex;
    mat.uniforms.uLabelLut.value = textures.lutTex;
    mat.uniforms.uTransferLut.value = transferLutTex;
    mat.uniforms.uCameraLocalPos.value.copy(camLocal);
    mat.uniforms.uTransferPreset.value = transferPreset;
    mat.uniforms.uWindowWidth.value = ww;
    mat.uniforms.uWindowLevel.value = wl;
    mat.uniforms.uCrosshair.value.set(crosshair[0], crosshair[1], crosshair[2]);
    mat.uniforms.uClipActive.value = clipActive ? 1 : 0;
    mat.uniforms.uHoverLabel.value = hoverLabel;
    mat.uniforms.uVolumeDims.value.set(volume.dims[0], volume.dims[1], volume.dims[2]);
    mat.uniforms.uVoxelSpacing.value.set(
      volume.spacing[0],
      volume.spacing[1],
      volume.spacing[2],
    );
  });

  // Step 4 — CPU ray-picking when hovering over the 3D model to identify the visible anatomical structure
  const handlePointerMove3D = (e: ThreeEvent<PointerEvent>) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    invMatrix.copy(mesh.matrixWorld).invert();
    const ro = camera.position.clone().applyMatrix4(invMatrix);
    const hitLocal = e.point.clone().applyMatrix4(invMatrix);
    const rd = hitLocal.sub(ro).normalize();

    // Intersects the cube [-0.5, +0.5]^3
    const [nx, ny, nz] = volume.dims;
    const minHuThreshold = transferPreset === 1 ? 260 : transferPreset === 2 ? -840 : Math.min(55, vascularThresholdHu);
    for (let step = 0; step < 96; step++) {
      const t = 0.2 + step * 0.022;
      const p = ro.clone().addScaledVector(rd, t);
      const tx = p.x + 0.5;
      const ty = p.y + 0.5;
      const tz = p.z + 0.5;
      if (tx < 0 || tx > 1 || ty < 0 || ty > 1 || tz < 0 || tz > 1) continue;
      if (clipActive && tx > crosshair[0] && ty < crosshair[1] && tz > crosshair[2]) continue;

      const ix = clampInt(Math.floor(tx * nx), 0, nx - 1);
      const iy = clampInt(Math.floor(ty * ny), 0, ny - 1);
      const iz = clampInt(Math.floor(tz * nz), 0, nz - 1);
      const flat = iz * nx * ny + iy * nx + ix;
      const hu = volume.huData[flat];
      const lbl = volume.labelData[flat];
      if (lbl > 0 && lbl !== 14 && hu >= minHuThreshold) {
        onHoverVoxel3D([tx, ty, tz], e.nativeEvent.clientX, e.nativeEvent.clientY);
        return;
      }
    }
    onHoverVoxel3D(null);
  };

  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <mesh
        ref={meshRef}
        scale={boxScale}
        onPointerMove={handlePointerMove3D}
        onPointerOut={() => onHoverVoxel3D(null)}
      >
        <boxGeometry args={[1, 1, 1]} />
        <shaderMaterial
          ref={matRef}
          vertexShader={RAYMARCH_VERTEX_SHADER}
          fragmentShader={RAYMARCH_FRAGMENT_SHADER}
          uniforms={uniforms}
          transparent
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampInt(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
