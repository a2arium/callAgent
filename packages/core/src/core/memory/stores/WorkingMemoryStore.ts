import { WorkingMemoryManager } from '../WorkingMemoryManager.js';
import { ThoughtEntry, DecisionEntry } from '../../../shared/types/workingMemory.js';

/**
 * Manages multiple working memory sessions by agent ID
 */
export class WorkingMemoryStore {
    private sessions: Map<string, WorkingMemoryManager> = new Map();

    private getOrCreateSession(tenantId: string, agentId: string): WorkingMemoryManager {
        const key = `${tenantId}:${agentId}`;
        if (!this.sessions.has(key)) {
            this.sessions.set(key, new WorkingMemoryManager(tenantId, agentId));
        }
        return this.sessions.get(key)!;
    }

    async storeGoal(goal: { content: string; timestamp: string }, tenantId: string, agentId: string): Promise<void> {
        const session = this.getOrCreateSession(tenantId, agentId);
        await session.setGoal(goal.content);
    }

    async getGoal(tenantId: string, agentId: string): Promise<string | null> {
        const session = this.getOrCreateSession(tenantId, agentId);
        return session.getGoal();
    }

    async addThought(thought: ThoughtEntry & { content: string }, tenantId: string, agentId: string): Promise<void> {
        const session = this.getOrCreateSession(tenantId, agentId);
        await session.addThought(thought.content, thought.processingMetadata);
    }

    async getThoughts(tenantId: string, agentId: string): Promise<ThoughtEntry[]> {
        const session = this.getOrCreateSession(tenantId, agentId);
        return session.getThoughts();
    }

    async makeDecision(key: string, decision: string, reasoning: string | undefined, tenantId: string, agentId: string): Promise<void> {
        const session = this.getOrCreateSession(tenantId, agentId);
        await session.makeDecision(key, decision, reasoning);
    }

    async getDecision(key: string, tenantId: string, agentId: string): Promise<DecisionEntry | null> {
        const session = this.getOrCreateSession(tenantId, agentId);
        return session.getDecision(key);
    }

    async setVariable(key: string, value: unknown, tenantId: string, agentId: string): Promise<void> {
        const session = this.getOrCreateSession(tenantId, agentId);
        await session.setVariable(key, value);
    }

    async getVariable(key: string, tenantId: string, agentId: string): Promise<unknown> {
        const session = this.getOrCreateSession(tenantId, agentId);
        return session.getVariable(key);
    }

    clearSession(tenantId: string, agentId: string): void {
        const key = `${tenantId}:${agentId}`;
        this.sessions.delete(key);
    }
} 