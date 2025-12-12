import { logger } from '@a2arium/callagent-utils';
import { SYSTEM_TENANT, DEFAULT_TENANT } from './tenantValidator.js';

// Create component-specific logger
const metricsLogger = logger.createLogger({ prefix: 'TenantMetrics' });

/**
 * Metrics data structure for a single tenant
 */
export type TenantMetrics = {
    tenantId: string;
    operationCounts: {
        memorySet: number;
        memoryGet: number;
        memoryDelete: number;
        memoryQuery: number;
        agentInvocation: number;
        entityAlignment: number;
    };
    memoryUsage: {
        totalEntries: number;
        totalSizeBytes: number;
        averageEntrySize: number;
        lastUpdated: Date;
    };
    performance: {
        averageResponseTime: number;
        slowestOperation: string;
        slowestOperationTime: number;
        totalOperationTime: number;
        operationTimes: number[]; // Last 100 operation times for rolling average
    };
    timeRange: {
        firstOperation: Date;
        lastOperation: Date;
    };
    errors: {
        totalErrors: number;
        lastError?: {
            message: string;
            timestamp: Date;
            operation: string;
        };
    };
};

/**
 * Performance measurement context
 */
type PerformanceContext = {
    operation: string;
    startTime: number;
    tenantId: string;
};

/**
 * Tenant Metrics Manager
 * 
 * Tracks tenant-specific metrics including operation counts, memory usage,
 * performance data, and error tracking for monitoring and optimization.
 */
export class TenantMetricsManager {
    private metrics = new Map<string, TenantMetrics>();
    private performanceContexts = new Map<string, PerformanceContext>();
    private maxOperationTimes = 100; // Keep last N operation times for rolling average

    /**
     * Initialize metrics for a tenant if not already tracked
     */
    private initializeTenantMetrics(tenantId: string): TenantMetrics {
        if (!this.metrics.has(tenantId)) {
            const now = new Date();
            const newMetrics: TenantMetrics = {
                tenantId,
                operationCounts: {
                    memorySet: 0,
                    memoryGet: 0,
                    memoryDelete: 0,
                    memoryQuery: 0,
                    agentInvocation: 0,
                    entityAlignment: 0
                },
                memoryUsage: {
                    totalEntries: 0,
                    totalSizeBytes: 0,
                    averageEntrySize: 0,
                    lastUpdated: now
                },
                performance: {
                    averageResponseTime: 0,
                    slowestOperation: '',
                    slowestOperationTime: 0,
                    totalOperationTime: 0,
                    operationTimes: []
                },
                timeRange: {
                    firstOperation: now,
                    lastOperation: now
                },
                errors: {
                    totalErrors: 0
                }
            };

            this.metrics.set(tenantId, newMetrics);
            metricsLogger.debug('Initialized metrics for tenant', { tenantId });
        }

        return this.metrics.get(tenantId)!;
    }

    /**
     * Record the start of an operation for performance tracking
     */
    startOperation(operation: string, tenantId: string): string {
        const contextId = `${tenantId}:${operation}:${Date.now()}:${Math.random()}`;
        const context: PerformanceContext = {
            operation,
            startTime: performance.now(),
            tenantId
        };

        this.performanceContexts.set(contextId, context);

        metricsLogger.debug('Started operation tracking', {
            contextId,
            operation,
            tenantId
        });

        return contextId;
    }

    /**
     * Record the completion of an operation and update metrics
     */
    endOperation(contextId: string, success: boolean = true, error?: Error): void {
        const context = this.performanceContexts.get(contextId);
        if (!context) {
            metricsLogger.warn('Operation context not found', { contextId });
            return;
        }

        const endTime = performance.now();
        const duration = endTime - context.startTime;

        this.performanceContexts.delete(contextId);

        const metrics = this.initializeTenantMetrics(context.tenantId);

        // Update operation counts
        this.incrementOperationCount(context.operation, context.tenantId);

        // Update performance metrics
        this.updatePerformanceMetrics(metrics, context.operation, duration);

        // Update time range
        metrics.timeRange.lastOperation = new Date();

        // Handle errors
        if (!success && error) {
            this.recordError(context.tenantId, error, context.operation);
        }

        metricsLogger.debug('Completed operation tracking', {
            contextId,
            operation: context.operation,
            tenantId: context.tenantId,
            duration: Math.round(duration * 100) / 100,
            success
        });
    }

    /**
     * Increment operation count for a specific operation type
     */
    incrementOperationCount(operation: string, tenantId: string): void {
        const metrics = this.initializeTenantMetrics(tenantId);

        switch (operation) {
            case 'memory:set':
                metrics.operationCounts.memorySet++;
                break;
            case 'memory:get':
                metrics.operationCounts.memoryGet++;
                break;
            case 'memory:delete':
                metrics.operationCounts.memoryDelete++;
                break;
            case 'memory:query':
                metrics.operationCounts.memoryQuery++;
                break;
            case 'agent:invoke':
                metrics.operationCounts.agentInvocation++;
                break;
            case 'entity:align':
                metrics.operationCounts.entityAlignment++;
                break;
            default:
                metricsLogger.warn('Unknown operation type for metrics', { operation, tenantId });
        }
    }

