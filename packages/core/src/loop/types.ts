// MentalState and related types for the loop-based agent model.
// This file defines a single, structured cognitive state that is saved
// and restored via the existing SessionManager snapshot mechanism.
//
// Design goals:
// - Single source of truth for session cognition (no parallel stores)
// - migration handled outside this file
// - Placeholders for future capabilities (world model, emotion, reward)

export type EpisodicEvent = {
    t: number;                 // discrete turn index or ms timestamp
    obs: unknown;              // observation at t
    act: unknown;              // action proposed/executed at t
    rew?: number;              // optional reward aggregated at t
    out?: unknown;             // optional outcome/result at t
};

export type SemanticConcept = {
    id: string;
    embedding?: number[];
    data: unknown;
    source?: string;           // provenance
};

export type Skill = {
    name: string;
    pre: unknown;              // preconditions placeholder
    policyRef?: string;        // reference to policy/program
};

export type WorldModel = {
    implicit: unknown | null;  // placeholder for learned dynamics/value
    explicit: unknown | null;  // placeholder for rules/sim
    simulator: unknown | null; // placeholder for external simulators
};

export type GoalId = string;
export type GoalType = 'long' | 'mid' | 'short';
export type GoalStatus = 'active' | 'blocked' | 'done' | 'failed' | 'dropped';

export type GoalContext = {
    tags?: string[];
    deadlineTs?: string;       // ISO 8601
    budget?: { timeMs?: number; cost?: number };
    metadata?: Record<string, unknown>;
};

export type GoalNode = {
    id: GoalId;
    title: string;
    type: GoalType;
    priority: number;          // 0..1
    status: GoalStatus;        // default 'active'
    parentId?: GoalId;         // undefined => root
    order?: number;            // sibling ordering
    context?: GoalContext;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
};

export type GoalHierarchy = {
    nodes: Record<GoalId, GoalNode>;
    roots: GoalId[];           // ordered root ids
};

export type GoalState = {
    hierarchy: GoalHierarchy;
    _index?: { byStatus?: Record<GoalStatus, GoalId[]> }; // optional, computed at load
};

export type MentalState<Sensory = unknown> = {
    // Shortcut alias (read-mostly) to short-term vars; points to memory.vars
    vars?: Record<string, unknown>;
    memory: {
        sensory: Sensory;        // e.g., { llmState, lastObservation }
        vars: Record<string, unknown>;
        thoughts?: import('../shared/types/workingMemory.js').ThoughtEntry[];
        decisions?: Record<string, import('../shared/types/workingMemory.js').DecisionEntry>;
        scratch?: unknown;
        window?: unknown;
        longTerm: {
            episodic: EpisodicEvent[];
            semantic: { concepts: SemanticConcept[] };
            procedural: { skills: Skill[] };
        };
    };
    worldModel: WorldModel;
    goalState: GoalState;
    emotion: { valence: number; arousal: number; label?: string };
    rewardParams: {
        extrinsicWeights: number[];
        intrinsic: { curiosity: number; novelty: number; competence: number; exploration: number };
        discountGamma: number;
    };
    policyParams: { theta: unknown; stochastic: boolean; temperature?: number; explorationEpsilon?: number; reactPlanner?: { enabled?: boolean; patterns?: Array<{ regex: string; tool: string; argKey: string }> } };
};

export type Snapshot = {
    M: MentalState;
    pending?: {
        inputs?: Record<string, unknown>;
        children?: Record<string, unknown>;
        tools?: Record<string, unknown>;
        groups?: Record<string, unknown>;
    };
    meta?: { agentId?: string; traceparent?: string };
};

// Environment state visible to the loop per turn
export type EnvironmentState = {
    time: string; // ISO timestamp
    input: unknown; // current task input or event payload
    sessionId?: string; // current session id (task id)
    turn?: number; // cumulative loop turn (persisted per session)
    budget?: { maxTurns?: number; latencyMs?: number }; // loop constraints from manifest
    pending: {
        inputs: Record<string, unknown>;
        children: Record<string, unknown>;
        tools: Record<string, unknown>;
        groups: Record<string, unknown>;
    };
    lastExec?: unknown; // optional description of last execution result
    externalEvents?: unknown[]; // future: bus events since last turn
    goalStats?: { doneCount: number };
};


