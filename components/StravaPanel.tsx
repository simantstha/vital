'use client';

import type { MileageDay, MinutesDay } from '@/lib/types';
import type { LastRun, LastWorkout } from '@/lib/strava';
import { TARGET_MI } from '@/lib/data';

type DataStatus = 'loading' | 'live' | 'error';

interface StravaPanelProps {
  mileage: MileageDay[];
  walkMileage: MileageDay[];
  gymMinutes: MinutesDay[];
  totalMi: number;
  totalWalkMi: number;
  totalGymMin: number;
  gymSessionCount: number;
  lastRun: LastRun | null;
  lastWorkout: LastWorkout | null;
  status: DataStatus;
}

export default function StravaPanel({
  mileage,
  walkMileage,
  gymMinutes,
  totalMi,
  totalWalkMi,
  totalGymMin,
  gymSessionCount,
  lastRun,
  lastWorkout,
  status,
}: StravaPanelProps) {
  const gymData = gymMinutes.map((d) => ({ d: d.d, mi: d.min, today: d.today }));
  const chartRows = [
    {
      key: 'run',
      title: 'Run Miles',
      total: `${totalMi.toFixed(1)} / ${TARGET_MI} mi target`,
      data: mileage,
      max: Math.max(11, ...mileage.map(d => d.mi)),
      opacity: 1,
    },
    {
      key: 'walk',
      title: 'Walk Miles',
      total: `${totalWalkMi.toFixed(1)} mi`,
      data: walkMileage,
      max: Math.max(5, ...walkMileage.map(d => d.mi)),
      opacity: 0.62,
    },
    {
      key: 'gym',
      title: 'Gym Minutes',
      total: `${totalGymMin} / ${gymSessionCount} sessions`,
      data: gymData,
      max: Math.max(90, ...gymData.map(d => d.mi)),
      opacity: 0.78,
    },
  ];

  return (
    <div className="glass panel activity-panel">
      <div className="panel-head">
        <div className="panel-title">
          Activity{' '}
          {status === 'error' ? (
            <span style={{ fontSize: '0.7rem', color: 'rgba(255,180,100,0.85)', marginLeft: 4 }}>⚠ Strava offline</span>
          ) : (
            <span className="src strava" style={{ opacity: status === 'loading' ? 0.4 : 1 }}>STRAVA</span>
          )}
        </div>
        <div className="panel-meta">Last 7 days</div>
      </div>

      <div className="activity-overview" style={{ opacity: status === 'loading' ? 0.3 : 1 }}>
        <div className="mini mini-primary">
          <div>
            <div className="k">Last Run</div>
            <div className="v">
              {lastRun?.distanceMi ?? '-'}<span className="u">mi</span>
            </div>
          </div>
          <div className="s">
            {status === 'error'
              ? 'Strava unavailable'
              : lastRun ? `${lastRun.name} · ${lastRun.dayTime}` : 'Waiting for Strava sync'}
          </div>
        </div>
        <div className="mini">
          <div className="k">Pace</div>
          <div className="v">
            {lastRun?.pace ?? '-'}<span className="u">/mi</span>
          </div>
          <div className="s">avg pace</div>
        </div>
        <div className="mini">
          <div className="k">Avg HR</div>
          <div className="v">
            {lastRun?.hr ?? '-'}<span className="u">bpm</span>
          </div>
          <div className="s">{lastRun?.zone ?? '-'}</div>
        </div>
        <div className="mini">
          <div className="k">Last {lastWorkout?.type === 'gym' ? 'Gym' : 'Walk'}</div>
          <div className="v">
            {lastWorkout?.durationMin ?? '-'}<span className="u">min</span>
          </div>
          <div className="s">
            {status === 'error' ? '—' : lastWorkout ? `${lastWorkout.name} · ${lastWorkout.dayTime}` : 'No recent walk/gym'}
          </div>
        </div>
      </div>

      <div className="training-board">
        {chartRows.map((row) => (
          <div className={`mileage mileage-${row.key}`} key={row.key}>
            <div className="mileage-head">
              <span className="t">{row.title}</span>
              <span className="total" style={{ opacity: status === 'loading' ? 0.3 : 1 }}>{row.total}</span>
            </div>
            <div className="bars">
              {row.data.map((b, i) => {
                const h = b.mi > 0 ? Math.min(100, Math.max(8, (b.mi / row.max) * 100)) : 6;
                return (
                  <div key={i} className={`bar${b.today ? ' is-today' : ''}`}>
                    <div className="col">
                      <div
                        className={`fill${b.mi === 0 ? ' empty' : b.today ? ' today' : ''}`}
                        style={{ height: h + '%', opacity: status === 'loading' ? 0.15 : row.opacity }}
                      />
                    </div>
                    <div className="day">{b.d}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="activity-footer" style={{ opacity: status === 'loading' ? 0.3 : 1 }}>
        <div>
          <span className="footer-k">Run Load</span>
          <span className="footer-v">{Math.round((totalMi / TARGET_MI) * 100)}%</span>
        </div>
        <div>
          <span className="footer-k">Cross-Training</span>
          <span className="footer-v">{totalGymMin + Math.round(totalWalkMi * 15)} min</span>
        </div>
        <div>
          <span className="footer-k">Today</span>
          <span className="footer-v">
            {(mileage.find((d) => d.today)?.mi ?? 0).toFixed(1)} mi
          </span>
        </div>
      </div>
    </div>
  );
}
