export function formatDateTime(value: string | undefined): string {
  if (!value) return 'Not captured';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleString()} (${date.toISOString()})`;
}

export function formatRelative(value: string | undefined, now: Date = new Date()): string {
  if (!value) return 'Not captured';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = now.getTime() - date.getTime();
  const absMs = Math.abs(diffMs);
  const units: Array<[number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  for (const [unitMs, label] of units) {
    if (absMs >= unitMs) {
      return `${Math.round(absMs / unitMs)}${label} ${diffMs >= 0 ? 'ago' : 'from now'}`;
    }
  }
  return 'just now';
}

export function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return 'Not captured';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatCost(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Not captured';
  if (value === 0) return '$0.0000';
  if (value < 0.0001) return '<$0.0001';
  return `$${value.toFixed(4)}`;
}

export function formatNumber(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Not captured';
  return new Intl.NumberFormat().format(value);
}

export function middleEllipsis(value: string, max = 18): string {
  if (value.length <= max) return value;
  const side = Math.max(4, Math.floor((max - 1) / 2));
  return `${value.slice(0, side)}…${value.slice(-side)}`;
}

export function stringFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'Not captured';
  try {
    return JSON.stringify(value);
  } catch {
    return 'Unserializable value';
  }
}
