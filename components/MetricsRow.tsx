'use client';

import type { MetricsData } from '@/lib/types';

type DataStatus = 'loading' | 'live' | 'error';

interface MetricsRowProps {
  metrics: MetricsData | null;
  status: DataStatus;
}

export default function MetricsRow({ metrics, status }: MetricsRowProps) {
  const isLive = status === 'live' && metrics != null;

  const cards = [
    {
      label: 'Recovery',
      value: isLive ? `${metrics!.recovery.v}%` : '--',
      sub: isLive ? metrics!.recovery.sub : null,
      prog: isLive ? (metrics!.recovery.v as number) : 0,
      isRecovery: true,
    },
    {
      label: 'HRV',
      value: isLive ? metrics!.hrv.v : '--',
      unit: isLive ? metrics!.hrv.unit : undefined,
      sub: isLive ? metrics!.hrv.sub : null,
      prog: isLive ? Math.min(100, metrics!.hrv.v as number) : 0,
    },
    {
      label: 'Resting HR',
      value: isLive ? metrics!.rhr.v : '--',
      unit: isLive ? metrics!.rhr.unit : undefined,
      sub: isLive ? metrics!.rhr.sub : null,
      prog: isLive ? Math.max(8, Math.min(100, ((70 - (metrics!.rhr.v as number)) / 25) * 100)) : 0,
    },
    {
      label: 'Sleep Performance',
      value: isLive ? `${metrics!.sleep.v}%` : '--',
      sub: isLive ? metrics!.sleep.sub : null,
      prog: isLive ? (metrics!.sleep.v as number) : 0,
    },
    {
      label: isLive && metrics!.strain.sub?.startsWith('Today') ? "Today's Strain" : "Yesterday's Strain",
      value: isLive ? metrics!.strain.v : '--',
      sub: isLive ? metrics!.strain.sub : null,
      prog: isLive ? Math.min(100, (parseFloat(String(metrics!.strain.v)) / 21) * 100) : 0,
    },
  ];

  return (
    <div className="metrics">
      {cards.map((card) => (
        <div key={card.label} className={`glass metric${card.isRecovery ? ' metric-recovery' : ''}`}>
          <div className="metric-glow" />
          <div className="metric-head">
            <div className="metric-label">{card.label}</div>
            <div className="metric-source">
              {status === 'error' ? (
                <span style={{ color: 'rgba(255,180,100,0.85)', fontSize: '0.7rem' }}>⚠ Whoop offline</span>
              ) : (
                <span style={{ opacity: status === 'loading' ? 0.4 : 1 }}>Whoop</span>
              )}
            </div>
          </div>
          <div className="metric-value" style={{ opacity: status === 'loading' ? 0.3 : 1 }}>
            <span>{card.value}</span>
            {card.unit && <span className="unit">{card.unit}</span>}
          </div>
          <div className="metric-sub" style={{ opacity: status === 'loading' ? 0.3 : 1 }}>
            {card.sub ?? ' '}
          </div>
          <div className="progress">
            <span style={{ width: card.prog + '%', opacity: isLive ? 1 : 0.15 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
