// Initialization helpers for MentalState.
// Seeds a default MentalState from the current TaskContext. This keeps placeholders
// for future capabilities and captures LLM state under memory.sensory.

import type { TaskContext } from '../shared/types/index.js';
import type { MentalState } from './types.js';

function nowIso(): string { return new Date().toISOString(); }

export function initialM(ctx: TaskContext): MentalState {
    const llmAny = (ctx as unknown as { llm?: { exportState?: () => unknown } }).llm;
    const llmState = (llmAny && typeof llmAny.exportState === 'function') ? llmAny.exportState() : null;
    return {
        memory: {
            sensory: { llmState, lastObservation: ctx.task.input },
            vars: {},
            longTerm: {
                episodic: [],
                semantic: { concepts: [] },
                procedural: { skills: [] }
            }
        },
        worldModel: { implicit: null, explicit: null, simulator: null },
        goalState: {
            hierarchy: { nodes: {}, roots: [] }
        },
        emotion: { valence: 0, arousal: 0.2 },
        rewardParams: {
            extrinsicWeights: [1],
            intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 },
            discountGamma: 0.99
        },
        policyParams: { theta: null, stochastic: false }
    } as MentalState;
}

export function touchGoalTimestamps(node: { createdAt?: string; updatedAt?: string; completedAt?: string }, completed?: boolean): void {
    const ts = nowIso();
    if (!node.createdAt) node.createdAt = ts;
    node.updatedAt = ts;
    if (completed && !node.completedAt) node.completedAt = ts;
}


