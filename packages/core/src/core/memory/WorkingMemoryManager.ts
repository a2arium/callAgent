import { logger } from '@callagent/utils';
import {
    WorkingMemoryState,
    ThoughtEntry,
    DecisionEntry,
    SerializedWorkingMemoryState,
} from '../../shared/types/workingMemory.js';
import { MemoryItem, createMemoryItem } from '../../shared/types/memoryLifecycle.js';

export class WorkingMemoryManager {
    private state: WorkingMemoryState;
    private logger = logger.createLogger({ prefix: 'WorkingMemory' });

    constructor(
        private tenantId: string,
        private agentId: string,
        initialState?: Partial<SerializedWorkingMemoryState>
    ) {
        this.state = this.initializeState(initialState);
    }

    private initializeState(initial?: Partial<SerializedWorkingMemoryState>): WorkingMemoryState {
        return {
            currentGoal: null,
            thoughtChain: [],
            decisions: {},
            variables: {},
            loadedLongTermMemories: [],
            meta: {
                lastUpdatedAt: new Date().toISOString(),
                version: '1.0.0',
                agentId: this.agentId,
                ...initial?.meta,
            },
            ...initial,
        };
    }

    async setGoal(goal: string): Promise<void> {
        const timestamp = new Date().toISOString();
        this.state.currentGoal = { content: goal, timestamp };
        this.state.meta.lastUpdatedAt = timestamp;

        this.logger.info('Goal set', {
            agentId: this.agentId,
            goal,
            tenantId: this.tenantId
        });
    }

    async getGoal(): Promise<string | null> {
        return this.state.currentGoal?.content || null;
    }

    async addThought(thought: string, processingMetadata?: { processingHistory?: string[]; compressed?: boolean; summarized?: boolean; }): Promise<void> {
        const timestamp = new Date().toISOString();
        this.state.thoughtChain.push({
            timestamp,
            content: thought,
            type: 'thought',
            processingMetadata,
        });
        this.state.meta.lastUpdatedAt = timestamp;

        this.logger.debug('Thought added', {
            agentId: this.agentId,
            thoughtLength: thought.length
        });
    }

    async getThoughts(): Promise<ThoughtEntry[]> {
        return this.state.thoughtChain
            .filter(entry => entry.type === 'thought' || entry.type === 'observation')
            .map(entry => ({
                timestamp: entry.timestamp,
                content: entry.content,
                type: entry.type as 'thought' | 'observation',
                processingMetadata: entry.processingMetadata,
            }));
    }

    async makeDecision(key: string, decision: string, reasoning?: string): Promise<void> {
        const timestamp = new Date().toISOString();

        this.state.decisions[key] = { decision, reasoning, timestamp };

        // Also add to thought chain for traceability
        this.state.thoughtChain.push({
            timestamp,
            content: `Decision[${key}]: ${decision}`,
            type: 'decision',
        });

        this.state.meta.lastUpdatedAt = timestamp;

        this.logger.info('Decision made', {
            agentId: this.agentId,
            key,
            decision
        });
    }

    async getDecision(key: string): Promise<DecisionEntry | null> {
        return this.state.decisions[key] || null;
    }

    async setVariable(key: string, value: unknown): Promise<void> {
        this.state.variables[key] = value;
        this.state.meta.lastUpdatedAt = new Date().toISOString();
    }

    async getVariable(key: string): Promise<unknown> {
        return this.state.variables[key];
    }

    serialize(): SerializedWorkingMemoryState {
        return JSON.parse(JSON.stringify(this.state));
    }

    load(state: SerializedWorkingMemoryState): void {
        this.state = { ...state };
        this.logger.info('State loaded', { agentId: this.agentId });
    }
} 