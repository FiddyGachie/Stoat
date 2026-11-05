import React from 'react';

interface Props {
  label: string;
  variant?: 'live' | 'replayed' | 'seeded' | 'mocked' | 'ok' | 'error' | 'warning' | 'info';
}

const COLORS: Record<NonNullable<Props['variant']>, string> = {
  live:     '#22c55e',
  replayed: '#a78bfa',
  seeded:   '#f59e0b',
  mocked:   '#64748b',
  ok:       '#22c55e',
  error:    '#ef4444',
  warning:  '#f59e0b',
  info:     '#38bdf8',
};

export const StatusBadge: React.FC<Props> = ({ label, variant = 'info' }) => (
  <span
    aria-label={`Status: ${label}`}
    style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      background: COLORS[variant] + '22',
      color: COLORS[variant],
      border: `1px solid ${COLORS[variant]}44`,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}
  >
    {label}
  </span>
);
