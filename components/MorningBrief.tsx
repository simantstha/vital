import type { BriefData } from '@/lib/types';
import type { DailyBrief } from '@/lib/types';
import { parseMarkup } from '@/lib/markup';
import Icon from './Icon';

type DataStatus = 'loading' | 'live' | 'error';

interface MorningBriefProps {
  brief: BriefData;
  claudeBrief?: DailyBrief | null;
  status: DataStatus;
}

const CHIP_ICONS: Record<string, 'bolt' | 'moon' | 'flame'> = {
  Workout: 'bolt',
  Sleep: 'moon',
  Strain: 'flame',
};

export default function MorningBrief({ brief, claudeBrief, status }: MorningBriefProps) {
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
        <span className="live-dot" style={{ opacity: status === 'error' ? 0.3 : 1 }} />
        <span className="hero-label">
          Claude <span className="sep">·</span> Morning Brief
        </span>
        {status === 'error' ? (
          <span className="hero-time" style={{ color: 'rgba(255,180,100,0.85)' }}>
            ⚠ Brief unavailable — check API keys
          </span>
        ) : (
          <span className="hero-time" style={{ opacity: status === 'loading' ? 0.4 : 1 }}>
            {status === 'loading' ? 'Generating…' : `Generated ${generatedAt} · Sources: Whoop, Strava`}
          </span>
        )}
      </div>
      <div className="hero-body" style={{ opacity: status === 'loading' ? 0.3 : 1 }}>
        {status === 'error' ? (
          <span style={{ opacity: 0.5 }}>Could not generate today&apos;s brief. Real-time data unavailable.</span>
        ) : (
          body
        )}
      </div>
      <div className="hero-chips" style={{ opacity: status === 'loading' ? 0.2 : status === 'error' ? 0.25 : 1 }}>
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
