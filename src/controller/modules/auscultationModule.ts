import type { SimSystem } from '../../model/contracts/types';
import { AuscultationSynth } from '../../model/auscultation/AuscultationSynth';

/**
 * Auscultation module wiring (controller layer).
 * Owns the synthesizer instance shared by the transport bar, the quick drawer
 * and the auscultation controls, and the system list for the SimulationLoop.
 */
export const auscultationSynth = new AuscultationSynth();
export const audioSystems: SimSystem[] = [auscultationSynth];
