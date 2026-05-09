'use client';

import type { MileageDay, Route } from '@/lib/types';
import type { LastRun } from '@/lib/strava';
import { TARGET_MI } from '@/lib/data';

interface StravaPanelProps {
  mileage: MileageDay[];
  routes: Route[];
  totalMi: number;
  lastRun: LastRun | null;
}

export default function StravaPanel({ mileage, routes, totalMi, lastRun }: StravaPanelProps) {

  return (
    <div className="glass panel">
      <div className="panel-head">
        <div className="panel-title">
          Activity <span className="src strava">STRAVA</span>
        </div>
        <div className="panel-meta">Last 7 days</div>
      </div>

      <div className="run-stats">
        <div className="mini">
          <div className="k">Last Run · Distance</div>
          <div className="v">
            {lastRun?.distanceMi ?? '–'}<span className="u">mi</span>
          </div>
          <div className="s">{lastRun ? `${lastRun.name} · ${lastRun.dayTime}` : '–'}</div>
        </div>
        <div className="mini">
          <div className="k">Pace</div>
          <div className="v">
            {lastRun?.pace ?? '–'}<span className="u">/mi</span>
          </div>
          <div className="s">avg pace</div>
        </div>
        <div className="mini">
          <div className="k">Avg HR</div>
          <div className="v">
            {lastRun?.hr ?? '–'}<span className="u">bpm</span>
          </div>
          <div className="s">{lastRun?.zone ?? '–'}</div>
        </div>
      </div>

      <div className="section-title">Favorite Routes</div>
      <div className="routes">
        {routes.map((r, i) => (
          <div key={i} className="route">
            <div className="name">
              <div className="t">{r.name}</div>
              <div className="d">
                {r.d} · {r.e} elev · {r.p}
              </div>
            </div>
            <div className="badge">{r.count} runs</div>
          </div>
        ))}
      </div>

      <div className="mileage">
        <div className="mileage-head">
          <span className="t">Weekly Miles</span>
          <span className="total">
            {totalMi.toFixed(1)} <span>/ {TARGET_MI} mi target</span>
          </span>
        </div>
        <div className="bars">
          {mileage.map((b, i) => {
            const h = b.mi > 0 ? Math.max(8, (b.mi / 11) * 100) : 6;
            return (
              <div key={i} className={`bar${b.today ? ' is-today' : ''}`}>
                <div className="col">
                  <div
                    className={`fill${b.mi === 0 ? ' empty' : b.today ? ' today' : ''}`}
                    style={{ height: h + '%' }}
                  />
                </div>
                <div className="day">{b.d}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
