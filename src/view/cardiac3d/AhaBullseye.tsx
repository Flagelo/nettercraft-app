import { usePhysiologyStore } from '../../controller/usePhysiologyStore';
import type { WallMotionScore } from '../../model/contracts/types';
import { AHA_SEGMENTS } from '../../model/electrophysiology/ElectroEngine';

interface Props {
  selectedSegment: number | null;
  onSelectSegment: (segId: number | null) => void;
  compact?: boolean;
}

const SCORE_COLORS: Record<WallMotionScore, string> = {
  1: '#16a34a', // Normal
  2: '#eab308', // Hypokinetic
  3: '#ea580c', // Akinetic
  4: '#a855f7', // Dyskinetic / Aneurysm
};

const SCORE_LABELS: Record<WallMotionScore, string> = {
  1: '1 · Normal',
  2: '2 · Hipocinético',
  3: '3 · Acinético',
  4: '4 · Discinético',
};

/**
 * Official AHA/ASE 17-Segment Polar Map ("Bull's-eye").
 * A single click selects or cycles the wall motion score (1 -> 2 -> 3 -> 4 -> 1).
 */
export function AhaBullseye({ selectedSegment, onSelectSegment, compact = false }: Props) {
  const wallMotion = usePhysiologyStore((s) => s.params.echo.wallMotion);
  const setWallMotion = usePhysiologyStore((s) => s.setWallMotion);
  const patchEcho = usePhysiologyStore((s) => s.patch);

  const size = compact ? 156 : 196;
  const cx = size / 2;
  const cy = size / 2;
  const rApex = size * 0.12;
  const rApical = size * 0.25;
  const rMid = size * 0.37;
  const rBasal = size * 0.48;

  const storeSelectedSegment = usePhysiologyStore((s) => s.selectedSegment);
  const activeSegment = selectedSegment ?? storeSelectedSegment;

  const handleSegmentClick = (segId: number) => {
    const nextSeg = activeSegment === segId ? null : segId;
    onSelectSegment(nextSeg);
    usePhysiologyStore.getState().setSelectedSegment(nextSeg);
    const idx = segId - 1;
    const cur = wallMotion[idx] ?? 1;
    const next = ((cur % 4) + 1) as WallMotionScore;
    setWallMotion(idx, next);
  };

  const setTerritoryScore = (territory: 'lad' | 'lcx' | 'rca' | 'all', score: WallMotionScore) => {
    const next = wallMotion.slice() as WallMotionScore[];
    for (let i = 0; i < 17; i++) {
      if (territory === 'all' || AHA_SEGMENTS[i].territory === territory) {
        next[i] = score;
      }
    }
    patchEcho('echo', { wallMotion: next });
  };

  return (
    <div className="bullseye-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="bullseye-svg">
        {/* Basal Ring: 1..6 */}
        {Array.from({ length: 6 }, (_, k) => {
          const segId = k + 1;
          const a0 = (-120 - k * 60) * (Math.PI / 180);
          const a1 = (-120 - (k + 1) * 60) * (Math.PI / 180);
          return renderArcSector(cx, cy, rMid, rBasal, a1, a0, segId, wallMotion[segId - 1], activeSegment === segId, handleSegmentClick);
        })}
        {/* Mid Ring: 7..12 */}
        {Array.from({ length: 6 }, (_, k) => {
          const segId = 7 + k;
          const a0 = (-120 - k * 60) * (Math.PI / 180);
          const a1 = (-120 - (k + 1) * 60) * (Math.PI / 180);
          return renderArcSector(cx, cy, rApical, rMid, a1, a0, segId, wallMotion[segId - 1], activeSegment === segId, handleSegmentClick);
        })}
        {/* Apical Ring: 13..16 */}
        {Array.from({ length: 4 }, (_, k) => {
          const segId = 13 + k;
          const a0 = (-135 - k * 90) * (Math.PI / 180);
          const a1 = (-135 - (k + 1) * 90) * (Math.PI / 180);
          return renderArcSector(cx, cy, rApex, rApical, a1, a0, segId, wallMotion[segId - 1], activeSegment === segId, handleSegmentClick);
        })}
        {/* Center: 17 (Apex) */}
        <g onClick={() => handleSegmentClick(17)} style={{ cursor: 'pointer' }}>
          <circle
            cx={cx}
            cy={cy}
            r={rApex}
            fill={SCORE_COLORS[wallMotion[16] ?? 1]}
            stroke={activeSegment === 17 ? '#ffffff' : '#0b0f14'}
            strokeWidth={activeSegment === 17 ? 2.2 : 1.2}
          />
          <text x={cx} y={cy + 3.5} textAnchor="middle" fill="#05070a" fontSize="9.5" fontWeight="700">
            17
          </text>
        </g>
      </svg>

      {!compact && (
        <div className="bullseye-controls">
          <div className="bullseye-legend">
            {([1, 2, 3, 4] as WallMotionScore[]).map((s) => (
              <span key={s} className="legend-pill">
                <i style={{ background: SCORE_COLORS[s] }} />
                {SCORE_LABELS[s]}
              </span>
            ))}
          </div>
          <div className="bullseye-quick">
            <button type="button" className="btn-chip" onClick={() => setTerritoryScore('all', 1)}>
              Normalizar 17 Seg
            </button>
            <button type="button" className="btn-chip" onClick={() => setTerritoryScore('lad', 3)}>
              Acinesia DA
            </button>
            <button type="button" className="btn-chip" onClick={() => setTerritoryScore('rca', 3)}>
              Acinesia CD
            </button>
            <button type="button" className="btn-chip" onClick={() => setTerritoryScore('lcx', 3)}>
              Acinesia CX
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function renderArcSector(
  cx: number,
  cy: number,
  rIn: number,
  rOut: number,
  a0: number,
  a1: number,
  segId: number,
  score: WallMotionScore,
  isSelected: boolean,
  onClick: (segId: number) => void,
) {
  const x0o = cx + rOut * Math.cos(a0);
  const y0o = cy + rOut * Math.sin(a0);
  const x1o = cx + rOut * Math.cos(a1);
  const y1o = cy + rOut * Math.sin(a1);
  const x0i = cx + rIn * Math.cos(a1);
  const y0i = cy + rIn * Math.sin(a1);
  const x1i = cx + rIn * Math.cos(a0);
  const y1i = cy + rIn * Math.sin(a0);

  const d = [
    `M ${x0o} ${y0o}`,
    `A ${rOut} ${rOut} 0 0 1 ${x1o} ${y1o}`,
    `L ${x0i} ${y0i}`,
    `A ${rIn} ${rIn} 0 0 0 ${x1i} ${y1i}`,
    'Z',
  ].join(' ');

  const aMid = 0.5 * (a0 + a1);
  const rMid = 0.5 * (rIn + rOut);
  const tx = cx + rMid * Math.cos(aMid);
  const ty = cy + rMid * Math.sin(aMid);

  return (
    <g key={segId} onClick={() => onClick(segId)} style={{ cursor: 'pointer' }}>
      <path
        d={d}
        fill={SCORE_COLORS[score ?? 1]}
        stroke={isSelected ? '#ffffff' : '#0b0f14'}
        strokeWidth={isSelected ? 2.2 : 1.2}
      />
      <text x={tx} y={ty + 3} textAnchor="middle" fill="#05070a" fontSize="9" fontWeight="700">
        {segId}
      </text>
    </g>
  );
}
