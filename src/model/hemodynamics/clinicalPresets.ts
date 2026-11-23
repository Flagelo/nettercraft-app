import { defaultParams } from '../../controller/usePhysiologyStore';
import type { ClinicalParams, WallMotionScore } from '../contracts/types';
import { AHA_SEGMENT_TERRITORY } from '../contracts/types';

export interface ClinicalPreset {
  id: string;
  label: string;
  summary: string;
  build: () => ClinicalParams;
}

function wmForTerritory(territory: 'lad' | 'lcx' | 'rca', score: WallMotionScore): WallMotionScore[] {
  return AHA_SEGMENT_TERRITORY.map((t) => (t === territory ? score : 1));
}

export const CLINICAL_PRESETS: readonly ClinicalPreset[] = [
  {
    id: 'normal',
    label: 'Fisiológico Normal',
    summary: 'Adulto hígido em repouso (FEVE 60%, DDVE 48 mm, Sinusal 72 bpm)',
    build: () => defaultParams(),
  },
  {
    id: 'hfref',
    label: 'ICFER (Miocardiopatia Dilatada)',
    summary: 'FEVE 26%, DDVE 66 mm, DSVE 55 mm, B3 audível, ESPVR deprimida',
    build: () => {
      const p = defaultParams();
      p.echo.lvef = 26;
      p.echo.lvedd = 66;
      p.echo.lvesd = 55;
      p.echo.wallMotion = Array.from({ length: 17 }, () => 2 as WallMotionScore);
      p.ecg.heartRate = 94;
      return p;
    },
  },
  {
    id: 'hfpef',
    label: 'ICFEP (HVE Concêntrica / Diastólica)',
    summary: 'FEVE 62%, Septo 15 mm, PP 14 mm, rigidez B↑↑, PD2 elevada, onda "a" gigante e B4',
    build: () => {
      const p = defaultParams();
      p.echo.lvef = 62;
      p.echo.lvedd = 45;
      p.echo.lvesd = 28;
      p.echo.septum = 15;
      p.echo.posteriorWall = 14;
      p.ecg.heartRate = 76;
      return p;
    },
  },
  {
    id: 'stemi_lad',
    label: 'IAMCSST Anterior Extenso (DA)',
    summary: 'Supra de ST em V1–V4, DI, aVL + espelho inferior; acinesia/discinesia apical/anterior',
    build: () => {
      const p = defaultParams();
      p.echo.lvef = 36;
      p.echo.wallMotion = wmForTerritory('lad', 3);
      p.echo.wallMotion[16] = 4; // dyskinetic apex
      p.ecg.ischemiaTerritory = 'lad';
      p.ecg.ischemiaTransmural = true;
      p.ecg.heartRate = 92;
      return p;
    },
  },
  {
    id: 'stemi_rca',
    label: 'IAMCSST Inferior (CD)',
    summary: 'Supra de ST em DII, DIII, aVF + imagem em espelho em DI e aVL; acinesia inferior',
    build: () => {
      const p = defaultParams();
      p.echo.lvef = 46;
      p.echo.wallMotion = wmForTerritory('rca', 3);
      p.ecg.ischemiaTerritory = 'rca';
      p.ecg.ischemiaTransmural = true;
      p.ecg.heartRate = 64;
      return p;
    },
  },
  {
    id: 'aortic_stenosis',
    label: 'Estenose Aórtica Grave (EOA 0.7 cm²)',
    summary: 'Gradiente VE–Ao elevado, HVE concêntrica, sopro sistólico em diamante e B2 paradoxal',
    build: () => {
      const p = defaultParams();
      p.echo.aorticEOA = 0.7;
      p.echo.septum = 14;
      p.echo.posteriorWall = 13;
      p.echo.lvef = 58;
      return p;
    },
  },
  {
    id: 'mitral_regurg',
    label: 'Insuficiência Mitral Grave (ROA 0.45 cm²)',
    summary: 'Sobrecarga de volume, onda "v" atrial proeminente, sopro holossistólico e B3',
    build: () => {
      const p = defaultParams();
      p.echo.mitralROA = 0.45;
      p.echo.lvedd = 60;
      p.echo.lvesd = 38;
      p.echo.lvef = 55;
      return p;
    },
  },
  {
    id: 'af_rvr',
    label: 'Fibrilação Atrial (FA)',
    summary: 'RR irregularmente irregular, ausência de onda P e de onda "a" atrial, ondas f',
    build: () => {
      const p = defaultParams();
      p.ecg.rhythm = 'af';
      p.ecg.heartRate = 118;
      return p;
    },
  },
  {
    id: 'flutter_2_1',
    label: 'Flutter Atrial 2:1',
    summary: 'Macrorreentrada cavotricuspídea a 300/min (ondas F em dente de serra), FC 150 bpm',
    build: () => {
      const p = defaultParams();
      p.ecg.rhythm = 'flutter';
      p.ecg.flutterConduction = 2;
      p.ecg.heartRate = 150;
      return p;
    },
  },
  {
    id: 'lbbb',
    label: 'Bloqueio de Ramo Esquerdo (BRE)',
    summary: 'QRS ≥ 130 ms, atraso elétrico/mecânico da parede lateral do VE, B2 paradoxal',
    build: () => {
      const p = defaultParams();
      p.ecg.bundleBranchBlock = 'lbbb';
      return p;
    },
  },
  {
    id: 'rbbb',
    label: 'Bloqueio de Ramo Direito (BRD)',
    summary: 'Padrão rSR\' em V1–V2, ativação tardia do VD e desdobramento amplo de B2',
    build: () => {
      const p = defaultParams();
      p.ecg.bundleBranchBlock = 'rbbb';
      return p;
    },
  },
  {
    id: 'septic_vm',
    label: 'Vasoplegia + Ventilação Mecânica (PEEP 12)',
    summary: 'RVS reduzida, hipotensão com ativação do barorreflexo, PEEP positiva e ΔPP elevado',
    build: () => {
      const p = defaultParams();
      p.circulation.svrScale = 0.52;
      p.circulation.bloodVolume = 4650;
      p.ventilation.mode = 'mechanical';
      p.ventilation.peep = 12;
      p.ventilation.drivingPressure = 14;
      return p;
    },
  },
];
