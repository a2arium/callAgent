import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type Header,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Ban, RefreshCw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useAgentRuns, useCancelRun } from '../../api/hooks';
import { Button } from '../../design/components/ui/button';
import { CopyableId } from '../../design/components/ui/copyable';
import { Notice } from '../../design/components/ui/notice';
import { StatusBadge } from '../../design/components/ui/status-badge';
import { formatCost, formatNumber, formatRelative } from '../../design/format';
import { deriveFleetSummary, normalizeRuntimeStatus } from '../../domain/derive';
import type { AgentRunGraph, AgentRunListItem } from '../../types';
import { parseFleetSearch, type FleetSearch } from '../../app/state';
import { cn } from '../../lib/utils';

type FleetRow = AgentRunListItem & {
  displayStatus: string;
};

const columnHelper = createColumnHelper<FleetRow>();
const fleetGridColumns =
  'grid-cols-[130px_minmax(170px,1.4fr)_minmax(210px,1.7fr)_80px_95px_80px_100px_120px_120px_104px]';

export function FleetPage(): React.ReactElement {
  const search = parseFleetSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const navigate = useNavigate({ from: '/' });
  const queryClient = useQueryClient();
  const cancelRun = useCancelRun();
  const [sorting, setSorting] = useState<SortingState>([]);
  const query = useAgentRuns({
    tenantId: search.tenantId,
    scope: search.scope,
    agentId: search.agentId || undefined,
    status: search.status || undefined,
    since: search.since || undefined,
    limit: 150,
  });
  const rows = useMemo(
    () =>
      filterRows(query.data?.items ?? [], search).map((row) => {
        const graph = queryClient.getQueryData<AgentRunGraph>(['run-graph', search.tenantId, row.rootTaskId]);
        return {
          ...row,
          displayStatus: graph?.root.status ?? row.status,
        };
      }),
    [query.data?.items, queryClient, search]
  );
  const summary = useMemo(() => deriveFleetSummary(rows), [rows]);
  const cancelFleetRun = (row: FleetRow) => {
    if (isTerminalStatus(row.displayStatus)) return;
    const defaultReason = 'operator cancel';
    const reason = window.prompt(
      `Cancel root run ${row.rootTaskId}?\n\nActive provider runs will be canceled best-effort and the runtime will stop at the next cancellation check.`,
      defaultReason
    );
    if (reason === null) return;
    cancelRun.mutate({
      tenantId: search.tenantId,
      taskId: row.rootTaskId,
      ...(row.agentId ? { agentId: row.agentId } : {}),
      reason: reason.trim() || defaultReason,
    });
  };

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Fleet</p>
          <h2 className="text-2xl font-semibold">Agent runs</h2>
          <p className="text-sm text-muted-foreground">
            {search.scope === 'all' ? 'Showing root and child agent runs.' : 'Showing root agent runs by default.'}
          </p>
          {query.data?.projection ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Projection: {query.data.projection.source}
              {query.data.projection.lagMs !== undefined ? ` · lag ${query.data.projection.lagMs}ms` : ''}
              {query.data.projection.partial ? ' · partial' : ''}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground">
            Tenant: <span className="font-mono text-foreground">{search.tenantId}</span>
          </span>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            <RefreshCw className={cn('h-4 w-4', query.isFetching ? 'animate-spin' : '')} />
            Refresh
          </Button>
        </div>
      </header>

      <FleetSummaryCards summary={summary} onStatus={(status) => void navigate({ search: { ...search, status } })} />
      <FleetFilters search={search} onChange={(next) => void navigate({ search: next })} />

      {query.error instanceof Error ? (
        <Notice kind="error" title="Data source unavailable">
          Failed to load /agent-runs: {query.error.message}. Make sure runtime-host is running on 127.0.0.1:8790.
        </Notice>
      ) : null}
      {!query.isLoading && !query.error && rows.length === 0 ? (
        <Notice title="No runs match the current filters">
          Start a task with a database-backed runtime, broaden filters, or open a task directly from its ID.
        </Notice>
      ) : null}
      {cancelRun.error instanceof Error ? (
        <Notice kind="error" title="Cancel failed">
          {cancelRun.error.message}
        </Notice>
      ) : null}

      <FleetTable
        rows={rows}
        isLoading={query.isLoading}
        sorting={sorting}
        onSortingChange={setSorting}
        onOpen={(row) => {
          void navigate({
            to: '/runs/$taskId',
            params: { taskId: row.rootTaskId },
            search: { ...search, nodeId: '', turn: '', tab: 'summary' },
          });
        }}
        onCancel={cancelFleetRun}
        cancelingTaskId={cancelRun.isPending ? cancelRun.variables?.taskId : undefined}
      />
    </div>
  );
}

