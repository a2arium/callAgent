export type MetricDimensions = Record<string, string | number | boolean | null | undefined>;

export type MetricCounterSnapshot = {
    name: string;
    count: number;
    dimensions: Record<string, string>;
};

export type MetricGaugeSnapshot = {
    name: string;
    value: number;
    dimensions: Record<string, string>;
    updatedAt: string;
};

export type MetricDurationSnapshot = {
    name: string;
    count: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    dimensions: Record<string, string>;
};

export type MetricsSnapshot = {
    generatedAt: string;
    uptimeMs: number;
    seriesCount: {
        total: number;
        counters: number;
        gauges: number;
        durations: number;
    };
    limits: {
        durationSampleLimit: number;
        maxSeriesTotal: number;
        maxSeriesPerMetric: number;
    };
    droppedSeriesCount: number;
    counters: MetricCounterSnapshot[];
    gauges: MetricGaugeSnapshot[];
    durations: MetricDurationSnapshot[];
    alerts: Array<{
        name: string;
        state: 'ok' | 'warning';
        message: string;
        value?: number;
        threshold?: number;
    }>;
};

const DEFAULT_DURATION_SAMPLE_LIMIT = 512;
const DEFAULT_MAX_SERIES_TOTAL = 2_000;
const DEFAULT_MAX_SERIES_PER_METRIC = 200;
const OVERFLOW_DIMENSIONS = { cardinality: 'overflow' } as const;

export type MetricsRegistryOptions = {
    durationSampleLimit?: number;
    maxSeriesTotal?: number;
    maxSeriesPerMetric?: number;
};

export class MetricsRegistry {
    private readonly startedAt = Date.now();
    private droppedSeriesCount = 0;
    private readonly counters = new Map<string, { name: string; dimensions: Record<string, string>; count: number }>();
    private readonly gauges = new Map<string, { name: string; dimensions: Record<string, string>; value: number; updatedAt: string }>();
    private readonly durations = new Map<string, { name: string; dimensions: Record<string, string>; samples: number[] }>();
    private readonly durationSampleLimit: number;
    private readonly maxSeriesTotal: number;
    private readonly maxSeriesPerMetric: number;

    constructor(options: MetricsRegistryOptions | number = {}) {
        const normalized = typeof options === 'number' ? { durationSampleLimit: options } : options;
        this.durationSampleLimit = readPositiveLimit(normalized.durationSampleLimit, DEFAULT_DURATION_SAMPLE_LIMIT);
        this.maxSeriesTotal = readPositiveLimit(normalized.maxSeriesTotal, DEFAULT_MAX_SERIES_TOTAL);
        this.maxSeriesPerMetric = readPositiveLimit(normalized.maxSeriesPerMetric, DEFAULT_MAX_SERIES_PER_METRIC);
    }

    increment(name: string, dimensions?: MetricDimensions, by = 1): void {
        this.safely(() => {
            const normalized = this.resolveDimensions('counter', name, dimensions);
            const key = metricKey(name, normalized.dimensions);
            if (normalized.dropped) {
                this.recordDroppedSeries(name, 'counter');
            }
            const current = this.counters.get(key) ?? { name, dimensions: normalized.dimensions, count: 0 };
            current.count += by;
            this.counters.set(key, current);
        });
    }

    setGauge(name: string, value: number, dimensions?: MetricDimensions): void {
        this.safely(() => {
            const normalized = this.resolveDimensions('gauge', name, dimensions);
            if (normalized.dropped) {
                this.recordDroppedSeries(name, 'gauge');
            }
            this.gauges.set(metricKey(name, normalized.dimensions), {
                name,
                dimensions: normalized.dimensions,
                value,
                updatedAt: new Date().toISOString(),
            });
        });
    }

