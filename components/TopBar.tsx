'use client';

import { useMemo } from 'react';

interface TopBarProps {
  stateLabel: string;
  now: Date;
}

export default function TopBar({ stateLabel, now }: TopBarProps) {
  const { h, min, ampm, dateStr } = useMemo(() => {
    let hours = now.getHours();
    const minutes = now.getMinutes();
    const period = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const date = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    return { h: hours, min: minutes, ampm: period, dateStr: date };
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
          <span className="days">149 days</span>
          <span className="sep">·</span>
          <span className="label">Loch Ness Marathon · Oct 4</span>
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
