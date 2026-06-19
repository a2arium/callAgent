import { ExternalLink } from 'lucide-react';
import { hatchetRunUrl, opikTraceUrl, type OperatorConfig } from '../../api/client';
import { Button } from '../../design/components/ui/button';
import { CopyableId } from '../../design/components/ui/copyable';
import { Notice } from '../../design/components/ui/notice';
import { StatusBadge } from '../../design/components/ui/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../design/components/ui/tabs';
import { formatCost, formatDuration, formatNumber, formatRelative } from '../../design/format';
import { buildNodeRollup, deriveStatus, normalizeRuntimeStatus } from '../../domain/derive';
import { JsonPreview } from './JsonPreview';
import { LlmCallsTable } from '../llm/LlmCallsTable';
import { MemoryOpsTable } from '../memory/MemoryOpsTable';
import { TurnDetail, TurnTimeline } from '../turn/TurnTimeline';
import type { AgentRunEvent, AgentRunGraph, AgentRunNode, EffectRun, TurnRun } from '../../types';

export function NodeInspector(props: {
  graph: AgentRunGraph;
  node: AgentRunNode | undefined;
  activeTab: string;
  selectedTurnSeq?: number;
  config: OperatorConfig;
  onTabChange: (tab: string) => void;
  onTurnSelect: (turn: TurnRun) => void;
  onTurnBack: () => void;
}): React.ReactElement {
  if (!props.node) {
    return (
      <aside className="min-w-0 self-start overflow-hidden rounded-lg border border-border bg-card p-4 xl:max-h-[640px]">
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
    <aside className="flex min-w-0 self-start overflow-hidden overflow-x-hidden rounded-lg border border-border bg-card xl:max-h-[640px] xl:flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Selected agent</p>
            <h3 className="mt-1 truncate text-lg font-semibold">{props.node.agentId ?? 'unknown agent'}</h3>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{props.node.parentTaskId ? 'Child agent' : 'Root agent'}</span>
              <span>Task</span>
              <CopyableId value={props.node.taskId} label="task ID" max={18} />
            </div>
          </div>
          <StatusBadge status={status.status} derived={status.derived} />
        </div>
      </div>

      <Tabs value={props.activeTab || 'summary'} onValueChange={props.onTabChange} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-b border-border px-4 py-2">
          <TabsList className="h-8 w-full justify-start rounded-none bg-transparent p-0">
            <TabsTrigger value="summary" className="h-8 rounded-none border-b-2 border-transparent px-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Summary</TabsTrigger>
            <TabsTrigger value="turns" className="h-8 rounded-none border-b-2 border-transparent px-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Turns</TabsTrigger>
            <TabsTrigger value="llm" className="h-8 rounded-none border-b-2 border-transparent px-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">LLM</TabsTrigger>
            <TabsTrigger value="memory" className="h-8 rounded-none border-b-2 border-transparent px-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Memory</TabsTrigger>
            <TabsTrigger value="links" className="h-8 rounded-none border-b-2 border-transparent px-2 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Links</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="summary" className="m-0 min-h-0 overflow-y-auto overflow-x-hidden p-4">
          <SummaryTab graph={props.graph} node={props.node} rollup={rollup} status={status.status} />
        </TabsContent>
        <TabsContent value="turns" className="m-0 min-h-0 overflow-y-auto overflow-x-hidden p-4">
          {selectedTurn ? (
            <TurnDetail
              turn={selectedTurn}
              agentId={props.node.agentId ?? props.node.taskId}
              events={eventsForTurn(props.graph, props.node, selectedTurn)}
              onBack={props.onTurnBack}
            />
          ) : (
            <TurnTimeline turns={rollup.turns} onSelect={props.onTurnSelect} />
          )}
        </TabsContent>
        <TabsContent value="llm" className="m-0 min-h-0 overflow-y-auto overflow-x-hidden p-4">
          <LlmCallsTable calls={rollup.llmCalls} config={props.config} />
        </TabsContent>
        <TabsContent value="memory" className="m-0 min-h-0 overflow-y-auto overflow-x-hidden p-4">
          <MemoryOpsTable operations={rollup.memoryOps} />
        </TabsContent>
        <TabsContent value="links" className="m-0 min-h-0 overflow-y-auto overflow-x-hidden p-4">
          <LinksTab node={props.node} config={props.config} />
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
}): React.ReactElement {
  const children = props.graph.nodes.filter((node) => node.parentTaskId === props.node.taskId).length;
  const outboxRows = outboxRowsForNode(props.graph, props.node);
  return (
    <div className="grid gap-4">
      <InspectorSection title="At a glance">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Metric label="Duration" value={formatDuration(durationBetween(props.node.startedAt, props.node.finishedAt))} />
          <Metric label="Turns" value={formatNumber(props.rollup.turns.length)} />
          <Metric label="LLM calls" value={formatNumber(props.rollup.llmCalls.length)} />
          <Metric label="Memory ops" value={formatNumber(props.rollup.memoryOps.length)} />
        </div>
        <FactRow label="Status"><StatusBadge status={props.status} /></FactRow>
        <FactRow label="Cost">{typeof props.rollup.costUsd === 'number' ? formatCost(props.rollup.costUsd) : 'Not captured'}</FactRow>
      </InspectorSection>

      <InspectorSection title="Execution context">
        <FactRow label="Parent">{props.node.parentTaskId ? <CopyableId value={props.node.parentTaskId} label="parent task ID" /> : 'Root agent'}</FactRow>
        <FactRow label="Children">{formatNumber(children)}</FactRow>
        <FactRow label="Started">{formatRelative(props.node.startedAt)}</FactRow>
        <FactRow label="Task ID"><CopyableId value={props.node.taskId} label="task ID" /></FactRow>
      </InspectorSection>

      <InspectorSection title="Task input">
        <JsonPreview
          value={props.node.inputPreview}
          summaryFields={['taskId', 'traceparent', 'agentId', 'kind', 'url']}
          emptyLabel="Input preview was not captured."
          maxPreviewRows={5}
        />
      </InspectorSection>

      <InspectorSection title="Final output">
        <FinalOutputPreview graph={props.graph} node={props.node} />
      </InspectorSection>

      <InspectorSection title="Outbox">
        <OutboxTable rows={outboxRows} />
      </InspectorSection>

      <InspectorSection title="Data availability">
        <FactRow label="Input preview">{props.node.inputPreview === undefined ? 'Not captured' : 'Available'}</FactRow>
        <FactRow label="Output preview">{props.node.outputPreview === undefined ? 'Not captured' : 'Available'}</FactRow>
        <FactRow label="Trace">{props.node.traceId ? 'Available' : 'Not captured'}</FactRow>
        <FactRow label="Provider run">{props.node.providerRunId ? 'Available' : 'Not captured'}</FactRow>
      </InspectorSection>
    </div>
  );
}

function LinksTab(props: { node: AgentRunNode; config: OperatorConfig }): React.ReactElement {
  const hatchetUrl = props.node.providerRunId ? hatchetRunUrl(props.node.providerRunId, props.config) : undefined;
  const opikUrl = props.node.traceId ? opikTraceUrl(props.node.traceId, undefined, props.config) : undefined;
  return (
    <div className="grid gap-4">
      <InspectorSection title="Trace">
        {opikUrl ? <ExternalButton href={opikUrl}>Open in Opik</ExternalButton> : <FactRow label="Opik">Not captured</FactRow>}
      </InspectorSection>
      <InspectorSection title="Backend run">
        {hatchetUrl ? <ExternalButton href={hatchetUrl}>Open in Hatchet</ExternalButton> : <FactRow label="Hatchet">Provider run ID not captured</FactRow>}
      </InspectorSection>
      <InspectorSection title="IDs">
        <FactRow label="Task ID"><CopyableId value={props.node.taskId} /></FactRow>
        <FactRow label="Root task ID"><CopyableId value={props.node.rootTaskId} /></FactRow>
        <FactRow label="Agent ID"><CopyableId value={props.node.agentId} /></FactRow>
        <FactRow label="Trace ID"><CopyableId value={props.node.traceId} /></FactRow>
        <FactRow label="Provider run"><CopyableId value={props.node.providerRunId} /></FactRow>
      </InspectorSection>
    </div>
  );
}

function FinalOutputPreview(props: { graph: AgentRunGraph; node: AgentRunNode }): React.ReactElement {
  if (props.node.outputPreview !== undefined && props.node.outputPreview !== null) {
    return (
      <JsonPreview
        value={props.node.outputPreview}
        summaryFields={['kind', 'status', 'statusCode', 'url', 'savedPath', 'html', 'content', 'error']}
        emptyLabel="Final output not captured."
        maxPreviewRows={6}
      />
    );
  }

  const transitionEvent = [...props.graph.events]
    .reverse()
    .find((event) => eventBelongsToNode(event, props.node) && isRecord(event.payload.transition));
  const effect = props.graph.effects.find((candidate) => effectBelongsToNode(candidate, props.node));

  if (transitionEvent) {
    return (
      <div className="grid gap-2">
        <Notice title="Final output available only in transition event">
          Final output was not captured as a task.completed preview. Output-like data is available in Transition / execution events.
        </Notice>
        <JsonPreview value={transitionEvent.payload.transition} summaryFields={['kind', 'result', 'status', 'error']} maxPreviewRows={5} />
      </div>
    );
  }

  if (effect) {
    return (
      <div className="grid gap-2">
        <Notice title="Final output available as artifact metadata">
          Final output was not captured as a task.completed preview. Effect metadata is available below.
        </Notice>
        <JsonPreview value={effect} summaryFields={['operation', 'status', 'token', 'outboxRowId', 'providerRunId']} maxPreviewRows={5} />
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

function Metric(props: { label: string; value: string }): React.ReactElement {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background/50 px-3 py-2">
      <p className="text-xs text-muted-foreground">{props.label}</p>
      <p className="mt-0.5 truncate font-medium">{props.value}</p>
    </div>
  );
}

function OutboxTable(props: { rows: Array<OutboxRow> }): React.ReactElement {
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
            {row.status ? <StatusBadge status={normalizeRuntimeStatus(row.status)} /> : null}
          </div>
          <details className="min-w-0">
            <summary className="cursor-pointer text-xs font-medium text-foreground">Show details</summary>
            <div className="mt-2">
              <JsonPreview value={row.payload} maxPreviewRows={4} maxRawHeight={220} />
            </div>
          </details>
        </article>
      ))}
    </div>
  );
}

