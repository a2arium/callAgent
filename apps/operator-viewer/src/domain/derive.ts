import type { AgentRunGraph, AgentRunListItem, AgentRunNode, FleetSummary, LlmCallRun, MemoryOperationRun, TurnRun } from '../types';
import type { RuntimeStatus } from '../design/tokens';

export type Thresholds = {
  awaitInputMs: number;
  awaitToolMs: number;
  awaitChildMs: number;
};

export const defaultThresholds: Thresholds = {
  awaitInputMs: 24 * 60 * 60 * 1000,
  awaitToolMs: 10 * 60 * 1000,
  awaitChildMs: 15 * 60 * 1000,
};

export type EnrichedStatus = {
  status: RuntimeStatus;
  runtimeStatus: string;
  derived: boolean;
  reason?: string;
  waitDurationMs?: number;
  thresholdMs?: number;
  awaitType?: 'await_input' | 'await_tool' | 'await_child' | 'unknown';
};

export type GraphInsights = {
  selectedNodeId?: string;
  deepestFailedNodeId?: string;
  failurePathNodeIds: string[];
  failurePathEdgeIds: string[];
  failedLeafCount: number;
  hasPartialData: boolean;
  summary: string;
};

export type NodeRollup = {
  taskId: string;
  turns: TurnRun[];
  llmCalls: LlmCallRun[];
  memoryOps: MemoryOperationRun[];
  costUsd?: number;
};

export function normalizeRuntimeStatus(status: string | undefined): RuntimeStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'waiting':
      return 'waiting';
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

export function deriveStatus(input: {
  status?: string;
  updatedAt?: string;
  finishedAt?: string;
  turns?: TurnRun[];
  now?: Date;
  thresholds?: Thresholds;
}): EnrichedStatus {
  const runtimeStatus = input.status ?? 'unknown';
  const normalized = normalizeRuntimeStatus(runtimeStatus);
  if (normalized !== 'running' && normalized !== 'queued') {
    return { status: normalized, runtimeStatus, derived: false };
  }
  const latestTurn = latestTurnRun(input.turns ?? []);
  const latestBoundaryKind = latestTurn ? turnBoundaryKind(latestTurn) : undefined;
  if (!latestTurn || !isAwaitBoundary(latestBoundaryKind)) {
    return { status: normalized, runtimeStatus, derived: false };
  }
  const waitingTurn = latestTurn;
  const awaitType = latestBoundaryKind as EnrichedStatus['awaitType'];
  const thresholds = input.thresholds ?? defaultThresholds;
  const thresholdMs =
    awaitType === 'await_input'
      ? thresholds.awaitInputMs
      : awaitType === 'await_tool'
        ? thresholds.awaitToolMs
        : thresholds.awaitChildMs;
  const anchor = waitingTurn.cognition?.timings?.finishedAt;
  const anchorText = typeof anchor === 'string' ? anchor : input.finishedAt ?? input.updatedAt;
  const waitDurationMs = durationSince(anchorText, input.now ?? new Date());
  if (typeof waitDurationMs === 'number' && waitDurationMs > thresholdMs) {
    return {
      status: 'stuck',
      runtimeStatus,
      derived: true,
      reason: 'Waiting longer than configured threshold',
      waitDurationMs,
      thresholdMs,
      awaitType,
    };
  }
  return {
    status: 'waiting',
    runtimeStatus,
    derived: true,
    reason: 'Latest known boundary is an await state',
    waitDurationMs,
    thresholdMs,
    awaitType,
  };
}

function latestTurnRun(turns: TurnRun[]): TurnRun | undefined {
  return turns.reduce<TurnRun | undefined>((latest, turn) => {
    if (!latest) return turn;
    const latestSeq = latest.turnSeq ?? Number.NEGATIVE_INFINITY;
    const turnSeq = turn.turnSeq ?? Number.NEGATIVE_INFINITY;
    return turnSeq >= latestSeq ? turn : latest;
  }, undefined);
}

