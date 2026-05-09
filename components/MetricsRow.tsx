'use client';

import type { MetricsData } from '@/lib/types';

interface MetricsRowProps {
  metrics: MetricsData;
}

export default function MetricsRow({ metrics }: MetricsRowProps) {
  const cards = [
    {
      label: 'Recovery',
      src: 'Whoop',
      value: `${metrics.recovery.v}%`,
      sub: metrics.recovery.sub,
      prog: metrics.recovery.v as number,
      isRecovery: true,
    },
    {
      label: 'HRV',
      src: 'Whoop',
      value: metrics.hrv.v,
      unit: metrics.hrv.unit,
      sub: metrics.hrv.sub,
      prog: Math.min(100, metrics.hrv.v as number),
    },
    {
      label: 'Resting HR',
      src: 'Whoop',
      value: metrics.rhr.v,
      unit: metrics.rhr.unit,
      sub: metrics.rhr.sub,
      prog: Math.max(8, Math.min(100, ((70 - (metrics.rhr.v as number)) / 25) * 100)),
    },
    {
      label: 'Sleep Performance',
      src: 'Whoop',
      value: `${metrics.sleep.v}%`,
      sub: metrics.sleep.sub,
      prog: metrics.sleep.v as number,
    },
    {
      label: "Yesterday's Strain",
      src: 'Whoop',
      value: metrics.strain.v,
      sub: metrics.strain.sub,
      prog: Math.min(100, (parseFloat(String(metrics.strain.v)) / 21) * 100),
    },
  ];

  return (
    <div className="metrics">
      {cards.map((card, i) => (
        <div key={i} className={`glass metric${card.isRecovery ? ' metric-recovery' : ''}`}>
          <div className="metric-glow" />
          <div className="metric-head">
            <div className="metric-label">{card.label}</div>
            <div className="metric-source">{card.src}</div>
          </div>
          <div className="metric-value">
            <span>{card.value}</span>
            {card.unit && <span className="unit">{card.unit}</span>}
          </div>
          <div className="metric-sub">{card.sub}</div>
          <div className="progress">
            <span style={{ width: card.prog + '%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