    observeDuration(name: string, durationMs: number, dimensions?: MetricDimensions): void {
        this.safely(() => {
            const normalized = this.resolveDimensions('duration', name, dimensions);
            const key = metricKey(name, normalized.dimensions);
            if (normalized.dropped) {
                this.recordDroppedSeries(name, 'duration');
            }
            const current = this.durations.get(key) ?? { name, dimensions: normalized.dimensions, samples: [] };
            current.samples.push(Math.max(0, Math.round(durationMs)));
            if (current.samples.length > this.durationSampleLimit) {
                current.samples.splice(0, current.samples.length - this.durationSampleLimit);
            }
            this.durations.set(key, current);
        });
    }

    startTimer(name: string, dimensions?: MetricDimensions): (extraDimensions?: MetricDimensions) => void {
        const start = Date.now();
        return (extraDimensions?: MetricDimensions) => {
            this.observeDuration(name, Date.now() - start, {
                ...dimensions,
                ...extraDimensions,
            });
        };
    }

    snapshot(): MetricsSnapshot {
        const counters = [...this.counters.values()]
            .map((entry) => ({ name: entry.name, count: entry.count, dimensions: entry.dimensions }))
            .sort(compareMetricRows);
        const gauges = [...this.gauges.values()]
            .map((entry) => ({ name: entry.name, value: entry.value, dimensions: entry.dimensions, updatedAt: entry.updatedAt }))
            .sort(compareMetricRows);
        const durations = [...this.durations.values()]
            .map((entry) => durationSnapshot(entry.name, entry.dimensions, entry.samples))
            .sort(compareMetricRows);
        return {
            generatedAt: new Date().toISOString(),
            uptimeMs: Date.now() - this.startedAt,
            seriesCount: {
                total: this.seriesCount(),
                counters: this.counters.size,
                gauges: this.gauges.size,
                durations: this.durations.size,
            },
            limits: {
                durationSampleLimit: this.durationSampleLimit,
                maxSeriesTotal: this.maxSeriesTotal,
                maxSeriesPerMetric: this.maxSeriesPerMetric,
            },
            droppedSeriesCount: this.droppedSeriesCount,
            counters,
            gauges,
            durations,
            alerts: deriveAlerts(counters, gauges, durations),
        };
    }

    reset(): void {
        this.counters.clear();
        this.gauges.clear();
        this.durations.clear();
        this.droppedSeriesCount = 0;
    }

    private resolveDimensions(kind: 'counter' | 'gauge' | 'duration', name: string, dimensions: MetricDimensions | undefined): {
        dimensions: Record<string, string>;
        dropped: boolean;
    } {
        const sanitized = sanitizeMetricDimensions(dimensions);
        const key = metricKey(name, sanitized);
        const collection = this.collectionFor(kind);
        if (collection.has(key)) {
            return { dimensions: sanitized, dropped: false };
        }
        const metricSeriesCount = [...this.counters.values()].filter((entry) => entry.name === name).length +
            [...this.gauges.values()].filter((entry) => entry.name === name).length +
            [...this.durations.values()].filter((entry) => entry.name === name).length;
        if (this.seriesCount() >= this.maxSeriesTotal || metricSeriesCount >= this.maxSeriesPerMetric) {
            return { dimensions: OVERFLOW_DIMENSIONS, dropped: true };
        }
        return { dimensions: sanitized, dropped: false };
    }

    private collectionFor(kind: 'counter' | 'gauge' | 'duration'): Map<string, unknown> {
        if (kind === 'counter') return this.counters;
        if (kind === 'gauge') return this.gauges;
        return this.durations;
    }

    private seriesCount(): number {
        return this.counters.size + this.gauges.size + this.durations.size;
    }

    private recordDroppedSeries(metric: string, kind: 'counter' | 'gauge' | 'duration'): void {
        this.droppedSeriesCount += 1;
        const dimensions = { metric, kind };
        const key = metricKey('observability.metric_cardinality_dropped_total', dimensions);
        const current = this.counters.get(key) ?? {
            name: 'observability.metric_cardinality_dropped_total',
            dimensions,
            count: 0,
        };
        current.count += 1;
        this.counters.set(key, current);
    }