    /**
     * Update memory usage metrics
     */
    updateMemoryUsage(tenantId: string, entryCount: number, totalBytes: number): void {
        const metrics = this.initializeTenantMetrics(tenantId);

        metrics.memoryUsage.totalEntries = entryCount;
        metrics.memoryUsage.totalSizeBytes = totalBytes;
        metrics.memoryUsage.averageEntrySize = entryCount > 0 ? totalBytes / entryCount : 0;
        metrics.memoryUsage.lastUpdated = new Date();

        metricsLogger.debug('Updated memory usage metrics', {
            tenantId,
            entryCount,
            totalBytes,
            averageSize: metrics.memoryUsage.averageEntrySize
        });
    }

    /**
     * Update performance metrics with new operation timing
     */
    private updatePerformanceMetrics(metrics: TenantMetrics, operation: string, duration: number): void {
        // Add to operation times array
        metrics.performance.operationTimes.push(duration);

        // Keep only last N operation times
        if (metrics.performance.operationTimes.length > this.maxOperationTimes) {
            metrics.performance.operationTimes.shift();
        }

        // Recalculate average
        const sum = metrics.performance.operationTimes.reduce((a, b) => a + b, 0);
        metrics.performance.averageResponseTime = sum / metrics.performance.operationTimes.length;

        // Update slowest operation if needed
        if (duration > metrics.performance.slowestOperationTime) {
            metrics.performance.slowestOperation = operation;
            metrics.performance.slowestOperationTime = duration;
        }

        // Update total operation time
        metrics.performance.totalOperationTime += duration;
    }

    /**
     * Record an error for a tenant
     */
    recordError(tenantId: string, error: Error, operation: string): void {
        const metrics = this.initializeTenantMetrics(tenantId);

        metrics.errors.totalErrors++;
        metrics.errors.lastError = {
            message: error.message,
            timestamp: new Date(),
            operation
        };

        metricsLogger.error('Recorded tenant error', error, {
            tenantId,
            operation,
            totalErrors: metrics.errors.totalErrors
        });
    }

    /**
     * Get metrics for a specific tenant
     */
    getTenantMetrics(tenantId: string): TenantMetrics | null {
        return this.metrics.get(tenantId) || null;
    }

    /**
     * Get metrics for all tenants
     */
    getAllMetrics(): Map<string, TenantMetrics> {
        return new Map(this.metrics);
    }

    /**
     * Get aggregated metrics across all tenants
     */
    getAggregatedMetrics(): TenantMetrics {
        const allMetrics = Array.from(this.metrics.values());

        if (allMetrics.length === 0) {
            return this.initializeTenantMetrics('__aggregated__');
        }

        const aggregated: TenantMetrics = {
            tenantId: '__aggregated__',
            operationCounts: {
                memorySet: 0,
                memoryGet: 0,
                memoryDelete: 0,
                memoryQuery: 0,
                agentInvocation: 0,
                entityAlignment: 0
            },
            memoryUsage: {
                totalEntries: 0,
                totalSizeBytes: 0,
                averageEntrySize: 0,
                lastUpdated: new Date()
            },
            performance: {
                averageResponseTime: 0,
                slowestOperation: '',
                slowestOperationTime: 0,
                totalOperationTime: 0,
                operationTimes: []
            },
            timeRange: {
                firstOperation: new Date(),
                lastOperation: new Date(0)
            },
            errors: {
                totalErrors: 0
            }
        };

        // Aggregate all metrics
        let totalOperationTimes: number[] = [];
        let earliestOperation = new Date();
        let latestOperation = new Date(0);

        for (const metrics of allMetrics) {
            // Sum operation counts
            aggregated.operationCounts.memorySet += metrics.operationCounts.memorySet;
            aggregated.operationCounts.memoryGet += metrics.operationCounts.memoryGet;
            aggregated.operationCounts.memoryDelete += metrics.operationCounts.memoryDelete;
            aggregated.operationCounts.memoryQuery += metrics.operationCounts.memoryQuery;
            aggregated.operationCounts.agentInvocation += metrics.operationCounts.agentInvocation;
            aggregated.operationCounts.entityAlignment += metrics.operationCounts.entityAlignment;

            // Sum memory usage
            aggregated.memoryUsage.totalEntries += metrics.memoryUsage.totalEntries;
            aggregated.memoryUsage.totalSizeBytes += metrics.memoryUsage.totalSizeBytes;

            // Collect operation times
            totalOperationTimes = totalOperationTimes.concat(metrics.performance.operationTimes);

            // Track slowest operation
            if (metrics.performance.slowestOperationTime > aggregated.performance.slowestOperationTime) {
                aggregated.performance.slowestOperation = `${metrics.tenantId}:${metrics.performance.slowestOperation}`;
                aggregated.performance.slowestOperationTime = metrics.performance.slowestOperationTime;
            }

            // Sum total operation time
            aggregated.performance.totalOperationTime += metrics.performance.totalOperationTime;

            // Track time range
            if (metrics.timeRange.firstOperation < earliestOperation) {
                earliestOperation = metrics.timeRange.firstOperation;
            }
            if (metrics.timeRange.lastOperation > latestOperation) {
                latestOperation = metrics.timeRange.lastOperation;
            }

            // Sum errors
            aggregated.errors.totalErrors += metrics.errors.totalErrors;
        }

        // Calculate aggregated averages
        aggregated.memoryUsage.averageEntrySize =
            aggregated.memoryUsage.totalEntries > 0
                ? aggregated.memoryUsage.totalSizeBytes / aggregated.memoryUsage.totalEntries
                : 0;

        aggregated.performance.averageResponseTime =
            totalOperationTimes.length > 0
                ? totalOperationTimes.reduce((a, b) => a + b, 0) / totalOperationTimes.length
                : 0;

        aggregated.timeRange.firstOperation = earliestOperation;
        aggregated.timeRange.lastOperation = latestOperation;

        return aggregated;
    }

