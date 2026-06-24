import { MetricsRegistry, sanitizeMetricDimensions } from '../src/observability/metrics.js';

describe('MetricsRegistry', () => {
    it('records counters, gauges, durations, and derived alerts', () => {
        const registry = new MetricsRegistry(3);

        registry.increment('hatchet.enqueue_total', { operation: 'agent.run', status: 'completed' });
        registry.increment('hatchet.enqueue_total', { operation: 'agent.run', status: 'completed' }, 2);
        registry.setGauge('runtime.timer_lag_ms', 90_000);
        registry.observeDuration('operator.api_request_ms', 10, { route: 'agent-runs' });
        registry.observeDuration('operator.api_request_ms', 20, { route: 'agent-runs' });
        registry.observeDuration('operator.api_request_ms', 30, { route: 'agent-runs' });

        const snapshot = registry.snapshot();

        expect(snapshot.counters).toContainEqual({
            name: 'hatchet.enqueue_total',
            count: 3,
            dimensions: { operation: 'agent.run', status: 'completed' },
        });
        expect(snapshot.gauges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'runtime.timer_lag_ms',
                value: 90_000,
            }),
        ]));
        expect(snapshot.durations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'operator.api_request_ms',
                count: 3,
                minMs: 10,
                maxMs: 30,
                p95Ms: 30,
            }),
        ]));
        expect(snapshot.alerts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'timer_lag',
                state: 'warning',
            }),
        ]));
        expect(snapshot.limits.durationSampleLimit).toBe(3);
        expect(snapshot.seriesCount.total).toBeGreaterThan(0);
    });

    it('bounds duration samples and can reset captured data', () => {
        const registry = new MetricsRegistry(2);

        registry.observeDuration('runtime.worker_task_ms', 1);
        registry.observeDuration('runtime.worker_task_ms', 2);
        registry.observeDuration('runtime.worker_task_ms', 3);
        expect(registry.snapshot().durations[0]).toEqual(expect.objectContaining({
            count: 2,
            minMs: 2,
            maxMs: 3,
        }));

        registry.reset();
        expect(registry.snapshot().counters).toEqual([]);
        expect(registry.snapshot().gauges).toEqual([]);
        expect(registry.snapshot().durations).toEqual([]);
    });

    it('drops unsafe high-cardinality dimensions before storing series', () => {
        expect(sanitizeMetricDimensions({
            operation: 'agent.run',
            status: 'failed',
            taskId: 'task-1',
            agentId: 'agent-1',
            traceId: 'trace-1',
            token: 'token-1',
        })).toEqual({
            operation: 'agent.run',
            status: 'failed',
        });

        const registry = new MetricsRegistry();
        registry.increment('hatchet.enqueue_total', {
            operation: 'agent.run',
            status: 'failed',
            taskId: 'task-1',
        });

        expect(registry.snapshot().counters).toContainEqual({
            name: 'hatchet.enqueue_total',
            count: 1,
            dimensions: { operation: 'agent.run', status: 'failed' },
        });
    });

    it('bounds metric series and routes excess cardinality to overflow', () => {
        const registry = new MetricsRegistry({
            durationSampleLimit: 2,
            maxSeriesTotal: 4,
            maxSeriesPerMetric: 2,
        });

        registry.increment('runtime.retry_total', { operation: 'a', status: 'failed' });
        registry.increment('runtime.retry_total', { operation: 'b', status: 'failed' });
        registry.increment('runtime.retry_total', { operation: 'c', status: 'failed' });

        const snapshot = registry.snapshot();

        expect(snapshot.seriesCount.total).toBeLessThanOrEqual(4);
        expect(snapshot.droppedSeriesCount).toBe(1);
        expect(snapshot.counters).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'runtime.retry_total',
                dimensions: { cardinality: 'overflow' },
                count: 1,
            }),
            expect.objectContaining({
                name: 'observability.metric_cardinality_dropped_total',
                dimensions: { kind: 'counter', metric: 'runtime.retry_total' },
                count: 1,
            }),
        ]));
    });
});
