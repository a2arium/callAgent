import { IAssociativeMemory } from '../../interfaces/IAssociativeMemory.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class PlaceholderAssociative implements IAssociativeMemory {
    readonly stageName: "neuralMemory";
    readonly componentName: "associative";
    readonly stageNumber = 5;
    private metrics;
    /**
     * PHASE 1: No associative memory
     *   - Appends stageName, returns unchanged.
     *
     * FUTURE (Phase 3+):
     *   - HopfieldNetworkWrapper: use Hopfield networks for ultra-fast pattern recall:
     *       • Hopfield-Transformer: https://github.com/o-rah/hopfield-transformer
     *       • Modern ML research: "Dense Associative Memories" (https://arxiv.org/abs/1712.03092).
     *   - Use library like HNSWLIB (https://github.com/nmslib/hnswlib) for approximate nearest neighbors
     *     in-memory.
     *   - For very large working sets, consider Graph Neural Networks (e.g., PyTorch Geometric:
     *     https://pytorch-geometric.readthedocs.io) for relational memory indexing.
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
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
    findAssociations(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>[]>;
    createAssociation(item1: MemoryItem<unknown>, item2: MemoryItem<unknown>, strength: number, associationType?: string): Promise<{
        associationId: string;
        strength: number;
        type: string;
        bidirectional: boolean;
    }>;
    buildAssociationNetwork(items: MemoryItem<unknown>[]): Promise<{
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
    updateAssociationStrength(item1: MemoryItem<unknown>, item2: MemoryItem<unknown>, delta: number, reason?: string): Promise<{
        oldStrength: number;
        newStrength: number;
        updated: boolean;
    }>;
    findConceptAssociations(concept: string, items: MemoryItem<unknown>[]): Promise<Array<{
        item: MemoryItem<unknown>;
        conceptRelevance: number;
        associatedConcepts: string[];
    }>>;
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
    getMetrics(): ProcessorMetrics;
}
