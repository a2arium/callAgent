import { AlertTriangle, ArrowLeft, Brain, DollarSign, FileOutput, ShieldAlert, Timer } from 'lucide-react';
import { Notice } from '../../design/components/ui/notice';
import { StatusBadge } from '../../design/components/ui/status-badge';
import { formatCost, formatDuration, stringFromUnknown } from '../../design/format';
import { normalizeRuntimeStatus } from '../../domain/derive';
import { semanticFailureFromTurn, type SemanticFailure } from '../../domain/semanticFailure';
import { JsonPreview } from '../inspector/JsonPreview';
import type { AgentRunEvent, TurnRun } from '../../types';
import { cn } from '../../lib/utils';

export function TurnTimeline(props: {
  turns: TurnRun[];
  tenantId?: string;
  onSelect: (turn: TurnRun) => void;
}): React.ReactElement {
  const duplicateSeqs = duplicateTurnSeqs(props.turns);

  return (
    <section className="grid gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">Turn timeline</h4>
          <p className="text-xs text-muted-foreground">{props.turns.length} captured turns</p>
        </div>
      </div>

      <div className="grid max-h-[360px] gap-2 overflow-y-auto overflow-x-hidden pr-1">
        {props.turns.length === 0 ? <p className="text-sm text-muted-foreground">Turn summary was not captured for this node.</p> : null}
        {props.turns.map((turn, index) => {
          const turnSeq = turn.turnSeq ?? index + 1;
          const duplicate = turn.turnSeq !== undefined && duplicateSeqs.has(turn.turnSeq);
          return (
            <button
              key={turn.id}
              type="button"
              className={cn(
                'min-w-0 rounded-lg border bg-background/50 p-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'border-border'
              )}
              onClick={() => props.onSelect(turn)}
            >
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words font-semibold [overflow-wrap:anywhere]">Turn {turnSeq}</p>
                  <p className="mt-1 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {turnFlowLabel(turn)}
                  </p>
                </div>
                <StatusBadge status={normalizeRuntimeStatus(turn.status)} />
              </div>
              {duplicate ? (
                <p className="mt-2 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-3 w-3" />
                  Duplicate turn number detected
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Marker icon={<Brain className="h-3 w-3" />} label={intentLabel(turn)} />
                {turn.cognition?.shield?.action ? <Marker icon={<ShieldAlert className="h-3 w-3" />} label={String(turn.cognition.shield.action) === 'pass' ? 'Shield pass' : `Shield ${String(turn.cognition.shield.action)}`} /> : null}
                {turn.boundaryKind?.startsWith('await') ? <Marker icon={<Timer className="h-3 w-3" />} label={turn.boundaryKind} /> : null}
                {hasOutputProduced(turn) ? <Marker icon={<FileOutput className="h-3 w-3" />} label="Output produced" /> : null}
                {turn.llmCalls?.length ? <Marker icon={<DollarSign className="h-3 w-3" />} label={formatCost(turnCost(turn))} /> : null}
                {normalizeRuntimeStatus(turn.status) === 'failed' ? <Marker icon={<AlertTriangle className="h-3 w-3" />} label="Error" /> : null}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function TurnDetail(props: {
  turn: TurnRun | undefined;
  agentId?: string;
  events?: AgentRunEvent[];
  tenantId?: string;
  onBack: () => void;
}): React.ReactElement {
  if (!props.turn) return <p className="text-sm text-muted-foreground">Select a turn to inspect APLRET cognition.</p>;
  const turn = props.turn;
  const turnLabel = `Turn ${turn.turnSeq ?? '?'}`;
  const events = props.events ?? [];
  const semanticFailure = semanticFailureFromTurn(turn);
  const stages = [
    { name: 'Attention', value: undefined },
    { name: 'Perception', value: turn.cognition?.perception },
    { name: 'Learning', value: turn.cognition?.mentalStateAfterHash ? { mentalStateAfterHash: turn.cognition.mentalStateAfterHash } : undefined },
    { name: 'Policy', value: turn.cognition?.intent },
    { name: 'Shield', value: turn.cognition?.shield },
    { name: 'Execution', value: turn.cognition?.execResult ?? turn.cognition?.execAction },
    { name: 'Transition', value: turn.cognition?.transition ?? turn.boundaryKind },
  ];
  return (
    <section className="grid gap-3">
      <button
        type="button"
        className="sticky top-0 z-20 grid min-w-0 gap-1 border-b border-border bg-card px-4 py-2 text-left shadow-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={props.onBack}
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
            <ArrowLeft className="h-4 w-4 shrink-0" />
            <span>Back to turns</span>
          </span>
          <StatusBadge status={normalizeRuntimeStatus(turn.status)} />
        </div>
        <p className="min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {props.agentId ?? 'selected agent'} → {turnLabel} · {turnFlowLabel(turn)}
        </p>
      </button>

      <div className="grid gap-3 px-4 pb-4">
        <section className="grid gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Summary</h4>
          {semanticFailure ? <SemanticFailureNotice failure={semanticFailure} /> : null}
          {!semanticFailure ? (
            <p className="rounded-lg border border-border bg-background/50 p-3 text-sm text-muted-foreground">
              {turnSummary(turn)}
            </p>
          ) : null}
        </section>

        <section className="grid gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Key signals</h4>
          <div className="grid gap-1">
            <FactRow label="Turn inbox">{turn.cognition?.perception ? 'Derived from perception context' : 'No inbox event captured'}</FactRow>
            <FactRow label="Shield">{shieldSummary(turn)}</FactRow>
            <FactRow label="Execution">{executionSummary(turn)}</FactRow>
            <FactRow label="Output">{hasOutputProduced(turn) ? 'Produced' : 'Not captured'}</FactRow>
            <FactRow label="LLM calls">{turn.llmCalls?.length ?? 0}</FactRow>
            <FactRow label="Memory ops">{turn.memoryOps?.length ?? 0}</FactRow>
            <FactRow label="Cost">{turnCost(turn) > 0 ? formatCost(turnCost(turn)) : 'Not captured'}</FactRow>
          </div>
        </section>

        {hasOutputProduced(turn) ? (
          <section className="grid gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Output</h4>
            <p className="rounded-lg border border-border bg-background/50 p-3 text-sm text-muted-foreground">
              Output was produced in Transition. Final output preview may still be unavailable at the agent summary level.
            </p>
          </section>
        ) : null}

        <section className="grid gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Execution events</h4>
          {events.length > 0 ? (
            <div className="grid gap-2">
              {events.map((event) => (
                <details key={event.id} className="min-w-0 rounded-lg border border-border bg-background/50">
                  <summary className="flex cursor-pointer items-start justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{event.type}</p>
                      <p className="mt-1 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{eventSummary(event)}</p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">Show details</span>
                  </summary>
                  <div className="border-t border-border p-3">
                    <JsonPreview value={event.payload} tenantId={props.tenantId} summaryFields={['turnSeq', 'kind', 'status', 'boundaryKind', 'error']} maxPreviewRows={5} maxRawHeight={220} />
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <Notice title="No turn-scoped execution events captured" className="bg-background/50" />
          )}
        </section>

        <div className="grid gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Stages</h4>
          <StageTimingRail turn={turn} />
        </div>
        {stages.map((stage, index) => (
          <StageDetailCard key={stage.name} index={index + 1} name={stage.name} value={stage.value} turn={turn} tenantId={props.tenantId} />
        ))}
      </div>
    </section>
  );
}

function StageDetailCard(props: { index: number; name: string; value: unknown; turn: TurnRun; tenantId?: string }): React.ReactElement {
  const facts = stageFacts(props.name, props.value, props.turn);
  const hasValue = props.value !== undefined && props.value !== null;
  const shouldOpen = defaultStageOpen(props.name, props.turn);
  const duration = stageDuration(props.turn, props.name);
  return (
    <details className="min-w-0 rounded-lg border border-border bg-background/50" open={shouldOpen}>
      <summary className="flex cursor-pointer items-center gap-2 p-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{props.index}</span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <h4 className="font-semibold">{props.name}</h4>
            {duration !== undefined ? <span className="shrink-0 text-xs text-muted-foreground">{formatDuration(duration)}</span> : null}
          </div>
          <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{stageSummary(props.name, props.value, props.turn)}</p>
        </div>
      </summary>
      <div className="grid gap-2 border-t border-border p-3">
        {props.name === 'Attention' && !hasValue ? (
          <Notice title="No turn inbox event captured">
            No separate turn inbox payload was captured. Perception context is available in the Perception stage.
          </Notice>
        ) : null}
        {facts.length > 0 ? (
          <div className="grid gap-1">
            {facts.map(([label, value]) => (
              <FactRow key={label} label={label}>{value}</FactRow>
            ))}
          </div>
        ) : null}
        {hasValue ? (
          <JsonPreview
            value={props.value}
            tenantId={props.tenantId}
            summaryFields={props.name === 'Transition' ? ['kind', 'status', 'result', 'error'] : ['kind', 'intent', 'action', 'status', 'url', 'message']}
            maxPreviewRows={5}
          />
        ) : props.name !== 'Attention' ? (
          <Notice title="Not captured" className="bg-background/50" />
        ) : null}
      </div>
    </details>
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

function StageTimingRail(props: { turn: TurnRun }): React.ReactElement | null {
  const segments = stageTimingSegments(props.turn);
  if (segments.length === 0) return null;
  const totalMs = timingTotal(props.turn) ?? segments.reduce((sum, segment) => sum + segment.durationMs, 0);
  if (totalMs <= 0) return null;
  return (
    <div className="overflow-hidden rounded-full border border-border bg-muted/60" title={`Total: ${formatDuration(totalMs)}`}>
      <div className="flex h-2 w-full">
        {segments.map((segment) => (
          <div
            key={segment.stage}
            className={cn('min-w-[2px]', segmentClass(segment.stage))}
            style={{ width: `${Math.max(1, (segment.durationMs / totalMs) * 100)}%` }}
            title={`${segment.stage}: ${formatDuration(segment.durationMs)}`}
          />
        ))}
      </div>
    </div>
  );
}

function FactRow(props: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="grid min-w-0 grid-cols-[96px_minmax(0,1fr)] gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <div className="min-w-0 break-words [overflow-wrap:anywhere]">{props.children}</div>
    </div>
  );
}

function Marker(props: { icon: React.ReactNode; label: string }): React.ReactElement {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
      {props.icon}
      <span className="break-words [overflow-wrap:anywhere]">{props.label}</span>
    </span>
  );
}

function duplicateTurnSeqs(turns: TurnRun[]): Set<number> {
  const counts = new Map<number, number>();
  for (const turn of turns) {
    if (turn.turnSeq === undefined) continue;
    counts.set(turn.turnSeq, (counts.get(turn.turnSeq) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([turnSeq]) => turnSeq));
}

function intentLabel(turn: TurnRun): string {
  const intent = turn.cognition?.intent;
  const kind = intent && typeof intent === 'object' && 'kind' in intent ? intent.kind : undefined;
  return typeof kind === 'string' ? kind : 'Intent not captured';
}

function turnCost(turn: TurnRun): number {
  return (turn.llmCalls ?? []).reduce((sum, call) => {
    const value = typeof call.costUsd === 'number' ? call.costUsd : typeof call.cost === 'number' ? call.cost : 0;
    return sum + value;
  }, 0);
}

function hasOutputProduced(turn: TurnRun): boolean {
  const execResult = turn.cognition?.execResult;
  const transition = turn.cognition?.transition;
  return valueContainsKey(execResult, 'data') || transitionResultOk(transition) || turn.boundaryKind === 'complete';
}

function turnFlowLabel(turn: TurnRun): string {
  const before = turn.cognition?.stageBefore ?? '?';
  const terminal = transitionKind(turn) ?? turn.boundaryKind;
  if (terminal && terminal !== 'continue') {
    return `${before} → ${terminal}`;
  }
  return `${before} → ${turn.cognition?.stageAfter ?? terminal ?? '?'}`;
}

function transitionKind(turn: TurnRun): string | undefined {
  const transition = turn.cognition?.transition;
  if (!isRecord(transition)) return undefined;
  return stringField(transition, 'kind');
}

type TimingSegment = {
  stage: string;
  durationMs: number;
};

const STAGE_TIMING_KEYS: Array<[string, string]> = [
  ['Attention', 'attentionMs'],
  ['Perception', 'perceptionMs'],
  ['Learning', 'learningMs'],
  ['Policy', 'policyMs'],
  ['Shield', 'shieldMs'],
  ['Execution', 'executionMs'],
  ['Transition', 'transitionMs'],
];

function stageTimingSegments(turn: TurnRun): TimingSegment[] {
  const timings = turn.cognition?.timings;
  if (!isRecord(timings)) return [];
  return STAGE_TIMING_KEYS.flatMap(([stage, key]) => {
    const durationMs = numberField(timings, key);
    return durationMs !== undefined ? [{ stage, durationMs: Math.max(0, durationMs) }] : [];
  });
}

function stageDuration(turn: TurnRun, stageName: string): number | undefined {
  const timings = turn.cognition?.timings;
  if (!isRecord(timings)) return undefined;
  const key = STAGE_TIMING_KEYS.find(([stage]) => stage === stageName)?.[1];
  return key ? numberField(timings, key) : undefined;
}

function timingTotal(turn: TurnRun): number | undefined {
  const timings = turn.cognition?.timings;
  if (!isRecord(timings)) return undefined;
  return numberField(timings, 'totalMs');
}

function segmentClass(stage: string): string {
  switch (stage) {
    case 'Attention':
      return 'bg-sky-500';
    case 'Perception':
      return 'bg-cyan-500';
    case 'Learning':
      return 'bg-teal-500';
    case 'Policy':
      return 'bg-amber-500';
    case 'Shield':
      return 'bg-emerald-500';
    case 'Execution':
      return 'bg-rose-500';
    case 'Transition':
      return 'bg-indigo-500';
    default:
      return 'bg-muted-foreground';
  }
}

function turnSummary(turn: TurnRun): string {
  const semanticFailure = semanticFailureFromTurn(turn);
  if (semanticFailure) {
    return `This turn completed with semantic failure${semanticFailure.code ? ` (${semanticFailure.code})` : ''}. ${semanticFailure.message}`;
  }
  const parts: string[] = [];
  const status = normalizeRuntimeStatus(turn.status);
  if (status === 'completed') parts.push('This turn completed successfully.');
  else if (status === 'failed') parts.push('This turn failed.');
  else parts.push(`This turn is ${status}.`);
  const shield = shieldAction(turn);
  if (shield === 'pass') parts.push('Shield passed.');
  else if (shield) parts.push(`Shield returned ${shield}.`);
  if (hasOutputProduced(turn)) parts.push('Output was produced.');
  if ((turn.llmCalls?.length ?? 0) > 0) parts.push(`${turn.llmCalls?.length ?? 0} LLM call${turn.llmCalls?.length === 1 ? '' : 's'} captured.`);
  if ((turn.memoryOps?.length ?? 0) > 0) parts.push(`${turn.memoryOps?.length ?? 0} memory operation${turn.memoryOps?.length === 1 ? '' : 's'} captured.`);
  return parts.join(' ');
}

function shieldSummary(turn: TurnRun): string {
  const action = shieldAction(turn);
  if (!action) return 'Not captured';
  if (action === 'pass') return 'Passed';
  return String(action);
}

function executionSummary(turn: TurnRun): string {
  const execResult = turn.cognition?.execResult;
  const execAction = turn.cognition?.execAction;
  if (isRecord(execResult)) {
    const kind = stringField(execResult, 'kind');
    const done = recordField(execResult, 'result')?.done ?? execResult.done;
    if (done === true) return kind ? `${kind} · done=true` : 'done=true';
    if (kind) return kind;
    return 'Result captured';
  }
  if (isRecord(execAction)) {
    return stringField(execAction, 'kind') ?? 'Action captured';
  }
  return 'Not captured';
}

function defaultStageOpen(stageName: string, turn: TurnRun): boolean {
  if (normalizeRuntimeStatus(turn.status) === 'failed') {
    return ['Execution', 'Transition', 'Shield'].includes(stageName);
  }
  if (shieldAction(turn) && shieldAction(turn) !== 'pass') return stageName === 'Shield';
  if (hasOutputProduced(turn)) return stageName === 'Transition';
  return false;
}

function stageSummary(stageName: string, value: unknown, turn: TurnRun): string {
  if (stageName === 'Attention' && (value === undefined || value === null)) {
    return 'No separate turn inbox payload captured.';
  }
  if (value === undefined || value === null) return `${stageName} was not captured for this turn.`;
  if (typeof value === 'string') return truncateText(value, 180);
  if (isRecord(value)) {
    const kind = stringField(value, 'kind');
    const status = stringField(value, 'status');
    const action = stringField(value, 'action');
    const intent = stringField(value, 'intent');
    const ok = recordField(value, 'result')?.ok;
    if (stageName === 'Shield' && action === 'pass') return 'Shield passed.';
    if (stageName === 'Execution') return executionSummary(turn);
    if (stageName === 'Transition' && hasOutputProduced(turn)) return 'Transition completed and output was produced.';
    if (ok === true) return `${stageName} completed successfully.`;
    if (ok === false) return `${stageName} completed with semantic failure.`;
    return [kind, status, action, intent].filter(Boolean).join(' · ') || `${stageName} data captured.`;
  }
  return truncateText(stringFromUnknown(value), 180);
}

function stageFacts(stageName: string, value: unknown, turn: TurnRun): Array<[string, React.ReactNode]> {
  if (stageName === 'Attention') {
    return [
      ['Input event', 'Not captured separately'],
      ['Related data', turn.cognition?.perception ? 'Perception context captured' : 'Not captured'],
    ];
  }
  if (stageName === 'Shield') {
    return [
      ['Outcome', shieldSummary(turn)],
      ...recordFact(value, 'reason'),
    ];
  }
  if (stageName === 'Execution') {
    return [
      ['Status', executionSummary(turn)],
      ['Output', hasOutputProduced(turn) ? 'Produced' : 'Not captured'],
    ];
  }
  if (stageName === 'Transition') {
    const semanticFailure = semanticFailureFromTurn(turn);
    return [
      ['Status', semanticFailure ? 'Semantic failure' : hasOutputProduced(turn) ? 'Completed' : 'Captured'],
      ...(semanticFailure?.code ? [['Code', semanticFailure.code] satisfies [string, React.ReactNode]] : []),
      ...(semanticFailure ? [['Message', semanticFailure.message] satisfies [string, React.ReactNode]] : []),
      ['Output produced', hasOutputProduced(turn) ? 'Yes' : 'No'],
    ];
  }
  if (!isRecord(value)) {
    return [];
  }
  const fields = stageName === 'Transition'
    ? ['kind', 'status', 'boundaryKind', 'ok', 'error', 'result']
    : ['kind', 'intent', 'action', 'status', 'url', 'statusCode', 'message'];
  return fields
    .flatMap((field): Array<[string, React.ReactNode]> => {
      if (field === 'ok') {
        const ok = recordField(value, 'result')?.ok;
        return typeof ok === 'boolean' ? [[field, String(ok)]] : [];
      }
      if (value[field] === undefined) return [];
      return [[field, valueNode(value[field])]];
    })
    .slice(0, 6);
}

function recordFact(value: unknown, key: string): Array<[string, React.ReactNode]> {
  if (!isRecord(value) || value[key] === undefined) return [];
  return [[key, valueNode(value[key])]];
}

function eventSummary(event: AgentRunEvent): string {
  const status = stringField(event.payload, 'status');
  const kind = stringField(event.payload, 'kind');
  const boundaryKind = stringField(event.payload, 'boundaryKind');
  const transition = recordField(event.payload, 'transition');
  const transitionKind = transition ? stringField(transition, 'kind') : undefined;
  const ok = transition ? recordField(transition, 'result')?.ok : undefined;
  if (ok === true) return 'Transition result ok.';
  if (ok === false) return 'Transition reported semantic failure.';
  return [status, kind, boundaryKind, transitionKind].filter(Boolean).join(' · ') || `Payload with ${Object.keys(event.payload).length} fields.`;
}

function shieldAction(turn: TurnRun): string | undefined {
  const action = turn.cognition?.shield?.action;
  return typeof action === 'string' && action.length > 0 ? action : undefined;
}

function transitionResultOk(transition: unknown): boolean {
  if (!isRecord(transition)) return false;
  const ok = recordField(transition, 'result')?.ok;
  return ok === true;
}

function valueNode(value: unknown): React.ReactNode {
  if (typeof value === 'string') return truncateText(value, 160);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return truncateText(stringFromUnknown(value), 160);
}

function valueContainsKey(value: unknown, key: string): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}
