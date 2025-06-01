import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';

/**
 * Associative Memory Interface - creates and manages associative connections between memory items
 * Implements conversation memory, speaker associations, and concept cross-referencing
 */
export type IAssociativeMemory = IStageProcessor & {
    readonly stageName: 'neuralMemory';
    readonly componentName: 'associative';

    /**
     * Create associative connections for memory items
     * @param item Memory item to process
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
        associationStrengthThreshold?: number;
        [key: string]: unknown;
    }): void;

    /**
     * Find associated items for a given memory item
     */
    findAssociations(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>[]>;

    /**
     * Create explicit association between two memory items
     */
    createAssociation(
        item1: MemoryItem<unknown>,
        item2: MemoryItem<unknown>,
        strength: number,
        associationType?: string
    ): Promise<{
        associationId: string;
        strength: number;
        type: string;
        bidirectional: boolean;
    }>;

    /**
     * Build association network from multiple items
     */
    buildAssociationNetwork(
        items: MemoryItem<unknown>[]
    ): Promise<{
        nodes: Array<{
            itemId: string;
            item: MemoryItem<unknown>;
            centrality: number;
            connections: number;
        }>;
        edges: Array<{
            from: string;
            to: string;
            strength: number;
            type: string;
        }>;
        clusters: Array<{
            id: string;
            items: MemoryItem<unknown>[];
            coherence: number;
        }>;
    }>;

    /**
     * Strengthen or weaken associations based on usage
     */
    updateAssociationStrength(
        item1: MemoryItem<unknown>,
        item2: MemoryItem<unknown>,
        delta: number,
        reason?: string
    ): Promise<{
        oldStrength: number;
        newStrength: number;
        updated: boolean;
    }>;

    /**
     * Find concept associations across items
     */
    findConceptAssociations(
        concept: string,
        items: MemoryItem<unknown>[]
    ): Promise<Array<{
        item: MemoryItem<unknown>;
        conceptRelevance: number;
        associatedConcepts: string[];
    }>>;

    /**
     * Get associative memory statistics
     */
    getAssociativeStats(): {
        totalAssociations: number;
        averageAssociationStrength: number;
        associationTypes: Record<string, number>;
        networkDensity: number;
        strongestAssociations: Array<{
            item1: string;
            item2: string;
            strength: number;
            type: string;
        }>;
    };
}; 