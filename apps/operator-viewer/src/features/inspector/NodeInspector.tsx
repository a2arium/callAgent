import { PanelRightClose, XCircle } from 'lucide-react';
import type { OperatorConfig } from '../../api/client';
import { Button } from '../../design/components/ui/button';
import { CopyableId } from '../../design/components/ui/copyable';
import { Notice } from '../../design/components/ui/notice';
import { StatusBadge } from '../../design/components/ui/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../design/components/ui/tabs';
import { formatCost, formatDuration, formatNumber, formatRelative } from '../../design/format';
import { buildNodeRollup, deriveStatus, normalizeRuntimeStatus } from '../../domain/derive';
import { semanticFailureFromTurns, type SemanticFailure } from '../../domain/semanticFailure';
import type { RunInspectorTab } from '../../app/state';
import { JsonPreview } from './JsonPreview';
import { LlmCallsTable } from '../llm/LlmCallsTable';
import { MemoryOpsTable } from '../memory/MemoryOpsTable';
import { TurnDetail, TurnTimeline } from '../turn/TurnTimeline';
import { HatchetRunLink } from '../hatchet/HatchetRunLink';
import type { AgentRunEvent, AgentRunGraph, AgentRunNode, EffectRun, TaskCoordinationView, TurnRun } from '../../types';

