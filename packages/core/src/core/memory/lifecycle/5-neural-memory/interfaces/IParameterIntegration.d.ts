import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';
/**
 * Parameter Integration Interface - integrates memory into model parameters
 * Implements LoRA, parameter updates, and model adaptation techniques
 */
export type IParameterIntegration = IStageProcessor & {
    readonly stageName: 'neuralMemory';
    readonly componentName: 'parameterIntegration';
    /**
     * Integrate memory item into model parameters
     * @param item Memory item to integrate
     * @returns Memory item with parameter integration metadata
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure parameter integration mechanism
     */
    configure(config: {
        enabled?: boolean;
        placeholder?: boolean;
        method?: string;
        targetLayers?: string[];
        learningRate?: number;
        adaptationStrength?: number;
        batchSize?: number;
        [key: string]: unknown;
    }): void;
    /**
     * Apply parameter updates based on memory items
     */
    applyParameterUpdates(items: MemoryItem<unknown>[]): Promise<{
        updatesApplied: number;
        layersModified: string[];
        totalParametersChanged: number;
        updateMagnitude: number;
    }>;
    /**
     * Get current parameter state
     */
    getParameterState(): Promise<Record<string, unknown>>;
    /**
     * Create parameter adaptation from memory
     */
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
    /**
     * Merge multiple parameter adaptations
     */
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
    /**
     * Evaluate parameter integration effectiveness
     */
    evaluateIntegration(testItems: MemoryItem<unknown>[], adaptationId?: string): Promise<{
        accuracy: number;
        memoryRetention: number;
        generalization: number;
        interferenceScore: number;
        recommendations: string[];
    }>;
    /**
     * Rollback parameter changes
     */
    rollbackChanges(adaptationId: string, targetState?: string): Promise<{
        rolledBack: boolean;
        parametersRestored: number;
        previousState: string;
    }>;
    /**
     * Get parameter integration statistics
     */
    getIntegrationStats(): {
        totalIntegrations: number;
        activeAdaptations: number;
        averageAdaptationStrength: number;
        parameterUtilization: Record<string, number>;
        integrationMethods: Record<string, number>;
        memoryToParameterRatio: number;
    };
};