    /**
     * Reset metrics for a specific tenant
     */
    resetTenantMetrics(tenantId: string): void {
        this.metrics.delete(tenantId);
        metricsLogger.info('Reset metrics for tenant', { tenantId });
    }

    /**
     * Reset all metrics
     */
    resetAllMetrics(): void {
        this.metrics.clear();
        this.performanceContexts.clear();
        metricsLogger.warn('Reset all tenant metrics');
    }

    /**
     * Get tenant performance summary
     */
    getTenantPerformanceSummary(tenantId: string): {
        averageResponseTime: number;
        operationsPerMinute: number;
        errorRate: number;
        memoryEfficiency: number;
    } | null {
        const metrics = this.metrics.get(tenantId);
        if (!metrics) return null;

        const totalOperations = Object.values(metrics.operationCounts)
            .reduce((sum, count) => sum + count, 0);

        const timeRangeMinutes =
            (metrics.timeRange.lastOperation.getTime() - metrics.timeRange.firstOperation.getTime())
            / (1000 * 60);

        const operationsPerMinute = timeRangeMinutes > 0 ? totalOperations / timeRangeMinutes : 0;
        const errorRate = totalOperations > 0 ? metrics.errors.totalErrors / totalOperations : 0;
        const memoryEfficiency = metrics.memoryUsage.averageEntrySize > 0 ?
            Math.min(1, 1000 / metrics.memoryUsage.averageEntrySize) : 1; // Arbitrary efficiency calculation

        return {
            averageResponseTime: metrics.performance.averageResponseTime,
            operationsPerMinute,
            errorRate,
            memoryEfficiency
        };
    }

    /**
     * Log tenant metrics summary
     */
    logTenantSummary(tenantId: string): void {
        const metrics = this.getTenantMetrics(tenantId);
        if (!metrics) {
            metricsLogger.warn('No metrics found for tenant', { tenantId });
            return;
        }

        const summary = this.getTenantPerformanceSummary(tenantId);

        metricsLogger.info('Tenant metrics summary', {
            tenantId,
            operationCounts: metrics.operationCounts,
            memoryUsage: metrics.memoryUsage,
            performance: summary,
            errors: {
                total: metrics.errors.totalErrors,
                lastError: metrics.errors.lastError?.message
            }
        });
    }
}

/**
 * Global tenant metrics manager instance
 */
export const tenantMetricsManager = new TenantMetricsManager();

/**
 * Decorator function for automatic operation tracking
 */
export function trackTenantOperation(operation: string) {
    return function (target: any, propertyName: string, descriptor: PropertyDescriptor) {
        const method = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            // Try to extract tenantId from various sources
            let tenantId = DEFAULT_TENANT;

            // Check if first argument has tenantId
            if (args[0] && typeof args[0] === 'object' && args[0].tenantId) {
                tenantId = args[0].tenantId;
            }
            // Check if options object has tenantId
            else if (args.length > 1 && args[1] && typeof args[1] === 'object' && args[1].tenantId) {
                tenantId = args[1].tenantId;
            }

            const contextId = tenantMetricsManager.startOperation(operation, tenantId);

            try {
                const result = await method.apply(this, args);
                tenantMetricsManager.endOperation(contextId, true);
                return result;
            } catch (error) {
                tenantMetricsManager.endOperation(contextId, false, error as Error);
                throw error;
            }
        };

        return descriptor;
    };
} 