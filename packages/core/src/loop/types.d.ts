export type EpisodicEvent = {
    t: number;
    obs: unknown;
    act: unknown;
    rew?: number;
    out?: unknown;
};
export type SemanticConcept = {
    id: string;
    embedding?: number[];
    data: unknown;
    source?: string;
};
export type Skill = {
    name: string;
    pre: unknown;
    policyRef?: string;
};
export type WorldModel = {
    implicit: unknown | null;
    explicit: unknown | null;
    simulator: unknown | null;
};
export type GoalId = string;
export type GoalType = 'long' | 'mid' | 'short';
export type GoalStatus = 'active' | 'blocked' | 'done' | 'failed' | 'dropped';
export type GoalContext = {
    tags?: string[];
    deadlineTs?: string;
    budget?: {
        timeMs?: number;
        cost?: number;
    };
    metadata?: Record<string, unknown>;
};
export type GoalNode = {
    id: GoalId;
    title: string;
    type: GoalType;
    priority: number;
    status: GoalStatus;
    parentId?: GoalId;
    order?: number;
    context?: GoalContext;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
};
export type GoalHierarchy = {
    nodes: Record<GoalId, GoalNode>;
    roots: GoalId[];
};
export type GoalState = {
    hierarchy: GoalHierarchy;
    _index?: {
        byStatus?: Record<GoalStatus, GoalId[]>;
    };
};
export type MentalState<Sensory = unknown> = {
    vars?: Record<string, unknown>;
    memory: {
        sensory: Sensory;
        vars: Record<string, unknown>;
        thoughts?: import('../shared/types/workingMemory.js').ThoughtEntry[];
        decisions?: Record<string, import('../shared/types/workingMemory.js').DecisionEntry>;
        scratch?: unknown;
        window?: unknown;
        longTerm: {
            episodic: EpisodicEvent[];
            semantic: {
                concepts: SemanticConcept[];
            };
            procedural: {
                skills: Skill[];
            };
        };
    };
    worldModel: WorldModel;
    goalState: GoalState;
    emotion: {
        valence: number;
        arousal: number;
        label?: string;
    };
    rewardParams: {
        extrinsicWeights: number[];
        intrinsic: {
            curiosity: number;
            novelty: number;
            competence: number;
            exploration: number;
        };
        discountGamma: number;
    };
    policyParams: {
        theta: unknown;
        stochastic: boolean;
        temperature?: number;
        explorationEpsilon?: number;
        reactPlanner?: {
            enabled?: boolean;
            patterns?: Array<{
                regex: string;
                tool: string;
                argKey: string;
            }>;
        };
    };
};
export type Snapshot = {
    M: MentalState;
    pending?: {
        inputs?: Record<string, unknown>;
        children?: Record<string, unknown>;
        tools?: Record<string, unknown>;
        groups?: Record<string, unknown>;
    };
    meta?: {
        agentId?: string;
        traceparent?: string;
    };
};
export type EnvironmentState = {
    time: string;
    input: unknown;
    sessionId?: string;
    turn?: number;
    pending: {
        inputs: Record<string, unknown>;
        children: Record<string, unknown>;
        tools: Record<string, unknown>;
        groups: Record<string, unknown>;
    };
    lastExec?: unknown;
    externalEvents?: unknown[];
    goalStats?: {
        doneCount: number;
    };
};
