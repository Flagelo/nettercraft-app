import * as nifti from 'nifti-reader-js';
import { gunzipSync } from 'fflate';
import dicomParser from 'dicom-parser';

/**
 * Volumetric Data and WebGL2 Pipeline (NIfTI .nii/.nii.gz via nifti-reader-js & DICOM .dcm series)
 * + 4×4 Affine Transformation Matrix (anisotropy correction in mm), Hounsfield (HU) conversion,
 * 1D Transfer Function (256×1 RGBA) and Netter Labelmaps (Liver Segment VI, IVC, Aorta, Heart, Lungs).
 */

export interface AnatomicalLabelInfo {
  id: number;
  name: string;
  system: string;
  /** Netter watercolor-style palette (RGB 0..1) */
  color: [number, number, number];
  typicalHu: number;
}

export const ANATOMICAL_LABELS: Record<number, AnatomicalLabelInfo> = {
  0: {
    id: 0,
    name: 'Ar / Fundo Extracorpóreo',
    system: 'Externo',
    color: [0.0, 0.0, 0.0],
    typicalHu: -1000,
  },
  1: {
    id: 1,
    name: 'Parênquima Pulmonar Direito',
    system: 'Sistema Respiratório',
    color: [0.34, 0.68, 0.88],
    typicalHu: -820,
  },
  2: {
    id: 2,
    name: 'Parênquima Pulmonar Esquerdo',
    system: 'Sistema Respiratório',
    color: [0.28, 0.76, 0.84],
    typicalHu: -815,
  },
  3: {
    id: 3,
    name: 'Ventrículo Esquerdo (Cavidade Arterial Contrastada)',
    system: 'Sistema Cardiovascular',
    color: [0.86, 0.22, 0.24],
    typicalHu: 325,
  },
  4: {
    id: 4,
    name: 'Miocárdio Ventricular Esquerdo',
    system: 'Sistema Cardiovascular',
    color: [0.76, 0.34, 0.38],
    typicalHu: 55,
  },
  5: {
    id: 5,
    name: 'Ventrículo Direito & Átrio Direito',
    system: 'Sistema Cardiovascular',
    color: [0.24, 0.46, 0.84],
    typicalHu: 265,
  },
  6: {
    id: 6,
    name: 'Aorta Torácica (Ascendente, Arco e Descendente)',
    system: 'Sistema Cardiovascular',
    color: [0.92, 0.18, 0.18],
    typicalHu: 375,
  },
  7: {
    id: 7,
    name: 'Tronco e Artérias Pulmonares',
    system: 'Sistema Cardiovascular',
    color: [0.36, 0.54, 0.92],
    typicalHu: 295,
  },
  8: {
    id: 8,
    name: 'Coluna Vertebral Torácica (Corpo e Arco Neural)',
    system: 'Sistema Esquelético',
    color: [0.94, 0.88, 0.68],
    typicalHu: 880,
  },
  9: {
    id: 9,
    name: 'Arcabouço Costal e Esterno',
    system: 'Sistema Esquelético',
    color: [0.90, 0.82, 0.58],
    typicalHu: 950,
  },
  10: {
    id: 10,
    name: 'Fígado — Segmentos VII/VIII (Cúpula Diafragmática)',
    system: 'Sistema Hepatobiliar',
    color: [0.74, 0.38, 0.26],
    typicalHu: 64,
  },
  11: {
    id: 11,
    name: 'Parênquima Encefálico (Córtex e Substância Branca)',
    system: 'Sistema Nervoso Central',
    color: [0.88, 0.62, 0.74],
    typicalHu: 36,
  },
  12: {
    id: 12,
    name: 'Sistema Ventricular Lateral (Líquor / LCR)',
    system: 'Sistema Nervoso Central',
    color: [0.24, 0.78, 0.94],
    typicalHu: 8,
  },
  13: {
    id: 13,
    name: 'Calota Craniana (Díploe e Tábua Óssea)',
    system: 'Sistema Esquelético',
    color: [0.96, 0.92, 0.76],
    typicalHu: 1180,
  },
  14: {
    id: 14,
    name: 'Partes Moles / Musculatura Torácica e Subcutâneo',
    system: 'Sistema Musculoesquelético',
    color: [0.68, 0.48, 0.38],
    typicalHu: 35,
  },
  15: {
    id: 15,
    name: 'Segmento VI do Fígado (Posteroinferior Direito)',
    system: 'Sistema Hepatobiliar (Couinaud VI)',
    color: [0.82, 0.45, 0.24],
    typicalHu: 68,
  },
  16: {
    id: 16,
    name: 'Veia Cava Inferior (VCI Supra-Hepática / Atriocaval)',
    system: 'Sistema Cardiovascular Venoso',
    color: [0.18, 0.52, 0.90],
    typicalHu: 215,
  },
};