export function NodeInspector(props: {
  graph: AgentRunGraph;
  node: AgentRunNode | undefined;
  tenantId: string;
  activeTab: RunInspectorTab;
  selectedTurnSeq?: number;
  config: OperatorConfig;
  collapseButtonRef?: React.Ref<HTMLButtonElement>;
  canCancel?: boolean;
  cancelPending?: boolean;
  onTabChange: (tab: RunInspectorTab) => void;
  onTurnSelect: (turn: TurnRun) => void;
  onTurnBack: () => void;
  onCollapse?: () => void;
  onCancel?: () => void;
}): React.ReactElement {
  if (!props.node) {
    return (
      <aside className="min-w-0 overflow-hidden rounded-lg border border-border bg-card p-4 xl:h-full xl:max-h-[calc(100vh-250px)]">
        <Notice title="No node selected">Select an agent node in the graph to inspect details.</Notice>
      </aside>
    );
  }

  const rollup = buildNodeRollup(props.graph, props.node.taskId);
  const status = deriveStatus({ status: props.node.status, updatedAt: props.node.finishedAt ?? props.node.startedAt, turns: rollup.turns });
  const selectedTurn = props.selectedTurnSeq !== undefined
    ? rollup.turns.find((turn) => turn.turnSeq === props.selectedTurnSeq)
    : undefined;

  return (
    <aside className="flex min-w-0 overflow-hidden overflow-x-hidden rounded-lg border border-border bg-card xl:h-full xl:max-h-[calc(100vh-250px)] xl:flex-col">
      <div className="relative border-b border-border px-4 py-3 pr-12">
        {props.onCollapse ? (
          <Button
            ref={props.collapseButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            onClick={props.onCollapse}
            aria-label="Collapse inspector"
            title="Collapse inspector"
            className="absolute right-3 top-3 h-7 w-7 text-muted-foreground hover:text-foreground"
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        ) : null}
        <div className="grid min-w-0 gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Selected agent</p>
            <h3 className="mt-1 truncate text-lg font-semibold">{props.node.agentId ?? 'unknown agent'}</h3>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{props.node.parentTaskId ? 'Child agent' : 'Root agent'}</span>
              <span>Task</span>
              <CopyableId value={props.node.taskId} label="task ID" max={18} />
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <StatusBadge
              status={status.status}
              derived={status.derived}
              className={props.node.severity === 'error' && status.status === 'cancelled'
                ? 'border-danger-border bg-danger-bg text-danger'
                : undefined}
            />
            <div className="flex shrink-0 items-center gap-1.5">
              {props.node.providerRunId ? (
                <HatchetRunLink
                  providerRunId={props.node.providerRunId}
                  config={props.config}
                  label="Hatchet run"
                  ariaLabel="Open agent run in Hatchet"
                  className="h-7 px-2"
                />
              ) : null}
              {props.onCancel ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={props.onCancel}
                  disabled={!props.canCancel || props.cancelPending}
                  className="h-7 px-2 text-danger hover:bg-danger-bg hover:text-danger"
                  title={props.canCancel ? 'Cancel selected agent task' : 'Selected agent is already terminal'}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {props.cancelPending ? 'Canceling...' : 'Cancel'}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <Tabs value={props.activeTab || 'summary'} onValueChange={(tab) => props.onTabChange(tab as RunInspectorTab)} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-b border-border px-4 py-2">
          <TabsList className="h-8 w-full justify-start rounded-none bg-transparent p-0">
            <TabsTrigger value="summary" className="h-8 rounded-none border-b-2 border-transparent px-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Summary</TabsTrigger>
            <TabsTrigger value="turns" className="h-8 rounded-none border-b-2 border-transparent px-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Turns</TabsTrigger>
            <TabsTrigger value="tools" className="h-8 rounded-none border-b-2 border-transparent px-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Tools</TabsTrigger>
            <TabsTrigger value="llm" className="h-8 rounded-none border-b-2 border-transparent px-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">LLM</TabsTrigger>
            <TabsTrigger value="memory" className="h-8 rounded-none border-b-2 border-transparent px-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Memory</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="summary" className="m-0 min-h-0 overflow-y-auto overflow-x-hidden p-4">
          <SummaryTab graph={props.graph} node={props.node} rollup={rollup} status={status.status} tenantId={props.tenantId} config={props.config} />
        </TabsContent>
        <TabsContent value="turns" className="m-0 min-h-0 overflow-y-auto overflow-x-hidden p-0">
          {selectedTurn ? (
            <TurnDetail
              turn={selectedTurn}
              agentId={props.node.agentId ?? props.node.taskId}
              events={eventsForTurn(props.graph, props.node, selectedTurn)}
              tenantId={props.tenantId}
              config={props.config}
              ownerStatus={props.node.status}
              onBack={props.onTurnBack}
            />
          ) : (
            <TurnTimeline
              turns={rollup.turns}
              unassignedAttempts={props.graph.unassignedAttempts.filter((attempt) => attempt.taskId === props.node?.taskId)}
              tenantId={props.tenantId}
              ownerStatus={props.node.status}
              onSelect={props.onTurnSelect}
            />
          )}
        </TabsContent>
        <TabsContent value="tools" className="m-0 min-h-0 overflow-y-auto overflow-x-hidden p-4">
          <ToolsTab rows={toolRowsForNode(props.graph, props.node)} tenantId={props.tenantId} />
        </TabsContent>
        <TabsContent value="llm" className="m-0 min-h-0 overflow-y-auto overflow-x-hidden p-4">
          <LlmCallsTable calls={rollup.llmCalls} />
        </TabsContent>
        <TabsContent value="memory" className="m-0 min-h-0 overflow-y-auto overflow-x-hidden p-4">
          <MemoryOpsTable operations={rollup.memoryOps} tenantId={props.tenantId} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function SummaryTab(props: {
  graph: AgentRunGraph;
  node: AgentRunNode;
  rollup: ReturnType<typeof buildNodeRollup>;
  status: ReturnType<typeof deriveStatus>['status'];
  tenantId: string;
  config: OperatorConfig;
}): React.ReactElement {
  const children = props.graph.nodes.filter((node) => node.parentTaskId === props.node.taskId).length;
  const outboxRows = outboxRowsForNode(props.graph, props.node);
  const semanticFailure = semanticFailureFromTurns(props.rollup.turns);
  const runtimeError = runtimeErrorForNode(props.graph, props.node, props.rollup.turns);
  return (
    <div className="grid gap-4">
      <InspectorSection title="At a glance">
        {props.node.executionOrigin === 'cache' ? <CacheOriginNotice /> : null}
        {semanticFailure ? <SemanticFailureNotice failure={semanticFailure} /> : null}
        {runtimeError ? <RuntimeErrorNotice error={runtimeError} /> : null}
        {props.node.cancellation ? <CancellationNotice cancellation={props.node.cancellation} /> : null}
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Metric label="Duration" value={formatDuration(durationBetween(props.node.startedAt, props.node.finishedAt))} />
          <Metric label="Turns" value={formatNumber(props.rollup.turns.reduce((count, turn) => count + (turn.cognitiveTurns?.filter((item) => item.disposition !== 'superseded').length ?? 0), 0))} />
          <Metric label="Segments" value={formatNumber(props.rollup.turns.length)} />
          <Metric label="LLM calls" value={formatNumber(props.rollup.llmCalls.length)} />
          <Metric label="Memory ops" value={formatNumber(props.rollup.memoryOps.length)} />
        </div>
        <FactRow label="Status"><StatusBadge status={props.status} /></FactRow>
        <FactRow label="Cost">{typeof props.rollup.costUsd === 'number' ? formatCost(props.rollup.costUsd) : 'Not captured'}</FactRow>
      </InspectorSection>

      {props.node.taskId === props.graph.taskId ? (
        <CoordinationCard coordination={props.graph.coordination} />
      ) : null}

      <InspectorSection title="Execution context">
        <FactRow label="Parent">{props.node.parentTaskId ? <CopyableId value={props.node.parentTaskId} label="parent task ID" /> : 'Root agent'}</FactRow>
        <FactRow label="Children">{formatNumber(children)}</FactRow>
        <FactRow label="Started">{formatRelative(props.node.startedAt)}</FactRow>
      </InspectorSection>

      <InspectorSection title="Task input">
        <JsonPreview
          value={props.node.inputPreview}
          tenantId={props.tenantId}
          summaryFields={['taskId', 'traceparent', 'agentId', 'kind', 'url']}
          emptyLabel="Input preview was not captured."
          maxPreviewRows={5}
        />
      </InspectorSection>

      <InspectorSection title="Final output">
        <FinalOutputPreview graph={props.graph} node={props.node} tenantId={props.tenantId} />
      </InspectorSection>

      <InspectorSection title="Outbox">
        <OutboxTable rows={outboxRows} tenantId={props.tenantId} config={props.config} />
      </InspectorSection>

      <details className="rounded-lg border border-border bg-background/50">
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Technical details</summary>
        <div className="grid gap-2 border-t border-border p-3">
          <FactRow label="Task ID"><CopyableId value={props.node.taskId} label="task ID" /></FactRow>
          <FactRow label="Root task ID"><CopyableId value={props.node.rootTaskId} label="root task ID" /></FactRow>
          {props.node.agentId ? <FactRow label="Agent ID"><CopyableId value={props.node.agentId} label="agent ID" /></FactRow> : null}
          {props.node.traceId ? <FactRow label="Trace ID"><CopyableId value={props.node.traceId} label="trace ID" /></FactRow> : null}
          {props.node.providerRunId ? <FactRow label="Provider run"><CopyableId value={props.node.providerRunId} label="provider run ID" /></FactRow> : null}
          <FactRow label="Input preview">{props.node.inputPreview === undefined ? 'Not captured' : 'Available'}</FactRow>
          <FactRow label="Output preview">{props.node.outputPreview === undefined ? 'Not captured' : 'Available'}</FactRow>
          <FactRow label="Trace data">{props.node.traceId ? 'Available' : 'Not captured'}</FactRow>
          <FactRow label="Provider data">{props.node.providerRunId ? 'Available' : props.node.executionOrigin === 'cache' ? 'Not created for cache hit' : 'Not captured'}</FactRow>
        </div>
      </details>
    </div>
  );
}

function CoordinationCard(props: { coordination: TaskCoordinationView }): React.ReactElement {
  const value = props.coordination;
  const active = value.active;
  const issueText = value.issues.length > 0
    ? value.issues.map((issue) => issue.replace(/_/g, ' ')).join(', ')
    : 'None';
  return (
    <InspectorSection title="Coordination">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <Metric label="State" value={value.state} />
        <Metric label="Health" value={value.health} />
        <Metric label="Requested" value={value.requestedGeneration} />
        <Metric label="Completed" value={value.completedGeneration} />
      </div>
      <FactRow label="Phase">{active?.phase ?? 'No active owner'}</FactRow>
      <FactRow label="Lease">{active ? `${active.leaseState} · expires ${formatRelative(active.expiresAt)}` : 'Not owned'}</FactRow>
      <FactRow label="Heartbeat">{active ? formatRelative(active.heartbeatAt) : 'Not applicable'}</FactRow>
      <FactRow label="Dispatch">{value.dispatchIntent ? `${value.dispatchIntent.state} · generation ${value.dispatchIntent.generation}` : 'None'}</FactRow>
      <FactRow label="Issues">{issueText}</FactRow>
      {active ? (
        <>
          <FactRow label="Claim"><CopyableId value={active.claimId} label="claim ID" /></FactRow>
          <FactRow label="Fence"><CopyableId value={active.fence} label="turn fence" /></FactRow>
          <FactRow label="Owner"><CopyableId value={active.ownerId} label="owner ID" /></FactRow>
        </>
      ) : null}
    </InspectorSection>
  );
}

function CacheOriginNotice(): React.ReactElement {
  return (
    <div className="rounded-md border border-info-border bg-info-bg px-3 py-2 text-sm text-info">
      <p className="font-medium">Served from cache</p>
      <p className="mt-1 text-xs opacity-90">
        This child returned from the previous run result cache, so no Hatchet provider run or turn trace was created for it.
      </p>
    </div>
  );
}

function FinalOutputPreview(props: { graph: AgentRunGraph; node: AgentRunNode; tenantId: string }): React.ReactElement {
  if (props.node.outputPreview !== undefined && props.node.outputPreview !== null) {
    return (
      <JsonPreview
        value={props.node.outputPreview}
        tenantId={props.tenantId}
        summaryFields={['kind', 'status', 'statusCode', 'url', 'savedPath', 'html', 'content', 'error']}
        emptyLabel="Final output not captured."
        maxPreviewRows={6}
      />
    );
  }

  const transitionEvent = [...props.graph.events]
    .reverse()
    .find((event) => eventBelongsToNode(event, props.node) && isRecord(eventPayloadValue(event).transition));
  const completedEvent = [...props.graph.events]
    .reverse()
    .find((event) => eventBelongsToNode(event, props.node) && event.type === 'task.completed' && Array.isArray(eventPayloadValue(event).artifacts));
  const effect = props.graph.effects.find((candidate) => effectBelongsToNode(candidate, props.node));

  if (transitionEvent) {
    return (
      <div className="grid gap-2">
        <Notice title="Final output available only in transition event">
          Final output was not captured as a task.completed preview. Output-like data is available in Transition / execution events.
        </Notice>
        <JsonPreview value={eventPayloadValue(transitionEvent).transition} tenantId={props.tenantId} summaryFields={['kind', 'result', 'status', 'error']} maxPreviewRows={5} />
      </div>
    );
  }

  if (completedEvent) {
    return (
      <div className="grid gap-2">
        <Notice title="Final output available as artifact metadata">
          Final output was not captured as a task.completed preview. Artifact metadata is available below.
        </Notice>
        <JsonPreview value={eventPayloadValue(completedEvent)} tenantId={props.tenantId} summaryFields={['taskId', 'artifactsCount', 'artifacts', 'traceparent']} maxPreviewRows={5} />
      </div>
    );
  }

  if (effect) {
    return (
      <div className="grid gap-2">
        <Notice title="Final output available as effect metadata">
          Final output was not captured as a task.completed preview. Effect metadata is available below.
        </Notice>
        <JsonPreview value={effect} tenantId={props.tenantId} summaryFields={['operation', 'status', 'token', 'outboxRowId', 'providerRunId']} maxPreviewRows={5} />
      </div>
    );
  }

  return <Notice title="Final output not captured" className="bg-background/50" />;
}

function InspectorSection(props: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="grid min-w-0 gap-2">
      <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{props.title}</h4>
      <div className="grid min-w-0 gap-2">{props.children}</div>
    </section>
  );
}

function FactRow(props: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="grid min-w-0 grid-cols-[112px_minmax(0,1fr)] items-start gap-3 rounded-md border border-border bg-background/50 px-3 py-2 text-sm">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <div className="min-w-0 break-words [overflow-wrap:anywhere]">{props.children}</div>
    </div>
  );
}

type RuntimeErrorSummary = {
  name?: string;
  message: string;
  source?: string;
  raw?: unknown;
};

function runtimeErrorForNode(graph: AgentRunGraph, node: AgentRunNode, turns: TurnRun[]): RuntimeErrorSummary | undefined {
  const direct = summarizeRuntimeError(node.error, 'agent.run');
  if (direct) return direct;

  const failedTurn = turns.find((turn) => turn.status === 'failed' && turn.error !== undefined);
  const turnError = summarizeRuntimeError(failedTurn?.error, failedTurn?.turnSeq ? `turn ${failedTurn.turnSeq}` : 'turn.segment');
  if (turnError) return turnError;

  const failedEffect = graph.effects.find((effect) => effect.taskId === node.taskId && effect.status === 'failed' && effect.error !== undefined);
  const effectError = summarizeRuntimeError(failedEffect?.error, failedEffect?.operation);
  if (effectError) return effectError;

  const driverRun = graph.debug.driverRuns
    .filter((run) => run.taskId === node.taskId || run.rootTaskId === node.taskId)
    .find((run) => run.status === 'failed' && run.error !== undefined);
  return summarizeRuntimeError(driverRun?.error, driverRun?.operation);
}

function summarizeRuntimeError(error: unknown, source?: string): RuntimeErrorSummary | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'string') return { message: error, source, raw: error };
  if (typeof error !== 'object' || Array.isArray(error)) return { message: String(error), source, raw: error };

  const record = error as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : undefined;
  const message =
    typeof record.message === 'string'
      ? record.message
      : typeof record.code === 'string'
        ? record.code
        : 'Runtime task failed.';
  return { ...(name ? { name } : {}), message, source, raw: error };
}

