'use client';

import type { BriefData } from '@/lib/types';
import Icon from './Icon';

interface MorningBriefProps {
  brief: BriefData;
}

export default function MorningBrief({ brief }: MorningBriefProps) {
  return (
    <div className="glass hero">
      <div className="hero-head">
        <span className="live-dot" />
        <span className="hero-label">
          Claude <span className="sep">·</span> Morning Brief
        </span>
        <span className="hero-time">Generated 6:42 AM · Sources: Whoop, Strava, Calendar</span>
      </div>
      <div className="hero-body">{brief.body}</div>
      <div className="hero-chips">
        {brief.chips.map((chip, i) => (
          <div className="chip" key={i}>
            <Icon name={chip.icon} className="icon" />
            <span className="k">{chip.k}</span>
            <span className="v">{chip.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
