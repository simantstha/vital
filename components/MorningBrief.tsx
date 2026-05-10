import type { BriefData } from '@/lib/types';
import type { DailyBrief } from '@/lib/types';
import { parseMarkup } from '@/lib/markup';
import Icon from './Icon';

interface MorningBriefProps {
  brief: BriefData;
  claudeBrief?: DailyBrief | null;
}

const CHIP_ICONS: Record<string, 'bolt' | 'moon' | 'flame'> = {
  Workout: 'bolt',
  Sleep: 'moon',
  Strain: 'flame',
};

export default function MorningBrief({ brief, claudeBrief }: MorningBriefProps) {
  const body = claudeBrief ? parseMarkup(claudeBrief.body) : brief.body;
  const chips = claudeBrief
    ? claudeBrief.chips.map(c => ({ ...c, icon: CHIP_ICONS[c.k] ?? 'bolt' }))
    : brief.chips;

  const generatedAt = claudeBrief
    ? new Date(claudeBrief.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '6:42 AM';

  return (
    <div className="glass hero">
      <div className="hero-head">
        <span className="live-dot" />
        <span className="hero-label">
          Claude <span className="sep">·</span> Morning Brief
        </span>
        <span className="hero-time">Generated {generatedAt} · Sources: Whoop, Strava</span>
      </div>
      <div className="hero-body">{body}</div>
      <div className="hero-chips">
        {chips.map((chip) => (
          <div className="chip" key={chip.k}>
            <Icon name={chip.icon} className="icon" />
            <span className="k">{chip.k}</span>
            <span className="v">{chip.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