function Metric(props: { label: string; value: string }): React.ReactElement {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background/50 px-3 py-2">
      <p className="text-xs text-muted-foreground">{props.label}</p>
      <p className="mt-0.5 truncate font-medium">{props.value}</p>
    </div>
  );
}

function SemanticFailureNotice(props: { failure: SemanticFailure }): React.ReactElement {
  return (
    <Notice kind="error" title="Semantic failure">
      <div className="grid gap-1">
        {props.failure.code ? (
          <div>
            <span className="font-medium">Code:</span> <span className="font-mono">{props.failure.code}</span>
          </div>
        ) : null}
        <div>
          <span className="font-medium">Message:</span> {props.failure.message}
        </div>
      </div>
    </Notice>
  );
}

function CancellationNotice(props: { cancellation: NonNullable<AgentRunNode['cancellation']> }): React.ReactElement {
  return (
    <Notice kind="warning" title="Cancellation requested">
      <div className="grid gap-1">
        <div>
          <span className="font-medium">Reason:</span> {props.cancellation.reason ?? 'Not captured'}
        </div>
        <div>
          <span className="font-medium">Requested:</span> {props.cancellation.requestedAt ? formatRelative(props.cancellation.requestedAt) : 'Time not captured'}
        </div>
      </div>
    </Notice>
  );
}