function turnBoundaryKind(turn: TurnRun): string | undefined {
  if (turn.boundaryKind) return turn.boundaryKind;
  const transition = turn.cognition?.transition;
  if (transition !== null && typeof transition === 'object' && !Array.isArray(transition) && 'kind' in transition) {
    const kind = transition.kind;
    return typeof kind === 'string' ? kind : undefined;
  }
  return undefined;
}

function isAwaitBoundary(value: string | undefined): value is 'await_input' | 'await_tool' | 'await_child' {
  return value === 'await_input' || value === 'await_tool' || value === 'await_child';
}

export function deriveFleetSummary(rows: AgentRunListItem[]): FleetSummary {
  return rows.reduce<FleetSummary>(
    (summary, row) => {
      const status = normalizeRuntimeStatus(row.status);
      summary.total += 1;
      if (status === 'failed') summary.failed += 1;
      if (status === 'completed') summary.completed += 1;
      if (status === 'running') summary.waiting += 1;
      if (typeof row.costUsd === 'number') summary.costCaptured += 1;
      else summary.costUnavailable += 1;
      return summary;
    },
    { total: 0, failed: 0, waiting: 0, stuck: 0, completed: 0, costCaptured: 0, costUnavailable: 0 }
  );
}

export function deriveGraphInsights(graph: AgentRunGraph | undefined): GraphInsights {
  if (!graph) {
    return {
      failurePathNodeIds: [],
      failurePathEdgeIds: [],
      failedLeafCount: 0,
      hasPartialData: false,
      summary: 'Select a run to inspect its execution graph.',
    };
  }
  const childrenByParent = new Map<string, AgentRunNode[]>();
  for (const node of graph.nodes) {
    if (!node.parentTaskId) continue;
    const children = childrenByParent.get(node.parentTaskId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentTaskId, children);
  }
  const failedNodes = graph.nodes.filter((node) => normalizeRuntimeStatus(node.status) === 'failed' || node.severity === 'error');
  const failedLeaves = failedNodes.filter((node) => !hasFailedDescendant(node.taskId, childrenByParent));
  const deepest = [...failedLeaves].sort((a, b) => depthOf(b, graph.nodes) - depthOf(a, graph.nodes))[0] ?? failedNodes[0];
  const pathNodeIds = deepest ? pathToRoot(deepest.taskId, graph.nodes) : [];
  const pathEdgeIds = graph.edges
    .filter((edge) => edge.childTaskId !== undefined && pathNodeIds.includes(edge.parentTaskId) && pathNodeIds.includes(edge.childTaskId))
    .map((edge) => edge.id);
  const hasPartialData = graph.nodes.length === 0 || graph.nodes.some((node) => normalizeRuntimeStatus(node.status) === 'unknown');
  const selectedNodeId = deepest?.id ?? graph.root.id;
  const summary = buildGraphSummary(graph, deepest, pathNodeIds, hasPartialData);
  return {
    selectedNodeId,
    deepestFailedNodeId: deepest?.id,
    failurePathNodeIds: pathNodeIds,
    failurePathEdgeIds: pathEdgeIds,
    failedLeafCount: failedLeaves.length,
    hasPartialData,
    summary,
  };
}

export function buildNodeRollup(graph: AgentRunGraph, taskId: string): NodeRollup {
  const turns = graph.turns.filter((turn) => turn.taskId === taskId);
  // New projections attach LLM calls to actual turns. Fall back to the old
  // segment-level field only when that run has no per-turn capture.
  const llmCalls = turns.flatMap((turn) => {
    const canonicalTurns = canonicalCognitiveTurns(turn);
    return canonicalTurns.length > 0
      ? canonicalTurns.flatMap((cognitive) => cognitive.llmCalls)
      : turn.llmCalls ?? [];
  });
  const memoryOps = graph.memoryOps.filter((op) => op.taskId === taskId || op.agentId === graph.nodes.find((node) => node.taskId === taskId)?.agentId);
  const callCostUsd = llmCalls.reduce<number | undefined>((sum, call) => {
    const value = typeof call.costUsd === 'number' ? call.costUsd : typeof call.cost === 'number' ? call.cost : undefined;
    if (typeof value !== 'number') return sum;
    return (sum ?? 0) + value;
  }, undefined);
  const usageCostUsd = turns.reduce<number | undefined>((sum, turn) => {
    for (const cognitive of canonicalCognitiveTurns(turn)) {
      const usage = cognitive.cognition.usage;
      const value = usage && typeof usage === 'object' && !Array.isArray(usage) && typeof (usage as Record<string, unknown>).totalCost === 'number'
        ? (usage as Record<string, unknown>).totalCost as number
        : undefined;
      if (typeof value === 'number') sum = (sum ?? 0) + value;
    }
    return sum;
  }, undefined);
  return { taskId, turns, llmCalls, memoryOps, costUsd: callCostUsd ?? usageCostUsd };
}

