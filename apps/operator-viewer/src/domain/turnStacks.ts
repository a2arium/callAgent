import type { AgentRunStatus, CognitiveTurnRun, TurnRun } from '../types';

export type TurnStack = {
  id: string;
  taskId: string;
  segment: TurnRun;
  turns: CognitiveTurnRun[];
  firstSeq: number;
  lastSeq: number;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'canceled';
  boundary?: string;
};

export function buildTurnStacks(turns: TurnRun[], taskStatuses?: ReadonlyMap<string, AgentRunStatus>): TurnStack[] {
  return turns.flatMap((segment) => {
    const canonical = new Map<string, CognitiveTurnRun>();
    for (const turn of segment.cognitiveTurns ?? []) {
      const identity = turn.turnId ? `${turn.taskId}:${turn.turnId}` : turn.id;
      const existing = canonical.get(identity);
      if (!existing || dispositionRank(turn.disposition) >= dispositionRank(existing.disposition)) canonical.set(identity, turn);
    }
    const observed = [...canonical.values()]
      .filter((turn) => turn.disposition !== 'superseded')
      .sort((a, b) => a.cognitionTurnSeq - b.cognitionTurnSeq);
    // Older runs predate per-turn capture. Keep their one durable attempt visible
    // as a single turn rather than making the run appear empty.
    if (observed.length === 0) {
      const legacy: CognitiveTurnRun = {
        id: `${segment.id}:legacy-turn`, rootTaskId: segment.rootTaskId, taskId: segment.taskId,
        ...(segment.agentId ? { agentId: segment.agentId } : {}),
        cognitionTurnSeq: segment.turnSeq, segmentSeq: segment.turnSeq,
        disposition: segment.status === 'running' ? 'running' : 'committed',
        cognition: segment.cognition ?? {}, llmCalls: segment.llmCalls ?? [], toolCalls: [], childCalls: [],
        memoryOps: segment.memoryOps ?? [], ...(segment.startedAt ? { startedAt: segment.startedAt } : {}),
        ...(segment.finishedAt ? { finishedAt: segment.finishedAt } : {}),
      };
      return [makeStack(segment, [legacy], segment.boundaryKind, taskStatuses?.get(segment.taskId))];
    }
    const stacks: TurnStack[] = [];
    let current: CognitiveTurnRun[] = [];
    for (const turn of observed) {
      current.push(turn);
      const boundary = transitionKind(turn);
      if (boundary !== 'continue') {
        stacks.push(makeStack(segment, current, boundary, taskStatuses?.get(segment.taskId)));
        current = [];
      }
    }
    if (current.length > 0) stacks.push(makeStack(segment, current, undefined, taskStatuses?.get(segment.taskId)));
    return stacks;
  });
}

function dispositionRank(disposition: CognitiveTurnRun['disposition']): number {
  switch (disposition) {
    case 'committed': return 3;
    case 'superseded': return 2;
    case 'observed': return 1;
    case 'running': return 0;
  }
}

function makeStack(segment: TurnRun, turns: CognitiveTurnRun[], boundary?: string, ownerStatus?: AgentRunStatus): TurnStack {
  const final = turns.at(-1)!;
  const terminal = boundary ?? transitionKind(final);
  return {
    id: `${segment.id}:turns:${turns[0]!.cognitionTurnSeq}-${final.cognitionTurnSeq}`,
    taskId: segment.taskId,
    segment,
    turns,
    firstSeq: turns[0]!.cognitionTurnSeq,
    lastSeq: final.cognitionTurnSeq,
    status: stackStatus(final, terminal, ownerStatus),
    ...(terminal ? { boundary: terminal } : {}),
  };
}

function stackStatus(turn: CognitiveTurnRun, boundary?: string, ownerStatus?: AgentRunStatus): TurnStack['status'] {
  // An unfinished turn cannot outlive its task. This is especially important
  // after cancellation, where no terminal turn event will be emitted.
  if ((turn.disposition === 'running' || turn.disposition === 'observed') && (ownerStatus === 'canceled' || ownerStatus === 'cancelled')) return 'canceled';
  if ((turn.disposition === 'running' || turn.disposition === 'observed') && ownerStatus === 'failed') return 'failed';
  if ((turn.disposition === 'running' || turn.disposition === 'observed') && ownerStatus === 'completed') return 'completed';
  if (turn.disposition === 'running') return 'running';
  if (turn.disposition === 'observed' && boundary === 'continue') return 'running';
  if (boundary?.startsWith('await_')) return 'waiting';
  if (boundary === 'complete') return 'completed';
  if (boundary === 'fail') return 'failed';
  if (boundary === 'canceled' || boundary === 'cancelled') return 'canceled';
  return turn.disposition === 'observed' ? 'running' : 'completed';
}

export function transitionKind(turn: CognitiveTurnRun): string | undefined {
  const transition = turn.cognition.transition;
  return transition && typeof transition === 'object' && !Array.isArray(transition) &&
    typeof (transition as Record<string, unknown>).kind === 'string'
    ? (transition as Record<string, unknown>).kind as string
    : undefined;
}

export function turnStackLabel(stack: TurnStack): string {
  return stack.firstSeq === stack.lastSeq ? `Turn ${stack.firstSeq}` : `Turns ${stack.firstSeq}–${stack.lastSeq}`;
}
