import { WorkingMemoryBackend, ThoughtEntry, DecisionEntry, WorkingMemoryState } from '@callagent/types';
import { UnifiedMemoryService } from '../../UnifiedMemoryService.js';
/**
 * Registry for working memory operations.
 * Directly routes calls to UnifiedMemoryService which handles MLO processing.
 *
 * This simplified approach eliminates unnecessary wrapper layers and provides
 * direct access to the 6-stage MLO pipeline for working memory operations.
 */
export declare class WorkingMemoryRegistry implements WorkingMemoryBackend {
    private unifiedMemoryService;
    constructor(unifiedMemoryService: UnifiedMemoryService);
    setGoal(goal: string, agentId: string, tenantId: string): Promise<void>;
    getGoal(agentId: string, tenantId: string): Promise<string | null>;
    addThought(thought: ThoughtEntry, agentId: string, tenantId: string): Promise<void>;
    getThoughts(agentId: string, tenantId: string): Promise<ThoughtEntry[]>;
    makeDecision(key: string, decision: DecisionEntry, agentId: string, tenantId: string): Promise<void>;
    getDecision(key: string, agentId: string, tenantId: string): Promise<DecisionEntry | null>;
    getAllDecisions(agentId: string, tenantId: string): Promise<Record<string, DecisionEntry>>;
    setVariable(key: string, value: unknown, agentId: string, tenantId: string): Promise<void>;
    getVariable(key: string, agentId: string, tenantId: string): Promise<unknown>;
    clearSession(agentId: string, tenantId: string): Promise<void>;
    getSessionState(agentId: string, tenantId: string): Promise<WorkingMemoryState>;
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
}