function canonicalCognitiveTurns(turn: TurnRun): NonNullable<TurnRun['cognitiveTurns']> {
  const byIdentity = new Map<string, NonNullable<TurnRun['cognitiveTurns']>[number]>();
  for (const cognitive of turn.cognitiveTurns ?? []) {
    const identity = cognitive.turnId ? `${cognitive.taskId}:${cognitive.turnId}` : cognitive.id;
    const existing = byIdentity.get(identity);
    if (!existing || cognitiveDispositionRank(cognitive.disposition) >= cognitiveDispositionRank(existing.disposition)) {
      byIdentity.set(identity, cognitive);
    }
  }
  return [...byIdentity.values()].filter((cognitive) => cognitive.disposition !== 'superseded');
}

function cognitiveDispositionRank(disposition: NonNullable<TurnRun['cognitiveTurns']>[number]['disposition']): number {
  return disposition === 'committed' ? 3 : disposition === 'superseded' ? 2 : disposition === 'observed' ? 1 : 0;
}

export function getNodeById(graph: AgentRunGraph | undefined, nodeId: string | undefined): AgentRunNode | undefined {
  if (!graph) return undefined;
  if (!nodeId) return graph.root;
  return graph.nodes.find((node) => node.id === nodeId || node.taskId === nodeId);
}

function durationSince(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return now.getTime() - date.getTime();
}

function hasFailedDescendant(taskId: string, childrenByParent: Map<string, AgentRunNode[]>): boolean {
  const children = childrenByParent.get(taskId) ?? [];
  return children.some((child) => normalizeRuntimeStatus(child.status) === 'failed' || child.severity === 'error' || hasFailedDescendant(child.taskId, childrenByParent));
}

function depthOf(node: AgentRunNode, nodes: AgentRunNode[]): number {
  const byTask = new Map(nodes.map((candidate) => [candidate.taskId, candidate]));
  let depth = 0;
  let current = node;
  while (current.parentTaskId) {
    const parent = byTask.get(current.parentTaskId);
    if (!parent) break;
    current = parent;
    depth += 1;
  }
  return depth;
}

function pathToRoot(taskId: string, nodes: AgentRunNode[]): string[] {
  const byTask = new Map(nodes.map((node) => [node.taskId, node]));
  const path: string[] = [];
  let current = byTask.get(taskId);
  while (current) {
    path.unshift(current.taskId);
    current = current.parentTaskId ? byTask.get(current.parentTaskId) : undefined;
  }
  return path;
}

function buildGraphSummary(graph: AgentRunGraph, deepest: AgentRunNode | undefined, pathNodeIds: string[], hasPartialData: boolean): string {
  if (deepest) {
    const leaf = deepest.agentId ?? deepest.taskId;
    const root = graph.root.agentId ?? graph.root.taskId;
    if (normalizeRuntimeStatus(deepest.status) === 'cancelled') {
      return `Cancelled after an error in ${leaf}.`;
    }
    if (pathNodeIds.length > 1) {
      return `Failed in ${leaf}. The failure propagated to ${root}.`;
    }
    return `Failed in ${leaf}.`;
  }
  if (hasPartialData) return 'This run has partial data. The graph shows known agent nodes only.';
  if (normalizeRuntimeStatus(graph.root.status) === 'completed') {
    return 'Run completed. Healthy branches are collapsed by default.';
  }
  return 'Run data loaded. Select an agent node to inspect turns, LLM calls, memory operations, and links.';
}
