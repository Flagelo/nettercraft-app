# Nettercraft

[![CI](https://github.com/Flagelo/nettercraft-app/actions/workflows/ci.yml/badge.svg)](https://github.com/Flagelo/nettercraft-app/actions/workflows/ci.yml) ![licença](https://img.shields.io/badge/licença-todos%20os%20direitos%20reservados-lightgrey)

Simulador médico interativo no navegador, para **estudantes de medicina, residentes e candidatos a provas de residência**. Sinais vitais, ECG, sons cardíacos e imagens são **calculados em tempo real** por modelos fisiológicos — sem vídeo ou áudio pré-gravado.

<!-- GIF de demonstração: adicionar em docs/img/demo.gif -->

> Projeto educacional em desenvolvimento. Não é dispositivo médico nem ferramenta de decisão clínica.

## Sumário
[Funcionalidades](#funcionalidades) · [Arquitetura](#arquitetura) · [Começando](#começando) · [Estrutura](#estrutura) · [Testes](#testes) · [Roadmap](#roadmap) · [Contribuição](#contribuição) · [Licença](#licença) · [Créditos](#créditos)

## Funcionalidades

**Foco atual: CardioCraft.** Os demais módulos chegam depois.

| Módulo | O que faz | Situação |
| --- | --- | --- |
| **CardioCraft** | Motor hemodinâmico 0D, coração 3D animado, ECG de 12 derivações, curvas de Wiggers, loop pressão-volume e ausculta sintetizada; responde a drogas, isquemia e outras intervenções. | Em desenvolvimento ativo |
| **RadioCraft** | Leitura de DICOM/NIfTI, unidades Hounsfield, reconstrução multiplanar (MPR) e renderização volumétrica. | Em breve |
| **ExamCraft** | Casos clínicos e estações de prova com feedback estruturado. | Em breve |

## Arquitetura

Padrão **MVC** em TypeScript. O modelo não conhece React nem Three.js; a view só lê o estado.

    Modelo (física) ──RK4, passo fixo de 1 ms──▶ LiveState ──leitura por quadro──▶ View (React/WebGL)
           ▲                                                                            │
           └──────────────── comandos do usuário (Controller / Zustand) ◀───────────────┘

- **Relógio desacoplado:** a física roda no `SimulationLoop` com passo fixo, até 250 subpassos por quadro, independente do FPS.
- **Zero alocação no laço quente:** sinais em tempo real vivem num `LiveState` mutado no lugar, sem `setState` por quadro.
- **Invariantes testadas:** volume sanguíneo conservado no circuito fechado; valvas por índice contínuo `z ∈ [0,1]`; fase do ciclo acumulada (nunca `t mod RR`).

**Stack:** React 18 · TypeScript · Vite · Three.js / React Three Fiber · Zustand · WebGL2 · Vitest · dicom-parser · nifti-reader-js

## Começando

**Pré-requisitos:** Node.js 20+ e um navegador com WebGL2 (Chrome, Edge ou Firefox atuais).

    git clone https://github.com/Flagelo/nettercraft-app.git
    cd nettercraft-app
    npm ci
    npm run dev

Abra o endereço exibido pelo Vite (normalmente http://localhost:5173).

| Comando | Função |
| --- | --- |
| `npm run dev` | servidor de desenvolvimento |
| `npm run build` | build de produção em `dist/` |
| `npm run preview` | serve o build localmente |
| `npm test` | testes (Vitest) |
| `npm run typecheck` | checagem de tipos |

## Estrutura

    src/
    ├── model/        domínio puro
    │   ├── hemodynamics/       motor 0D (câmaras, valvas, circulação)
    │   ├── electrophysiology/  condução e ECG
    │   ├── cardiacGeometry/    deformação da malha cardíaca
    │   ├── auscultation/       síntese sonora (DSP)
    │   ├── imaging/            DICOM/NIfTI e HU
    │   └── exams/              casos e avaliação
    ├── controller/   relógio, loop de simulação, store
    └── view/         React, React Three Fiber, shaders e painéis
    public/models/    modelo 3D do coração (GLB)

## Testes

Centenas de testes automatizados (Vitest) cobrem o motor fisiológico, a geometria cardíaca e o áudio, incluindo as invariantes acima. Toda alteração passa por checagem de tipos, testes, build e análise de segurança (CodeQL) no CI.

## Roadmap

- [ ] Raiz aórtica, tronco pulmonar e válvula pulmonar no modelo 3D
- [ ] Revisão do ECG e da ausculta
- [ ] Predefinições de paciente (ex.: choque cardiogênico, insuficiência cardíaca)
- [ ] Menu de ajuda explicando cada controle
- [ ] RadioCraft e ExamCraft

## Contribuição

Este repositório é a vitrine pública do produto: pull requests e issues estão restritos a colaboradores.

## Segurança

Para relatar uma vulnerabilidade, use **Security → Report a vulnerability** (canal privado). Detalhes em [SECURITY.md](SECURITY.md).

## Licença

© 2026 Nettercraft. Todos os direitos reservados. O código está visível para consulta; uso, cópia e redistribuição exigem autorização prévia. Ver [LICENSE](LICENSE).

## Créditos

- Modelo anatômico do coração (`public/models/realistic_heart.glb`): "BodyParts3D, © The Database Center for Life Science (DBCLS) licensed under CC Attribution 4.0 International." (origem: [organui/heart-3d](https://github.com/organui/heart-3d)).
- Bibliotecas de terceiros e suas licenças: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
