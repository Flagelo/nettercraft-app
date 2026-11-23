import type { SimSystem } from '../../model/contracts/types';
import { HemodynamicEngine } from '../../model/hemodynamics/HemodynamicEngine';

/**
 * Hemodynamics module wiring (controller layer).
 * Owns the engine instance and the system list handed to the SimulationLoop,
 * so the view never instantiates or registers a model engine.
 */
export const hemoEngine = new HemodynamicEngine();
export const physiologySystems: SimSystem[] = [hemoEngine];
