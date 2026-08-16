import { Maximize2, Route, Shrink } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  type Edge,
  type Node,
  type NodeProps,
  useNodesInitialized,
  useReactFlow,
} from 'reactflow';
import { StatusBadge } from '../../design/components/ui/status-badge';
import { CopyableId } from '../../design/components/ui/copyable';
import { formatCost, formatDuration } from '../../design/format';
import { buildNodeRollup, deriveStatus, normalizeRuntimeStatus, type GraphInsights } from '../../domain/derive';
import { semanticAttentionFromTurns, semanticFailureFromTurns } from '../../domain/semanticFailure';
import type { AgentRunGraph, AgentRunNode, TurnRun } from '../../types';
import { buildTurnStacks, turnStackLabel, type TurnStack } from '../../domain/turnStacks';
import { cn } from '../../lib/utils';
import { Button } from '../../design/components/ui/button';

export type AgentNodeData = {
  kind: 'agent';
  node: AgentRunNode;
  graph: AgentRunGraph;
  insights: GraphInsights;
  selected: boolean;
};

export type TurnNodeData = {
  kind: 'turn';
  stack: TurnStack;
  selected: boolean;
};

export function AgentRunGraphView(props: {
  graph: AgentRunGraph;
  insights: GraphInsights;
  layoutKey?: string;
  selectedNodeId?: string;
  selectedTurnSeq?: number;
  onSelectNode: (nodeId: string) => void;
  onSelectTurn: (turn: TurnRun) => void;
}): React.ReactElement {
  const flow = useMemo(
    () => buildFlow(props.graph, props.insights, props.selectedNodeId, props.selectedTurnSeq),
    [props.graph, props.insights, props.selectedNodeId, props.selectedTurnSeq]
  );
  const isSingleNode = props.graph.nodes.length === 1;
  const hasFailurePath = props.insights.failurePathNodeIds.length > 0;
  const nodeSignature = useMemo(
    () => [
      ...props.graph.nodes.map((node) => node.id),
      ...buildTurnStacks(props.graph.turns, new Map(props.graph.nodes.map((node) => [node.taskId, node.status]))).map((stack) => stack.id),
      props.layoutKey ?? '',
    ].sort().join('|'),
    [props.graph.nodes, props.graph.turns, props.layoutKey]
  );
  return (
    <section className="relative h-full min-h-[520px] overflow-hidden rounded-xl border border-border bg-card xl:min-h-[calc(100vh-250px)]">
      <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-2">
        <GraphControlButton kind="fit" />
        {hasFailurePath ? <GraphControlButton kind="failure" /> : null}
        {isSingleNode ? (
          <span className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">No child agents</span>
        ) : null}
      </div>
      <div className="absolute right-3 top-3 z-10 hidden items-center gap-3 rounded-md border border-border bg-card/95 px-2.5 py-1.5 text-[10px] text-muted-foreground shadow-sm md:flex">
        <SeverityLegendDot className="border-emerald-600 bg-emerald-500" label="Successful" />
        <SeverityLegendDot className="border-sky-600 bg-sky-500" label="Active" />
        <SeverityLegendDot className="border-amber-600 bg-amber-500" label="Attention" />
        <SeverityLegendDot className="border-rose-600 bg-rose-500" label="Error" />
        <SeverityLegendDot className="border-slate-500 bg-slate-300" label="Neutral" />
      </div>
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={{ agent: AgentRunNodeCard, turn: TurnRunNodeCard }}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_event, node) => {
          const data = node.data as AgentNodeData | TurnNodeData;
          if (data.kind === 'turn') {
            props.onSelectTurn(data.stack.segment);
            return;
          }
          props.onSelectNode(data.node.id);
        }}
      >
        <AutoFitGraph nodeSignature={nodeSignature} />
        <Background gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}

