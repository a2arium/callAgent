// Initialization helpers for MentalState.
// Seeds a default MentalState from the current TaskContext. This keeps placeholders
// for future capabilities.

import type { TaskContext } from '../shared/types/index.js';
import type { MentalState } from './types.js';

function nowIso(): string { return new Date().toISOString(); }

export function initialM(ctx: TaskContext): MentalState {
    return {
        memory: {
            sensory: { lastObservation: ctx.task.input },
            longTerm: {
                episodic: [],
                semantic: { concepts: [] },
                procedural: { skills: [] }
            }
        },
        worldModel: {},
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


