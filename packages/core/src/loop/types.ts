// MentalState and related types for the loop-based agent model.
// This file defines a single, structured cognitive state that is saved
// and restored via the existing SessionManager snapshot mechanism.
//
// Design goals:
// - Single source of truth for session cognition (no parallel stores)
// - migration handled outside this file
// - Placeholders for future capabilities (world model, emotion, reward)
import { Observation, ObservationSchema } from '../types/observation.js';

export type ObservationBySource<Source> = Extract<Observation, { source: Source }>;

const findUser = (observations: Observation[]) =>
    observations.find((o): o is ObservationBySource<'user'> => o?.source === 'user');
const findTool = (observations: Observation[]) =>
    observations.find((o): o is ObservationBySource<'tool'> => o?.source === 'tool');
const findChild = (observations: Observation[]) =>
    observations.find((o): o is ObservationBySource<'child'> => o?.source === 'child');
const findInternal = (observations: Observation[]) =>
    observations.find((o): o is ObservationBySource<'internal'> => o?.source === 'internal');
const findEnv = (observations: Observation[]) =>
    observations.find((o): o is ObservationBySource<'env'> => o?.source === 'env');

const attachInboxAccessors = (
    inbox: Pick<ObservationInbox, 'current' | 'all'> & Partial<ObservationInbox>
): ObservationInbox => {
    const casted = inbox as ObservationInbox;
    const define = <K extends keyof ObservationInbox>(key: K, fn: ObservationInbox[K]) => {
        Object.defineProperty(casted, key, { value: fn, enumerable: false, writable: true, configurable: true });
    };
    define('user', () => findUser(inbox.current));
    define('tool', () => findTool(inbox.current));
    define('child', () => findChild(inbox.current));
    define('internal', () => findInternal(inbox.current));
    define('env', () => findEnv(inbox.current));
    return casted;
};

export type ObservationInbox = {
    current: Observation[];
    all: Observation[];
    user(): ObservationBySource<'user'> | undefined;
    tool(): ObservationBySource<'tool'> | undefined;
    child(): ObservationBySource<'child'> | undefined;
    internal(): ObservationBySource<'internal'> | undefined;
    env(): ObservationBySource<'env'> | undefined;
};

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
    tags?: string[];
};

export type Skill = {
    name: string;
    pre: unknown;              // preconditions placeholder
    policyRef?: string;        // reference to policy/program
};

export type WorldModel = Record<string, unknown>;

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

// Read-only memory facade made available to all cognitive modules
export type MemoryReader = {
    semantic: {
        read: (q: { id?: string | string[]; tag?: string; tags?: string[]; limit?: number; filters?: unknown[] }) => Promise<SemanticConcept[]>;
        get: (id: string) => Promise<SemanticConcept | null>;
    };
    episodic: { range: (opts?: { from?: number; to?: number; limit?: number }) => Promise<EpisodicEvent[]> };
    procedural: { list: () => Promise<Skill[]> };
    world: { get: () => Promise<WorldModel> };
    goals: { get: () => Promise<GoalHierarchy> };
    policy: { getParams: () => Promise<MentalState['policyParams']> };
    reward: { getParams: () => Promise<MentalState['rewardParams']> };
};

// Learning-only writer that accumulates durable patches for this turn
export type MemoryWriter = {
    semantic: {
        add: (item: SemanticConcept) => void;
        delete: (id: string) => void;
    };
    episodic: { append: (e: EpisodicEvent) => void };
    procedural: { set: (skills: Skill[]) => void };
    world: { set: (wm: WorldModel) => void };
    goals: {
        set: (g: GoalHierarchy) => void;
        add?: (node: GoalNode) => void;
        update?: (id: GoalId, patch: Partial<GoalNode>) => void;
        remove?: (id: GoalId) => void;
        clear?: (predicate?: (g: GoalNode) => boolean) => void;
    };
    policy: { setParams: (p: MentalState['policyParams']) => void };
    reward: { setParams: (p: MentalState['rewardParams']) => void };
};

export type MentalState<Sensory = unknown> = {

    memory: {
        sensory: Sensory;        // e.g., { lastObservation }

        thoughts?: import('../shared/types/index.js').ThoughtEntry[];
        decisions?: Record<string, import('../shared/types/index.js').DecisionEntry>;
        scratch?: unknown;       // Optional ephemeral working set (Learning-owned)
        window?: unknown;        // Optional ephemeral window (Learning-owned)
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
    llmState?: unknown;
    pending?: {
        inputs?: Record<string, unknown>;
        children?: Record<string, unknown>;
        tools?: Record<string, unknown>;
        groups?: Record<string, unknown>;
        controlVars?: Record<string, unknown>;
    };
    meta?: { agentId?: string; traceparent?: string };
};

export type ControlPendingState = {
    inputs?: Record<string, unknown>;
    children?: Record<string, { token?: string } & Record<string, unknown>>;
    tools?: Record<string, unknown>;
    groups?: Record<string, unknown>;
    controlVars?: Record<string, unknown>;
};

export type ControlState = {
    pendingSnapshot?: ControlPendingState;
    lastExec?: unknown;
};

// Environment state visible to the loop per turn
export type EnvironmentState = {
    time: string; // ISO timestamp
    sessionId?: string; // current session id (task id)
    turn: number; // cumulative loop turn (persisted per session)
    budget: { maxTurns: number; latencyMs: number }; // loop constraints from manifest
    inbox: ObservationInbox; // ordered observations awaiting perception (current turn + history)
    pending: {
        inputs: Record<string, unknown>;
        children: Record<string, unknown>;
        tools: Record<string, unknown>;
        groups: Record<string, unknown>;
        controlVars?: Record<string, unknown>;
    };
    // Optional control surface for modules needing control signals without ctx.vars
    control?: ControlState;
    lastExec?: unknown; // optional description of last execution result
    externalEvents?: unknown[]; // future: bus events since last turn
    goalStats?: { doneCount: number };
    config?: Record<string, unknown>; // manifest-level configuration
};

export const normalizeObservationInbox = (
    value: unknown
): ObservationInbox => {
    const parseOrLog = (obsArray: unknown[]): Observation[] => {
        const result: Observation[] = [];
        for (const item of obsArray) {
            const parsed = ObservationSchema.safeParse(item);
            if (parsed.success) {
                result.push(parsed.data);
            } else {
                // We drop invalid envelope structures right at the generic boundary.
                if (process.env.CALLAGENT_DEBUG_INBOX) {
                    // eslint-disable-next-line no-console
                    console.warn('[normalizeObservationInbox] Dropping invalid observation payload envelope:', parsed.error, item);
                }
            }
        }
        return result;
    };

    if (Array.isArray(value)) {
        const arr = parseOrLog(value);
        return attachInboxAccessors({
            current: [...arr],
            all: [...arr]
        });
    }
    if (value && typeof value === 'object') {
        const candidate = value as Partial<ObservationInbox>;
        const current = Array.isArray(candidate.current) ? parseOrLog(candidate.current) : [];
        const all = Array.isArray(candidate.all) ? parseOrLog(candidate.all) : [];
        const inbox = {
            current,
            all,
            user: candidate.user,
            tool: candidate.tool,
            child: candidate.child,
            internal: candidate.internal,
            env: candidate.env
        };
        return attachInboxAccessors(inbox);
    }
    return attachInboxAccessors({ current: [], all: [] });
};

