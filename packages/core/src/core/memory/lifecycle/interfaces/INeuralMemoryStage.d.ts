import { MemoryItem } from '../../../../shared/types/memoryLifecycle.js';
import { IStageProcessor } from './IStageProcessor.js';
/**
 * Associative memory processor - creates and manages associative connections between memory items
 */
export type IAssociativeMemory = IStageProcessor & {
    readonly stageName: 'neuralMemory';
    readonly componentName: 'associative';
    /**
     * Create associative connections for memory items
     * @returns Memory item with associative connections added
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure associative memory mechanism
     */
    configure(config: {
        enabled?: boolean;
        placeholder?: boolean;
        conversationMemory?: boolean;
        speakerAssociations?: boolean;
        researchMemory?: boolean;
        conceptAssociations?: boolean;
        crossReferencing?: boolean;
        [key: string]: unknown;
    }): void;
    /**
     * Find associated items for a given memory item
     */
    findAssociations(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>[]>;
    /**
     * Create explicit association between two memory items
     */
    createAssociation(item1: MemoryItem<unknown>, item2: MemoryItem<unknown>, strength: number): Promise<void>;
};
/**
 * Parameter integration processor - integrates memory into model parameters
 */
export type IParameterIntegration = IStageProcessor & {
    readonly stageName: 'neuralMemory';
    readonly componentName: 'parameterIntegration';
    /**
     * Integrate memory item into model parameters
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
        [key: string]: unknown;
    }): void;
    /**
     * Apply parameter updates based on memory items
     */
    applyParameterUpdates(items: MemoryItem<unknown>[]): Promise<void>;
    /**
     * Get current parameter state
     */
    getParameterState(): Promise<Record<string, unknown>>;
};
/**
 * Complete neural memory stage processor that orchestrates associative memory and parameter integration
 */
export type INeuralMemoryStage = IStageProcessor & {
    readonly stageName: 'neuralMemory';
    readonly stageNumber: 5;
    associative: IAssociativeMemory;
    parameterIntegration: IParameterIntegration;
    /**
     * Process memory item through the complete neural memory pipeline
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Check if neural memory is enabled for this stage
     */
    isEnabled(): boolean;
};
