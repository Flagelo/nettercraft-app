import { WiggersCanvas } from './WiggersCanvas';
import { PVLoopCanvas } from './PVLoopCanvas';

export function WiggersView({ height }: { height?: number } = {}) {
  return <WiggersCanvas height={height} />;
}

export function PVLoopView({ height }: { height?: number } = {}) {
  return <PVLoopCanvas height={height} />;
}
