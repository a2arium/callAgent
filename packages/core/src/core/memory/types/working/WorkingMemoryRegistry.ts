import { WorkingMemoryBackend, ThoughtEntry, DecisionEntry, WorkingMemoryState } from '@callagent/types';
import { UnifiedMemoryService } from '../../UnifiedMemoryService.js';

/**
 * Registry for working memory operations.
 * Directly routes calls to UnifiedMemoryService which handles MLO processing.
 * 
 * This simplified approach eliminates unnecessary wrapper layers and provides
 * direct access to the 6-stage MLO pipeline for working memory operations.
 */
export class WorkingMemoryRegistry implements WorkingMemoryBackend {
    constructor(private unifiedMemoryService: UnifiedMemoryService) { }

    // ========================================
    // Goal Management
    // ========================================

    async setGoal(goal: string, agentId: string, tenantId: string): Promise<void> {
        return this.unifiedMemoryService.setGoal(goal, agentId);
    }

    async getGoal(agentId: string, tenantId: string): Promise<string | null> {
        return this.unifiedMemoryService.getGoal(agentId);
    }

    // ========================================
    // Thought Chain Management
    // ========================================

    async addThought(thought: ThoughtEntry, agentId: string, tenantId: string): Promise<void> {
        return this.unifiedMemoryService.addThought(thought.content, agentId);
    }

    async getThoughts(agentId: string, tenantId: string): Promise<ThoughtEntry[]> {
        const thoughts = await this.unifiedMemoryService.getThoughts(agentId);
        // Convert internal ThoughtEntry format to the expected interface format
        return thoughts.map(thought => ({
            ...thought,
            type: thought.type || 'thought' // Ensure type is defined
        })) as ThoughtEntry[];
    }

    // ========================================
    // Decision Tracking
    // ========================================

    async makeDecision(key: string, decision: DecisionEntry, agentId: string, tenantId: string): Promise<void> {
        return this.unifiedMemoryService.makeDecision(key, decision.decision, decision.reasoning, agentId);
    }

    async getDecision(key: string, agentId: string, tenantId: string): Promise<DecisionEntry | null> {
        return this.unifiedMemoryService.getDecision(key, agentId);
    }

    // ========================================
    // Variable Storage
    // ========================================

    async setVariable(key: string, value: unknown, agentId: string, tenantId: string): Promise<void> {
        return this.unifiedMemoryService.setWorkingVariable(key, value, agentId);
    }

    async getVariable(key: string, agentId: string, tenantId: string): Promise<unknown> {
        return this.unifiedMemoryService.getWorkingVariable(key, agentId);
    }

    // ========================================
    // Session Management
    // ========================================

    async clearSession(agentId: string, tenantId: string): Promise<void> {
        // For now, this is a placeholder since UnifiedMemoryService doesn't have clearSession
        // In a full implementation, this would clear all working memory for the agent
        throw new Error('clearSession not yet implemented in UnifiedMemoryService');
    }

    async getSessionState(agentId: string, tenantId: string): Promise<WorkingMemoryState> {
        // Reconstruct session state from UnifiedMemoryService
        const [goal, thoughts] = await Promise.all([
            this.getGoal(agentId, tenantId),
            this.getThoughts(agentId, tenantId)
        ]);

        return {
            currentGoal: goal ? {
                content: goal,
                timestamp: new Date().toISOString()
            } : null,
            thoughtChain: thoughts,
            decisions: {}, // TODO: Implement decision retrieval
            variables: {}, // TODO: Implement variable retrieval
            loadedLongTermMemories: [],
            meta: {
                lastUpdatedAt: new Date().toISOString(),
                version: '1.0.0',
                agentId
            }
        };
    }

    // ========================================
    // Lifecycle Management
    // ========================================

    async initialize(): Promise<void> {
        // UnifiedMemoryService handles its own initialization
    }

    async shutdown(): Promise<void> {
        // UnifiedMemoryService handles its own shutdown
        await this.unifiedMemoryService.shutdown();
    }
} 