function RuntimeErrorNotice(props: { error: RuntimeErrorSummary }): React.ReactElement {
  return (
    <Notice kind="error" title="Runtime error">
      <div className="grid gap-2">
        <div className="grid gap-1">
          {props.error.name ? (
            <div>
              <span className="font-medium">Type:</span> <span className="font-mono">{props.error.name}</span>
            </div>
          ) : null}
          <div>
            <span className="font-medium">Message:</span> {props.error.message}
          </div>
          {props.error.source ? (
            <div className="text-xs text-muted-foreground">Source: {props.error.source}</div>
          ) : null}
        </div>
        {props.error.raw ? (
          <JsonPreview value={props.error.raw} title="Runtime error details" summaryFields={['name', 'message', 'code']} maxPreviewRows={3} maxRawHeight={180} />
        ) : null}
      </div>
    </Notice>
  );
}

function OutboxTable(props: { rows: Array<OutboxRow>; tenantId: string; config: OperatorConfig }): React.ReactElement {
  if (props.rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No execution events or effects captured for this agent.</p>;
  }
  return (
    <div className="grid gap-2">
      {props.rows.map((row) => (
        <article key={row.id} className="grid min-w-0 gap-2 rounded-lg border border-border bg-background/50 p-3">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="break-words text-sm font-medium [overflow-wrap:anywhere]">{row.kind}</span>
                {row.turn !== undefined ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Turn {row.turn}</span> : null}
              </div>
              <p className="mt-1 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{row.preview}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {row.status ? <StatusBadge status={normalizeRuntimeStatus(row.status)} /> : null}
              {row.providerRunId ? (
                <HatchetRunLink
                  providerRunId={row.providerRunId}
                  config={props.config}
                  label="Hatchet run"
                  ariaLabel={`Open ${row.kind} in Hatchet`}
                  className="h-7 px-2"
                />
              ) : null}
            </div>
          </div>
          <details className="min-w-0">
            <summary className="cursor-pointer text-xs font-medium text-foreground">Show details</summary>
            <div className="mt-2">
              <JsonPreview value={row.payload} tenantId={props.tenantId} maxPreviewRows={4} maxRawHeight={220} />
            </div>
          </details>
        </article>
      ))}
    </div>
  );
}

