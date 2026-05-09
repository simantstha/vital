import { Fragment } from 'react';
import type { ReactNode } from 'react';

export function parseMarkup(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return (
    <Fragment>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <b key={i}>{part.slice(2, -2)}</b>;
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return <em key={i}>{part.slice(1, -1)}</em>;
        }
        return part || null;
      })}
    </Fragment>
  );
}
