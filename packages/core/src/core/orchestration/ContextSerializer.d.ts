import type { MinimalSourceTaskContext } from '../../shared/types/A2ATypes.js';
import type { A2ACallOptions, SerializedAgentContext } from '../../shared/types/A2ATypes.js';
import type { TaskContext } from '../../shared/types/index.js';
/**
 * Service for serializing and deserializing agent context
 * Integrates with MLO pipeline and existing memory operations
 */
export declare class ContextSerializer {
    /**
     * Serialize agent context for transfer to another agent
     */
    static serializeContext(sourceCtx: MinimalSourceTaskContext, options: A2ACallOptions): Promise<SerializedAgentContext>;
    /**
     * Deserialize context into target agent
     */
    static deserializeContext(targetCtx: TaskContext, serializedContext: SerializedAgentContext): Promise<void>;
    /**
     * Serialize working memory using existing MLO operations
     */
    private static serializeWorkingMemory;
    /**
     * Serialize memory context using MLO recall operations
     */
    private static serializeMemoryContext;
    /**
     * Deserialize working memory into target context
     */
    private static deserializeWorkingMemory;
    /**
     * Deserialize memory context into target
     */
    private static deserializeMemoryContext;
    /**
     * Create a snapshot of memory data for transfer
     */
    private static createMemorySnapshot;
    /**
     * Dynamically extract content from ModalityFusion output
     * Supports any modality type (text, audio, image, video, sensor, etc.)
     */
    private static extractContentFromModalityFusion;
}
