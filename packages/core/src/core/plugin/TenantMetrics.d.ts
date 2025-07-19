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
        operationTimes: number[];
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
 * Tenant Metrics Manager
 *
 * Tracks tenant-specific metrics including operation counts, memory usage,
 * performance data, and error tracking for monitoring and optimization.
 */
export declare class TenantMetricsManager {
    private metrics;
    private performanceContexts;
    private maxOperationTimes;
    /**
     * Initialize metrics for a tenant if not already tracked
     */
    private initializeTenantMetrics;
    /**
     * Record the start of an operation for performance tracking
     */
    startOperation(operation: string, tenantId: string): string;
    /**
     * Record the completion of an operation and update metrics
     */
    endOperation(contextId: string, success?: boolean, error?: Error): void;
    /**
     * Increment operation count for a specific operation type
     */
    incrementOperationCount(operation: string, tenantId: string): void;
    /**
     * Update memory usage metrics
     */
    updateMemoryUsage(tenantId: string, entryCount: number, totalBytes: number): void;
    /**
     * Update performance metrics with new operation timing
     */
    private updatePerformanceMetrics;
    /**
     * Record an error for a tenant
     */
    recordError(tenantId: string, error: Error, operation: string): void;
    /**
     * Get metrics for a specific tenant
     */
    getTenantMetrics(tenantId: string): TenantMetrics | null;
    /**
     * Get metrics for all tenants
     */
    getAllMetrics(): Map<string, TenantMetrics>;
    /**
     * Get aggregated metrics across all tenants
     */
    getAggregatedMetrics(): TenantMetrics;
    /**
     * Reset metrics for a specific tenant
     */
    resetTenantMetrics(tenantId: string): void;
    /**
     * Reset all metrics
     */
    resetAllMetrics(): void;
    /**
     * Get tenant performance summary
     */
    getTenantPerformanceSummary(tenantId: string): {
        averageResponseTime: number;
        operationsPerMinute: number;
        errorRate: number;
        memoryEfficiency: number;
    } | null;
    /**
     * Log tenant metrics summary
     */
    logTenantSummary(tenantId: string): void;
}
/**
 * Global tenant metrics manager instance
 */
export declare const tenantMetricsManager: TenantMetricsManager;
/**
 * Decorator function for automatic operation tracking
 */
export declare function trackTenantOperation(operation: string): (target: any, propertyName: string, descriptor: PropertyDescriptor) => PropertyDescriptor;
