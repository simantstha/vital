'use client';

import { useMemo } from 'react';

interface TopBarProps {
  stateLabel: string;
  now: Date;
}

export default function TopBar({ stateLabel, now }: TopBarProps) {
  const { h, min, ampm, dateStr, daysLeft } = useMemo(() => {
    let hours = now.getHours();
    const minutes = now.getMinutes();
    const period = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const date = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    const raceDate = new Date('2026-10-04T00:00:00');
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.ceil((raceDate.getTime() - todayMidnight.getTime()) / (1000 * 60 * 60 * 24));
    return { h: hours, min: minutes, ampm: period, dateStr: date, daysLeft: diff };
  }, [now]);

  return (
    <div className="topbar">
      <div className="brand-row">
        <div className="brand">Vital</div>
        <div className="brand-sub">
          {dateStr} · {stateLabel}
        </div>
      </div>
      <div className="top-right">
        <div className="countdown-pill">
          <span className="days">{daysLeft} days</span>
          <span className="sep">·</span>
          <span className="label">Twin Cities Marathon · Oct 4</span>
        </div>
        <div className="clock">
          <span>{h}</span>
          <span className="colon">:</span>
          <span>{String(min).padStart(2, '0')}</span>
          <span className="ampm">{ampm}</span>
        </div>
      </div>
    </div>
  );
}
