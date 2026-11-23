import { describe, expect, it } from 'vitest';
import { usePhysiologyStore } from '../../controller/usePhysiologyStore';
import {
  ANATOMICAL_LABELS,
  buildPhysicalAffineMatrix,
  buildThoraxAngioCtPhantom,
  buildTransferFunction1DLut,
  voxelToPhysicalMm,
} from './volumeLoader';

describe('Multiplanar Reconstruction and 3D Raymarching Engine (DICOM/NIfTI)', () => {
  it('corrects anisotropic voxels in millimeters through the 4x4 affine transformation matrix', () => {
    const affine = buildPhysicalAffineMatrix([96, 96, 96], [3.0, 2.6, 2.8]);
    const mm = voxelToPhysicalMm(affine, 10, 20, 30);
    expect(mm).toEqual([30, 52, 84]);
  });

  it('generates the CT Angiography Phantom with Hounsfield Units and Netter Labelmaps (including Liver Segment VI and IVC)', () => {
    const vol = buildThoraxAngioCtPhantom();
    expect(vol.dims).toEqual([96, 96, 96]);
    expect(vol.physicalSizeMm).toEqual([288, 249.6, 268.8]);

    let hasLiverSeg6 = false;
    let hasIvc = false;
    let hasAorta = false;
    for (let i = 0; i < vol.labelData.length; i++) {
      if (vol.labelData[i] === 15) hasLiverSeg6 = true;
      if (vol.labelData[i] === 16) hasIvc = true;
      if (vol.labelData[i] === 6) hasAorta = true;
    }
    expect(hasLiverSeg6).toBe(true);
    expect(hasIvc).toBe(true);
    expect(hasAorta).toBe(true);
    expect(ANATOMICAL_LABELS[15].name).toContain('Segmento VI do Fígado');
    expect(ANATOMICAL_LABELS[16].name).toContain('Veia Cava Inferior');
  });

  it('builds the 1D Transfer Function Texture mapping vascular contrast (>150 HU) and bone (>400 HU)', () => {
    const lut = buildTransferFunction1DLut(0, 150, 400, 1.0);
    expect(lut.length).toBe(256 * 4);

    // Index corresponding to -900 HU (air): must be fully transparent (alpha = 0)
    const idxAir = Math.round(((-900 + 1000) / 2500) * 255);
    expect(lut[idxAir * 4 + 3]).toBe(0);

    // Index corresponding to +260 HU (vascular contrast > 150 HU): red channel dominance (R >> G, B)
    const idxVasc = Math.round(((260 + 1000) / 2500) * 255);
    expect(lut[idxVasc * 4]).toBeGreaterThan(200);
    expect(lut[idxVasc * 4 + 1]).toBeLessThan(90);
    expect(lut[idxVasc * 4 + 3]).toBeGreaterThan(30);

    // Index corresponding to +900 HU (cortical bone > 400 HU): opaque white/ivory (high R, G, B and high alpha)
    const idxBone = Math.round(((900 + 1000) / 2500) * 255);
    expect(lut[idxBone * 4]).toBeGreaterThan(230);
    expect(lut[idxBone * 4 + 1]).toBeGreaterThan(220);
    expect(lut[idxBone * 4 + 2]).toBeGreaterThan(200);
    expect(lut[idxBone * 4 + 3]).toBeGreaterThan(150);
  });

  it('synchronizes Window Width (WW) and Window Level (WL) in usePhysiologyStore', () => {
    const store = usePhysiologyStore.getState();
    store.setRadiologyWindow(2000, 400, 0);
    expect(usePhysiologyStore.getState().radiologyWw).toBe(2000);
    expect(usePhysiologyStore.getState().radiologyWl).toBe(400);
  });
});
