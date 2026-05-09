'use client';

import type { MileageDay, Route } from '@/lib/types';
import { TARGET_KM } from '@/lib/data';

interface StravaPanelProps {
  mileage: MileageDay[];
  routes: Route[];
  totalKm: number;
}

export default function StravaPanel({ mileage, routes, totalKm }: StravaPanelProps) {

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
            8.4<span className="u">km</span>
          </div>
          <div className="s">Kelvingrove · Wed PM</div>
        </div>
        <div className="mini">
          <div className="k">Pace</div>
          <div className="v">
            4:58<span className="u">/km</span>
          </div>
          <div className="s">−12s vs avg</div>
        </div>
        <div className="mini">
          <div className="k">Avg HR</div>
          <div className="v">
            154<span className="u">bpm</span>
          </div>
          <div className="s">Zone 3 · 78%</div>
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
          <span className="t">Weekly Mileage</span>
          <span className="total">
            {totalKm.toFixed(1)} <span>/ {TARGET_KM} km target</span>
          </span>
        </div>
        <div className="bars">
          {mileage.map((b, i) => {
            const h = b.km > 0 ? Math.max(8, (b.km / 18) * 100) : 6;
            return (
              <div key={i} className={`bar${b.today ? ' is-today' : ''}`}>
                <div className="col">
                  <div
                    className={`fill${b.km === 0 ? ' empty' : b.today ? ' today' : ''}`}
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