function FleetSummaryCards(props: {
  summary: ReturnType<typeof deriveFleetSummary>;
  onStatus: (status: string) => void;
}): React.ReactElement {
  const cards = [
    ['Total runs', props.summary.total, ''],
    ['Failed', props.summary.failed, 'failed'],
    ['Waiting', props.summary.waiting, 'running'],
    ['Stuck', props.summary.stuck, ''],
    ['Completed', props.summary.completed, 'completed'],
    ['Cost captured', props.summary.costCaptured, ''],
    ['Cost unavailable', props.summary.costUnavailable, ''],
  ] as const;
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
      {cards.map(([label, value, status]) => (
        <button
          key={label}
          type="button"
          className={cn(
            'rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/35 hover:bg-accent',
            label === 'Failed' && value > 0 ? 'border-danger-border' : '',
            label === 'Completed' && value > 0 ? 'border-success-border' : ''
          )}
          onClick={() => props.onStatus(status)}
        >
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(value)}</p>
        </button>
      ))}
    </section>
  );
}

function FleetFilters(props: {
  search: FleetSearch;
  onChange: (next: FleetSearch) => void;
}): React.ReactElement {
  const update = (patch: Partial<FleetSearch>) => props.onChange({ ...props.search, ...patch });
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <Field label="Tenant">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={props.search.tenantId} onChange={(event) => update({ tenantId: event.target.value })} />
        </Field>
        <Field label="Agent">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" placeholder="agentId" value={props.search.agentId} onChange={(event) => update({ agentId: event.target.value })} />
        </Field>
        <Field label="Status">
          <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={props.search.status} onChange={(event) => update({ status: event.target.value })}>
            {['', 'queued', 'running', 'completed', 'failed', 'canceled', 'unknown'].map((status) => (
              <option key={status || 'all'} value={status}>
                {status || 'all'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Since">
          <input
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            type="datetime-local"
            value={props.search.since ? props.search.since.slice(0, 16) : ''}
            onChange={(event) => update({ since: event.target.value ? new Date(event.target.value).toISOString() : '' })}
          />
        </Field>
        <Field label="Task/root task">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" placeholder="taskId" value={props.search.taskId} onChange={(event) => update({ taskId: event.target.value })} />
        </Field>
        <Field label="Cost">
          <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={props.search.costState} onChange={(event) => update({ costState: event.target.value as FleetSearch['costState'] })}>
            <option value="">all</option>
            <option value="captured">captured</option>
            <option value="missing">missing</option>
          </select>
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Toggle checked={props.search.scope === 'all'} onClick={() => update({ scope: props.search.scope === 'all' ? 'roots' : 'all' })}>Include child agents</Toggle>
        <Toggle checked={props.search.hasLlm} onClick={() => update({ hasLlm: !props.search.hasLlm })}>Has LLM calls</Toggle>
        <Toggle checked={props.search.hasMemory} onClick={() => update({ hasMemory: !props.search.hasMemory })}>Has memory ops</Toggle>
      </div>
    </section>
  );
}

function FleetTable(props: {
  rows: FleetRow[];
  isLoading: boolean;
  sorting: SortingState;
  onSortingChange: Dispatch<SetStateAction<SortingState>>;
  onOpen: (row: AgentRunListItem) => void;
  onCancel: (row: FleetRow) => void;
  cancelingTaskId?: string;
}): React.ReactElement {
  const columns = useMemo(
    () => [
      columnHelper.accessor('displayStatus', {
        header: 'Status',
        cell: (info) => <StatusBadge status={normalizeRuntimeStatus(info.getValue())} />,
      }),
      columnHelper.accessor('agentId', {
        header: 'Agent',
        cell: (info) => <span className="font-medium">{info.getValue() ?? 'unknown'}</span>,
      }),
      columnHelper.accessor('rootTaskId', {
        header: 'Task',
        cell: (info) => <CopyableId value={info.getValue()} label="root task ID" />,
      }),
      columnHelper.accessor('turns', { header: 'Turns', cell: (info) => formatNumber(info.getValue()) }),
      columnHelper.accessor('children', { header: 'Children', cell: (info) => formatNumber(info.getValue()) }),
      columnHelper.accessor('llmCalls', { header: 'LLM', cell: (info) => formatNumber(info.getValue()) }),
      columnHelper.accessor('memoryOps', {
        header: 'Memory',
        cell: (info) => formatNumber(info.getValue()),
      }),
      columnHelper.accessor('costUsd', {
        header: 'Cost',
        cell: (info) => formatCost(info.getValue()),
      }),
      columnHelper.accessor('startedAt', {
        header: 'Started',
        cell: (info) => <span title={info.getValue()}>{formatRelative(info.getValue())}</span>,
      }),
      columnHelper.display({
        id: 'actions',
        header: 'Actions',
        cell: (info) => {
          const row = info.row.original;
          const isCanceling = props.cancelingTaskId === row.rootTaskId;
          const disabled = isTerminalStatus(row.displayStatus) || isCanceling;
          return (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              title={isTerminalStatus(row.displayStatus) ? 'Run is already terminal' : 'Cancel run'}
              onClick={(event) => {
                event.stopPropagation();
                props.onCancel(row);
              }}
            >
              <Ban className="h-3.5 w-3.5" />
              {isCanceling ? 'Canceling' : 'Cancel'}
            </Button>
          );
        },
      }),
    ],
    [props.cancelingTaskId, props.onCancel]
  );
  const table = useReactTable({
    data: props.rows,
    columns,
    state: { sorting: props.sorting },
    onSortingChange: props.onSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const parentRef = useRef<HTMLDivElement | null>(null);
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 10,
  });
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card shadow-[0_12px_35px_hsl(220_20%_10%/0.04)]">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h3 className="font-semibold">Runs</h3>
          <p className="text-xs text-muted-foreground">{props.isLoading ? 'Loading...' : `${formatNumber(props.rows.length)} visible rows`}</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[1280px]">
          {table.getHeaderGroups().map((headerGroup) => (
            <div
              key={headerGroup.id}
              className={`sticky top-0 z-10 grid ${fleetGridColumns} border-b border-border bg-surface-muted px-3 text-xs uppercase tracking-wide text-muted-foreground`}
            >
              {headerGroup.headers.map((header) => (
                <HeaderCell key={header.id} header={header} />
              ))}
            </div>
          ))}
        </div>
        <div ref={parentRef} className="h-[56vh] min-h-[360px] overflow-auto">
          <div className="relative min-w-[1280px]" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={row.id}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    `absolute left-0 grid w-full ${fleetGridColumns} items-center border-b border-border px-3 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`,
                    normalizeRuntimeStatus(row.original.displayStatus) === 'failed' ? 'border-l-2 border-l-danger-border' : ''
                  )}
                  style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}
                  onClick={() => props.onOpen(row.original)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      props.onOpen(row.original);
                    }
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <span key={cell.id} className="min-w-0 truncate py-2 pr-3">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function HeaderCell(props: { header: Header<FleetRow, unknown> }): React.ReactElement {
  return (
    <button
      type="button"
      className="min-w-0 truncate py-2 pr-3 text-left font-semibold hover:text-foreground"
      onClick={props.header.column.getToggleSortingHandler()}
    >
      {flexRender(props.header.column.columnDef.header, props.header.getContext())}
      {props.header.column.getIsSorted() === 'asc' ? ' ↑' : props.header.column.getIsSorted() === 'desc' ? ' ↓' : ''}
    </button>
  );
}

function Field(props: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {props.label}
      {props.children}
    </label>
  );
}

function Toggle(props: { checked: boolean; onClick: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <Button type="button" variant={props.checked ? 'default' : 'outline'} size="sm" onClick={props.onClick}>
      {props.children}
    </Button>
  );
}

function isTerminalStatus(status: string | undefined): boolean {
  const normalized = status?.toLowerCase();
  return normalized === 'completed' || normalized === 'failed' || normalized === 'canceled' || normalized === 'cancelled';
}

function filterRows(rows: AgentRunListItem[], search: FleetSearch): AgentRunListItem[] {
  return rows.filter((row) => {
    if (search.taskId && !row.taskId.includes(search.taskId) && !row.rootTaskId.includes(search.taskId)) return false;
    if (search.hasLlm && row.llmCalls <= 0) return false;
    if (search.hasMemory) {
      const memoryOps = readNumber(row, 'memoryOps');
      if ((memoryOps ?? 0) <= 0) return false;
    }
    if (search.costState === 'captured' && typeof row.costUsd !== 'number') return false;
    if (search.costState === 'missing' && typeof row.costUsd === 'number') return false;
    return true;
  });
}

function readNumber(row: AgentRunListItem, key: string): number | undefined {
  const value = (row as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}
