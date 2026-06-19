import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ReactFlowProvider } from 'reactflow';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { useOperatorConfig, useRunGraph } from '../../api/hooks';
import { Button } from '../../design/components/ui/button';
import { CopyableId } from '../../design/components/ui/copyable';
import { Notice } from '../../design/components/ui/notice';
import { StatusBadge } from '../../design/components/ui/status-badge';
import { formatCost, formatDuration, formatRelative } from '../../design/format';
import { buildNodeRollup, deriveGraphInsights, deriveStatus, getNodeById } from '../../domain/derive';
import { AgentRunGraphView } from '../graph/AgentRunGraphView';
import { NodeInspector } from '../inspector/NodeInspector';
import type { TurnRun } from '../../types';
import { parseRunSearch } from '../../app/state';
import { cn } from '../../lib/utils';

export function RunDetailPage(): React.ReactElement {
  const params = useParams({ strict: false }) as { taskId?: string };
  const search = parseRunSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const navigate = useNavigate({ from: '/runs/$taskId' });
  const taskId = params.taskId;
  const graphQuery = useRunGraph(search.tenantId, taskId);
  const configQuery = useOperatorConfig();
  const graph = graphQuery.data;
  const insights = useMemo(() => deriveGraphInsights(graph), [graph]);
  const selectedNode = getNodeById(graph, search.nodeId || insights.selectedNodeId);
  const selectedTurnSeq = numberFromString(search.turn);
  const rootRollup = graph ? buildNodeRollup(graph, graph.root.taskId) : undefined;
  const rootStatus = deriveStatus({
    status: graph?.root.status,
    updatedAt: graph?.root.finishedAt ?? graph?.root.startedAt,
    turns: rootRollup?.turns,
  });

  const updateSearch = (patch: Partial<typeof search>) => {
    void navigate({
      search: { ...search, ...patch },
      params: { taskId: taskId ?? '' },
    });
  };

  return (
    <div className="grid min-h-0 gap-4">
      <header className="sticky top-[73px] z-10 rounded-xl border border-border bg-card/95 p-4 backdrop-blur">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Button asChild variant="ghost" size="sm">
                <Link to="/" search={search}>
                  <ArrowLeft className="h-4 w-4" />
                  Fleet
                </Link>
              </Button>
              <StatusBadge status={rootStatus.status} derived={rootStatus.derived} />
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">Tenant {search.tenantId}</span>
            </div>
            <h2 className="truncate text-2xl font-semibold">{graph?.root.agentId ?? 'Run Detail'}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                Root <CopyableId value={taskId} label="root task ID" />
              </span>
              <span className="inline-flex items-center gap-1.5">Started {formatRelative(graph?.root.startedAt)}</span>
              <span className="inline-flex items-center gap-1.5">Duration {formatDuration(durationBetween(graph?.root.startedAt, graph?.root.finishedAt))}</span>
              <span className="inline-flex items-center gap-1.5">Known cost {formatCost(rootRollup?.costUsd)}</span>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void graphQuery.refetch()}>
            <RefreshCw className={cn('h-4 w-4', graphQuery.isFetching ? 'animate-spin' : '')} />
            Refresh
          </Button>
        </div>
      </header>

      {graphQuery.error instanceof Error ? (
        <Notice kind="error" title="Run graph unavailable">
          Failed to load /tasks/{taskId}/run-graph: {graphQuery.error.message}
        </Notice>
      ) : null}

      <Notice kind={insights.hasPartialData ? 'partial' : rootStatus.status === 'failed' ? 'error' : 'info'} title="Investigation summary">
        {graphQuery.isLoading ? 'Loading run graph…' : insights.summary}
      </Notice>

      {graph ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(620px,1fr)_460px] xl:items-start">
          <ReactFlowProvider>
            <AgentRunGraphView
              graph={graph}
              insights={insights}
              selectedNodeId={selectedNode?.id}
              onSelectNode={(nodeId) => updateSearch({ nodeId, tab: search.tab || 'summary' })}
            />
          </ReactFlowProvider>
          <NodeInspector
            graph={graph}
            node={selectedNode}
            activeTab={search.tab}
            selectedTurnSeq={selectedTurnSeq}
            config={configQuery.data ?? {}}
            onTabChange={(tab) => updateSearch({ tab })}
            onTurnSelect={(turn: TurnRun) => updateSearch({ turn: String(turn.turnSeq ?? ''), tab: 'turns' })}
            onTurnBack={() => updateSearch({ turn: '', tab: 'turns' })}
          />
        </div>
      ) : (
        <div className="flex min-h-[520px] items-center justify-center rounded-xl border border-dashed border-border bg-card text-muted-foreground">
          {graphQuery.isLoading ? 'Loading execution graph…' : 'Graph data is unavailable.'}
        </div>
      )}
    </div>
  );
}

function numberFromString(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function durationBetween(start: string | undefined, finish: string | undefined): number | undefined {
  if (!start) return undefined;
  const startDate = new Date(start);
  const finishDate = finish ? new Date(finish) : new Date();
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(finishDate.getTime())) return undefined;
  return finishDate.getTime() - startDate.getTime();
}