export const NUM_ANATOMICAL_LABELS = 17;

export interface MedicalVolume {
  title: string;
  modality: 'CT' | 'MR';
  dims: [number, number, number];           // [nx, ny, nz] in voxels
  spacing: [number, number, number];        // [dx, dy, dz] in mm (Pixel Spacing + Slice Thickness)
  physicalSizeMm: [number, number, number]; // [nx*dx, ny*dy, nz*dz] in mm (anisotropic physical scale)
  affine: number[][];                       // 4×4 Affine Transformation Matrix (voxel [i,j,k,1] -> world [x,y,z,1] mm)
  huData: Float32Array;                     // Hounsfield units (HU = raw * slope + intercept)
  labelData: Uint8Array;                    // anatomical segmentation IDs (0..255)
  anonymizedMeta: Record<string, string>;
  huMin: number;
  huMax: number;
}

/**
 * Builds a standard 4×4 affine transformation matrix (centered at the origin, in mm)
 * from the dimensions `[nx, ny, nz]` and physical spacing `[dx, dy, dz]` (Pixel Spacing & Slice Thickness).
 */
export function buildPhysicalAffineMatrix(
  dims: [number, number, number],
  spacing: [number, number, number],
  origin: [number, number, number] = [0, 0, 0],
): number[][] {
  const [dx, dy, dz] = spacing;
  return [
    [dx, 0, 0, origin[0]],
    [0, dy, 0, origin[1]],
    [0, 0, dz, origin[2]],
    [0, 0, 0, 1],
  ];
}

/**
 * Converts voxel coordinates `[ix, iy, iz]` to physical coordinates `(x, y, z)` in millimeters
 * by applying the volume's 4×4 affine transformation matrix.
 */
export function voxelToPhysicalMm(
  affine: number[][],
  ix: number,
  iy: number,
  iz: number,
): [number, number, number] {
  const r0 = affine[0] ?? [1, 0, 0, 0];
  const r1 = affine[1] ?? [0, 1, 0, 0];
  const r2 = affine[2] ?? [0, 0, 1, 0];
  const x = r0[0] * ix + r0[1] * iy + r0[2] * iz + (r0[3] || 0);
  const y = r1[0] * ix + r1[1] * iy + r1[2] * iz + (r1[3] || 0);
  const z = r2[0] * ix + r2[1] * iy + r2[2] * iz + (r2[3] || 0);
  return [Number(x.toFixed(1)), Number(y.toFixed(1)), Number(z.toFixed(1))];
}

/**
 * Generates the RGBA bytes (256 × 1 × 4) of the 1D Transfer Function Texture (`uTransferLut`),
 * mapping the [-1000 HU .. +1500 HU] range to color and opacity according to the UI sliders:
 *  - `vascularThresholdHu` (e.g. > 150 HU becomes translucent arterial red)
 *  - `boneThresholdHu` (e.g. > 400 HU becomes opaque white/ivory)
 *  - `opacityScale` (global 3D opacity multiplier)
 */