type OutboxRow = {
  id: string;
  turn?: number;
  kind: string;
  status?: string;
  preview: string;
  payload: unknown;
  providerRunId?: string;
};

type ToolRow = {
  token: string;
  toolName: string;
  provider: 'mcp' | 'tool';
  server?: string;
  tool?: string;
  status: 'requested' | 'completed' | 'failed';
  requestedAt?: string;
  completedAt?: string;
  argsPreview?: unknown;
  resultPreview?: unknown;
  requestedPayload?: unknown;
  completedPayload?: unknown;
};

function ToolsTab(props: { rows: ToolRow[]; tenantId: string }): React.ReactElement {
  if (props.rows.length === 0) {
    return <Notice title="No tool calls captured" className="bg-background/50">This agent did not record MCP/tool calls, or the run predates tool event projection.</Notice>;
  }
  return (
    <div className="grid gap-3">
      {props.rows.map((row) => (
        <article key={`${row.token}-${row.toolName}`} className="grid min-w-0 gap-3 rounded-lg border border-border bg-background/50 p-3">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="rounded-full border border-info-border bg-info-bg px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-info">
                  {row.provider === 'mcp' ? 'MCP' : 'Tool'}
                </span>
                <span className="break-words font-mono text-sm font-semibold [overflow-wrap:anywhere]">{row.toolName}</span>
              </div>
              {row.provider === 'mcp' ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Server <span className="font-mono text-foreground">{row.server ?? 'unknown'}</span>
                  {' · '}
                  Tool <span className="font-mono text-foreground">{row.tool ?? 'unknown'}</span>
                </p>
              ) : null}
              <p className="mt-1 text-xs text-muted-foreground">Token <CopyableId value={row.token} label="tool token" max={24} /></p>
            </div>
            <StatusBadge status={row.status === 'requested' ? 'running' : row.status} />
          </div>

          <div className="grid gap-2 text-sm">
            <FactRow label="Requested">{row.requestedAt ? formatRelative(row.requestedAt) : 'Not captured'}</FactRow>
            <FactRow label="Completed">{row.completedAt ? formatRelative(row.completedAt) : row.status === 'requested' ? 'Pending' : 'Not captured'}</FactRow>
          </div>

          <details className="min-w-0 rounded-md border border-border bg-card/60">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Input params</summary>
            <div className="border-t border-border p-3">
              <JsonPreview value={row.argsPreview} tenantId={props.tenantId} emptyLabel="Tool input params were not captured." maxPreviewRows={6} maxRawHeight={260} />
            </div>
          </details>

          <details className="min-w-0 rounded-md border border-border bg-card/60">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Output</summary>
            <div className="border-t border-border p-3">
              <JsonPreview value={row.resultPreview} tenantId={props.tenantId} emptyLabel={row.status === 'requested' ? 'Tool output is not available yet.' : 'Tool output was not captured.'} maxPreviewRows={6} maxRawHeight={300} />
            </div>
          </details>

          <details className="min-w-0">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Raw tool events</summary>
            <div className="mt-2 grid gap-2">
              {row.requestedPayload !== undefined ? <JsonPreview value={row.requestedPayload} tenantId={props.tenantId} title="Requested event" maxPreviewRows={4} maxRawHeight={180} /> : null}
              {row.completedPayload !== undefined ? <JsonPreview value={row.completedPayload} tenantId={props.tenantId} title="Completed event" maxPreviewRows={4} maxRawHeight={180} /> : null}
            </div>
          </details>
        </article>
      ))}
    </div>
  );
}