function ExternalButton(props: { href: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={props.href} target="_blank" rel="noreferrer">
        <ExternalLink className="h-4 w-4" />
        {props.children}
      </a>
    </Button>
  );
}

type OutboxRow = {
  id: string;
  turn?: number;
  kind: string;
  status?: string;
  preview: string;
  payload: unknown;
};

function outboxRowsForNode(graph: AgentRunGraph, node: AgentRunNode): OutboxRow[] {
  const events = graph.events
    .filter((event) => eventBelongsToNode(event, node))
    .filter((event) => event.type.startsWith('task.') || event.type === 'turn.completed')
    .map((event): OutboxRow => ({
      id: event.id,
      turn: numberField(event.payload, 'turnSeq'),
      kind: event.type,
      status: stringField(event.payload, 'status'),
      preview: eventPreview(event),
      payload: event.payload,
    }));
  const effects = graph.effects
    .filter((effect) => effectBelongsToNode(effect, node))
    .map((effect): OutboxRow => ({
      id: effect.id,
      kind: effect.operation,
      status: effect.status,
      preview: effect.token ?? effect.outboxRowId ?? effect.providerRunId ?? 'Effect captured',
      payload: effect,
    }));
  return [...events, ...effects].slice(0, 12);
}

function eventBelongsToNode(event: AgentRunEvent, node: AgentRunNode): boolean {
  const payloadTaskId = stringField(event.payload, 'taskId');
  const payloadAgentId = stringField(event.payload, 'agentId') ?? stringField(event.payload, 'childAgentId');
  return payloadTaskId === node.taskId || payloadAgentId === node.agentId || event.group.agentId === node.agentId;
}

function eventsForTurn(graph: AgentRunGraph, node: AgentRunNode, turn: TurnRun): AgentRunEvent[] {
  return graph.events
    .filter((event) => eventBelongsToNode(event, node))
    .filter((event) => {
      const payloadTurnSeq = numberField(event.payload, 'turnSeq');
      if (turn.turnSeq !== undefined && payloadTurnSeq === turn.turnSeq) return true;
      const turnId = turn.cognition?.turnId ?? turn.turnTraceRef?.turnTraceId;
      return Boolean(turnId && event.group.turnId === turnId);
    });
}

function effectBelongsToNode(effect: EffectRun, node: AgentRunNode): boolean {
  return effect.taskId === node.taskId || effect.agentId === node.agentId;
}

function eventPreview(event: AgentRunEvent): string {
  const payload = event.payload;
  const status = stringField(payload, 'status');
  const kind = stringField(payload, 'kind');
  const token = stringField(payload, 'token');
  const transition = recordField(payload, 'transition');
  const transitionKind = stringField(transition, 'kind');
  return [status, kind, transitionKind, token].filter(Boolean).join(' · ') || semanticSummary(payload);
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
