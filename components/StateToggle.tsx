'use client';

import type { RecoveryState } from '@/lib/types';

interface StateToggleProps {
  state: RecoveryState;
  onStateChange: (state: RecoveryState) => void;
}

const BUTTONS: [RecoveryState, string, string][] = [
  ['green', 'Recovered', 'sw-green'],
  ['amber', 'Adequate', 'sw-amber'],
  ['red', 'Compromised', 'sw-red'],
];

export default function StateToggle({ state, onStateChange }: StateToggleProps) {
  return (
    <div className="state-toggle">
      {BUTTONS.map(([key, label, swClass]) => (
        <button
          key={key}
          className={state === key ? 'active' : ''}
          onClick={() => onStateChange(key)}
        >
          <span className={`swatch ${swClass}`} />
          {label}
        </button>
      ))}
    </div>
  );
}