function toolRowsForNode(graph: AgentRunGraph, node: AgentRunNode): ToolRow[] {
  const rows = new Map<string, ToolRow>();
  const events = graph.events
    .filter((event) => eventBelongsToNode(event, node))
    .filter((event) => event.type === 'task.tool_requested' || event.type === 'task.tool_completed')
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.seq - right.seq);

  for (const event of events) {
    const payload = eventPayloadValue(event);
    const token = stringField(payload, 'token') ?? event.group.token;
    const toolName = stringField(payload, 'toolName') ?? stringField(payload, 'tool');
    if (!token || !toolName) continue;
    const existing = rows.get(token) ?? {
      token,
      toolName,
      ...toolDisplayParts(toolName),
      status: 'requested' as const,
    };
    if (event.type === 'task.tool_requested') {
      rows.set(token, {
        ...existing,
        requestedAt: event.timestamp,
        argsPreview: payload.argsPreview,
        requestedPayload: payload,
      });
    } else {
      rows.set(token, {
        ...existing,
        status: toolEventFailed(payload) ? 'failed' : 'completed',
        completedAt: event.timestamp,
        resultPreview: payload.resultPreview,
        completedPayload: payload,
      });
    }
  }
  return [...rows.values()];
}

function toolDisplayParts(toolName: string): Pick<ToolRow, 'provider' | 'server' | 'tool'> {
  if (!toolName.startsWith('mcp:')) return { provider: 'tool' };
  const parts = toolName.slice(4).split('.');
  return {
    provider: 'mcp',
    server: parts[0],
    tool: parts.slice(1).join('.') || undefined,
  };
}

