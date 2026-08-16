import { describe, expect, it } from 'vitest';
import { buildTurnStacks } from './turnStacks';
import type { CognitiveTurnRun, TurnRun } from '../types';

describe('buildTurnStacks', () => {
  it('preserves superseded traces when a deadline prevents terminal turn arbitration', () => {
    const segment = baseSegment();
    segment.cognitiveTurns = [1, 2, 3].map((cognitionTurnSeq) => cognitiveTurn(cognitionTurnSeq));

    const stacks = buildTurnStacks([segment], new Map([[segment.taskId, 'canceled']]));

    expect(stacks).toHaveLength(1);
    expect(stacks[0]?.firstSeq).toBe(1);
    expect(stacks[0]?.lastSeq).toBe(3);
    expect(stacks[0]?.turns).toHaveLength(3);
    expect(stacks[0]?.status).toBe('canceled');
    expect(stacks[0] && `${stacks[0].segment.turnSeq}:${stacks[0].firstSeq}-${stacks[0].lastSeq}`).toBe('1:1-3');
  });

  it('keeps a started-only turn visible and marks its stack cancelled after a timeout', () => {
    const segment = baseSegment();
    segment.cognitiveTurns = [
      { ...cognitiveTurn(1), disposition: 'observed' },
      { ...cognitiveTurn(2), disposition: 'running', cognition: {} },
    ];

    const stacks = buildTurnStacks([segment], new Map([[segment.taskId, 'canceled']]));

    expect(stacks).toHaveLength(1);
    expect(stacks[0]?.turns.map((turn) => turn.cognitionTurnSeq)).toEqual([1, 2]);
    expect(stacks[0]?.status).toBe('canceled');
  });

  it('continues reader-facing turn numbers across segments', () => {
    const first = baseSegment();
    first.cognitiveTurns = [1, 2].map((seq) => ({ ...cognitiveTurn(seq), disposition: 'observed' }));
    const second = { ...baseSegment(), id: 'segment-2', turnSeq: 2 };
    second.cognitiveTurns = [1, 2, 3].map((seq) => ({ ...cognitiveTurn(seq), id: `segment-2-turn-${seq}`, segmentSeq: 2, disposition: 'observed' }));

    const stacks = buildTurnStacks([first, second], new Map([[first.taskId, 'canceled']]));

    expect(stacks.map((stack) => [stack.displayFirstSeq, stack.displayLastSeq])).toEqual([[1, 2], [3, 5]]);
  });
});

function baseSegment(): TurnRun {
  return {
    id: 'segment-1', rootTaskId: 'task-1', taskId: 'task-1', turnSeq: 1,
    status: 'canceled', severity: 'error', operation: 'turn.segment', attempts: [],
  };
}

function cognitiveTurn(cognitionTurnSeq: number): CognitiveTurnRun {
  return {
    id: `turn-${cognitionTurnSeq}`, rootTaskId: 'task-1', taskId: 'task-1',
    cognitionTurnSeq, segmentSeq: 1, disposition: 'superseded',
    cognition: { transition: { kind: 'continue' } },
    llmCalls: [], toolCalls: [], childCalls: [], memoryOps: [],
  };
}
