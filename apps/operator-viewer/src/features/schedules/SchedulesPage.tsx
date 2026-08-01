import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { CalendarClock, History, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  createAgentSchedule,
  deleteAgentSchedule,
  getAgentSchedulePayload,
  replaceAgentCron,
  rescheduleAgentSchedule,
  runAgentScheduleNow,
  setAgentSchedulePaused,
  type AgentSchedule,
} from '../../api/client';
import { useAgents, useInfiniteAgentSchedules } from '../../api/hooks';
import { useAuth } from '../../app/auth';
import { Button } from '../../design/components/ui/button';
import { Notice } from '../../design/components/ui/notice';

type View = 'active' | 'historical' | 'all';

export function SchedulesPage(): React.ReactElement {
  const auth = useAuth();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate({ from: '/schedules' });
  const queryClient = useQueryClient();
  const tenantId = window.localStorage.getItem('callagent.operator.tenant') || auth.session.memberships[0]?.tenantId || 'default';
  const role = auth.session.memberships.find((item) => item.tenantId === tenantId)?.role ?? 'viewer';
  const canOperate = role === 'operator' || role === 'admin';
  const canAdmin = role === 'admin';
  const [agentId, setAgentId] = useState(typeof search.agentId === 'string' ? search.agentId : '');
  const [kind, setKind] = useState('');
  const [state, setState] = useState('');
  const [view, setView] = useState<View>('active');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string }>();
  const [payload, setPayload] = useState<{ scheduleId: string; value: unknown }>();
  const schedules = useInfiniteAgentSchedules({ tenantId, agentId: agentId || undefined, kind: kind || undefined, state: state || undefined });
  const agents = useAgents(tenantId);
  const scheduleItems = useMemo(
    () => schedules.data?.pages.flatMap((page) => page.items) ?? [],
    [schedules.data?.pages],
  );
  const items = useMemo(() => scheduleItems.filter((item) => inView(item, view)), [scheduleItems, view]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['agent-schedules'] });
  };
  const action = async (key: string, operation: () => Promise<unknown>, success: string) => {
    setBusy(key); setMessage(undefined);
    try {
      await operation();
      setMessage({ kind: 'info', text: success });
      await refresh();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy('');
    }
  };

  return <div className="grid gap-4">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Automation</p>
        <h2 className="text-2xl font-semibold">Agent schedules</h2>
        <p className="text-sm text-muted-foreground">Hatchet is the authoritative scheduler; CallAgent owns admission, authorization, audit, and run provenance.</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => void schedules.refetch()}>
        <RefreshCw className={schedules.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> Refresh
      </Button>
    </header>

    <Notice kind="warning" title="Payloads are stored durably">
      Do not place passwords, API keys, tokens, or other secrets in schedule payloads. Payload access is separately authorized and audited.
    </Notice>
    {message ? <Notice kind={message.kind} title={message.kind === 'error' ? 'Schedule operation failed' : 'Schedule updated'}>{message.text}</Notice> : null}
    {schedules.error instanceof Error ? <Notice kind="error" title="Schedule provider unavailable">{schedules.error.message}</Notice> : null}

    {canAdmin ? <CreateScheduleForm tenantId={tenantId} agents={agents.data?.items ?? []} initialAgentId={agentId} onCreated={refresh} /> : null}

    <section className="rounded-lg border border-border bg-card p-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <Field label="Agent">
          <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="">all</option>
            {(agents.data?.items ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </Field>
        <Field label="Kind">
          <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">all</option><option value="once">one-time</option><option value="cron">cron</option>
          </select>
        </Field>
        <Field label="Provider state">
          <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">all</option>
            {['pending', 'running', 'succeeded', 'failed', 'canceled', 'enabled', 'paused', 'degraded'].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </Field>
        <Field label="View">
          <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={view} onChange={(event) => setView(event.target.value as View)}>
            <option value="active">active</option><option value="historical">historical</option><option value="all">all</option>
          </select>
        </Field>
        <div className="flex items-end text-xs text-muted-foreground">Tenant: <span className="ml-1 font-mono text-foreground">{tenantId}</span></div>
      </div>
    </section>

    {!schedules.isLoading && items.length === 0 ? <Notice title="No schedules match the current filters">Create a schedule as an administrator or broaden the filters.</Notice> : null}
    <section className="grid gap-3">
      {items.map((schedule) => <ScheduleCard
        key={`${schedule.id}:${schedule.revision}`}
        schedule={schedule}
        canOperate={canOperate}
        canAdmin={canAdmin}
        busy={busy}
        onAction={action}
        onPayload={async () => {
          setBusy(`payload:${schedule.id}`); setMessage(undefined);
          try {
            const result = await getAgentSchedulePayload(tenantId, schedule.id);
            setPayload({ scheduleId: schedule.id, value: result.input });
          } catch (error) {
            setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
          } finally { setBusy(''); }
        }}
        onHistory={() => void navigate({
          to: '/',
          search: { tenantId, scope: 'roots', agentId: '', status: '', since: '', taskId: '', scheduleId: schedule.id, hasLlm: false, hasMemory: false, costState: '' },
        })}
        tenantId={tenantId}
      />)}
      {schedules.hasNextPage ? <div className="flex justify-center">
        <Button
          variant="outline"
          disabled={schedules.isFetchingNextPage}
          onClick={() => void schedules.fetchNextPage()}
        >
          {schedules.isFetchingNextPage ? 'Loading…' : 'Load more schedules'}
        </Button>
      </div> : null}
    </section>
    {payload ? <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">Stored payload · {payload.scheduleId}</h3><Button variant="ghost" size="sm" onClick={() => setPayload(undefined)}>Close</Button></div>
      <pre className="mt-3 max-h-80 overflow-auto rounded-md border border-border bg-background p-3 text-xs">{JSON.stringify(payload.value, null, 2)}</pre>
      <p className="mt-2 text-xs text-muted-foreground">This read was recorded in the operator audit log.</p>
    </section> : null}
  </div>;
}

function CreateScheduleForm(props: { tenantId: string; agents: Array<{ id: string; name: string }>; initialAgentId: string; onCreated: () => Promise<void> }): React.ReactElement {
  const [kind, setKind] = useState<'once' | 'cron'>('cron');
  const [displayName, setDisplayName] = useState('');
  const [agentId, setAgentId] = useState(props.initialAgentId);
  const [when, setWhen] = useState('');
  const [cron, setCron] = useState('0 * * * *');
  const [input, setInput] = useState('{}');
  const [maxTurns, setMaxTurns] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const parsed = JSON.parse(input) as unknown;
      await createAgentSchedule({
        tenantId: props.tenantId, kind, displayName: displayName.trim(), agentId,
        input: parsed,
        ...(kind === 'once' ? { triggerAt: new Date(when).toISOString() } : { cronExpression: cron.trim() }),
        ...(maxTurns ? { maxTurns: Number(maxTurns) } : {}),
      });
      setDisplayName('');
      await props.onCreated();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <form className="grid gap-3 rounded-lg border border-border bg-card p-4" onSubmit={submit}>
    <div><h3 className="font-semibold">Create schedule</h3><p className="text-xs text-muted-foreground">Cron expressions and one-time timestamps are stored and evaluated in UTC.</p></div>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Field label="Display name"><input required className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
      <Field label="Agent"><select required className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">select</option>{props.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field>
      <Field label="Kind"><select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={kind} onChange={(event) => setKind(event.target.value as 'once' | 'cron')}><option value="cron">cron</option><option value="once">one-time</option></select></Field>
      <Field label="Max turns (optional)"><input min="1" type="number" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={maxTurns} onChange={(event) => setMaxTurns(event.target.value)} /></Field>
      {kind === 'cron'
        ? <Field label="UTC cron expression"><input required className="h-9 rounded-md border border-input bg-background px-3 font-mono text-sm" value={cron} onChange={(event) => setCron(event.target.value)} /></Field>
        : <Field label="Local time"><input required type="datetime-local" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={when} onChange={(event) => setWhen(event.target.value)} /></Field>}
    </div>
    <Field label="JSON payload"><textarea className="min-h-28 rounded-md border border-input bg-background p-3 font-mono text-xs" value={input} onChange={(event) => setInput(event.target.value)} /></Field>
    {kind === 'once' && when ? <p className="text-xs text-muted-foreground">UTC: {safeUtc(when)}</p> : null}
    {error ? <Notice kind="error" title="Could not create schedule">{error}</Notice> : null}
    <div><Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create schedule'}</Button></div>
  </form>;
}

function ScheduleCard(props: {
  schedule: AgentSchedule; tenantId: string; canOperate: boolean; canAdmin: boolean; busy: string;
  onAction: (key: string, operation: () => Promise<unknown>, success: string) => Promise<void>;
  onPayload: () => Promise<void>; onHistory: () => void;
}): React.ReactElement {
  const item = props.schedule;
  const key = (operation: string) => `${operation}:${item.id}`;
  const disabled = (operation: string) => props.busy === key(operation);
  return <article className="rounded-lg border border-border bg-card p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2"><CalendarClock className="h-4 w-4 text-primary" /><h3 className="font-semibold">{item.displayName}</h3><Badge>{item.kind}</Badge><Badge>{item.state}</Badge>{!item.agentAvailable ? <Badge>agent unavailable</Badge> : null}{item.cleanupRequired ? <Badge>cleanup required</Badge> : null}</div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{item.id} · revision {item.revision} · {item.agentId}</p>
        {item.kind === 'cron' ? <p className="mt-2 text-sm">UTC cron: <span className="font-mono">{item.cronExpression}</span></p> : <Time value={item.triggerAt} />}
        <p className="mt-1 text-xs text-muted-foreground">Created <TimeInline value={item.createdAt} /> · payload keys: {item.payloadKeys.join(', ') || '(none)'}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={props.onHistory}><History className="h-4 w-4" /> Runs</Button>
        {props.canOperate ? <Button variant="outline" size="sm" disabled={!item.agentAvailable || disabled('run')} onClick={() => void props.onAction(key('run'), () => runAgentScheduleNow(props.tenantId, item.id), 'Run admitted to Hatchet.')}><Play className="h-4 w-4" /> Run now</Button> : null}
        {props.canOperate ? <Button variant="outline" size="sm" disabled={disabled('payload')} onClick={() => void props.onPayload()}>Payload</Button> : null}
        {props.canOperate && item.kind === 'cron' ? <Button variant="outline" size="sm" disabled={disabled('pause')} onClick={() => void props.onAction(key('pause'), () => setAgentSchedulePaused(props.tenantId, item.id, item.state !== 'paused'), item.state === 'paused' ? 'Cron resumed.' : 'Cron paused.')}>{item.state === 'paused' ? 'Resume' : 'Pause'}</Button> : null}
        {props.canAdmin && item.kind === 'once' && item.state === 'pending' ? <Button variant="outline" size="sm" onClick={() => {
          const value = window.prompt('New local trigger time (YYYY-MM-DDTHH:mm)', item.triggerAt ? localInput(item.triggerAt) : '');
          if (value) void props.onAction(key('reschedule'), () => rescheduleAgentSchedule(props.tenantId, item.id, new Date(value).toISOString()), 'One-time run rescheduled.');
        }}>Reschedule</Button> : null}
        {props.canAdmin && item.kind === 'cron' ? <Button variant="outline" size="sm" onClick={() => void replaceCron(props, item)}>Replace</Button> : null}
        {props.canAdmin ? <Button variant="outline" size="sm" disabled={disabled('delete')} onClick={() => {
          if (window.confirm(`Delete schedule “${item.displayName}”?`)) void props.onAction(key('delete'), () => deleteAgentSchedule(props.tenantId, item.id), 'Schedule deleted.');
        }}><Trash2 className="h-4 w-4" /> Delete</Button> : null}
      </div>
    </div>
    {item.cleanupRequired ? <Notice className="mt-3" kind="partial" title="Replacement completed with cleanup required">Old disabled provider resources: {item.cleanupRequired.providerIds.join(', ')}</Notice> : null}
  </article>;
}

async function replaceCron(props: Parameters<typeof ScheduleCard>[0], item: AgentSchedule): Promise<void> {
  try {
    const stored = await getAgentSchedulePayload(props.tenantId, item.id);
    const cronExpression = window.prompt('Replacement UTC cron expression', item.cronExpression ?? '');
    if (cronExpression === null) return;
    const agentId = window.prompt('Replacement agent ID', item.agentId);
    if (agentId === null) return;
    const rawPayload = window.prompt('Replacement JSON payload', JSON.stringify(stored.input));
    if (rawPayload === null) return;
    const input = JSON.parse(rawPayload) as unknown;
    await props.onAction(`replace:${item.id}`, () => replaceAgentCron(props.tenantId, item.id, {
      expectedRevision: item.revision, displayName: item.displayName, agentId, input, cronExpression,
      ...(item.maxTurns ? { maxTurns: item.maxTurns } : {}),
    }), 'Cron replaced with a new revision.');
  } catch (error) {
    await props.onAction(`replace:${item.id}`, async () => { throw error; }, '');
  }
}

function inView(item: AgentSchedule, view: View): boolean {
  if (view === 'all') return true;
  const historical = item.state === 'succeeded' || item.state === 'failed' || item.state === 'canceled';
  return view === 'historical' ? historical : !historical;
}
function Field(props: { label: string; children: React.ReactNode }): React.ReactElement { return <label className="grid gap-1.5 text-xs font-medium text-muted-foreground"><span>{props.label}</span>{props.children}</label>; }
function Badge(props: { children: React.ReactNode }): React.ReactElement { return <span className="rounded-md border border-border bg-surface-muted px-2 py-1 text-xs text-muted-foreground">{props.children}</span>; }
function Time(props: { value?: string }): React.ReactElement { return <p className="mt-2 text-sm">Trigger: <TimeInline value={props.value} /></p>; }
function TimeInline(props: { value?: string }): React.ReactElement { if (!props.value) return <>unknown</>; const date = new Date(props.value); return <><span>{date.toLocaleString()}</span> <span className="font-mono text-xs text-muted-foreground">({date.toISOString()} UTC)</span></>; }
function localInput(value: string): string { const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
function safeUtc(value: string): string { try { return new Date(value).toISOString(); } catch { return 'invalid date'; } }
