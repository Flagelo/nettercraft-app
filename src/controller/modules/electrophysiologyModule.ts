import type { SimSystem } from '../../model/contracts/types';
import { ElectroEngine } from '../../model/electrophysiology/ElectroEngine';

/**
 * Electrophysiology module wiring (controller layer).
 * Owns the 12-lead engine instance registered in the SimulationLoop.
 */
export const electroEngine = new ElectroEngine();
export const electroSystems: SimSystem[] = [electroEngine];
