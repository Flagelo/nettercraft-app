import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { usePhysiologyStore } from '../../controller/usePhysiologyStore';
import { parseNiftiArrayBuffer } from '../imaging/volumeLoader';
import { EXAM_CASES, getExamCaseById } from './examCases';

function buildMinimalNiftiGzBuffer(): ArrayBuffer {
  const nx = 8;
  const ny = 8;
  const nz = 8;
  const voxOffset = 352;
  const totalVoxels = nx * ny * nz;
  const buf = new ArrayBuffer(voxOffset + totalVoxels * 2);
  const dv = new DataView(buf);

  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true);
  dv.setInt16(42, nx, true);
  dv.setInt16(44, ny, true);
  dv.setInt16(46, nz, true);
  dv.setInt16(48, 1, true);
  dv.setInt16(70, 4, true); // INT16
  dv.setInt16(72, 16, true);
  dv.setFloat32(76, 1.0, true);
  dv.setFloat32(80, 3.2, true);
  dv.setFloat32(84, 2.8, true);
  dv.setFloat32(88, 3.0, true);
  dv.setFloat32(108, voxOffset, true);
  dv.setFloat32(112, 1.0, true); // scl_slope
  dv.setFloat32(116, 0.0, true); // scl_inter
  dv.setUint8(344, 0x6e);
  dv.setUint8(345, 0x2b);
  dv.setUint8(346, 0x31);
  dv.setUint8(347, 0x00);

  for (let i = 0; i < totalVoxels; i++) {
    const hu = i < 64 ? -820 : i < 256 ? 68 : 950;
    dv.setInt16(voxOffset + i * 2, hu, true);
  }

  const gz = gzipSync(new Uint8Array(buf));
  return gz.slice().buffer as ArrayBuffer;
}

describe('ExamChallengeHub (ENARE & SES-PE Mock Exams + DiSSS 6-Layer Stack)', () => {
  it('has the 5 ENARE and SES-PE cases with DiSSS Framework and 6 complete layers', () => {
    expect(EXAM_CASES.length).toBeGreaterThanOrEqual(5);
    const ids = EXAM_CASES.map((c) => c.id);
    expect(ids).toEqual([
      'sespe_trauma_fast',
      'enare_ecg_stemi_lad',
      'enare_cardio_icfep',
      'sespe_vascular_pocus_ijv',
      'enare_radiology_nifti_liver',
    ]);
    for (const c of EXAM_CASES) {
      expect(c.disss.deconstruction.diagnosis.length).toBeGreaterThan(10);
      expect(c.disss.selection.practicalRule.length).toBeGreaterThan(10);
      expect(c.disss.sequencingLayers).toHaveLength(6);
      expect(c.options.some((o) => o.isCorrect)).toBe(true);
    }
  });

  it('activates Exam Mode in the SES-PE Trauma case (E-FAST in Morison\'s Pouch) restricting sliders and opening POCUS', () => {
    const traumaCase = getExamCaseById('sespe_trauma_fast')!;
    const store = usePhysiologyStore.getState();

    store.startExamCase({
      caseId: traumaCase.id,
      targetView: traumaCase.targetView,
      allowedSliders: traumaCase.allowedSliders,
      params: traumaCase.initialParams,
      pocusScenario: traumaCase.pocusScenario,
    });

    const after = usePhysiologyStore.getState();
    expect(after.activeExamCaseId).toBe('sespe_trauma_fast');
    expect(after.view).toBe('pocus');
    expect(after.pocusScenario).toBe('fast_morison');
    expect(after.activeExamAllowedSliders).toEqual(['bloodVolume', 'norepinephrine']);

    after.exitExamMode(false);
    expect(usePhysiologyStore.getState().activeExamCaseId).toBeNull();
    expect(usePhysiologyStore.getState().activeExamAllowedSliders).toBeNull();
  });

  it('validates MAP control in the ENARE case of Extensive Anterior Wall STEMI (V1-V4)', () => {
    const stemiCase = getExamCaseById('enare_ecg_stemi_lad')!;
    const store = usePhysiologyStore.getState();

    store.startExamCase({
      caseId: stemiCase.id,
      targetView: stemiCase.targetView,
      allowedSliders: stemiCase.allowedSliders,
      params: stemiCase.initialParams,
    });

    expect(usePhysiologyStore.getState().activeExamAllowedSliders).toEqual([
      'norepinephrine',
      'dobutamine',
    ]);
    expect(stemiCase.sliderRequirement!.check(usePhysiologyStore.getState().params)).toBe(false);

    usePhysiologyStore.getState().patch('drugs', { norepinephrine: 0.12 });
    expect(stemiCase.sliderRequirement!.check(usePhysiologyStore.getState().params)).toBe(true);
    usePhysiologyStore.getState().exitExamMode(false);
  });

  it('validates the mandatory IV Furosemide titration in the ENARE case of Acute Pulmonary Edema due to HFpEF', () => {
    const icfepCase = getExamCaseById('enare_cardio_icfep')!;
    const store = usePhysiologyStore.getState();

    store.startExamCase({
      caseId: icfepCase.id,
      targetView: icfepCase.targetView,
      allowedSliders: icfepCase.allowedSliders,
      params: icfepCase.initialParams,
    });

    expect(usePhysiologyStore.getState().activeExamAllowedSliders).toEqual([
      'furosemide',
      'bloodVolume',
    ]);
    expect(icfepCase.sliderRequirement!.check(usePhysiologyStore.getState().params)).toBe(false);

    usePhysiologyStore.getState().patch('drugs', { furosemide: 60 });
    expect(icfepCase.sliderRequirement!.check(usePhysiologyStore.getState().params)).toBe(true);
    usePhysiologyStore.getState().exitExamMode(false);
  });

  it('activates the Vascular POCUS scenario for Central Venous Access assessment (SES-PE Vascular Surgery)', () => {
    const vascularCase = getExamCaseById('sespe_vascular_pocus_ijv')!;
    const store = usePhysiologyStore.getState();

    store.startExamCase({
      caseId: vascularCase.id,
      targetView: vascularCase.targetView,
      allowedSliders: vascularCase.allowedSliders,
      params: vascularCase.initialParams,
      pocusScenario: vascularCase.pocusScenario,
    });

    const after = usePhysiologyStore.getState();
    expect(after.activeExamCaseId).toBe('sespe_vascular_pocus_ijv');
    expect(after.view).toBe('pocus');
    expect(after.pocusScenario).toBe('vascular');
    after.exitExamMode(false);
  });

  it('loads NIfTI volume (.nii.gz) via nifti-reader-js and points to /volumes/sample_thorax_abdomen_anon.nii.gz', () => {
    const radioCase = getExamCaseById('enare_radiology_nifti_liver')!;
    expect(radioCase.radiologyNiftiUrl).toBe('/volumes/sample_thorax_abdomen_anon.nii.gz');

    const gzAb = buildMinimalNiftiGzBuffer();
    const vol = parseNiftiArrayBuffer(gzAb, 'sample_thorax_abdomen_anon.nii.gz');

    expect(vol.dims).toEqual([8, 8, 8]);
    expect(vol.spacing[0]).toBeCloseTo(3.2, 2);
    expect(vol.spacing[1]).toBeCloseTo(2.8, 2);
    expect(vol.spacing[2]).toBeCloseTo(3.0, 2);
    expect(vol.huMin).toBe(-820);
    expect(vol.huMax).toBe(950);
  });
});
