'use client';

interface IconProps {
  name: 'bolt' | 'moon' | 'flame';
  className?: string;
}

export default function Icon({ name, className }: IconProps) {
  const props = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
  };

  if (name === 'bolt') {
    return (
      <svg {...props}>
        <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
      </svg>
    );
  }
  if (name === 'moon') {
    return (
      <svg {...props}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  }
  if (name === 'flame') {
    return (
      <svg {...props}>
        <path d="M12 2s4 4 4 8a4 4 0 0 1-8 0c0-1 .4-2 .9-2.6C8 9 8 7 8 7s2 1 2 3c0-3 2-6 2-8z" />
      </svg>
    );
  }
  return null;
}