function toolEventFailed(payload: Record<string, unknown>): boolean {
  if (payload.status === 'failed') return true;
  const result = recordField(payload, 'resultPreview');
  return result?.error === true || typeof result?.message === 'string' && result.error === true;
}

function outboxRowsForNode(graph: AgentRunGraph, node: AgentRunNode): OutboxRow[] {
  const events = graph.events
    .filter((event) => eventBelongsToNode(event, node))
    .filter((event) => event.type.startsWith('task.') || event.type === 'turn.completed')
    .map((event): OutboxRow => {
      const payload = eventPayloadValue(event);
      return {
        id: event.id,
        turn: numberField(payload, 'turnSeq'),
        kind: event.type,
        status: stringField(payload, 'status'),
        preview: eventPreview(event),
        payload,
        providerRunId: stringField(payload, 'providerRunId'),
      };
    });
  const effects = graph.effects
    .filter((effect) => effectBelongsToNode(effect, node))
    .map((effect): OutboxRow => ({
      id: effect.id,
      kind: effect.operation,
      status: effect.status,
      preview: effect.token ?? effect.outboxRowId ?? effect.providerRunId ?? 'Effect captured',
      payload: effect,
      providerRunId: effect.providerRunId,
    }));
  return [...events, ...effects].slice(0, 12);
}