export function buildTransferFunction1DLut(
  preset: 0 | 1 | 2 | 3,
  vascularThresholdHu: number,
  boneThresholdHu: number,
  opacityScale: number,
): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  const huMin = -1000;
  const huMax = 1500;
  const span = huMax - huMin;

  for (let i = 0; i < 256; i++) {
    const hu = huMin + (i / 255) * span;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;

    if (preset === 0) {
      // Preset 0: CT angiography (Vascular contrast > vascularThresholdHu in red, Bone > boneThresholdHu in white/ivory)
      if (hu >= boneThresholdHu) {
        const t = Math.min(1, (hu - boneThresholdHu) / 550);
        r = 0.94 + 0.06 * t;
        g = 0.91 + 0.07 * t;
        b = 0.82 + 0.14 * t;
        a = Math.min(0.95, (0.28 + 0.58 * t) * opacityScale);
      } else if (hu >= vascularThresholdHu) {
        const t = Math.min(1, (hu - vascularThresholdHu) / Math.max(40, boneThresholdHu - vascularThresholdHu));
        r = 0.88 + 0.12 * t;
        g = 0.16 + 0.12 * t;
        b = 0.16 + 0.08 * t;
        a = Math.min(0.85, (0.14 + 0.34 * t) * opacityScale);
      } else if (hu >= 25 && hu < vascularThresholdHu) {
        // Faint hepatic / myocardial parenchyma, Netter style
        r = 0.76;
        g = 0.42;
        b = 0.32;
        a = Math.min(0.25, 0.022 * opacityScale);
      }
    } else if (preset === 1) {
      // Preset 1: Cortical Bone / 3D Skeleton (> boneThresholdHu)
      if (hu >= boneThresholdHu * 0.65) {
        const t = Math.min(1, Math.max(0, (hu - boneThresholdHu * 0.65) / 650));
        r = 0.84 + 0.15 * t;
        g = 0.72 + 0.25 * t;
        b = 0.52 + 0.40 * t;
        a = Math.min(0.98, (0.18 + 0.68 * t) * opacityScale);
      }
    } else if (preset === 2) {
      // Preset 2: Lung Parenchyma & Bronchovascular Tree
      if (hu >= -860 && hu <= -320) {
        const t = (hu + 860) / 540;
        r = 0.22;
        g = 0.74;
        b = 0.95;
        a = Math.min(0.45, 0.075 * t * opacityScale);
      } else if (hu >= vascularThresholdHu) {
        r = 0.92;
        g = 0.25;
        b = 0.25;
        a = Math.min(0.65, 0.16 * opacityScale);
      }
    } else {
      // Preset 3: MIP
      const t = Math.max(0, Math.min(1, (hu + 200) / 1200));
      r = t;
      g = t;
      b = t;
      a = t;
    }

    lut[i * 4] = Math.round(Math.max(0, Math.min(1, r)) * 255);
    lut[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
    lut[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
    lut[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
  return lut;
}

/**
 * Step 1 — Loads a NIfTI buffer (.nii or .nii.gz) using `nifti-reader-js`:
 *  1. Decompresses `.nii.gz` via `nifti.isCompressed` / `nifti.decompress` (or `fflate` fallback).
 *  2. Reads the header (`nifti.readHeader`), extracting `dims[1..3]`, `pixDims[1..3]` (Pixel Spacing and Slice Thickness)
 *     and the 4×4 affine transformation matrix (`header.affine`), ensuring anisotropic voxel correction in mm.
 *  3. Converts raw voxel values using Rescale Slope (`scl_slope`) and Intercept (`scl_inter`)
 *     to Hounsfield Units (`HU = raw * slope + inter`).
 */
export function parseNiftiArrayBuffer(
  rawArrayBuffer: ArrayBuffer,
  title = 'Volume NIfTI (.nii.gz)',
): MedicalVolume {
  let dataBuffer: ArrayBuffer = rawArrayBuffer;

  if (nifti.isCompressed(dataBuffer)) {
    const decompressed = nifti.decompress(dataBuffer);
    dataBuffer = (
      decompressed instanceof ArrayBuffer
        ? decompressed
        : new Uint8Array(decompressed).slice().buffer
    ) as ArrayBuffer;
  } else {
    const u8 = new Uint8Array(dataBuffer);
    if (u8[0] === 0x1f && u8[1] === 0x8b) {
      const unzipped = gunzipSync(u8);
      dataBuffer = unzipped.slice().buffer as ArrayBuffer;
    }
  }

  if (!nifti.isNIFTI(dataBuffer)) {
    throw new Error('O arquivo selecionado não possui cabeçalho NIfTI-1/NIfTI-2 válido.');
  }

  const header = nifti.readHeader(dataBuffer);
  const imageBuffer = nifti.readImage(header, dataBuffer);

  const nx = Math.max(1, header.dims[1] || 1);
  const ny = Math.max(1, header.dims[2] || 1);
  const nz = Math.max(1, header.dims[3] || 1);

  const dx = Math.abs(header.pixDims[1]) || 1.0;
  const dy = Math.abs(header.pixDims[2]) || 1.0;
  const dz = Math.abs(header.pixDims[3]) || 1.0;
  const spacing: [number, number, number] = [dx, dy, dz];
  const physicalSizeMm: [number, number, number] = [
    Number((nx * dx).toFixed(2)),
    Number((ny * dy).toFixed(2)),
    Number((nz * dz).toFixed(2)),
  ];

  // Extract the 4×4 affine matrix from the NIfTI header (sform/qform) or build it from the physical spacing
  const affine: number[][] =
    header.affine && header.affine.length === 4
      ? header.affine.map((row) => [
          Math.abs(row[0]) || (row === header.affine[0] ? dx : 0),
          Math.abs(row[1]) || (row === header.affine[1] ? dy : 0),
          Math.abs(row[2]) || (row === header.affine[2] ? dz : 0),
          row[3] || 0,
        ])
      : buildPhysicalAffineMatrix([nx, ny, nz], spacing);

  let slope = header.scl_slope;
  const inter = header.scl_inter || 0;
  if (!Number.isFinite(slope) || slope === 0) slope = 1.0;

  const total = nx * ny * nz;
  const huData = new Float32Array(total);
  const dv = new DataView(imageBuffer);
  const littleEndian = header.littleEndian !== false;
  const dtCode = header.datatypeCode;

  let huMin = Infinity;
  let huMax = -Infinity;

  let ptr = 0;
  for (let i = 0; i < total && ptr < dv.byteLength; i++) {
    let raw = 0;
    if (dtCode === nifti.NIFTI1.TYPE_UINT8) {
      raw = dv.getUint8(ptr);
      ptr += 1;
    } else if (dtCode === nifti.NIFTI1.TYPE_INT8) {
      raw = dv.getInt8(ptr);
      ptr += 1;
    } else if (dtCode === nifti.NIFTI1.TYPE_INT16) {
      raw = dv.getInt16(ptr, littleEndian);
      ptr += 2;
    } else if (dtCode === nifti.NIFTI1.TYPE_UINT16) {
      raw = dv.getUint16(ptr, littleEndian);
      ptr += 2;
    } else if (dtCode === nifti.NIFTI1.TYPE_INT32) {
      raw = dv.getInt32(ptr, littleEndian);
      ptr += 4;
    } else if (dtCode === nifti.NIFTI1.TYPE_UINT32) {
      raw = dv.getUint32(ptr, littleEndian);
      ptr += 4;
    } else if (dtCode === nifti.NIFTI1.TYPE_FLOAT32) {
      raw = dv.getFloat32(ptr, littleEndian);
      ptr += 4;
    } else if (dtCode === nifti.NIFTI1.TYPE_FLOAT64) {
      raw = dv.getFloat64(ptr, littleEndian);
      ptr += 8;
    } else {
      raw = dv.getInt16(ptr, littleEndian);
      ptr += 2;
    }

    const hu = raw * slope + inter;
    huData[i] = hu;
    if (hu < huMin) huMin = hu;
    if (hu > huMax) huMax = hu;
  }

  const labelData = deriveHeuristicLabelsFromHu(huData, [nx, ny, nz]);

  return {
    title,
    modality: huMin < -200 ? 'CT' : 'MR',
    dims: [nx, ny, nz],
    spacing,
    physicalSizeMm,
    affine,
    huData,
    labelData,
    anonymizedMeta: {
      Formato: 'NIfTI (nifti-reader-js)',
      Dimensões: `${nx}×${ny}×${nz}`,
      Espaçamento: `${dx.toFixed(2)}×${dy.toFixed(2)}×${dz.toFixed(2)} mm`,
      Escala: `HU = raw × ${slope.toFixed(2)} + ${inter.toFixed(1)}`,
      Paciente: 'ANONIMIZADO (Client-Side / Radiopaedia-TCIA)',
    },
    huMin: Number.isFinite(huMin) ? huMin : -1000,
    huMax: Number.isFinite(huMax) ? huMax : 1500,
  };
}

export async function loadNiftiFile(file: File): Promise<MedicalVolume> {
  const rawArrayBuffer = await file.arrayBuffer();
  return parseNiftiArrayBuffer(rawArrayBuffer, file.name);
}

/**
 * Loads an anonymized local/remote NIfTI file from a URL (e.g. `/volumes/sample_thorax_abdomen_anon.nii.gz`).
 */
export async function loadNiftiFromUrl(url: string, customTitle?: string): Promise<MedicalVolume> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Falha ao buscar volume NIfTI em ${url} (HTTP ${response.status})`);
  }
  const buf = await response.arrayBuffer();
  const fileName = customTitle ?? (url.split('/').pop() || 'sample.nii.gz');
  return parseNiftiArrayBuffer(buf, fileName);
}

/**
 * Step 4 — Loads a second masked NIfTI file (.nii / .nii.gz) and injects it as
 * the second Data3DTexture (anatomical segmentation Labelmap).
 */
export async function loadNiftiLabelmapIntoVolume(
  file: File,
  baseVol: MedicalVolume,
): Promise<MedicalVolume> {
  const segVol = await loadNiftiFile(file);
  const total = baseVol.dims[0] * baseVol.dims[1] * baseVol.dims[2];
  const labelData = new Uint8Array(total);
  const len = Math.min(total, segVol.huData.length);
  for (let i = 0; i < len; i++) {
    labelData[i] = Math.max(0, Math.min(255, Math.round(segVol.huData[i])));
  }
  return { ...baseVol, labelData };
}

/**
 * Loads a series of local DICOM (.dcm) files, performs client-side anonymization
 * by removing all PHI tags (0010,xxxx), sorts by spatial projection ImagePositionPatient (0020,0032),
 * extracts PixelSpacing / SliceThickness, builds the 4×4 affine matrix and converts to Hounsfield Units (HU).
 */
export async function loadDicomSeries(files: FileList | File[]): Promise<MedicalVolume> {
  const list = Array.from(files).filter(
    (f) => f.name.toLowerCase().endsWith('.dcm') || !f.name.includes('../../view/radiology'),
  );
  if (list.length === 0) {
    throw new Error('Nenhum arquivo DICOM (.dcm) encontrado na seleção.');
  }

  interface ParsedSlice {
    zCoord: number;
    rows: number;
    cols: number;
    rowSpacing: number;
    colSpacing: number;
    sliceThick: number;
    slope: number;
    intercept: number;
    modality: 'CT' | 'MR';
    huSlice: Float32Array;
  }

  const slices: ParsedSlice[] = [];

  for (const file of list) {
    const byteArray = new Uint8Array(await file.arrayBuffer());
    const dataSet = dicomParser.parseDicom(byteArray);

    const rows = dataSet.uint16('x00280010') || 256;
    const cols = dataSet.uint16('x00280011') || 256;
    const bitsAllocated = dataSet.uint16('x00280100') || 16;
    const pixelRep = dataSet.uint16('x00280103') || 0;
    const slope = parseFloat(dataSet.string('x00281053') || '1') || 1;
    const intercept = parseFloat(dataSet.string('x00281052') || '0') || 0;
    const modalityStr = (dataSet.string('x00080060') || 'CT').toUpperCase();
    const modality: 'CT' | 'MR' = modalityStr.includes('MR') ? 'MR' : 'CT';

    const psStr = dataSet.string('x00280030') || '1.0\\1.0';
    const psParts = psStr.split('\\').map((s) => parseFloat(s) || 1.0);
    const rowSpacing = psParts[0] || 1.0;
    const colSpacing = psParts[1] || rowSpacing;
    const sliceThick = parseFloat(dataSet.string('x00180050') || '1.5') || 1.5;

    const ippStr = dataSet.string('x00200032');
    let zCoord = parseFloat(dataSet.string('x00201041') || '0') || 0;
    if (ippStr) {
      const parts = ippStr.split('\\').map((s) => parseFloat(s) || 0);
      if (parts.length >= 3) zCoord = parts[2];
    }

    const pixelElement = dataSet.elements.x7fe00010;
    if (!pixelElement) continue;

    const nPixels = rows * cols;
    const huSlice = new Float32Array(nPixels);
    const dv = new DataView(
      byteArray.buffer,
      byteArray.byteOffset + pixelElement.dataOffset,
      pixelElement.length,
    );

    for (let i = 0; i < nPixels; i++) {
      let raw = 0;
      if (bitsAllocated === 8) {
        raw = dv.getUint8(i);
      } else if (pixelRep === 1) {
        raw = dv.getInt16(i * 2, true);
      } else {
        raw = dv.getUint16(i * 2, true);
      }
      huSlice[i] = raw * slope + intercept;
    }

    slices.push({
      zCoord,
      rows,
      cols,
      rowSpacing,
      colSpacing,
      sliceThick,
      slope,
      intercept,
      modality,
      huSlice,
    });
  }

  slices.sort((a, b) => a.zCoord - b.zCoord);
  const first = slices[0];
  const nx = first.cols;
  const ny = first.rows;
  const nz = slices.length;
  const dz =
    nz > 1
      ? Math.abs((slices[nz - 1].zCoord - slices[0].zCoord) / (nz - 1)) || first.sliceThick
      : first.sliceThick;

  const huData = new Float32Array(nx * ny * nz);
  let huMin = Infinity;
  let huMax = -Infinity;

  for (let z = 0; z < nz; z++) {
    const sl = slices[z].huSlice;
    const zOff = z * nx * ny;
    for (let i = 0; i < sl.length && i < nx * ny; i++) {
      const v = sl[i];
      huData[zOff + i] = v;
      if (v < huMin) huMin = v;
      if (v > huMax) huMax = v;
    }
  }

  const spacing: [number, number, number] = [first.colSpacing, first.rowSpacing, dz];
  const physicalSizeMm: [number, number, number] = [
    nx * spacing[0],
    ny * spacing[1],
    nz * spacing[2],
  ];
  const affine = buildPhysicalAffineMatrix([nx, ny, nz], spacing);
  const labelData = deriveHeuristicLabelsFromHu(huData, [nx, ny, nz]);

  return {
    title: `Série DICOM (${nz} fatias)`,
    modality: first.modality,
    dims: [nx, ny, nz],
    spacing,
    physicalSizeMm,
    affine,
    huData,
    labelData,
    anonymizedMeta: {
      Modalidade: first.modality,
      Dimensões: `${nx}×${ny}×${nz}`,
      PixelSpacing: `${first.colSpacing.toFixed(2)}×${first.rowSpacing.toFixed(2)} mm`,
      SliceThickness: `${dz.toFixed(2)} mm`,
      Paciente: 'ANONIMIZADO [Tags 0010,xxxx removidas]',
    },
    huMin,
    huMax,
  };
}

function deriveHeuristicLabelsFromHu(
  hu: Float32Array,
  dims: [number, number, number],
): Uint8Array {
  const [nx, ny, nz] = dims;
  const out = new Uint8Array(hu.length);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = z * nx * ny + y * nx + x;
        const v = hu[i];
        if (v < -900) out[i] = 0;
        else if (v < -450) out[i] = x < nx * 0.5 ? 1 : 2;
        else if (v > 520) out[i] = y > ny * 0.62 ? 8 : 9;
        else if (v > 180) out[i] = 6;
        else if (v >= 50 && v <= 85 && z < nz * 0.35 && x < nx * 0.55) {
          out[i] = y > ny * 0.5 ? 15 : 10; // Segment VI vs Hepatic Dome
        } else out[i] = 14;
      }
    }
  }
  return out;
}

/**
 * Generates a 3D Anatomical Phantom of Thoracoabdominal CT Angiography (96×96×96 voxels, anisotropic spacing 3.0×2.6×2.8 mm)
 * with exact Hounsfield Units and Netter Labelmap (including Liver Segment VI, Hepatic Dome VII/VIII,
 * Inferior Vena Cava, Thoracic Aorta, Heart, Lungs and Thoracic Skeleton).
 */
export function buildThoraxAngioCtPhantom(): MedicalVolume {
  const nx = 96;
  const ny = 96;
  const nz = 96;
  const spacing: [number, number, number] = [3.0, 2.6, 2.8];
  const physicalSizeMm: [number, number, number] = [
    Number((nx * spacing[0]).toFixed(2)),
    Number((ny * spacing[1]).toFixed(2)),
    Number((nz * spacing[2]).toFixed(2)),
  ];
  const affine = buildPhysicalAffineMatrix([nx, ny, nz], spacing);
  const total = nx * ny * nz;
  const huData = new Float32Array(total);
  const labelData = new Uint8Array(total);

  for (let z = 0; z < nz; z++) {
    const zn = (z / (nz - 1)) * 2 - 1; // -1 (upper abdomen / liver) .. +1 (lung apices)
    for (let y = 0; y < ny; y++) {
      const yn = (y / (ny - 1)) * 2 - 1; // -1 (anterior/sternum) .. +1 (posterior/spine)
      for (let x = 0; x < nx; x++) {
        const xn = (x / (nx - 1)) * 2 - 1; // -1 (anatomical right) .. +1 (anatomical left)
        const idx = z * nx * ny + y * nx + x;

        const noise =
          ((Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453) % 1) * 12;

        const bodyEll = (xn * xn) / (0.86 * 0.86) + (yn * yn) / (0.64 * 0.64);
        if (bodyEll > 1.0) {
          huData[idx] = -1000;
          labelData[idx] = 0;
          continue;
        }

        let hu = bodyEll > 0.86 ? -92 + noise : 38 + noise;
        let label = 14;

        // 1. Right (xn < 0) and Left (xn > 0) Lung Parenchyma (-820 HU)
        const lungR =
          ((xn + 0.4) / 0.36) ** 2 + ((yn + 0.02) / 0.46) ** 2 + ((zn - 0.1) / 0.76) ** 2;
        const lungL =
          ((xn - 0.42) / 0.34) ** 2 + ((yn + 0.02) / 0.45) ** 2 + ((zn - 0.1) / 0.74) ** 2;
        if (lungR < 1.0 && zn > -0.56) {
          const vesselTree = Math.pow(
            0.5 + 0.5 * Math.sin(x * 0.55) * Math.cos(y * 0.55) * Math.sin(z * 0.45),
            6,
          );
          hu = -825 + 240 * vesselTree + noise;
          label = 1;
        } else if (lungL < 1.0 && zn > -0.52) {
          const vesselTree = Math.pow(
            0.5 + 0.5 * Math.sin(x * 0.55) * Math.cos(y * 0.55) * Math.sin(z * 0.45),
            6,
          );
          hu = -820 + 240 * vesselTree + noise;
          label = 2;
        }

        // 2. Liver: Diaphragmatic Dome (Segments VII/VIII, label 10) and Right Posteroinferior Segment VI (label 15)
        const liverEll =
          ((xn + 0.28) / 0.54) ** 2 + ((yn + 0.02) / 0.48) ** 2 + ((zn + 0.74) / 0.46) ** 2;
        if (liverEll < 1.0) {
          if (xn < -0.18 && yn > 0.02 && zn < -0.58) {
            // Liver Segment VI (Couinaud right posteroinferior)
            hu = 68 + noise * 0.6;
            label = 15;
          } else {
            // Segments VII / VIII of the Hepatic Dome
            hu = 63 + noise * 0.6;
            label = 10;
          }
        }

        // 3. Inferior Vena Cava (Suprahepatic / Subdiaphragmatic IVC draining into the Right Atrium, label 16)
        const ivcDist = Math.hypot(xn + 0.12, yn - 0.06);
        if (ivcDist < 0.095 && zn >= -0.95 && zn <= -0.05) {
          hu = 215 + noise;
          label = 16;
        }

        // 4. Heart: Left Ventricle (cavity +325 HU, myocardium +55 HU) and Right Chambers (+265 HU)
        const lvDist = Math.hypot(
          (xn - 0.18) / 0.24,
          (yn + 0.14) / 0.22,
          (zn + 0.18) / 0.36,
        );
        if (lvDist < 1.0) {
          if (lvDist < 0.72) {
            hu = 325 + noise;
            label = 3;
          } else {
            hu = 56 + noise;
            label = 4;
          }
        }
        const rvDist = Math.hypot(
          (xn + 0.06) / 0.22,
          (yn + 0.28) / 0.16,
          (zn + 0.15) / 0.34,
        );
        if (rvDist < 0.92 && lvDist >= 0.88) {
          hu = 265 + noise;
          label = 5;
        }

        // 5. Contrast-enhanced Thoracic Aorta (+375 HU): Ascending, Arch and Descending
        const aoAsc =
          Math.hypot(xn - 0.04, yn + 0.06) < 0.105 && zn > -0.05 && zn < 0.48;
        const aoArch =
          Math.hypot(Math.hypot(xn - 0.08, yn - 0.08) - 0.16, zn - 0.48) < 0.095 &&
          zn >= 0.36;
        const aoDesc = Math.hypot(xn - 0.11, yn - 0.24) < 0.095 && zn < 0.48;
        if (aoAsc || aoArch || aoDesc) {
          hu = 378 + noise;
          label = 6;
        }

        // 6. Pulmonary Trunk and Arteries (+295 HU)
        const paTrunk = Math.hypot(xn - 0.1, yn + 0.18, zn - 0.24) < 0.11;
        const paBranches =
          Math.abs(zn - 0.26) < 0.07 &&
          Math.abs(yn + 0.06) < 0.075 &&
          Math.abs(xn) < 0.36;
        if (paTrunk || paBranches) {
          hu = 295 + noise;
          label = 7;
        }

        // 7. Posterior Thoracic Spine (+440..+1050 HU)
        const spineDist = Math.hypot(xn / 0.15, (yn - 0.42) / 0.14);
        if (spineDist < 1.0) {
          hu = spineDist > 0.72 ? 1050 + noise : 440 + noise;
          label = 8;
        }

        // 8. Anterior Sternum and Rib Cage (+960 HU)
        const sternum =
          Math.abs(xn) < 0.09 &&
          Math.abs(yn + 0.56) < 0.045 &&
          zn > -0.55 &&
          zn < 0.65;
        const ribRing =
          Math.abs(bodyEll - 0.78) < 0.045 &&
          Math.sin(z * 1.15 + Math.abs(xn) * 2.2) > 0.42;
        if (sternum || ribRing) {
          hu = 960 + noise;
          label = 9;
        }

        huData[idx] = hu;
        labelData[idx] = label;
      }
    }
  }

  return {
    title: 'Angio-TC Toracoabdominal 3D (Coração, Aorta, VCI & Fígado Seg. VI)',
    modality: 'CT',
    dims: [nx, ny, nz],
    spacing,
    physicalSizeMm,
    affine,
    huData,
    labelData,
    anonymizedMeta: {
      Modalidade: 'Angio-TC Multislice',
      Dimensões: `${nx}×${ny}×${nz}`,
      Espaçamento: `${spacing[0]}×${spacing[1]}×${spacing[2]} mm`,
      Unidade: 'Hounsfield Units (HU)',
      Paciente: 'PHANTOM ANATÔMICO (Client-Side)',
    },
    huMin: -1000,
    huMax: 1200,
  };
}

/**
 * Generates a 3D Anatomical Phantom of Skull / Brain (compatible with CT windowing of Parenchyma/Bone
 * and multiparametric MR synthesis of T1, T2 and FLAIR).
 */
export function buildBrainNeuroPhantom(): MedicalVolume {
  const nx = 96;
  const ny = 96;
  const nz = 96;
  const spacing: [number, number, number] = [2.2, 2.2, 2.4];
  const physicalSizeMm: [number, number, number] = [
    Number((nx * spacing[0]).toFixed(2)),
    Number((ny * spacing[1]).toFixed(2)),
    Number((nz * spacing[2]).toFixed(2)),
  ];
  const affine = buildPhysicalAffineMatrix([nx, ny, nz], spacing);
  const total = nx * ny * nz;
  const huData = new Float32Array(total);
  const labelData = new Uint8Array(total);

  for (let z = 0; z < nz; z++) {
    const zn = (z / (nz - 1)) * 2 - 1;
    for (let y = 0; y < ny; y++) {
      const yn = (y / (ny - 1)) * 2 - 1;
      for (let x = 0; x < nx; x++) {
        const xn = (x / (nx - 1)) * 2 - 1;
        const idx = z * nx * ny + y * nx + x;
        const noise =
          ((Math.sin(x * 19.1 + y * 47.3 + z * 61.7) * 43758.5453) % 1) * 4;

        const headEll =
          (xn / 0.76) ** 2 + (yn / 0.88) ** 2 + (zn / 0.82) ** 2;
        if (headEll > 1.0) {
          huData[idx] = -1000;
          labelData[idx] = 0;
          continue;
        }

        if (headEll > 0.84) {
          huData[idx] = 1180 + noise * 5;
          labelData[idx] = 13;
          continue;
        }

        const gyri = Math.sin(xn * 14) * Math.cos(yn * 14) * Math.sin(zn * 10);
        let hu = headEll > 0.62 || gyri > 0.25 ? 39 + noise : 29 + noise;
        let label = 11;

        const ventL =
          ((xn - 0.16) / 0.11) ** 2 +
          ((yn + 0.02) / 0.28) ** 2 +
          ((zn - 0.04) / 0.16) ** 2;
        const ventR =
          ((xn + 0.16) / 0.11) ** 2 +
          ((yn + 0.02) / 0.28) ** 2 +
          ((zn - 0.04) / 0.16) ** 2;
        if (ventL < 1.0 || ventR < 1.0) {
          hu = 8 + noise * 0.5;
          label = 12;
        }

        const mcaVessel =
          Math.abs(zn + 0.22) < 0.05 &&
          Math.abs(yn + 0.12) < 0.05 &&
          Math.abs(xn) < 0.42;
        if (mcaVessel) {
          hu = 265 + noise;
          label = 6;
        }

        huData[idx] = hu;
        labelData[idx] = label;
      }
    }
  }

  return {
    title: 'Neuro TC / RM Encefálica 3D (Córtex, Ventrículos, Polígono de Willis e Crânio)',
    modality: 'CT',
    dims: [nx, ny, nz],
    spacing,
    physicalSizeMm,
    affine,
    huData,
    labelData,
    anonymizedMeta: {
      Modalidade: 'TC / RM Neuro Multimodal',
      Dimensões: `${nx}×${ny}×${nz}`,
      Espaçamento: `${spacing[0]}×${spacing[1]}×${spacing[2]} mm`,
      Unidade: 'Hounsfield Units (HU) + Síntese T1/T2/FLAIR',
      Paciente: 'PHANTOM NEURO (Client-Side)',
    },
    huMin: -1000,
    huMax: 1300,
  };
}
