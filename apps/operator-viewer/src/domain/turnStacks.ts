import type { AgentRunStatus, CognitiveTurnRun, TurnRun } from '../types';

export type TurnStack = {
  id: string;
  taskId: string;
  segment: TurnRun;
  turns: CognitiveTurnRun[];
  firstSeq: number;
  lastSeq: number;
  displayFirstSeq: number;
  displayLastSeq: number;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'canceled';
  boundary?: string;
};

export function buildTurnStacks(turns: TurnRun[], taskStatuses?: ReadonlyMap<string, AgentRunStatus>): TurnStack[] {
  const visibleSegments = primarySegments(turns, taskStatuses);
  const stacks: Array<Omit<TurnStack, 'displayFirstSeq' | 'displayLastSeq'>> = visibleSegments.flatMap((segment) => {
    const ownerStatus = taskStatuses?.get(segment.taskId);
    const canonical = new Map<string, CognitiveTurnRun>();
    for (const turn of segment.cognitiveTurns ?? []) {
      const identity = turn.turnId ? `${turn.taskId}:${turn.turnId}` : turn.id;
      const existing = canonical.get(identity);
      if (!existing || dispositionRank(turn.disposition) >= dispositionRank(existing.disposition)) canonical.set(identity, turn);
    }
    // Keep a started turn when its owner has become terminal. It did begin, and
    // hiding it makes the trace look as if time vanished. `stackStatus` maps it
    // to the owner's terminal state, so the UI can say "cancelled by timeout"
    // instead of incorrectly leaving it "running".
    const finalized = [...canonical.values()];
    // A root deadline can interrupt the segment after cognitive work has
    // completed but before the segment's terminal arbitration. Those traces are
    // diagnostic rather than authoritative, but they are still the only honest
    // account of the work that occurred. Show them instead of synthesising one
    // fake legacy turn per segment.
    const observed = finalized
      .filter((turn) => turn.disposition !== 'superseded')
    const visible = (observed.length > 0 ? observed : finalized)
      .sort((a, b) => a.cognitionTurnSeq - b.cognitionTurnSeq);
    // Older runs predate per-turn capture. Keep their one durable attempt visible
    // as a single turn rather than making the run appear empty.
    if (visible.length === 0) {
      const legacy: CognitiveTurnRun = {
        id: `${segment.id}:legacy-turn`, rootTaskId: segment.rootTaskId, taskId: segment.taskId,
        ...(segment.agentId ? { agentId: segment.agentId } : {}),
        cognitionTurnSeq: segment.turnSeq, segmentSeq: segment.turnSeq,
        disposition: segment.status === 'running' ? 'running' : 'committed',
        cognition: segment.cognition ?? {}, llmCalls: segment.llmCalls ?? [], toolCalls: [], childCalls: [],
        memoryOps: segment.memoryOps ?? [], ...(segment.startedAt ? { startedAt: segment.startedAt } : {}),
        ...(segment.finishedAt ? { finishedAt: segment.finishedAt } : {}),
      };
      return [makeStack(segment, [legacy], segment.boundaryKind, ownerStatus)];
    }
    const stacks: Array<Omit<TurnStack, 'displayFirstSeq' | 'displayLastSeq'>> = [];
    let current: CognitiveTurnRun[] = [];
    for (const turn of visible) {
      current.push(turn);
      const boundary = transitionKind(turn);
      if (boundary !== 'continue') {
        stacks.push(makeStack(segment, current, boundary, ownerStatus));
        current = [];
      }
    }
    if (current.length > 0) stacks.push(makeStack(segment, current, undefined, ownerStatus));
    return stacks;
  });
  let nextDisplaySeq = 1;
  return stacks.map((stack) => {
    const displayFirstSeq = nextDisplaySeq;
    nextDisplaySeq += stack.turns.length;
    return { ...stack, displayFirstSeq, displayLastSeq: nextDisplaySeq - 1 };
  });
}

function primarySegments(turns: TurnRun[], taskStatuses?: ReadonlyMap<string, AgentRunStatus>): TurnRun[] {
  const ordered = [...turns].sort((a, b) => {
    const byStart = (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
    return byStart !== 0 ? byStart : a.turnSeq - b.turnSeq;
  });
  const hasAuthoritativeCognition = ordered.some((segment) =>
    (segment.cognitiveTurns ?? []).some((turn) => turn.disposition !== 'superseded')
  );
  const taskIsTerminal = ordered.some((segment) => {
    const status = taskStatuses?.get(segment.taskId);
    return status === 'completed' || status === 'failed' || status === 'canceled' || status === 'cancelled';
  });
  if (hasAuthoritativeCognition || !taskIsTerminal) return ordered;

  // If terminality beat every segment's final arbitration, only the first
  // segment containing cognition is the execution that consumed the run. Any
  // later all-superseded segment is a replay after terminality and belongs in
  // runtime diagnostics, never alongside the real execution in the graph.
  const firstRecordedSegment = ordered.find((segment) => (segment.cognitiveTurns?.length ?? 0) > 0);
  return firstRecordedSegment ? [firstRecordedSegment] : ordered;
}

function dispositionRank(disposition: CognitiveTurnRun['disposition']): number {
  switch (disposition) {
    case 'committed': return 3;
    case 'superseded': return 2;
    case 'observed': return 1;
    case 'running': return 0;
  }
}

function makeStack(segment: TurnRun, turns: CognitiveTurnRun[], boundary?: string, ownerStatus?: AgentRunStatus): Omit<TurnStack, 'displayFirstSeq' | 'displayLastSeq'> {
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
  if ((turn.disposition === 'running' || turn.disposition === 'observed' || turn.disposition === 'superseded') && (ownerStatus === 'canceled' || ownerStatus === 'cancelled')) return 'canceled';
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
  return stack.displayFirstSeq === stack.displayLastSeq
    ? `Turn ${stack.displayFirstSeq}`
    : `Turns ${stack.displayFirstSeq}–${stack.displayLastSeq}`;
}