function AutoFitGraph(props: { nodeSignature: string }): null {
  const instance = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  useEffect(() => {
    if (!nodesInitialized || props.nodeSignature.length === 0) return undefined;
    let frame = 0;
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        void instance.fitView({ padding: 0.2, duration: 220 });
      });
    }, 50);
    return () => {
      window.clearTimeout(timer);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [instance, nodesInitialized, props.nodeSignature]);
  return null;
}

function GraphControlButton(props: { kind: 'fit' | 'failure' }): React.ReactElement {
  const instance = useReactFlow();
  const isFailure = props.kind === 'failure';
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => {
        if (isFailure) {
          instance.fitView({ padding: 0.32, duration: 200 });
        } else {
          instance.fitView({ padding: 0.2, duration: 200 });
        }
      }}
    >
      {isFailure ? <Route className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      {isFailure ? 'Fit failure path' : 'Fit graph'}
    </Button>
  );
}

function AgentRunNodeCard(props: NodeProps<AgentNodeData>): React.ReactElement {
  const { node, graph, insights, selected } = props.data;
  const rollup = buildNodeRollup(graph, node.taskId);
  const status = deriveStatus({ status: node.status, updatedAt: node.finishedAt ?? node.startedAt, turns: rollup.turns });
  const semanticFailure = semanticFailureFromTurns(rollup.turns);
  const semanticAttention = semanticAttentionFromTurns(rollup.turns);
  const timedOut = node.status === 'canceled' && node.cancellation?.reason === 'active_run_timeout';
  const isFailurePath = insights.failurePathNodeIds.includes(node.taskId);
  const isDeepestFailure = insights.deepestFailedNodeId === node.id;
  const isSingleNode = graph.nodes.length === 1;
  return (
    <div className="relative">
      <Handle id="left" type="target" position={Position.Left} />
      <Handle id="right" type="source" position={Position.Right} />
      <article
        className={cn(
          'rounded-lg border bg-card p-3 text-left shadow-sm transition-colors',
          isSingleNode ? 'w-[220px]' : 'w-[250px]',
          selected ? 'border-primary ring-2 ring-primary/30' : 'border-border',
          isFailurePath ? 'bg-rose-500/10' : '',
          semanticAttention && !semanticFailure ? 'border-amber-300 bg-amber-500/10' : '',
          isDeepestFailure ? 'border-rose-300 ring-2 ring-rose-400/30' : ''
        )}
        aria-label={`${node.agentId ?? 'unknown agent'} ${status.status}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="truncate text-sm font-semibold">{node.agentId ?? 'unknown agent'}</p>
              {node.executionOrigin === 'cache' ? <CacheBadge compact /> : null}
            </div>
            <CopyableId value={node.taskId} label="task ID" max={18} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {node.severity === 'error' && status.status === 'cancelled' && !timedOut ? (
              <span className="h-2.5 w-2.5 rounded-full border border-rose-700 bg-rose-500" title="Error occurred before cancellation" />
            ) : null}
            {semanticAttention && status.status === 'completed'
              ? <OutcomeAttentionBadge />
              : <StatusBadge status={status.status} derived={status.derived} label={timedOut ? 'Timed out' : undefined} />}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <Metric label="Turns" value={String(buildTurnStacks(rollup.turns).reduce((count, stack) => count + stack.turns.length, 0))} />
          <Metric label="LLM" value={String(rollup.llmCalls.length)} />
          <Metric label="Cost" value={formatCost(rollup.costUsd)} />
        </div>
        {semanticFailure ? (
          <div className="mt-2 min-w-0 rounded-md border border-rose-500/45 bg-rose-100 px-2 py-1 text-xs text-rose-900 dark:border-rose-400/35 dark:bg-rose-500/10 dark:text-rose-100">
            <p className="truncate font-medium">{semanticFailure.code ?? 'Semantic failure'}</p>
            <p className="truncate opacity-85" title={semanticFailure.message}>{semanticFailure.message}</p>
          </div>
        ) : null}
        {!semanticFailure && semanticAttention ? (
          <div className="mt-2 min-w-0 rounded-md border border-amber-500/45 bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:border-amber-400/35 dark:bg-amber-500/10 dark:text-amber-100">
            <p className="font-medium">Completed with attention</p>
            <p className="truncate opacity-85" title={semanticAttention.message}>{semanticAttention.message}</p>
          </div>
        ) : null}
        {!semanticFailure && timedOut ? (
          <div className="mt-2 min-w-0 rounded-md border border-amber-500/45 bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:border-amber-400/35 dark:bg-amber-500/10 dark:text-amber-100">
            <p className="font-medium">Time budget exceeded</p>
            <p className="opacity-85">The durable root deadline stopped this run.</p>
          </div>
        ) : null}
        {!semanticFailure && !timedOut && node.severity === 'error' && status.status === 'cancelled' ? (
          <div className="mt-2 min-w-0 rounded-md border border-rose-500/45 bg-rose-100 px-2 py-1 text-xs text-rose-900 dark:border-rose-400/35 dark:bg-rose-500/10 dark:text-rose-100">
            <p className="font-medium">Error occurred before cancellation</p>
            {runtimeErrorMessage(node.error) ? <p className="truncate opacity-85" title={runtimeErrorMessage(node.error)}>{runtimeErrorMessage(node.error)}</p> : null}
          </div>
        ) : null}
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Shrink className="h-3.5 w-3.5" />
          {node.executionOrigin === 'cache'
            ? 'Cache-served child'
            : node.parentTaskId ? 'Child agent' : 'Root agent'} · {node.startedAt ? formatDuration(durationBetween(node.startedAt, node.finishedAt)) : 'duration not captured'}
        </div>
      </article>
    </div>
  );
}

function OutcomeAttentionBadge(): React.ReactElement {
  return <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/45 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-400/35 dark:bg-amber-500/10 dark:text-amber-100">Completed · attention</span>;
}

function CacheBadge(props: { compact?: boolean }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-info-border bg-info-bg font-medium text-info',
        props.compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs'
      )}
      title="Served from previous run result cache"
    >
      Cached
    </span>
  );
}

function TurnRunNodeCard(props: NodeProps<TurnNodeData>): React.ReactElement {
  const { stack, selected } = props.data;
  const finalTurn = stack.turns.at(-1)!;
  const status = normalizeRuntimeStatus(stack.status);
  const boundary = humanizeBoundary(stack.boundary);
  const flowLabel = `${finalTurn.cognition.stageBefore ?? '?'} → ${finalTurn.cognition.stageAfter ?? stack.boundary ?? 'continue'}`;
  const llmCalls = stack.turns.reduce((count, turn) => count + turn.llmCalls.length, 0);
  const failedLlmCalls = stack.turns.flatMap((turn) => turn.llmCalls).filter((call) => isRecord(call) && call.terminalReason !== undefined && call.terminalReason !== 'completed').length;
  return (
    <div className="relative">
      <Handle id="left" type="target" position={Position.Left} />
      <Handle id="right" type="source" position={Position.Right} />
      <article
        className={cn(
          'w-[146px] rounded-md border bg-background px-2 py-1.5 text-left shadow-sm transition-colors',
          selected ? 'border-primary ring-2 ring-primary/30' : 'border-border',
          stack.status === 'failed' ? 'border-rose-300 bg-rose-500/10' : '',
          failedLlmCalls > 0 && stack.status === 'completed' ? 'border-amber-300 bg-amber-500/10' : '',
          status === 'running' || status === 'waiting' ? 'border-sky-300 bg-sky-500/10' : ''
        )}
        aria-label={`${turnStackLabel(stack)} ${status}`}
      >
        <div className="flex min-w-0 items-start justify-between gap-1.5">
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold">{turnStackLabel(stack)}</p>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={flowLabel}>{boundary ?? status}</p>
          </div>
          <div className="flex shrink-0 items-start gap-1">
            <span className="rounded border border-border bg-card px-1 py-0.5 text-[9px] font-medium text-muted-foreground" title={`Segment ${stack.segment.turnSeq}`}>#{stack.segment.turnSeq}</span>
            <span
              className={cn(
                'mt-0.5 h-2 w-2 shrink-0 rounded-full border',
                stack.status === 'completed' && failedLlmCalls === 0 ? 'border-emerald-600 bg-emerald-500' : '',
                stack.status === 'completed' && failedLlmCalls > 0 ? 'border-amber-600 bg-amber-500' : '',
                stack.status === 'failed' ? 'border-rose-600 bg-rose-500' : '',
                stack.status === 'running' || stack.status === 'waiting' ? 'border-sky-600 bg-sky-500' : '',
                stack.status === 'canceled' ? 'border-slate-500 bg-slate-300' : ''
              )}
              title={status}
            />
          </div>
        </div>
        <p className="mt-1 truncate text-[9px] font-medium text-muted-foreground">{stack.turns.length} turns · {llmCalls} LLM{failedLlmCalls > 0 ? ` · ${failedLlmCalls} failed` : ''}</p>
      </article>
    </div>
  );
}

function Metric(props: { label: string; value: string }): React.ReactElement {
  return (
    <div className="rounded-md border border-border bg-background/50 px-2 py-1">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{props.label}</p>
      <p className="truncate font-mono">{props.value}</p>
    </div>
  );
}

function buildFlow(
  graph: AgentRunGraph,
  insights: GraphInsights,
  selectedNodeId: string | undefined,
  selectedTurnSeq: number | undefined
): {
  nodes: Array<Node<AgentNodeData> | Node<TurnNodeData>>;
  edges: Edge[];
} {
  const stacks = buildTurnStacks(graph.turns, new Map(graph.nodes.map((node) => [node.taskId, node.status])));
  const layout = layoutExecutionGraph(graph, stacks);
  const byTask = new Map(graph.nodes.map((node) => [node.taskId, node]));
  const turnByParentAndToken = new Map<string, TurnStack>();
  for (const stack of stacks) {
    const token = awaitChildToken(stack.segment) ?? awaitChildTokenFromCognition(stack.turns.at(-1)!);
    if (!token) continue;
    turnByParentAndToken.set(`${stack.taskId}:${token}`, stack);
  }
  const isSingleAgent = graph.nodes.length === 1;
  const agentNodes: Node<AgentNodeData>[] = graph.nodes.map((node) => {
    const position = layout.positions.get(node.id) ?? { x: 0, y: 0 };
    return {
      id: node.id,
      type: 'agent',
      position: {
        x: isSingleAgent && graph.turns.length === 0 ? 0 : position.x,
        y: isSingleAgent && graph.turns.length === 0 ? 0 : position.y,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        kind: 'agent',
        node,
        graph,
        insights,
        selected: selectedNodeId === node.id || selectedNodeId === node.taskId,
      },
    };
  });
  const turnNodes: Node<TurnNodeData>[] = stacks
    .filter((stack) => byTask.has(stack.taskId))
    .map((stack) => {
      const id = stack.id;
      const position = layout.positions.get(id) ?? { x: 0, y: 0 };
      return {
        id,
        type: 'turn',
        position,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: {
          kind: 'turn',
          stack,
          selected: selectedNodeId === stack.taskId && selectedTurnSeq !== undefined && selectedTurnSeq >= stack.firstSeq && selectedTurnSeq <= stack.lastSeq,
        },
      };
    });
  const turnEdges: Edge[] = stacks
    .filter((stack) => byTask.has(stack.taskId))
    .map((stack) => {
      const status = normalizeRuntimeStatus(stack.status);
      return {
        id: `agent-turn:${stack.id}`,
        source: byTask.get(stack.taskId)?.id ?? stack.taskId,
        target: stack.id,
        sourceHandle: 'right',
        targetHandle: 'left',
        animated: status === 'running' || status === 'waiting',
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        style: {
          strokeWidth: 2,
          stroke: stack.status === 'failed' ? '#fb7185' : status === 'running' || status === 'waiting' ? '#38bdf8' : '#94a3b8',
        },
      };
    });
  const childEdges: Edge[] = graph.edges
    .filter((edge) => edge.childTaskId !== undefined && byTask.has(edge.parentTaskId) && byTask.has(edge.childTaskId))
    .map((edge) => {
      const highlighted = insights.failurePathEdgeIds.includes(edge.id);
      const sourceTurn = edge.token ? turnByParentAndToken.get(`${edge.parentTaskId}:${edge.token}`) : undefined;
      const temporalSourceTurn = sourceTurn ?? findTemporalSourceStack(stacks, edge.parentTaskId, edge.startedAt);
      return {
        id: edge.id,
        source: temporalSourceTurn ? temporalSourceTurn.id : byTask.get(edge.parentTaskId)?.id ?? edge.parentTaskId,
        target: byTask.get(edge.childTaskId ?? '')?.id ?? edge.childTaskId ?? edge.id,
        sourceHandle: 'right',
        targetHandle: 'left',
        animated: highlighted || edge.status === 'running',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        className: highlighted ? 'stroke-rose-300' : '',
        style: highlighted
          ? { strokeWidth: 3, stroke: '#fda4af' }
          : { strokeWidth: 2.25, stroke: '#64748b' },
      };
    });
  return { nodes: [...agentNodes, ...turnNodes], edges: [...turnEdges, ...childEdges] };
}

function findTemporalSourceStack(stacks: TurnStack[], parentTaskId: string, edgeStartedAt: string | undefined): TurnStack | undefined {
  const edgeStartedMs = edgeStartedAt ? Date.parse(edgeStartedAt) : Number.NaN;
  const parentTurns = stacks.filter((stack) => stack.taskId === parentTaskId)
    .sort((left, right) => left.displayLastSeq - right.displayLastSeq);
  if (!Number.isFinite(edgeStartedMs)) {
    return parentTurns.find((stack) => stack.status === 'running');
  }
  return parentTurns
    .filter((stack) => {
      const startedMs = stack.turns[0]?.startedAt ? Date.parse(stack.turns[0].startedAt) : Number.NaN;
      if (!Number.isFinite(startedMs) || startedMs > edgeStartedMs) return false;
      const finishedMs = stack.turns.at(-1)?.finishedAt ? Date.parse(stack.turns.at(-1)!.finishedAt!) : Number.NaN;
      return !Number.isFinite(finishedMs) || finishedMs >= edgeStartedMs;
    })
    .at(-1);
}

type LayoutPoint = { x: number; y: number };

const AGENT_WIDTH = 250;
const AGENT_HEIGHT = 148;
const ROOT_AGENT_WIDTH = 220;
const TURN_HEIGHT = 58;
const AGENT_COLUMN_GAP = 560;
const TURN_COLUMN_OFFSET = 300;
const TURN_GAP = 24;
const SUBTREE_GAP = 54;

function layoutExecutionGraph(graph: AgentRunGraph, stacks: TurnStack[]): { positions: Map<string, LayoutPoint> } {
  const positions = new Map<string, LayoutPoint>();
  const nodesByTask = new Map(graph.nodes.map((node) => [node.taskId, node]));
  const turnsByTask = new Map<string, TurnStack[]>();
  for (const stack of stacks) {
    if (!nodesByTask.has(stack.taskId)) continue;
    const taskStacks = turnsByTask.get(stack.taskId) ?? [];
    taskStacks.push(stack);
    turnsByTask.set(stack.taskId, taskStacks);
  }
  for (const taskStacks of turnsByTask.values()) {
    taskStacks.sort((a, b) => a.displayFirstSeq - b.displayFirstSeq);
  }

  const childEdgesByParentToken = new Map<string, typeof graph.edges>();
  const edgeIdsAssignedToTurns = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge.childTaskId || !nodesByTask.has(edge.childTaskId)) continue;
    const key = `${edge.parentTaskId}:${edge.token ?? ''}`;
    const edges = childEdgesByParentToken.get(key) ?? [];
    edges.push(edge);
    childEdgesByParentToken.set(key, edges);
  }

  const visited = new Set<string>();

  function layoutAgent(taskId: string, depth: number, top: number): { height: number; centerY: number } {
    const node = nodesByTask.get(taskId);
    if (!node || visited.has(taskId)) {
      return { height: AGENT_HEIGHT, centerY: top + AGENT_HEIGHT / 2 };
    }
    visited.add(taskId);

    const agentX = depth * AGENT_COLUMN_GAP;
    const turnX = agentX + TURN_COLUMN_OFFSET;
    const turns = turnsByTask.get(taskId) ?? [];

    if (turns.length === 0) {
      positions.set(node.id, { x: agentX, y: top });
      return { height: AGENT_HEIGHT, centerY: top + AGENT_HEIGHT / 2 };
    }

    let cursor = top;
    const turnCenters: number[] = [];

    for (const turn of turns) {
      const turnId = turn.id;
      const token = awaitChildToken(turn.segment) ?? awaitChildTokenFromCognition(turn.turns.at(-1)!);
      const childEdges = token ? childEdgesByParentToken.get(`${taskId}:${token}`) ?? [] : [];

      if (childEdges.length > 0) {
        const childCenters: number[] = [];
        const childStart = cursor;
        for (const edge of childEdges) {
          if (!edge.childTaskId) continue;
          edgeIdsAssignedToTurns.add(edge.id);
          const childLayout = layoutAgent(edge.childTaskId, depth + 1, cursor);
          childCenters.push(childLayout.centerY);
          cursor += childLayout.height + SUBTREE_GAP;
        }
        if (childCenters.length > 0) {
          cursor -= SUBTREE_GAP;
          const turnCenter = (childCenters[0] + childCenters[childCenters.length - 1]) / 2;
          positions.set(turnId, { x: turnX, y: turnCenter - TURN_HEIGHT / 2 });
          turnCenters.push(turnCenter);
          cursor = Math.max(cursor, childStart + TURN_HEIGHT) + TURN_GAP;
          continue;
        }
      }

      const turnCenter = cursor + TURN_HEIGHT / 2;
      positions.set(turnId, { x: turnX, y: cursor });
      turnCenters.push(turnCenter);
      cursor += TURN_HEIGHT + TURN_GAP;
    }

    const unmatchedChildEdges = graph.edges.filter((edge) =>
      edge.parentTaskId === taskId &&
      edge.childTaskId !== undefined &&
      nodesByTask.has(edge.childTaskId) &&
      !edgeIdsAssignedToTurns.has(edge.id)
    );
    for (const edge of unmatchedChildEdges) {
      if (!edge.childTaskId) continue;
      const childLayout = layoutAgent(edge.childTaskId, depth + 1, cursor);
      cursor += childLayout.height + SUBTREE_GAP;
    }
    if (unmatchedChildEdges.length > 0) {
      cursor -= SUBTREE_GAP;
    }

    cursor -= TURN_GAP;
    const turnStackHeight = Math.max(TURN_HEIGHT, cursor - top);
    const agentCenter = (turnCenters[0] + turnCenters[turnCenters.length - 1]) / 2;
    positions.set(node.id, { x: agentX, y: agentCenter - AGENT_HEIGHT / 2 });
    const minY = Math.min(top, agentCenter - AGENT_HEIGHT / 2);
    const maxY = Math.max(top + turnStackHeight, agentCenter + AGENT_HEIGHT / 2);
    return { height: Math.max(AGENT_HEIGHT, maxY - minY), centerY: agentCenter };
  }

  let cursor = 0;
  const roots = [
    graph.root,
    ...graph.nodes.filter((node) => node.id !== graph.root.id && !node.parentTaskId),
  ];
  for (const root of roots) {
    const result = layoutAgent(root.taskId, 0, cursor);
    cursor += result.height + SUBTREE_GAP;
  }
  for (const node of graph.nodes) {
    if (positions.has(node.id)) continue;
    const result = layoutAgent(node.taskId, 0, cursor);
    cursor += result.height + SUBTREE_GAP;
  }

  return { positions };
}

function turnNodeId(turn: TurnRun): string {
  return `turn:${turn.taskId}:${turn.turnSeq}`;
}

function SeverityLegendDot(props: { className: string; label: string }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('h-2 w-2 rounded-full border', props.className)} />
      {props.label}
    </span>
  );
}

function humanizeBoundary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const labels: Record<string, string> = {
    await_child: 'Awaiting child',
    await_input: 'Awaiting input',
    await_tool: 'Awaiting tool',
    await_event: 'Awaiting event',
    complete: 'Completed',
    fail: 'Failed',
    canceled: 'Cancelled',
  };
  return labels[value] ?? value.replace(/_/g, ' ');
}

function runtimeErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!isRecord(error)) return undefined;
  return typeof error.message === 'string'
    ? error.message
    : typeof error.code === 'string'
      ? error.code
      : undefined;
}

function turnFlowLabel(turn: TurnRun): string {
  const before = turn.cognition?.stageBefore ?? '?';
  const terminal = effectiveBoundaryKind(turn);
  if (terminal && terminal !== 'continue') {
    return `${before} -> ${terminal}`;
  }
  return `${before} -> ${turn.cognition?.stageAfter ?? terminal ?? '?'}`;
}

function effectiveBoundaryKind(turn: TurnRun): string | undefined {
  return transitionKind(turn) ?? turn.boundaryKind;
}

function transitionKind(turn: TurnRun): string | undefined {
  const transition = turn.cognition?.transition;
  if (!isRecord(transition)) return undefined;
  const kind = transition.kind;
  return typeof kind === 'string' ? kind : undefined;
}

function awaitChildToken(turn: TurnRun): string | undefined {
  const transition = turn.cognition?.transition;
  if (isRecord(transition) && transition.kind === 'await_child' && typeof transition.token === 'string') {
    return transition.token;
  }
  if (isRecord(transition) && typeof transition.kind === 'string') {
    return undefined;
  }
  if (turn.boundaryKind === 'await_child' && typeof turn.token === 'string') {
    return turn.token;
  }
  return undefined;
}

function awaitChildTokenFromCognition(turn: TurnStack['turns'][number]): string | undefined {
  const transition = turn.cognition.transition;
  return isRecord(transition) && transition.kind === 'await_child' && typeof transition.token === 'string'
    ? transition.token
    : undefined;
}

function hasOutputProduced(turn: TurnRun): boolean {
  const execResult = turn.cognition?.execResult;
  const transition = turn.cognition?.transition;
  return isRecord(execResult) && Object.prototype.hasOwnProperty.call(execResult, 'data')
    || transitionResultOk(transition)
    || turn.boundaryKind === 'complete';
}

function transitionResultOk(transition: unknown): boolean {
  if (!isRecord(transition)) return false;
  const result = transition.result;
  return isRecord(result) && result.ok === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function durationBetween(start: string, finish: string | undefined): number | undefined {
  const startDate = new Date(start);
  const finishDate = finish ? new Date(finish) : new Date();
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(finishDate.getTime())) return undefined;
  return finishDate.getTime() - startDate.getTime();
}
