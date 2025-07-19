import { MemoryItem } from '../../../../shared/types/memoryLifecycle.js';
export type ProcessorMetrics = {
    itemsProcessed: number;
    itemsDropped: number;
    processingTimeMs: number;
    lastProcessedAt?: string;
};
export type IStageProcessor = {
    readonly stageName: string;
    readonly stageNumber: number;
    /**
     * Process a memory item through this stage
     * @returns Modified item, array of items, or null if filtered out
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | MemoryItem<unknown>[] | null>;
    /**
     * Configure this processor with options
     */
    configure(config: Record<string, unknown>): void;
    /**
     * Get metrics for observability
     * ENHANCEMENT: Fine-Grained Observability & Telemetry
     * • Consider sampling detailed logs (e.g., using OpenTelemetry) to identify slow processors in production.
     * • Add tracing across processors (e.g., using a trace_id) to reconstruct a MemoryItem's end-to-end journey.
     *   This aligns with APM best practices (Datadog, New Relic) for distributed tracing.
     */
    getMetrics(): ProcessorMetrics;
};
