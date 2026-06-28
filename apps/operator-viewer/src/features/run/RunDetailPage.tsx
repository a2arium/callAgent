import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ReactFlowProvider } from 'reactflow';
import { ArrowLeft, PanelRightOpen, Play, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCancelRun, useOperatorConfig, useRunGraph } from '../../api/hooks';
import { runAgent } from '../../api/client';
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

const INSPECTOR_WIDTH_KEY = 'operator.runDetail.inspectorWidth';
const INSPECTOR_COLLAPSED_KEY = 'operator.runDetail.inspectorCollapsed';
const INSPECTOR_DEFAULT_WIDTH = 460;
const INSPECTOR_MIN_WIDTH = 340;
const INSPECTOR_MAX_WIDTH = 680;
const INSPECTOR_RAIL_WIDTH = 44;
const SPLITTER_WIDTH = 10;

export function RunDetailPage(): React.ReactElement {
  const params = useParams({ strict: false }) as { taskId?: string };
  const search = parseRunSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const navigate = useNavigate({ from: '/runs/$taskId' });
  const taskId = params.taskId;
  const graphQuery = useRunGraph(search.tenantId, taskId);
  const configQuery = useOperatorConfig();
  const cancelRun = useCancelRun();
  const [launchState, setLaunchState] = useState<{ state: 'idle' } | { state: 'running' } | { state: 'error'; message: string }>({ state: 'idle' });
  const [inspectorCollapsed, setInspectorCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(INSPECTOR_COLLAPSED_KEY) === 'true';
  });
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    if (typeof window === 'undefined') return INSPECTOR_DEFAULT_WIDTH;
    const stored = Number(window.localStorage.getItem(INSPECTOR_WIDTH_KEY));
    return clampInspectorWidth(Number.isFinite(stored) ? stored : INSPECTOR_DEFAULT_WIDTH);
  });
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);
  const collapseButtonRef = useRef<HTMLButtonElement | null>(null);
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
  const liveRefresh = graph === undefined || graph.nodes.some((node) => ['queued', 'running', 'unknown'].includes(node.status));
  const rootCancelable = taskId !== undefined && graph !== undefined && !isTerminalStatus(graph.root.status);
  const cancelDisabled = !rootCancelable || cancelRun.isPending;
  const selectedNodeCancelable = selectedNode !== undefined && !isTerminalStatus(selectedNode.status);
  const replayPayload = graph ? replayPayloadFromInputPreview(graph.root.inputPreview) : undefined;
  const canRunNewInstance = graph?.root.agentId !== undefined && isTerminalStatus(graph.root.status) && replayPayload !== undefined;

  const updateSearch = (patch: Partial<typeof search>) => {
    void navigate({
      search: { ...search, ...patch },
      params: { taskId: taskId ?? '' },
    });
  };

  const setInspectorOpen = (open: boolean) => {
    const collapsed = !open;
    setInspectorCollapsed(collapsed);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(INSPECTOR_COLLAPSED_KEY, String(collapsed));
    }
  };

  const updateInspectorWidth = (nextWidth: number) => {
    const width = clampInspectorWidth(nextWidth);
    setInspectorWidth(width);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(width));
    }
  };

  useEffect(() => {
    window.requestAnimationFrame(() => {
      if (inspectorCollapsed) {
        expandButtonRef.current?.focus();
      } else {
        collapseButtonRef.current?.focus();
      }
    });
  }, [inspectorCollapsed]);

  const selectNode = (nodeId: string) => {
    setInspectorOpen(true);
    updateSearch({ nodeId, tab: search.tab || 'summary' });
  };

  const selectTurn = (turn: TurnRun) => {
    setInspectorOpen(true);
    updateSearch({
      nodeId: turn.taskId,
      turn: String(turn.turnSeq ?? ''),
      tab: 'turns',
    });
  };

  const cancelRootRun = () => {
    if (!taskId || !graph || isTerminalStatus(graph.root.status)) return;
    const defaultReason = 'operator cancel';
    const reason = window.prompt(
      `Cancel root run ${taskId}?\n\nActive provider runs will be canceled best-effort and the runtime will stop at the next cancellation check.`,
      defaultReason
    );
    if (reason === null) return;
    const trimmedReason = reason.trim() || defaultReason;
    cancelRun.mutate({
      tenantId: search.tenantId,
      taskId,
      ...(graph.root.agentId ? { agentId: graph.root.agentId } : {}),
      reason: trimmedReason,
    });
  };

  const cancelSelectedNode = () => {
    if (!graph || !selectedNode || isTerminalStatus(selectedNode.status)) return;
    const defaultReason = 'operator cancel';
    const label = selectedNode.parentTaskId ? 'child agent' : 'root agent';
    const reason = window.prompt(
      `Cancel ${label} ${selectedNode.taskId}?\n\nActive provider runs for this agent task will be canceled best-effort and the runtime will stop at the next cancellation check.`,
      defaultReason
    );
    if (reason === null) return;
    const trimmedReason = reason.trim() || defaultReason;
    cancelRun.mutate({
      tenantId: search.tenantId,
      taskId: selectedNode.taskId,
      rootTaskId: graph.root.taskId,
      ...(selectedNode.agentId ? { agentId: selectedNode.agentId } : {}),
      reason: trimmedReason,
    });
  };

  const runNewInstance = async () => {
    if (!graph?.root.agentId || !replayPayload) return;
    setLaunchState({ state: 'running' });
    try {
      const response = await runAgent({
        tenantId: search.tenantId,
        agentId: graph.root.agentId,
        payload: replayPayload,
      });
      if (response.error) {
        setLaunchState({ state: 'error', message: response.error.message });
        return;
      }
      const nextTaskId = response.result?.id;
      if (!nextTaskId) {
        setLaunchState({ state: 'error', message: 'Runtime accepted the request but did not return a task id.' });
        return;
      }
      setLaunchState({ state: 'idle' });
      await navigate({
        to: '/runs/$taskId',
        params: { taskId: nextTaskId },
        search: {
          ...search,
          taskId: '',
          nodeId: '',
          turn: '',
          tab: 'summary',
        },
      });
    } catch (error) {
      setLaunchState({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
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
              {liveRefresh ? (
                <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                  Live
                </span>
              ) : null}
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
              {graph?.projection ? (
                <span className="inline-flex items-center gap-1.5">
                  Projection {graph.projection.source}
                  {graph.projection.lagMs !== undefined ? ` · ${graph.projection.lagMs}ms lag` : ''}
                  {graph.projection.partial ? ' · partial' : ''}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canRunNewInstance ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runNewInstance()}
                disabled={launchState.state === 'running'}
                title="Run a new task with the same captured input params"
              >
                <Play className="h-4 w-4" />
                {launchState.state === 'running' ? 'Starting...' : 'Run new instance'}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => void graphQuery.refetch()}>
              <RefreshCw className={cn('h-4 w-4', graphQuery.isFetching ? 'animate-spin' : '')} />
              Refresh
            </Button>
            {rootCancelable ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={cancelRootRun}
                disabled={cancelDisabled}
                className="text-danger hover:bg-danger-bg hover:text-danger"
                title="Cancel root run"
              >
                <XCircle className="h-4 w-4" />
                {cancelRun.isPending ? 'Canceling...' : 'Cancel run'}
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {cancelRun.error instanceof Error ? (
        <Notice kind="error" title="Cancel failed">
          {cancelRun.error.message}
        </Notice>
      ) : null}

      {launchState.state === 'error' ? (
        <Notice kind="error" title="Could not start new instance">
          {launchState.message}
        </Notice>
      ) : null}

      {graphQuery.error instanceof Error ? (
        <Notice kind="error" title="Run graph unavailable">
          Failed to load /tasks/{taskId}/run-graph: {graphQuery.error.message}
        </Notice>
      ) : null}

      {graph?.caps?.truncated ? (
        <Notice title="Graph is capped">
          Showing {graph.nodes.length} nodes and {graph.edges.length} edges. {graph.collapsedBranches?.length ?? 0} branch groups are collapsed by the operator read model.
        </Notice>
      ) : null}

      {graph ? (
        <div
          className="grid min-h-[520px] grid-cols-1 gap-y-3 xl:min-h-[calc(100vh-250px)] xl:grid-cols-[minmax(620px,1fr)_var(--splitter-width)_var(--inspector-width)] xl:items-stretch xl:gap-y-0"
          style={{
            '--splitter-width': `${SPLITTER_WIDTH}px`,
            '--inspector-width': `${inspectorCollapsed ? INSPECTOR_RAIL_WIDTH : inspectorWidth}px`,
          } as React.CSSProperties}
        >
          <ReactFlowProvider>
            <AgentRunGraphView
              graph={graph}
              insights={insights}
              layoutKey={inspectorCollapsed ? 'inspector-collapsed' : `inspector-${inspectorWidth}`}
              selectedNodeId={selectedNode?.id}
              selectedTurnSeq={selectedTurnSeq}
              onSelectNode={selectNode}
              onSelectTurn={selectTurn}
            />
          </ReactFlowProvider>
          <InspectorSplitter
            collapsed={inspectorCollapsed}
            width={inspectorWidth}
            onResize={updateInspectorWidth}
            onReset={() => updateInspectorWidth(INSPECTOR_DEFAULT_WIDTH)}
          />
          {inspectorCollapsed ? (
            <CollapsedInspectorRail buttonRef={expandButtonRef} onOpen={() => setInspectorOpen(true)} />
          ) : (
            <div className="min-w-0 overflow-hidden">
              <NodeInspector
                graph={graph}
                node={selectedNode}
                tenantId={search.tenantId}
                activeTab={search.tab}
                selectedTurnSeq={selectedTurnSeq}
                config={configQuery.data ?? {}}
                collapseButtonRef={collapseButtonRef}
                canCancel={selectedNodeCancelable}
                cancelPending={cancelRun.isPending}
                onTabChange={(tab) => updateSearch({ tab })}
                onTurnSelect={selectTurn}
                onTurnBack={() => updateSearch({ turn: '', tab: 'turns' })}
                onCollapse={() => setInspectorOpen(false)}
                onCancel={selectedNodeCancelable ? cancelSelectedNode : undefined}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-[520px] items-center justify-center rounded-xl border border-dashed border-border bg-card text-muted-foreground">
          {graphQuery.isLoading ? 'Loading execution graph…' : 'Graph data is unavailable.'}
        </div>
      )}
    </div>
  );
}

function isTerminalStatus(status: string | undefined): boolean {
  const normalized = status?.toLowerCase();
  return normalized === 'completed' || normalized === 'failed' || normalized === 'canceled' || normalized === 'cancelled';
}

function replayPayloadFromInputPreview(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const next = { ...value };
  delete next.id;
  delete next.agentId;
  delete next.tenantId;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function InspectorSplitter(props: {
  collapsed: boolean;
  width: number;
  onResize: (width: number) => void;
  onReset: () => void;
}): React.ReactElement {
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (props.collapsed || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = { startX: event.clientX, startWidth: props.width };
  };

  const continueDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    const delta = dragState.current.startX - event.clientX;
    props.onResize(dragState.current.startWidth + delta);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    dragState.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (props.collapsed) return;
    const step = event.shiftKey ? 40 : 16;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      props.onResize(props.width + step);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      props.onResize(props.width - step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      props.onResize(INSPECTOR_MIN_WIDTH);
    } else if (event.key === 'End') {
      event.preventDefault();
      props.onResize(INSPECTOR_MAX_WIDTH);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      props.onReset();
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize inspector panel"
      aria-valuemin={INSPECTOR_MIN_WIDTH}
      aria-valuemax={INSPECTOR_MAX_WIDTH}
      aria-valuenow={props.collapsed ? INSPECTOR_RAIL_WIDTH : props.width}
      tabIndex={props.collapsed ? -1 : 0}
      className={cn(
        'group hidden h-full cursor-col-resize items-stretch justify-center focus-visible:outline-none xl:flex',
        props.collapsed ? 'cursor-default' : ''
      )}
      onPointerDown={beginDrag}
      onPointerMove={continueDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        if (!props.collapsed) props.onReset();
      }}
      onKeyDown={onKeyDown}
      title={props.collapsed ? undefined : 'Drag to resize inspector. Double-click to reset.'}
    >
      <span
        className={cn(
          'my-0 w-px bg-border transition-colors group-hover:bg-primary/70 group-focus-visible:bg-primary',
          props.collapsed ? 'bg-border/70' : ''
        )}
      />
    </div>
  );
}

function CollapsedInspectorRail(props: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
}): React.ReactElement {
  return (
    <aside className="min-w-0">
      <button
        ref={props.buttonRef}
        type="button"
        className="group flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 text-muted-foreground shadow-sm transition-colors hover:border-primary/50 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:h-full xl:min-h-[calc(100vh-250px)] xl:w-11 xl:flex-col xl:justify-start xl:gap-3 xl:px-1.5 xl:py-3"
        onClick={props.onOpen}
        aria-label="Open inspector"
        title="Open inspector"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background/70">
          <PanelRightOpen className="h-4 w-4" />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] xl:[writing-mode:vertical-rl] xl:rotate-180">
          Inspector
        </span>
      </button>
    </aside>
  );
}

function clampInspectorWidth(width: number): number {
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, Math.round(width)));
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
