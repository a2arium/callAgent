import { IParameterIntegration } from '../../interfaces/IParameterIntegration.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class PlaceholderParameterIntegration implements IParameterIntegration {
    readonly stageName: "neuralMemory";
    readonly componentName: "parameterIntegration";
    readonly stageNumber = 5;
    private metrics;
    /**
     * PHASE 1: No parameter updates
     *   - Appends stageName, returns unchanged.
     *
     * FUTURE (Phase 2+):
     *   - LoRA / QLoRA-based fine-tuning for small, targeted updates:
     *       • HuggingFace PEFT (https://github.com/huggingface/peft)
     *         with LoRA integration.
     *       • Alpaca LoRA (https://crfm.stanford.edu/2023/03/13/alpaca.html) examples.
     *   - Custom "parameter merging": given a set of facts, use DeltaFineTuner
     *     (https://github.com/TimDettmers/delta) to update model weights in a
     *     memory-efficient way.
     *   - For on-device devices (e.g., edge), use TinyLlama LoRA (https://github.com/antimatter15/tinyllama).
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    configure(config: {
        enabled?: boolean;
        placeholder?: boolean;
        loraEnabled?: boolean;
        parameterUpdateThreshold?: number;
        modelPath?: string;
        updateStrategy?: string;
        [key: string]: unknown;
    }): void;
    updateParameters(items: MemoryItem<unknown>[], updateType?: string): Promise<{
        parametersUpdated: number;
        updateSuccess: boolean;
        updateMetrics: Record<string, number>;
    }>;
    createParameterSnapshot(): Promise<{
        snapshotId: string;
        timestamp: string;
        parameterCount: number;
        checksum: string;
    }>;
    rollbackParameters(snapshotId: string): Promise<{
        rollbackSuccess: boolean;
        parametersRestored: number;
        rollbackTime: number;
    }>;
    applyParameterUpdates(items: MemoryItem<unknown>[]): Promise<{
        updatesApplied: number;
        layersModified: string[];
        totalParametersChanged: number;
        updateMagnitude: number;
    }>;
    getParameterState(): Promise<Record<string, unknown>>;
    createParameterAdaptation(items: MemoryItem<unknown>[], adaptationType: 'lora' | 'full' | 'selective'): Promise<{
        adaptationId: string;
        parameters: Record<string, unknown>;
        metadata: {
            sourceItems: number;
            adaptationStrength: number;
            targetLayers: string[];
            createdAt: string;
        };
    }>;
    mergeAdaptations(adaptationIds: string[], mergeStrategy?: 'average' | 'weighted' | 'selective'): Promise<{
        mergedAdaptationId: string;
        sourceAdaptations: string[];
        mergeWeights: Record<string, number>;
        conflictResolutions: Array<{
            parameter: string;
            resolution: string;
            confidence: number;
        }>;
    }>;
    evaluateIntegration(testItems: MemoryItem<unknown>[], adaptationId?: string): Promise<{
        accuracy: number;
        memoryRetention: number;
        generalization: number;
        interferenceScore: number;
        recommendations: string[];
    }>;
    rollbackChanges(adaptationId: string, targetState?: string): Promise<{
        rolledBack: boolean;
        parametersRestored: number;
        previousState: string;
    }>;
    getIntegrationStats(): {
        totalIntegrations: number;
        activeAdaptations: number;
        averageAdaptationStrength: number;
        parameterUtilization: Record<string, number>;
        integrationMethods: Record<string, number>;
        memoryToParameterRatio: number;
    };
    getMetrics(): ProcessorMetrics;
}
