import type { ClinicalParams, WallMotionScore } from '../contracts/types';
import {
  type DrawerSliderId,
  type PocusScenarioId,
  type ViewId,
  defaultParams,
} from '../../controller/usePhysiologyStore';

export interface ExamActionOption {
  id: string;
  label: string;
  subtitle: string;
  isCorrect: boolean;
  /** Optional intervention the button applies or checks in the store when triggered */
  applyStoreIntervention?: () => void;
}

export interface SixLayerStackItem {
  layerNumber: number;
  layerTitle: string;
  content: string;
  /** If present, shows a shortcut button to inspect the corresponding physiology module */
  quickLinkView?: ViewId;
  quickLinkLabel?: string;
}

export interface ExamCase {
  id: string;
  board: 'ENARE' | 'SES-PE';
  category: string;
  yearTag: string;
  difficulty: 'Alta Complexidade' | 'Essencial Residência' | 'Raciocínio Integrado';
  title: string;
  targetView: ViewId;
  pocusScenario?: PocusScenarioId;
  /** URL of a local anonymized NIfTI file (Radiopaedia/TCIA) loaded by volumeLoader.ts */
  radiologyNiftiUrl?: string | null;
  radiologyWw?: number;
  radiologyWl?: number;
  /** Sliders visible in the BottomQuickDrawer during Exam Mode (the others stay hidden) */
  allowedSliders: DrawerSliderId[];
  /** Initial hemodynamic and electrophysiological state loaded into the engines */
  initialParams: ClinicalParams;
  /** Raw, direct clinical vignette (ENARE / SES-PE residency exam style) */
  vignette: string;
  vitalsHeader: string;
  taskPrompt: string;
  /** Optional slider-manipulation requirements to validate a complete hands-on intervention */
  sliderRequirement?: {
    description: string;
    check: (params: ClinicalParams) => boolean;
    statusLabel?: (params: ClinicalParams) => string;
    quickFixLabel?: string;
    quickFixDrugPatch?: Partial<ClinicalParams['drugs']>;
  };
  options: ExamActionOption[];
  /** Step 3 — DiSSS framework and 6-Layer Stack for Active Recall */
  disss: {
    deconstruction: {
      diagnosis: string;
      imageOrSignalTrigger: string;
      summary: string;
    };
    selection: {
      guidelineName: string;
      practicalRule: string;
    };
    sequencingLayers: SixLayerStackItem[];
    stakesEdgeCases: {
      title: string;
      scenario: string;
      alternativeManagement: string;
    };
  };
}

function makeTraumaShockParams(): ClinicalParams {
  const p = defaultParams();
  p.ecg.heartRate = 128;
  p.circulation.bloodVolume = 3550; // class III/IV hemorrhagic hypovolemic shock
  p.circulation.svrScale = 1.45;
  p.echo.lvef = 68;
  p.echo.lvedd = 38;
  p.echo.lvesd = 22;
  return p;
}

function makeStemiLadParams(): ClinicalParams {
  const p = defaultParams();
  p.ecg.heartRate = 108;
  p.ecg.rhythm = 'sinus';
  p.ecg.ischemiaTerritory = 'lad'; // Proximal left anterior descending (LAD) occlusion (V1-V4 + inferior mirror image)
  p.ecg.ischemiaTransmural = true;
  p.echo.lvef = 32;
  p.echo.lvedd = 56;
  p.echo.lvesd = 45;
  // Anterior, anteroseptal and apical akinesis (AHA segments 1, 2, 7, 8, 13, 14, 17)
  const wm = Array.from({ length: 17 }, () => 1 as WallMotionScore);
  for (const seg of [1, 2, 7, 8, 13, 14, 17]) {
    wm[seg - 1] = 3;
  }
  p.echo.wallMotion = wm;
  p.circulation.bloodVolume = 4850;
  p.circulation.svrScale = 0.95; // borderline hypotension requiring MAP support
  return p;
}

function makeHfpefCongestiveParams(): ClinicalParams {
  const p = defaultParams();
  p.ecg.heartRate = 94;
  p.echo.lvef = 62;
  p.echo.lvedd = 46;
  p.echo.lvesd = 29;
  p.echo.septum = 15; // concentric left ventricular hypertrophy
  p.echo.posteriorWall = 14;
  p.circulation.bloodVolume = 5900; // pulmonary venous congestion / hypervolemia (elevated LVEDP)
  p.circulation.svrScale = 1.45;
  return p;
}

function makeVascularIjvPocusParams(): ClinicalParams {
  const p = defaultParams();
  p.ecg.heartRate = 86;
  p.circulation.bloodVolume = 5100;
  p.circulation.svrScale = 1.05;
  return p;
}

function makeRadiologyLiverCaseParams(): ClinicalParams {
  const p = defaultParams();
  p.ecg.heartRate = 88;
  p.circulation.bloodVolume = 4850;
  return p;
}

