import dagre from 'dagre';
import { Maximize2, Route, Shrink } from 'lucide-react';
import { useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  type Edge,
  type Node,
  type NodeProps,
  useReactFlow,
} from 'reactflow';
import { StatusBadge } from '../../design/components/ui/status-badge';
import { CopyableId } from '../../design/components/ui/copyable';
import { formatCost, formatDuration } from '../../design/format';
import { buildNodeRollup, deriveStatus, type GraphInsights } from '../../domain/derive';
import type { AgentRunGraph, AgentRunNode } from '../../types';
import { cn } from '../../lib/utils';
import { Button } from '../../design/components/ui/button';

export type AgentNodeData = {
  node: AgentRunNode;
  graph: AgentRunGraph;
  insights: GraphInsights;
  selected: boolean;
};

export function AgentRunGraphView(props: {
  graph: AgentRunGraph;
  insights: GraphInsights;
  selectedNodeId?: string;
  onSelectNode: (nodeId: string) => void;
}): React.ReactElement {
  const flow = useMemo(() => buildFlow(props.graph, props.insights, props.selectedNodeId), [props.graph, props.insights, props.selectedNodeId]);
  const isSingleNode = props.graph.nodes.length === 1;
  const hasFailurePath = props.insights.failurePathNodeIds.length > 0;
  return (
    <section className={cn('relative overflow-hidden rounded-xl border border-border bg-card', isSingleNode ? 'h-[420px]' : 'h-[560px]')}>
      <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-2">
        <GraphControlButton kind="fit" />
        {hasFailurePath ? <GraphControlButton kind="failure" /> : null}
        {isSingleNode ? (
          <span className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">No child agents</span>
        ) : null}
      </div>
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={{ agent: AgentRunNodeCard }}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_event, node) => props.onSelectNode(node.id)}
      >
        <Background gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
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
  const isFailurePath = insights.failurePathNodeIds.includes(node.taskId);
  const isDeepestFailure = insights.deepestFailedNodeId === node.id;
  const isSingleNode = graph.nodes.length === 1;
  return (
    <article
      className={cn(
        'rounded-lg border bg-card p-3 text-left shadow-sm transition-colors',
        isSingleNode ? 'w-[220px]' : 'w-[250px]',
        selected ? 'border-primary ring-2 ring-primary/30' : 'border-border',
        isFailurePath ? 'bg-rose-500/10' : '',
        isDeepestFailure ? 'border-rose-300 ring-2 ring-rose-400/30' : ''
      )}
      aria-label={`${node.agentId ?? 'unknown agent'} ${status.status}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{node.agentId ?? 'unknown agent'}</p>
          <CopyableId value={node.taskId} label="task ID" max={18} />
        </div>
        <StatusBadge status={status.status} derived={status.derived} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <Metric label="Turns" value={String(rollup.turns.length)} />
        <Metric label="LLM" value={String(rollup.llmCalls.length)} />
        <Metric label="Cost" value={formatCost(rollup.costUsd)} />
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Shrink className="h-3.5 w-3.5" />
        {node.parentTaskId ? 'Child agent' : 'Root agent'} · {node.startedAt ? formatDuration(durationBetween(node.startedAt, node.finishedAt)) : 'duration not captured'}
      </div>
    </article>
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

function buildFlow(graph: AgentRunGraph, insights: GraphInsights, selectedNodeId: string | undefined): {
  nodes: Node<AgentNodeData>[];
  edges: Edge[];
} {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 70, ranksep: 110 });
  for (const node of graph.nodes) {
    g.setNode(node.id, { width: graph.nodes.length === 1 ? 220 : 260, height: 148 });
  }
  for (const edge of graph.edges) {
    if (edge.childTaskId) g.setEdge(edge.parentTaskId, edge.childTaskId);
  }
  dagre.layout(g);
  const byTask = new Map(graph.nodes.map((node) => [node.taskId, node]));
  const nodes: Node<AgentNodeData>[] = graph.nodes.map((node) => {
    const layout = g.node(node.id) ?? g.node(node.taskId);
    const isSingleNode = graph.nodes.length === 1;
    return {
      id: node.id,
      type: 'agent',
      position: {
        x: isSingleNode ? 0 : typeof layout?.x === 'number' ? layout.x : 0,
        y: isSingleNode ? 0 : typeof layout?.y === 'number' ? layout.y : 0,
      },
      data: {
        node,
        graph,
        insights,
        selected: selectedNodeId === node.id || selectedNodeId === node.taskId,
      },
    };
  });
  const edges: Edge[] = graph.edges
    .filter((edge) => edge.childTaskId !== undefined && byTask.has(edge.parentTaskId) && byTask.has(edge.childTaskId))
    .map((edge) => {
      const highlighted = insights.failurePathEdgeIds.includes(edge.id);
      return {
        id: edge.id,
        source: byTask.get(edge.parentTaskId)?.id ?? edge.parentTaskId,
        target: byTask.get(edge.childTaskId ?? '')?.id ?? edge.childTaskId ?? edge.id,
        label: edge.edgeKind,
        animated: highlighted || edge.status === 'running',
        markerEnd: { type: MarkerType.ArrowClosed },
        className: highlighted ? 'stroke-rose-300' : '',
        style: highlighted ? { strokeWidth: 3, stroke: '#fda4af' } : undefined,
      };
    });
  return { nodes, edges };
}

function durationBetween(start: string, finish: string | undefined): number | undefined {
  const startDate = new Date(start);
  const finishDate = finish ? new Date(finish) : new Date();
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(finishDate.getTime())) return undefined;
  return finishDate.getTime() - startDate.getTime();
}