function eventBelongsToNode(event: AgentRunEvent, node: AgentRunNode): boolean {
  const payload = eventPayloadValue(event);
  const payloadTaskId = stringField(payload, 'taskId');
  const payloadAgentId = stringField(payload, 'agentId') ?? stringField(payload, 'childAgentId');
  const childTaskId = stringField(payload, 'childTaskId');
  return event.taskId === node.taskId ||
    event.group.taskId === node.taskId ||
    payloadTaskId === node.taskId ||
    childTaskId === node.taskId ||
    payloadAgentId === node.agentId ||
    event.group.agentId === node.agentId;
}

function eventsForTurn(graph: AgentRunGraph, node: AgentRunNode, turn: TurnRun): AgentRunEvent[] {
  return graph.events
    .filter((event) => eventBelongsToNode(event, node))
    .filter((event) => {
      const payloadTurnSeq = numberField(eventPayloadValue(event), 'turnSeq');
      if (turn.turnSeq !== undefined && payloadTurnSeq === turn.turnSeq) return true;
      const turnId = turn.cognition?.turnId ?? turn.turnTraceRef?.turnTraceId;
      return Boolean(turnId && event.group.turnId === turnId);
    });
}

function effectBelongsToNode(effect: EffectRun, node: AgentRunNode): boolean {
  return effect.taskId === node.taskId || effect.agentId === node.agentId;
}

function eventPreview(event: AgentRunEvent): string {
  const payload = eventPayloadValue(event);
  if (event.type === 'task.tool_requested') {
    const toolName = stringField(payload, 'toolName') ?? 'tool';
    return `Requested ${toolName}`;
  }
  if (event.type === 'task.tool_completed') {
    const toolName = stringField(payload, 'toolName') ?? stringField(payload, 'tool') ?? 'tool';
    return `${toolEventFailed(payload) ? 'Failed' : 'Completed'} ${toolName}`;
  }
  const status = stringField(payload, 'status');
  const kind = stringField(payload, 'kind');
  const token = stringField(payload, 'token');
  const transition = recordField(payload, 'transition');
  const transitionKind = stringField(transition, 'kind');
  return [status, kind, transitionKind, token].filter(Boolean).join(' · ') || semanticSummary(payload);
}

function eventPayloadValue(event: AgentRunEvent): Record<string, unknown> {
  const envelope = recordField(event.payload, 'envelope');
  if (envelope?.state === 'available') {
    const value = envelope.value;
    if (isRecord(value)) return value;
  }
  return event.payload;
}

function semanticSummary(value: unknown): string {
  if (!isRecord(value)) return truncate(String(value), 220);
  const ok = recordField(value, 'result')?.ok;
  if (ok === false) return 'Completed with semantic failure.';
  if (ok === true) return 'Completed successfully.';
  const status = stringField(value, 'status');
  const kind = stringField(value, 'kind');
  const statusCode = numberField(value, 'statusCode');
  if (statusCode !== undefined) return `HTTP status ${statusCode}.`;
  if (status || kind) return [kind, status].filter(Boolean).join(' · ');
  return `Object with ${Object.keys(value).length} fields`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function durationBetween(start: string | undefined, finish: string | undefined): number | undefined {
  if (!start) return undefined;
  const startDate = new Date(start);
  const finishDate = finish ? new Date(finish) : new Date();
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(finishDate.getTime())) return undefined;
  return finishDate.getTime() - startDate.getTime();
}