export const EXAM_CASES: readonly ExamCase[] = [
  // =========================================================================
  // 1. SES-PE (Trauma): positive FAST in Morison's pouch (Decision: laparotomy)
  // =========================================================================
  {
    id: 'sespe_trauma_fast',
    board: 'SES-PE',
    category: 'Trauma e Cirurgia — SES-PE',
    yearTag: 'SES-PE · Cirurgia do Trauma',
    difficulty: 'Essencial Residência',
    title: 'Politrauma Chocado + E-FAST Positivo no Espaço de Morison',
    targetView: 'pocus',
    pocusScenario: 'fast_morison',
    allowedSliders: ['bloodVolume', 'norepinephrine'],
    initialParams: makeTraumaShockParams(),
    vignette:
      'Homem, 29 anos, vítima de colisão motociclística em alta velocidade contra anteparo fixo há 35 minutos. Admitido na Sala Vermelha agitado, sudoreico, mucosas hipocoradas (++/4+), turgência jugular ausente, murmúrio vesicular bilateralmente preservado e abdome tenso e doloroso à palpação profunda em hipocôndrio direito. Realizado E-FAST imediato na janela hepatorrenal (exibido no monitor POCUS ao lado).',
    vitalsHeader: 'PA: 76/48 mmHg (PAM 57) · FC: 128 bpm · FR: 28 irpm · SpO₂: 95% · Glasgow: 14',
    taskPrompt:
      'Analise a janela hepatorrenal (Espaço de Morison) no monitor de Ultrassom POCUS e execute a conduta cirúrgica imediata:',
    options: [
      {
        id: 'laparotomia',
        label: '🔪 Indicar Laparotomia Exploradora Mediana Imediata',
        subtitle: 'Ativar protocolo de transfusão maciça (1:1:1) e encaminhar direto ao Bloco Cirúrgico',
        isCorrect: true,
      },
      {
        id: 'tomografia',
        label: '🖥️ Solicitar TC de Abdome Total com Contraste Endovenoso',
        subtitle: 'Estadiar o grau da laceração hepática (AAST) antes de indicar abordagem cirúrgica',
        isCorrect: false,
      },
      {
        id: 'lpd',
        label: '💉 Realizar Lavado Peritoneal Diagnóstico (LPD) Supraumbilical',
        subtitle: 'Confirmar aspiração > 10 mL de sangue vivo antes de indicar laparotomia',
        isCorrect: false,
      },
      {
        id: 'observacao',
        label: '💧 Manter Reposição Cristaloide (2000 mL) e Repetir FAST em 4h',
        subtitle: 'Instituir tratamento não-operatório (TNO) em leito de UTI',
        isCorrect: false,
      },
    ],
    disss: {
      deconstruction: {
        diagnosis: 'Choque Hemorrágico Classe III/IV por Hemoperitônio Traumático (E-FAST Positivo)',
        imageOrSignalTrigger:
          'Faixa anecoica falciforme (preta) interposta entre o lobo direito do fígado (cápsula de Glisson) e o córtex anterior do rim direito (fáscia de Gerota) no Espaço de Morison.',
        summary:
          'O recesso hepatorrenal (Espaço de Morison) é o local mais dependente do abdome superior no paciente em decúbito dorsal; bastam ~200–250 mL de sangue livre intraperitoneal para gerar a lâmina anecoica visível no shader.',
      },
      selection: {
        guidelineName: 'ATLS 10ª Edição (American College of Surgeons) & Banca SES-PE',
        practicalRule:
          'Trauma Abdominal Fechado + Instabilidade Hemodinâmica (PAS < 90 mmHg) + FAST Positivo = Laparotomia Exploradora Imediata. A tomografia é formalmente contraindicada no paciente instável.',
      },
      sequencingLayers: [
        {
          layerNumber: 1,
          layerTitle: 'Reconhecimento de Padrão (5s na Prova)',
          content:
            'Politraumatizado hipotenso/taquicárdico + lâmina anecoica entre fígado e rim direito no QSD = Hemoperitônio cirúrgico até segunda ordem.',
        },
        {
          layerNumber: 2,
          layerTitle: 'Fisiopatologia & Biomecânica Cardiovascular',
          content:
            'A perda aguda > 30% da volemia reduz drasticamente o retorno venoso e o VDF do VE, encurtando a largura da alça Pressão-Volume (queda do Volume Sistólico) apesar da taquicardia reflexa simpática.',
          quickLinkView: 'cardio',
          quickLinkLabel: 'Inspecionar Alça PV & Wiggers do Choque',
        },
        {
          layerNumber: 3,
          layerTitle: 'Gatilho Físico no Ultrassom (Shader POCUS)',
          content:
            'O sangue recente não coagulado comporta-se como meio anecoico homogêneo (sem espalhadores de Rayleigh), gerando linha escura nítida abaixo da cápsula de Glisson e reforço acústico posterior.',
          quickLinkView: 'pocus',
          quickLinkLabel: 'Rever Janela de Morison no POCUS',
        },
        {
          layerNumber: 4,
          layerTitle: 'Conduta de 1ª Linha & Ressuscitação de Controle de Danos',
          content:
            'Laparotomia exploradora mediana imediata + ácido tranexâmico (1g EV em 10 min se < 3h do trauma) + transfusão balanceada 1:1:1 (CH : PFC : Plaquetas) evitando excesso de cristaloide.',
        },
        {
          layerNumber: 5,
          layerTitle: 'Diagnóstico Diferencial (Armadilhas de Prova)',
          content:
            'Não confundir a gordura perirrenal fisiológica (hipoecoica com ecos internos finos e sinal do duplo contorno) nem sombra acústica costal com líquido livre anecoico verdadeiro.',
        },
        {
          layerNumber: 6,
          layerTitle: 'Stakes & Edge Cases (Quando o Padrão Muda)',
          content:
            'Se o paciente apresentar E-FAST positivo, porém estiver hemodinamicamente ESTÁVEL (PAS > 100 mmHg, FC < 95 bpm), a conduta muda para TC de Abdome com contraste EV buscando Tratamento Não-Operatório (TNO).',
        },
      ],
      stakesEdgeCases: {
        title: 'Quando a conduta padrão falha: Ascite Cirrótica ou Sangramento Retroperitoneal Puro',
        scenario:
          'Pacientes hepatopatas com ascite prévia ou diálise peritoneal apresentam fluido anecoico basal no Espaço de Morison; além disso, o FAST não detecta sangramento retroperitoneal puro (ex: fratura pélvica em livro aberto ou hematoma de zona II).',
        alternativeManagement:
          'Em fratura pélvica instável com FAST negativo na janela peritoneal, realizar tamponamento pré-peritoneal / fixação pélvica externa e angioembolização arterial.',
      },
    },
  },

  // =========================================================================
  // 2. ENARE (Cardio): extensive anterior wall STEMI (V1-V4 + MAP control)
  // =========================================================================
  {
    id: 'enare_ecg_stemi_lad',
    board: 'ENARE',
    category: 'Emergências Clínicas — ENARE',
    yearTag: 'ENARE · Cardiologia / Sala de Emergência',
    difficulty: 'Alta Complexidade',
    title: 'IAMCSST Parede Anterior Extenso (V1–V4) + Controle de PAM & Acinesia 17-AHA',
    targetView: 'cardio',
    allowedSliders: ['norepinephrine', 'dobutamine'],
    initialParams: makeStemiLadParams(),
    vignette:
      'Homem, 61 anos, tabagista e dislipidêmico, apresenta dor retroesternal em aperto de forte intensidade há 70 minutos, irradiada para membro superior esquerdo, associada a sudorese fria e hipotensão limítrofe (PA 84/54 mmHg, PAM 64 mmHg). O monitor multiparamétrico de 12 derivações (projetado pela matriz vetorial de Dower) e o coração 3D eletromecânico mostram a alteração territorial aguda.',
    vitalsHeader: 'PA: 84/54 mmHg (PAM 64) · FC: 108 bpm · FEVE: 32% · Supra de ST em V1–V4',
    taskPrompt:
      '1º Identifique o supra de ST em V1–V4 no ECG e ajuste o suporte vasopressor/inotrópico na gaveta inferior (Noradrenalina ≥ 0.08 mcg/kg/min ou Dobutamina ≥ 3 mcg/kg/min) para proteger a pressão de perfusão coronariana (PAM ≥ 65 mmHg); 2º Selecione a artéria culpada e a estratégia de reperfusão:',
    sliderRequirement: {
      description:
        'Ajustar controle de PAM na gaveta inferior (Noradrenalina ≥ 0.08 mcg/kg/min ou Dobutamina ≥ 3.0 mcg/kg/min)',
      check: (params) =>
        params.drugs.norepinephrine >= 0.08 || params.drugs.dobutamine >= 3.0,
      statusLabel: (params) =>
        `Nora: ${params.drugs.norepinephrine.toFixed(2)} mcg/kg/min · Dobuta: ${params.drugs.dobutamine.toFixed(1)} mcg/kg/min`,
      quickFixLabel: 'Titular Nora 0.12 + Dobuta 5.0 Agora',
      quickFixDrugPatch: { norepinephrine: 0.12, dobutamine: 5.0 },
    },
    options: [
      {
        id: 'icp_lad',
        label: '🫀 Oclusão da Descendente Anterior (DA) — Angioplastia Primária (ICP ≤ 90 min) + Suporte de PAM',
        subtitle: 'AAS + Inibidor P2Y12 + Anticoagulação plena, estabilização da PAM com vasopressor e cateterismo imediato',
        isCorrect: true,
      },
      {
        id: 'rca_nitro',
        label: '🩸 Oclusão da Coronária Direita (CD) — Infusão de Nitroglicerina EV em Alta Dose',
        subtitle: 'Tratar como infarto inferior isolado com vasodilatação venosa agressiva apesar da hipotensão',
        isCorrect: false,
      },
      {
        id: 'pericardite_aine',
        label: '💊 Pericardite Aguda Viral — Prescrever Ibuprofeno 600 mg + Colchicina',
        subtitle: 'Interpretar o supradesnivelamento de ST como difuso benigno sem imagem em espelho',
        isCorrect: false,
      },
      {
        id: 'alta_teste_ergometrico',
        label: '🏃 Solicitar Teste Ergométrico em Esteira Imediato para Estratificação',
        subtitle: 'Submeter paciente com corrente de lesão subepicárdica aguda ao esforço físico',
        isCorrect: false,
      },
    ],
    disss: {
      deconstruction: {
        diagnosis:
          'Infarto Agudo do Miocárdio com Supradesnivelamento de ST (IAMCSST) de Parede Anterior Extenso (Oclusão Proximal da Artéria Descendente Anterior — DA) com Pré-Choque Cardiogênico',
        imageOrSignalTrigger:
          'Supradesnivelamento convexo do segmento ST nas derivações precordiais V1–V4 (vetor de corrente de lesão apontando para frente e para o ápice) com infradesnivelamento recíproco (imagem em espelho) em DII, DIII e aVF + acinesia dos segmentos AHA 1, 2, 7, 8, 13, 14 e 17.',
        summary:
          'A isquemia transmural despolariza parcialmente a zona lesada em diástole e encurta o platô da fase 2 em sístole, criando um dipolo de corrente de lesão dirigido para o território da DA e reduzindo a elastância ventricular máxima (Ees).',
      },
      selection: {
        guidelineName: 'Diretriz da Sociedade Brasileira de Cardiologia (SBC) sobre IAMCSST & ENARE',
        practicalRule:
          'IAMCSST anterior com delta-T < 12h e hipotensão: garantir PAM ≥ 65 mmHg (Noradrenalina como vasopressor de 1ª linha no choque cardiogênico + Dobutamina se baixo débito persistente) e encaminhar para Angioplastia Primária (ICP) da artéria culpada (DA) em ≤ 90 min.',
      },
      sequencingLayers: [
        {
          layerNumber: 1,
          layerTitle: 'Reconhecimento de Padrão (5s na Prova)',
          content:
            'Supra de ST em V1–V4 + infra recíproco em DII, DIII e aVF = Oclusão da Artéria Descendente Anterior (DA) com risco iminente de choque cardiogênico.',
        },
        {
          layerNumber: 2,
          layerTitle: 'Eletromecânica 3D & Matriz de Dower',
          content:
            'A perda contrátil de 7 dos 17 segmentos AHA reduz a elastância sistólica máxima (Ees) de 2.5 para ~1.0 mmHg/mL, achatando o pico sistólico do VE no Diagrama de Wiggers e exigindo titulação de catecolaminas.',
          quickLinkView: 'cardio',
          quickLinkLabel: 'Inspecionar Vetor 3D & ECG 12 Derivações',
        },
        {
          layerNumber: 3,
          layerTitle: 'Diagnóstico Diferencial Eletrocardiográfico',
          content:
            'A presença de infradesnivelamento recíproco (imagem em espelho) nas derivações inferiores afasta pericardite aguda e repolarização precoce benigna.',
        },
        {
          layerNumber: 4,
          layerTitle: 'Terapia Antitrombótica & Controle Hemodinâmico',
          content:
            'AAS 300 mg mastigado + Ticagrelor 180 mg (ou Prasugrel 60 mg na hemodinâmica / Clopidogrel 600 mg) + Heparina Não-Fracionada. Evitar nitratos e betabloqueadores venosos na vigência de hipotensão/Killip III-IV.',
        },
        {
          layerNumber: 5,
          layerTitle: 'Complicações Mecânicas a Vigiar',
          content:
            'Insuficiência mitral aguda, comunicação interventricular (CIV) apical, ruptura de parede livre e aneurisma verdadeiro da parede anterior.',
        },
        {
          layerNumber: 6,
          layerTitle: 'Stakes & Edge Cases (Estudo CULPRIT-SHOCK)',
          content:
            'Se o paciente evoluir com Choque Cardiogênico (Killip IV) e doença multiarterial na coronariografia, deve-se revascularizar APENAS a artéria culpada (DA) no procedimento índex.',
        },
      ],
      stakesEdgeCases: {
        title: 'Quando a conduta padrão falha: Centro sem Hemodinâmica em > 120 minutos',
        scenario:
          'Se o tempo estimado do primeiro contato médico até a passagem do fio-guia na ICP for superior a 120 minutos, aguardar transferência aumenta a necrose transmural e a mortalidade.',
        alternativeManagement:
          'Administrar Tenecteplase (TNK-tPA) em bolus único ajustado pelo peso em até 10 minutos (estratégia fármaco-invasiva) após excluir contraindicações absolutas, seguido de transferência para angiografia em 2–24h.',
      },
    },
  },

  // =========================================================================
  // 3. ENARE (Internal Medicine/Nephro): acute pulmonary edema due to HFpEF (Wiggers)
  // =========================================================================
  {
    id: 'enare_cardio_icfep',
    board: 'ENARE',
    category: 'Emergências Clínicas — ENARE',
    yearTag: 'ENARE · Clínica Médica / Nefro-Cardio',
    difficulty: 'Raciocínio Integrado',
    title: 'Edema Agudo de Pulmão por ICFEP — Furosemida e Vasodilatador no Diagrama de Wiggers',
    targetView: 'cardio',
    allowedSliders: ['furosemide', 'bloodVolume'],
    initialParams: makeHfpefCongestiveParams(),
    vignette:
      'Mulher, 74 anos, hipertensa de longa data e portadora de DRC estágio 3a, dá entrada na emergência com ortopneia intensa, dispneia paroxística noturna e espuma rósea iniciadas há 4 horas. Ao exame: PA 174/102 mmHg, FC 94 bpm, estase jugular a 45°, crepitações finas até ápices pulmonares bilateralmente, ritmo cardíaco com B4/B3 em galope na ponta e extremidades quentes (TEC < 2s). Analise o Diagrama de Wiggers e a curva EDPVR na Alça Pressão-Volume.',
    vitalsHeader: 'PA: 174/102 mmHg · FC: 94 bpm · FEVE: 62% · PD2VE: > 24 mmHg · SpO₂: 88% AA',
    taskPrompt:
      '1º Titule o slider de FUROSEMIDA IV na gaveta inferior (≥ 40 mg) para aliviar a congestão venocapilar no Diagrama de Wiggers; 2º Confirme a conduta conjunta de Furosemida + Vasodilatador:',
    sliderRequirement: {
      description: 'Titular o slider de Furosemida IV ≥ 40 mg na gaveta inferior (BottomQuickDrawer)',
      check: (params) => params.drugs.furosemide >= 40,
      statusLabel: (params) => `Furosemida IV atual: ${params.drugs.furosemide} mg`,
      quickFixLabel: 'Titular 60 mg IV Agora',
      quickFixDrugPatch: { furosemide: 60 },
    },
    options: [
      {
        id: 'furosemida_vni',
        label: '💉 Furosemida EV (1 mg/kg) Titulada + Vasodilatador EV (Nitroglicerina/Nitroprussiato) + VNI',
        subtitle: 'Reduzir pré-carga (PD2VE na EDPVR) e pós-carga arterial no Edema Agudo de Pulmão Hipertensivo (Perfil B)',
        isCorrect: true,
      },
      {
        id: 'volume_cristaloide',
        label: '💧 Prova Volêmica com Ringer Lactato 500 mL EV Rápido',
        subtitle: 'Aumentar o enchimento diastólico do ventrículo esquerdo hipertrofiado',
        isCorrect: false,
      },
      {
        id: 'dobutamina_isolada',
        label: '⚡ Iniciar Dobutamina 10 mcg/kg/min + Noradrenalina em Bolus',
        subtitle: 'Tratar como choque cardiogênico clássico por falência sistólica (Perfil C)',
        isCorrect: false,
      },
      {
        id: 'metoprolol_ev',
        label: '🛑 Administrar Metoprolol 15 mg EV em Bolus Imediato',
        subtitle: 'Bloquear o tônus simpático na vigência de edema agudo pulmonar congestivo franco',
        isCorrect: false,
      },
    ],
    disss: {
      deconstruction: {
        diagnosis:
          'Edema Agudo de Pulmão Hipertensivo por Insuficiência Cardíaca com Fração de Ejeção Preservada (ICFEP) — Perfil B (Quente e Úmido)',
        imageOrSignalTrigger:
          'Alça Pressão-Volume estreita com FEVE > 50%, porém deslocada superiormente sobre uma curva EDPVR exponencial íngreme (rigidez de câmara β elevada → PD2VE > 24 mmHg no Diagrama de Wiggers) + presença de B4/B3 na ausculta.',
        summary:
          'Na ICFEP hipertensiva, o relaxamento ativo (lusitropismo) é lento e a complascência passiva do VE é reduzida: pequenos aumentos de volume ou de pós-carga geram grandes saltos na pressão diastólica final (PD2VE) e transudação alveolar aguda.',
      },
      selection: {
        guidelineName: 'Diretriz Brasileira de Insuficiência Cardíaca Aguda (SBC) & ENARE',
        practicalRule:
          'Edema Agudo de Pulmão Hipertensivo (Perfil B — Quente e Congesto): Furosemida EV em bolus + Vasodilatador endovenoso (Nitroglicerina ou Nitroprussiato de Sódio para reduzir pós-carga e venoconstrição) + Ventilação Não-Invasiva com pressão positiva (CPAP/BiPAP).',
      },
      sequencingLayers: [
        {
          layerNumber: 1,
          layerTitle: 'Reconhecimento de Padrão (5s na Prova)',
          content:
            'Idosa hipertensa + crepitações difusas + extremidades quentes + FEVE 62% e septo 15 mm = Edema Agudo de Pulmão por ICFEP em Perfil B (congestão sem hipoperfusão).',
        },
        {
          layerNumber: 2,
          layerTitle: 'Fisiopatologia no Diagrama de Wiggers & Alça PV',
          content:
            'A curva EDPVR (P = A · [e^(B·(V-V0)) - 1]) possui coeficiente de rigidez B elevado. Na fase de enchimento diastólico do Wiggers, a pressão do VE sobe abruptamente e transmite-se ao Átrio Esquerdo e capilares pulmonares.',
          quickLinkView: 'cardio',
          quickLinkLabel: 'Ver Alça PV & EDPVR no Cardiac Twin',
        },
        {
          layerNumber: 3,
          layerTitle: 'Semiologia Acústica (B4 e B3)',
          content:
            'A contração atrial vigorosa contra um VE rígido produz a 4ª bulha (B4 pré-sistólica); quando a pressão atrial esquerda é muito alta, a desaceleração abrupta na protodiástole soma a B3.',
        },
        {
          layerNumber: 4,
          layerTitle: 'Sinergia Furosemida + Vasodilatador',
          content:
            'A Furosemida promove venodilatação rápida (em 5–15 min via prostaglandinas) seguida de natriurese na alça de Henle, enquanto o vasodilatador reduz a impedância aórtica e desloca o VE para a porção plana da EDPVR.',
        },
        {
          layerNumber: 5,
          layerTitle: 'Diagnóstico Diferencial na Prova',
          content:
            'Diferenciar de ICFER em Perfil C (Frio e Úmido, onde inotrópico seria necessário) e de estenose de artéria renal bilateral (Edema Agudo em Flash / Síndrome de Pickering).',
        },
        {
          layerNumber: 6,
          layerTitle: 'Stakes & Edge Cases (Quando a Conduta Padrão Falha)',
          content:
            'Evitar betabloqueador venoso na fase aguda de edema pulmonar congestivo e evitar diurese excessiva se houver estenose aórtica crítica ou amiloidose cardíaca.',
        },
      ],
      stakesEdgeCases: {
        title: 'Quando a conduta padrão falha: Resistência Diurética & Síndrome Cardiorrenal Tipo 1',
        scenario:
          'Em pacientes com DRC avançada ou uso crônico de altas doses de furosemida, ocorre hipertrofia do túbulo contorcido distal com resistência ao diurético de alça isolado.',
        alternativeManagement:
          'Realizar bloqueio sequencial do néfron associando tiazídico (Hidroclorotiazida/Clortalidona) ou acetazolamida (estudo ADVOR), ou indicar ultrafiltração venovenosa se oligoanúria refratária com acidose/hipercalemia.',
      },
    },
  },

  // =========================================================================
  // 4. SES-PE (Vascular Surgery/POCUS): central venous access assessment
  // =========================================================================
  {
    id: 'sespe_vascular_pocus_ijv',
    board: 'SES-PE',
    category: 'Trauma e Cirurgia — SES-PE',
    yearTag: 'SES-PE · Cirurgia Vascular & POCUS',
    difficulty: 'Essencial Residência',
    title: 'Acesso Venoso Central Guiado por POCUS — Compressão de Ramanujan (VJI vs. Carótida)',
    targetView: 'pocus',
    pocusScenario: 'vascular',
    allowedSliders: ['bloodVolume', 'norepinephrine'],
    initialParams: makeVascularIjvPocusParams(),
    vignette:
      'Paciente de 58 anos em preparo para cirurgia de grande porte necessita de cateter venoso central em região cervical anterolateral direita (triângulo de Sedillot). Você posiciona o transdutor linear de alta frequência transversalmente (out-of-plane) sobre os vasos cervicais. No simulador POCUS ao lado, pressione o transdutor no eixo Y (slider de Compressão) e observe o comportamento mecânico dos dois vasos antes de introduzir a agulha biselada.',
    vitalsHeader: 'PA: 118/74 mmHg · FC: 86 bpm · PVC: 7 mmHg · Transdutor Linear 7.5–10 MHz',
    taskPrompt:
      'Aplique compressão com o transdutor no POCUS para diferenciar a Veia Jugular Interna (VJI) da Artéria Carótida Comum (ACC) e assinale a conduta técnica correta para a punção:',
    options: [
      {
        id: 'puncao_vji_compressivel',
        label: '🎯 Puncionar o Vaso Lateral de Parede Fina que Colaba Totalmente sob Compressão (Veia Jugular Interna)',
        subtitle: 'Confirmar colabamento venoso (P_transdutor > P_venosa com conservação do perímetro de Ramanujan) e visualizar a ponta da agulha com reverberação em cauda de cometa',
        isCorrect: true,
      },
      {
        id: 'puncao_carotida_medial',
        label: '🩸 Puncionar o Vaso Medial Circular, Pulsátil e Incompressível de Parede Espessa',
        subtitle: 'Escolher o vaso medial resistente à pressão do transdutor como alvo do cateter de duplo lúmen',
        isCorrect: false,
      },
      {
        id: 'puncao_cega_posterior',
        label: '⚠️ Avançar a Agulha sem Compressão Prévia Direto para a Parede Posterior da Carótida',
        subtitle: 'Dispensar o teste de compressibilidade dinâmica por considerar a posição anatômica invariável',
        isCorrect: false,
      },
      {
        id: 'transdutor_convexo_abdomen',
        label: '📡 Trocar para Transdutor Convexo de Baixa Frequência (2.5 MHz) sem Guia Visual da Ponta',
        subtitle: 'Priorizar penetração de 25 cm em detrimento da resolução axial superficial cervical',
        isCorrect: false,
      },
    ],
    disss: {
      deconstruction: {
        diagnosis:
          'Identificação Sonoanatômica Cervical: Veia Jugular Interna (Lateral, Ovóide e Compressível) vs. Artéria Carótida Comum (Medial, Circular e Pulsátil)',
        imageOrSignalTrigger:
          'Ao aumentar a pressão do transdutor no eixo Y (P_transdutor > P_venosa), o lúmen lateral (VJI) achata progressivamente conservando seu perímetro endotelial (elipse de Ramanujan) até o colabamento total, enquanto o lúmen medial (Artéria Carótida Comum) permanece circular, hiperecogênico e pulsátil.',
        summary:
          'A baixa pressão transmural venosa (PVC ~5–8 mmHg) permite que uma força mínima do transdutor linear colabe a VJI; já a Artéria Carótida possui túnica média muscular-elástica espessa submetida à pressão arterial sistêmica (120/80 mmHg), resistindo à deformação.',
      },
      selection: {
        guidelineName: 'Diretrizes de Acesso Vascular Guiado por Ultrassom (AVA / Colégio Brasileiro de Cirurgiões & SES-PE)',
        practicalRule:
          'Antes de puncionar no triângulo de Sedillot: 1) Realizar o teste de compressão dinâmica (VJI colaba; Carótida pulsa e não colaba); 2) Avaliar com Color Doppler (BART); 3) Acompanhar o bisel metálico hiperecogênico e seu artefato de reverberação em cauda de cometa penetrando a parede anterior da VJI.',
      },
      sequencingLayers: [
        {
          layerNumber: 1,
          layerTitle: 'Reconhecimento de Padrão (5s na Prova)',
          content:
            'Vaso cervical lateral, maior diâmetro em Trendelenburg, parede fina e 100% compressível ao toque do transdutor = Veia Jugular Interna (VJI). Vaso medial, redondo, pulsátil e incompressível = Artéria Carótida Comum.',
        },
        {
          layerNumber: 2,
          layerTitle: 'Biomecânica Vascular & Conservação do Perímetro de Ramanujan',
          content:
            'Durante a compressão pelo transdutor, a VJI não "encolhe" seu endotélio: o semi-eixo menor vertical (b) diminui até zero enquanto o semi-eixo maior horizontal (a) se expande conservando o perímetro P ≈ π[3(a+b) - √((3a+b)(a+3b))].',
          quickLinkView: 'pocus',
          quickLinkLabel: 'Testar Compressão da VJI no Shader POCUS',
        },
        {
          layerNumber: 3,
          layerTitle: 'Física Acústica da Agulha (Cauda de Cometa)',
          content:
            'O aço cirúrgico da agulha apresenta altíssima impedância acústica; as múltiplas reflexões internas entre as paredes anterior e posterior do bisel geram ecos verticais decrescentes conhecidos como artefato em cauda de cometa (Comet-Tail).',
          quickLinkView: 'pocus',
          quickLinkLabel: 'Visualizar Agulha e Cauda de Cometa',
        },
        {
          layerNumber: 4,
          layerTitle: 'Técnica de Punção Segura (Seldinger Guiado)',
          content:
            'Posicionar o paciente em Trendelenburg a 15° (ingurgita a VJI e reduz o risco de embolia gasosa), anestesiar pele, avançar a agulha a 30–45° acompanhando a ponta no feixe e confirmar o fio-guia em eixo curto e eixo longo antes de passar o dilatador.',
        },
        {
          layerNumber: 5,
          layerTitle: 'Diagnóstico Diferencial (Trombose Venosa Cervical)',
          content:
            'Se a VJI NÃO colabar sob compressão firme do transdutor e apresentar ecos intraluminais estáticos, diagnosticar Trombose Venosa Profunda de VJI — contraindicando a punção naquele sítio.',
        },
        {
          layerNumber: 6,
          layerTitle: 'Stakes & Edge Cases (Canulação Carotídea Inadvertida)',
          content:
            'Se a agulha fina (18G) puncionar a carótida, retira-se a agulha e aplica-se compressão local. Porém, se o DILATADOR calibroso (≥ 7 Fr) já tiver sido introduzido na carótida, NUNCA puxar no leito!',
        },
      ],
      stakesEdgeCases: {
        title: 'Quando ocorre complicação grave: Canulação Arterial Inadvertida com Dilatador/Cateter Calibroso',
        scenario:
          'Se o dilatador rígido ou cateter de hemodiálise (12 Fr) for introduzido acidentalmente na Artéria Carótida Comum, a simples retirada manual com compressão externa ("pull and pressure") tem alto risco de hematoma cervical expansivo, AVC isquêmico, fístula arteriovenosa ou pseudoaneurisma.',
        alternativeManagement:
          'Manter o cateter in situ, heparinizar cautelosamente se não houver sangramento ativo e acionar imediatamente a Cirurgia Vascular/Endovascular para remoção sob visão direta cirúrgica ou fechamento percutâneo por dispositivo/stent revestido.',
      },
    },
  },

  // =========================================================================
  // 5. ENARE (Radiology): hemorrhage / lesion in hepatic segment VI (Slicer MPR)
  // =========================================================================
  {
    id: 'enare_radiology_nifti_liver',
    board: 'ENARE',
    category: 'Emergências Clínicas — ENARE',
    yearTag: 'ENARE · Radiologia & Anatomia Seccional',
    difficulty: 'Alta Complexidade',
    title: 'Tomografia MPR 3D — Identificação de Lesão/Hemorragia no Segmento VI Hepático',
    targetView: 'radiology',
    radiologyNiftiUrl: '/volumes/sample_thorax_abdomen_anon.nii.gz',
    radiologyWw: 180,
    radiologyWl: 65,
    allowedSliders: [],
    initialParams: makeRadiologyLiverCaseParams(),
    vignette:
      'Paciente de 45 anos é submetido a Tomografia Computadorizada Multislice de tórax e abdome superior (carregada via arquivo NIfTI local anonimizado no visualizador MPR de 4 quadrantes) para localização topográfica precisa de lesão hemorrágica contusa/focal na porção posteroinferior do lobo hepático direito. Utilize os Crosshairs 3D sincronizados e o identificador anatômico por hover para determinar o segmento de Couinaud acometido e sua drenagem venosa.',
    vitalsHeader: 'Volume NIfTI: 64×64×64 · Janela Abdominal (W:180 L:65) · Slicer MPR & Crosshairs Ativos',
    taskPrompt:
      'Navegue pelos cortes Axial, Coronal e Sagital usando os Crosshairs 3D e o cursor de Unidades Hounsfield (HU) para localizar a porção posteroinferior direita do fígado e assinale a alternativa correta:',
    options: [
      {
        id: 'couinaud_vi_ivc',
        label: '🎯 Segmento VI de Couinaud (Posteroinferior Direito, ~65–72 HU) + Relação com Espaço de Morison e VCI Retro-Hepática',
        subtitle: 'Identificado nos cortes Axial/Sagital abaixo do plano portal direito, anterior ao polo superior renal direito',
        isCorrect: true,
      },
      {
        id: 'couinaud_ii_porta',
        label: '🔍 Segmento II de Couinaud (Setor Lateral Esquerdo) + Drenagem Direta na Aorta Descendente',
        subtitle: 'Localizado na transição posteroinferior direita adjacente ao polo renal direito',
        isCorrect: false,
      },
      {
        id: 'pulmao_hu_positivo',
        label: '🫁 Parênquima Pulmonar Basal Direito apresentando atenuação fisiológica de +350 HU',
        subtitle: 'Valores positivos elevados caracterizam o ar alveolar normal na escala Hounsfield',
        isCorrect: false,
      },
      {
        id: 'osso_negativo',
        label: '🦴 Corpo Vertebral Torácico apresentando atenuação de -820 HU na Janela Óssea',
        subtitle: 'Osso cortical denso atenua menos raios-X que a água destilada (0 HU)',
        isCorrect: false,
      },
    ],
    disss: {
      deconstruction: {
        diagnosis:
          'Topografia Tomográfica de Couinaud: Segmento VI Hepático (Posteroinferior Direito, +60 a +75 HU) e Veia Cava Inferior Retro/Supra-Hepática (+215 HU contrastada)',
        imageOrSignalTrigger:
          'Ao alinhar os Crosshairs 3D sobre a porção posteroinferior direita do fígado nos cortes Axial, Coronal e Sagital, o Labelmap Netter identifica o Segmento VI (~68 HU) adjacente ao recesso hepatorrenal, enquanto medialmente identifica-se a VCI contrastada (~215 HU).',
        summary:
          'A classificação funcional de Couinaud divide o fígado em 8 segmentos independentes baseados nos planos verticais das 3 veias hepáticas (direita, média e esquerda) e no plano transversal da bifurcação da veia porta.',
      },
      selection: {
        guidelineName: 'Colégio Brasileiro de Radiologia (CBR), Classificação de Couinaud & Banca ENARE',
        practicalRule:
          'No lobo direito (à direita da Linha de Cantlie / veia hepática média): o setor posterior é dividido pela veia porta direita em Segmento VII (posterossuperior/subdiafragmático) e Segmento VI (posteroinferior/justarrenal, sede frequente de lacerações e hemorragias no trauma de hipocôndrio direito).',
      },
      sequencingLayers: [
        {
          layerNumber: 1,
          layerTitle: 'Reconhecimento de Padrão Tomográfico (5s na Prova)',
          content:
            'Corte tomográfico inferior do fígado direito em contato íntimo com o polo superior do rim direito (Espaço de Morison) = Segmento VI de Couinaud.',
        },
        {
          layerNumber: 2,
          layerTitle: 'Física da Escala Hounsfield (HU) & Janelamento',
          content:
            'Ar = -1000 HU; Pulmão = -820 HU; Gordura = -90 HU; Água/LCR = 0 HU; Sangue agudo/coágulo sentinela = +45 a +70 HU; Parênquima Hepático = +60 a +75 HU; Vasos Contrastados = +200 a +380 HU; Osso Cortical > +800 HU.',
          quickLinkView: 'radiology',
          quickLinkLabel: 'Voltar ao Slicer MPR & Testar Crosshairs',
        },
        {
          layerNumber: 3,
          layerTitle: 'Reconstrução Multiplanar (MPR) & Crosshairs 3D',
          content:
            'O arraste sincronizado do Crosshair no corte Sagital permite correlacionar simultaneamente a altura craniocaudal (Z) entre a cúpula diafragmática (Seg. VII/VIII) e a borda posteroinferior (Seg. VI).',
        },
        {
          layerNumber: 4,
          layerTitle: 'Estadiamento Tomográfico & Conduta Cirúrgica/Endovascular',
          content:
            'Lesões/lacerações parenquimatosas no Segmento VI com blush arterial ativo na fase contrastada em paciente estável têm indicação de angioembolização seletiva do ramo arterial hepático direito posterior.',
        },
        {
          layerNumber: 5,
          layerTitle: 'Diagnóstico Diferencial Radiológico',
          content:
            'No fígado esteatótico grave, a atenuação basal cai abaixo de +40 HU; já o hematoma subcapsular comprime o contorno hepático em formato lenticular (biconvexo), diferindo do líquido livre no Espaço de Morison.',
        },
        {
          layerNumber: 6,
          layerTitle: 'Stakes & Edge Cases (Síndrome de Budd-Chiari & Segmento I)',
          content:
            'Na trombose das veias supra-hepáticas (Budd-Chiari), o Segmento I (lobo caudado de Spiegel) hipertrofia compensatoriamente por drenar direto na VCI através das veias emissárias de Spigelius.',
        },
      ],
      stakesEdgeCases: {
        title: 'Quando a anatomia padrão muda: Lobo Caudado (Segmento I) e Linha de Cantlie',
        scenario:
          'A divisão cirúrgica real entre fígado direito e esquerdo NÃO é o ligamento falciforme (que divide apenas os segmentos II/III do segmento IV), mas sim a Linha de Cantlie (do fundo da vesícula biliar à VCI supra-hepática).',
        alternativeManagement:
          'Durante uma hepatectomia direita regrada (ressecção dos segmentos V, VI, VII e VIII), preservar o fluxo portal do ramo esquerdo e a drenagem da veia hepática média/esquerda é mandatório para evitar insuficiência hepática pós-operatória.',
      },
    },
  },
];

export function getExamCaseById(caseId: string | null): ExamCase | null {
  if (!caseId) return null;
  if (caseId === 'sespe_radiology_nifti_liver') {
    return EXAM_CASES.find((c) => c.id === 'enare_radiology_nifti_liver') ?? null;
  }
  return EXAM_CASES.find((c) => c.id === caseId) ?? null;
}
