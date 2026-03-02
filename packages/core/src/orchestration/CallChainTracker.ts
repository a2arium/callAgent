/**
 * CallChainTracker - Tracks agent call chains for circular dependency detection
 *
 * This module provides utilities to:
 * 1. Track the current chain of agent calls
 * 2. Detect circular dependencies before spawning agents
 * 3. Limit call depth to prevent runaway recursion
 * 4. Provide clear error messages for debugging
 */

import { logger } from '@a2arium/callagent-utils';

const chainLogger = logger.createLogger({ prefix: 'CallChain' });

/**
 * Configuration for circular dependency detection
 */
export interface CircularDependencyConfig {
    /** Maximum depth of agent calls before throwing error (default: 20) */
    maxDepth?: number;
    /** Enable circular dependency detection (default: true) */
    enableCycleDetection?: boolean;
    /** Enable depth limiting (default: true) */
    enableDepthLimiting?: boolean;
    /** In development, warn but don't throw on circular dependencies (default: false) */
    warnOnlyInDevelopment?: boolean;
}

/**
 * Represents a single agent in the call chain
 */
export interface AgentCall {
    /** Task ID for this agent instance */
    taskId: string;
    /** Agent name/ID */
    agentId: string;
    /** Parent task ID (if this is a child call) */
    parentTaskId?: string;
    /** Depth in the call chain (0 = root) */
    depth: number;
    /** Timestamp when this call was made */
    timestamp: number;
}

/**
 * Result of a circular dependency check
 */
export interface CycleDetectionResult {
    /** Whether a cycle was detected */
    hasCycle: boolean;
    /** The complete call chain from root to current */
    chain: AgentCall[];
    /** If cycle detected, the agent that would create the cycle */
    cycleAgent?: string;
    /** Current depth of the call chain */
    depth: number;
    /** Whether depth limit was exceeded */
    exceedsMaxDepth?: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<CircularDependencyConfig> = {
    maxDepth: 20,
    enableCycleDetection: true,
    enableDepthLimiting: true,
    warnOnlyInDevelopment: false
};

/**
 * CallChainTracker class
 *
 * Stores and analyzes agent call chains to detect circular dependencies.
 * Uses a Map for O(1) lookup by task ID.
 */
export class CallChainTracker {
    private readonly taskMap: Map<string, AgentCall>;
    private readonly config: Required<CircularDependencyConfig>;

    constructor(config: CircularDependencyConfig = {}) {
        this.taskMap = new Map();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Register a new agent call in the chain
     */
    registerCall(call: AgentCall): void {
        this.taskMap.set(call.taskId, {
            ...call,
            timestamp: Date.now()
        });

        chainLogger.debug('Agent call registered', {
            taskId: call.taskId,
            agentId: call.agentId,
            parentTaskId: call.parentTaskId,
            depth: call.depth
        });
    }

    /**
     * Remove a task from the chain (when it completes)
     */
    unregisterCall(taskId: string): void {
        this.taskMap.delete(taskId);
        chainLogger.debug('Agent call unregistered', { taskId });
    }

    /**
     * Check if spawning a new agent would create a circular dependency
     *
     * @param targetAgentId - Agent we want to spawn
     * @param parentTaskId - Task ID of the parent making the call
     * @returns Cycle detection result
     */
    checkCircularDependency(targetAgentId: string, parentTaskId?: string): CycleDetectionResult {
        const chain = this.buildCallChain(parentTaskId);
        const depth = chain.length;

        const result: CycleDetectionResult = {
            hasCycle: false,
            chain,
            depth
        };

        // Check for circular dependency
        if (this.config.enableCycleDetection) {
            const cycleAgent = chain.find(call => call.agentId === targetAgentId);
            if (cycleAgent) {
                result.hasCycle = true;
                result.cycleAgent = targetAgentId;

                chainLogger.warn('Circular dependency detected', {
                    targetAgent: targetAgentId,
                    chain: chain.map(c => c.agentId).join(' → '),
                    depth
                });

                return result;
            }
        }

        // Check depth limit
        if (this.config.enableDepthLimiting && depth >= this.config.maxDepth) {
            result.exceedsMaxDepth = true;

            chainLogger.warn('Maximum agent depth exceeded', {
                depth,
                maxDepth: this.config.maxDepth,
                chain: chain.map(c => c.agentId).join(' → ')
            });

            return result;
        }

        // Explicitly set exceedsMaxDepth to false when within limits
        result.exceedsMaxDepth = false;

        return result;
    }

    /**
     * Build the call chain from a given task back to the root
     */
    private buildCallChain(taskId?: string): AgentCall[] {
        const chain: AgentCall[] = [];
        let currentTaskId = taskId;

        while (currentTaskId) {
            const call = this.taskMap.get(currentTaskId);
            if (!call) {
                break;
            }

            chain.unshift(call);
            currentTaskId = call.parentTaskId;

            // Safety: prevent infinite loops in corrupted data
            if (chain.length > 1000) {
                chainLogger.error('Call chain exceeds safety limit, possible data corruption');
                break;
            }
        }

        return chain;
    }

    /**
     * Get the current call chain for a task
     */
    getCallChain(taskId?: string): AgentCall[] {
        return this.buildCallChain(taskId);
    }

    /**
     * Get a formatted string representation of the call chain
     */
    formatCallChain(taskId?: string): string {
        const chain = this.buildCallChain(taskId);
        if (chain.length === 0) {
            return '(no calls)';
        }

        return chain.map((call, index) => {
            const prefix = index === 0 ? '📍' : '  └─>';
            return `${prefix} ${call.agentId} (task: ${call.taskId.slice(0, 12)}...)`;
        }).join('\n');
    }

    /**
     * Clear all tracked calls (useful for testing)
     */
    clear(): void {
        this.taskMap.clear();
    }

    /**
     * Get the number of tracked calls
     */
    get size(): number {
        return this.taskMap.size;
    }
}

/**
 * Global call chain tracker instance
 *
 * This is a singleton that tracks all agent calls across the framework.
 * In production, you might want to make this per-tenant or per-session.
 */
let globalTracker: CallChainTracker | null = null;

export function getCallChainTracker(config?: CircularDependencyConfig): CallChainTracker {
    if (!globalTracker) {
        globalTracker = new CallChainTracker(config);
    }
    return globalTracker;
}

/**
 * Reset the global tracker (useful for testing)
 */
export function resetCallChainTracker(): void {
    globalTracker = null;
}
