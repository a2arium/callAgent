import type { TaskInput } from '../../shared/types/index.js';
import type { MinimalSourceTaskContext, // Use for sourceCtx type
A2ACallOptions, InteractiveTaskResult, IA2AService } from '../../shared/types/A2ATypes.js';
import type { AgentPlugin } from '../plugin/types.js';
/**
 * Service for agent-to-agent communication
 * Handles local agent discovery, context transfer, and task execution
 */
export declare class A2AService implements IA2AService {
    private eventBus?;
    private agentResultCache;
    constructor(eventBus?: any | undefined);
    /**
     * Initialize cache service for A2A operations
     */
    private initializeCacheService;
    /**
     * Send task to another agent with context inheritance
     */
    sendTaskToAgent(sourceCtx: MinimalSourceTaskContext, // Use MinimalSourceTaskContext
    targetAgent: string, taskInput: TaskInput, options?: A2ACallOptions): Promise<InteractiveTaskResult | unknown>;
    /**
     * Find local agent by name
     */
    findLocalAgent(agentName: string): Promise<AgentPlugin | null>;
    /**
 * Create target context with memory capabilities using inheritance pattern
 */
    private createTargetContext;
    /**
     * Create target-specific reply function
     */
    private createTargetReply;
    /**
     * Create target-specific progress function
     */
    private createTargetProgress;
    /**
     * Create target-specific complete function
     */
    private createTargetComplete;
    /**
     * Create target-specific fail function
     */
    private createTargetFail;
    /**
     * Create target-specific logger
     */
    private createTargetLogger;
    /**
     * Create target-specific throw function
     */
    private createTargetThrow;
    /**
     * Create target-specific recordUsage function
     */
    private createTargetRecordUsage;
    /**
     * Execute target agent with error handling and caching
     */
    private executeTargetAgent;
}
export declare const globalA2AService: A2AService;