    private safely(fn: () => void): void {
        try {
            fn();
        } catch {
            // Metrics must never change runtime behavior.
        }
    }
}

export const defaultMetricsRegistry = new MetricsRegistry();

const ALLOWED_DIMENSIONS = new Set([
    'cardinality',
    'code',
    'errorCode',
    'eventType',
    'kind',
    'level',
    'method',
    'metric',
    'operation',
    'phase',
    'route',
    'status',
    'surface',
    'type',
]);

const MAX_DIMENSION_VALUE_LENGTH = 80;

export function sanitizeMetricDimensions(dimensions: MetricDimensions | undefined): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(dimensions ?? {})) {
        if (value !== undefined && value !== null && ALLOWED_DIMENSIONS.has(key)) {
            output[key] = normalizeDimensionValue(value);
        }
    }
    return output;
}

function normalizeDimensionValue(value: string | number | boolean): string {
    const text = String(value);
    if (text.length <= MAX_DIMENSION_VALUE_LENGTH) {
        return text;
    }
    return `${text.slice(0, MAX_DIMENSION_VALUE_LENGTH)}...`;
}

function metricKey(name: string, dimensions: Record<string, string>): string {
    const pairs = Object.entries(dimensions)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join('|');
    return `${name}|${pairs}`;
}

function durationSnapshot(name: string, dimensions: Record<string, string>, samples: number[]): MetricDurationSnapshot {
    const sorted = [...samples].sort((left, right) => left - right);
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
        name,
        count: sorted.length,
        minMs: sorted[0] ?? 0,
        maxMs: sorted[sorted.length - 1] ?? 0,
        avgMs: sorted.length > 0 ? Math.round(sum / sorted.length) : 0,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        dimensions,
    };
}

function percentile(sorted: number[], ratio: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
    return sorted[index] ?? 0;
}

function compareMetricRows(left: { name: string; dimensions: Record<string, string> }, right: { name: string; dimensions: Record<string, string> }): number {
    return `${left.name}:${JSON.stringify(left.dimensions)}`.localeCompare(`${right.name}:${JSON.stringify(right.dimensions)}`);
}

function deriveAlerts(
    counters: MetricCounterSnapshot[],
    gauges: MetricGaugeSnapshot[],
    durations: MetricDurationSnapshot[]
): MetricsSnapshot['alerts'] {
    const alerts: MetricsSnapshot['alerts'] = [];
    const timerLagThreshold = readThreshold('CALLAGENT_ALERT_TIMER_LAG_MS', 60_000);
    for (const gauge of gauges.filter((item) => item.name === 'runtime.timer_lag_ms')) {
        alerts.push({
            name: 'timer_lag',
            state: gauge.value > timerLagThreshold ? 'warning' : 'ok',
            message: gauge.value > timerLagThreshold ? 'Timer lag exceeds threshold.' : 'Timer lag is within threshold.',
            value: gauge.value,
            threshold: timerLagThreshold,
        });
    }
    const apiP95Threshold = readThreshold('CALLAGENT_ALERT_API_P95_MS', 2_000);
    for (const duration of durations.filter((item) => item.name === 'operator.api_request_ms')) {
        alerts.push({
            name: `api_p95:${duration.dimensions.route ?? 'unknown'}`,
            state: duration.p95Ms > apiP95Threshold ? 'warning' : 'ok',
            message: duration.p95Ms > apiP95Threshold ? 'Operator API p95 exceeds threshold.' : 'Operator API p95 is within threshold.',
            value: duration.p95Ms,
            threshold: apiP95Threshold,
        });
    }
    const degradedLogs = counters
        .filter((item) => item.name === 'observability.log_sink_failure_total')
        .reduce((total, item) => total + item.count, 0);
    if (degradedLogs > 0) {
        alerts.push({
            name: 'log_sink_failure',
            state: 'warning',
            message: 'One or more log sink writes failed.',
            value: degradedLogs,
            threshold: 0,
        });
    }
    return alerts;
}

function readThreshold(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPositiveLimit(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}
