export interface RawSqlTimeBindings {
  now: string;
  lease: string;
}

export function rawSqlTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid raw SQL timestamp.');
  return date.toISOString();
}

export function rawSqlTimeBindings(now: Date, leaseMs: number): RawSqlTimeBindings {
  return {
    now: rawSqlTimestamp(now),
    lease: rawSqlTimestamp(new Date(now.getTime() + leaseMs)),
  };
}
