import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useDeleteSemanticMemory, useMemoryActivity, useMemoryEntities, useProbeSemanticMemory, useRetagSemanticMemory, useSemanticMemory, useSemanticMemoryAudit, useSemanticMemoryDetail, useUpdateSemanticMemory } from '../../api/hooks';
import type { SemanticEntityItem, SemanticMemoryActivityItem, SemanticMemoryAuditItem, SemanticMemoryItem, SemanticProbeResult } from '../../api/client';
import { parseProbeFilterValue, probeSelectionSearchPatch } from '../../domain/probe';
import { parseMemorySearch, type MemorySearch } from '../../app/state';
import { Button } from '../../design/components/ui/button';
import { CopyableId } from '../../design/components/ui/copyable';
import { Notice } from '../../design/components/ui/notice';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../design/components/ui/tabs';
import { formatDateTime, formatNumber, formatRelative } from '../../design/format';
import { JsonPreview } from '../inspector/JsonPreview';
import { JsonEditor, parseJsonAny } from '../inspector/JsonEditor';
import { cn } from '../../lib/utils';
import { useAuth } from '../../app/auth';

export function MemoryPage(): React.ReactElement {
  const search = parseMemorySearch(useSearch({ strict: false }) as Record<string, unknown>);
  const { session } = useAuth();
  const role = session.memberships.find((membership) => membership.tenantId === search.tenantId)?.role;
  const canEdit = role === 'operator' || role === 'admin';
  const canDelete = role === 'admin';
  const navigate = useNavigate({ from: '/memory' });
  const updateSearch = (patch: Partial<MemorySearch>) => void navigate({ search: { ...search, ...patch } });
  const memoryQuery = useSemanticMemory({
    tenantId: search.tenantId,
    key: search.key || undefined,
    tag: search.tag || undefined,
    entity: search.entity || undefined,
    entityType: search.entityType || undefined,
    agentId: search.agentId || undefined,
    taskId: search.taskId || undefined,
    since: search.since || undefined,
    limit: 100,
  });
  const activityQuery = useMemoryActivity({
    tenantId: search.tenantId,
    key: search.key || undefined,
    taskId: search.taskId || undefined,
    agentId: search.agentId || undefined,
    op: search.op || undefined,
    since: search.since || undefined,
    limit: 100,
  });
  const entitiesQuery = useMemoryEntities({
    tenantId: search.tenantId,
    search: search.entity || undefined,
    entityType: search.entityType || undefined,
    limit: 100,
  });
  const selectedKey = search.selectedKey || memoryQuery.data?.items[0]?.key;
  const selectedDetail = useSemanticMemoryDetail(search.tenantId, selectedKey);
  const constrainsMemoryPane = search.tab === 'inventory' || search.tab === 'probe';
  const showsInspector = search.tab === 'inventory' || (search.tab === 'probe' && search.selectedKey.length > 0);
  const refreshAll = () => {
    void memoryQuery.refetch();
    void activityQuery.refetch();
    void entitiesQuery.refetch();
    void selectedDetail.refetch();
  };

  return (
    <div className="grid min-h-0 gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Semantic memory</p>
          <h2 className="text-2xl font-semibold">Memory observation</h2>
          <p className="text-sm text-muted-foreground">Inspect durable facts, activity, retrieval probes, and entity alignments.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground">
            Tenant: <span className="font-mono text-foreground">{search.tenantId}</span>
          </span>
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className={cn('h-4 w-4', memoryQuery.isFetching || activityQuery.isFetching || entitiesQuery.isFetching ? 'animate-spin' : '')} />
            Refresh
          </Button>
        </div>
      </header>

      <MemoryFilters search={search} onChange={updateSearch} />

      {memoryQuery.error instanceof Error ? <Notice kind="error" title="Memory unavailable">{memoryQuery.error.message}</Notice> : null}

      <div
        className={cn(
          'grid gap-4',
          constrainsMemoryPane
            ? 'min-h-0 xl:h-[calc(100vh-285px)] xl:min-h-[520px]'
            : 'min-h-[620px]',
          showsInspector ? 'xl:grid-cols-[minmax(0,1fr)_420px]' : 'xl:grid-cols-1'
        )}
      >
        <section className="flex min-w-0 min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
          <Tabs value={search.tab} onValueChange={(tab) => updateSearch({ tab: tab as MemorySearch['tab'] })} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border px-4 py-3">
              <TabsList className="h-9 justify-start rounded-none bg-transparent p-0">
                {(['overview', 'probe', 'inventory', 'activity', 'entities'] as const).map((tab) => (
                  <TabsTrigger key={tab} value={tab} className="h-9 rounded-none border-b-2 border-transparent px-3 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">
                    {labelForTab(tab)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <TabsContent value="overview" className="m-0 p-4">
              <OverviewTab
                summary={memoryQuery.data?.summary}
                pageInfo={memoryQuery.data?.pageInfo}
                items={memoryQuery.data?.items ?? []}
                activity={activityQuery.data?.items ?? []}
                onFilter={updateSearch}
              />
            </TabsContent>
            <TabsContent value="probe" className="m-0 min-h-0 flex-1 overflow-hidden p-4">
              <ProbeTab tenantId={search.tenantId} selectedKey={search.selectedKey} onSelectKey={(key) => updateSearch(probeSelectionSearchPatch(key))} />
            </TabsContent>
            <TabsContent value="inventory" className="m-0 min-h-0 flex-1 overflow-hidden p-0">
              <InventoryTable
                items={memoryQuery.data?.items ?? []}
                isLoading={memoryQuery.isLoading}
                selectedKey={selectedKey}
                onSelect={(key) => updateSearch({ selectedKey: key })}
              />
            </TabsContent>
            <TabsContent value="activity" className="m-0 p-0">
              <ActivityTable tenantId={search.tenantId} items={activityQuery.data?.items ?? []} isLoading={activityQuery.isLoading} onSelectKey={(key) => updateSearch({ selectedKey: key, key })} />
            </TabsContent>
            <TabsContent value="entities" className="m-0 p-0">
              <EntitiesTable items={entitiesQuery.data?.items ?? []} isLoading={entitiesQuery.isLoading} onSelectKey={(key) => updateSearch({ selectedKey: key, key, tab: 'inventory' })} />
            </TabsContent>
          </Tabs>
        </section>

        {showsInspector ? (
          <MemoryInspector
            tenantId={search.tenantId}
            item={selectedDetail.data}
            isLoading={selectedDetail.isLoading}
            error={selectedDetail.error}
            onKeyChanged={(key) => updateSearch({ selectedKey: key, key })}
            canEdit={canEdit}
            canDelete={canDelete}
            onChanged={() => {
              void memoryQuery.refetch();
              void selectedDetail.refetch();
              void activityQuery.refetch();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function MemoryFilters(props: { search: MemorySearch; onChange: (patch: Partial<MemorySearch>) => void }): React.ReactElement {
  const update = props.onChange;
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-8">
        <Field label="Tenant">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={props.search.tenantId} onChange={(event) => update({ tenantId: event.target.value })} />
        </Field>
        <Field label="Key">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" placeholder="key or prefix" value={props.search.key} onChange={(event) => update({ key: event.target.value })} />
        </Field>
        <Field label="Tag">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" placeholder="tag" value={props.search.tag} onChange={(event) => update({ tag: event.target.value })} />
        </Field>
        <Field label="Entity">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" placeholder="name or alias" value={props.search.entity} onChange={(event) => update({ entity: event.target.value })} />
        </Field>
        <Field label="Entity type">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" placeholder="person, customer" value={props.search.entityType} onChange={(event) => update({ entityType: event.target.value })} />
        </Field>
        <Field label="Agent">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" placeholder="agentId" value={props.search.agentId} onChange={(event) => update({ agentId: event.target.value })} />
        </Field>
        <Field label="Task">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" placeholder="taskId" value={props.search.taskId} onChange={(event) => update({ taskId: event.target.value })} />
        </Field>
        <Field label="Since">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" type="datetime-local" value={props.search.since ? props.search.since.slice(0, 16) : ''} onChange={(event) => update({ since: event.target.value ? new Date(event.target.value).toISOString() : '' })} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {(['', 'read', 'write', 'delete'] as const).map((op) => (
          <Button key={op || 'all'} type="button" variant={props.search.op === op ? 'default' : 'outline'} size="sm" onClick={() => update({ op })}>
            {op || 'All ops'}
          </Button>
        ))}
      </div>
    </section>
  );
}

function OverviewTab(props: {
  summary?: { totalOnPage: number; withBlob: number; withAlignment: number; noTags: number; recentlyRead: number; recentlyWritten: number };
  pageInfo?: { hasMore: boolean; limit: number };
  items: SemanticMemoryItem[];
  activity: SemanticMemoryActivityItem[];
  onFilter: (patch: Partial<MemorySearch>) => void;
}): React.ReactElement {
  const summary = props.summary ?? { totalOnPage: 0, withBlob: 0, withAlignment: 0, noTags: 0, recentlyRead: 0, recentlyWritten: 0 };
  const cards = [
    ['Loaded in view', summary.totalOnPage, {}, props.pageInfo?.hasMore ? `First ${props.pageInfo.limit}` : 'Current filters'],
    ['Recently read', summary.recentlyRead, { tab: 'activity', op: 'read' }],
    ['Recently written', summary.recentlyWritten, { tab: 'activity', op: 'write' }],
    ['No tags', summary.noTags, { tab: 'inventory' }],
    ['Aligned', summary.withAlignment, { tab: 'entities' }],
    ['Blob-backed', summary.withBlob, { tab: 'inventory' }],
  ] as const;
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map(([label, value, patch, helper]) => (
          <button key={label} type="button" className="rounded-lg border border-border bg-background p-3 text-left hover:border-primary/40 hover:bg-accent" onClick={() => props.onFilter(patch as Partial<MemorySearch>)}>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(value)}{label === 'Loaded in view' && props.pageInfo?.hasMore ? '+' : ''}</p>
            {helper ? <p className="mt-1 text-[11px] text-muted-foreground">{helper}</p> : null}
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Recently changed">
          <MiniMemoryList items={props.items.slice(0, 8)} onFilter={props.onFilter} />
        </Panel>
        <Panel title="Recent activity">
          <MiniActivityList items={props.activity.slice(0, 8)} />
        </Panel>
      </div>
    </div>
  );
}

function ProbeTab(props: { tenantId: string; selectedKey?: string; onSelectKey: (key: string) => void }): React.ReactElement {
  const probe = useProbeSemanticMemory();
  const [pattern, setPattern] = useState('');
  const [tag, setTag] = useState('');
  const [expectedKey, setExpectedKey] = useState('');
  const [limit, setLimit] = useState(20);
  const [filterPath, setFilterPath] = useState('');
  const [filterOperator, setFilterOperator] = useState('CONTAINS');
  const [filterValue, setFilterValue] = useState('');
  const runProbe = () => {
    probe.mutate({
      tenantId: props.tenantId,
      pattern: pattern || undefined,
      tag: tag || undefined,
      expectedKey: expectedKey || undefined,
      limit,
      filters: filterPath ? [{ path: filterPath, operator: filterOperator, value: parseProbeFilterValue(filterValue) }] : undefined,
    });
  };
  const result = probe.data;
  return (
    <div className="flex min-h-0 h-full flex-col gap-4">
      <section className="grid shrink-0 gap-3 rounded-lg border border-border bg-background p-3 md:grid-cols-5">
        <Field label="Key pattern">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" placeholder="user:" value={pattern} onChange={(event) => setPattern(event.target.value)} />
        </Field>
        <Field label="Tag">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={tag} onChange={(event) => setTag(event.target.value)} />
        </Field>
        <Field label="Expected key">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={expectedKey} onChange={(event) => setExpectedKey(event.target.value)} />
        </Field>
        <Field label="Limit">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" type="number" min={1} max={200} value={limit} onChange={(event) => setLimit(Number(event.target.value))} />
        </Field>
        <div className="flex items-end">
          <Button type="button" className="w-full" onClick={runProbe} disabled={probe.isPending}>
            <Search className="h-4 w-4" />
            {probe.isPending ? 'Running...' : 'Run probe'}
          </Button>
        </div>
        <Field label="Filter path">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" placeholder="profile.name" value={filterPath} onChange={(event) => setFilterPath(event.target.value)} />
        </Field>
        <Field label="Operator">
          <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={filterOperator} onChange={(event) => setFilterOperator(event.target.value)}>
            {['CONTAINS', '=', '!=', 'STARTS_WITH', 'ENDS_WITH'].map((operator) => <option key={operator}>{operator}</option>)}
          </select>
        </Field>
        <Field label="Filter value">
          <input className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={filterValue} onChange={(event) => setFilterValue(event.target.value)} />
        </Field>
      </section>
      {probe.error instanceof Error ? <Notice kind="error" title="Probe failed">{probe.error.message}</Notice> : null}
      {result ? <ProbeResults result={result} selectedKey={props.selectedKey} onSelectKey={props.onSelectKey} /> : <Notice title="No probe has run">Enter a key pattern, tag, or expected key, then run the probe.</Notice>}
    </div>
  );
}

function ProbeResults(props: { result: SemanticProbeResult; selectedKey?: string; onSelectKey: (key: string) => void }): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {props.result.expected ? (
        <Notice kind={props.result.expected.present ? 'info' : 'warning'} title={props.result.expected.present ? 'Expected key returned' : 'Expected key missing'}>
          {props.result.expected.key}{props.result.expected.rank ? ` at rank ${props.result.expected.rank}` : ''}
        </Notice>
      ) : null}
      {props.result.notes.map((note) => <Notice key={note} kind="info" title="Probe note">{note}</Notice>)}
      <InventoryTable items={props.result.items} isLoading={false} selectedKey={props.selectedKey} onSelect={props.onSelectKey} />
    </div>
  );
}

function InventoryTable(props: { items: SemanticMemoryItem[]; isLoading: boolean; selectedKey?: string; onSelect: (key: string) => void }): React.ReactElement {
  if (props.isLoading) return <div className="h-full overflow-auto p-4 text-sm text-muted-foreground">Loading memory...</div>;
  if (props.items.length === 0) return <div className="h-full overflow-auto p-4"><Notice title="No memories match the current filters" /></div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="min-w-[1120px] w-full text-sm">
        <thead className="sticky top-0 z-10 bg-muted text-xs uppercase text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
          <tr>
            <th className="px-3 py-2 text-left">Key</th>
            <th className="px-3 py-2 text-left">Preview</th>
            <th className="px-3 py-2 text-left">Tags</th>
            <th className="px-3 py-2 text-left">Entities</th>
            <th className="px-3 py-2 text-left">Reads</th>
            <th className="px-3 py-2 text-left">Writes</th>
            <th className="px-3 py-2 text-left">Updated</th>
            <th className="px-3 py-2 text-left">Flags</th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => (
            <tr
              key={item.key}
              role="button"
              tabIndex={0}
              aria-selected={props.selectedKey === item.key}
              className={cn(
                'cursor-pointer border-t border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                props.selectedKey === item.key ? 'bg-info-bg shadow-[inset_3px_0_0_hsl(var(--info))]' : ''
              )}
              onClick={() => props.onSelect(item.key)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  props.onSelect(item.key);
                }
              }}
            >
              <td className="max-w-[220px] px-3 py-2 font-mono text-xs"><CopyableId value={item.key} label="memory key" max={28} /></td>
              <td className="max-w-[280px] truncate px-3 py-2">{shortValue(item.valuePreview)}</td>
              <td className="px-3 py-2"><ChipList values={item.tags} empty="none" /></td>
              <td className="px-3 py-2"><ChipList values={item.entities.map((entity) => entity.canonicalName ?? entity.entityId)} empty="none" /></td>
              <td className="px-3 py-2">{formatNumber(item.activity.reads)}</td>
              <td className="px-3 py-2">{formatNumber(item.activity.writes)}</td>
              <td className="px-3 py-2">{formatRelative(item.updatedAt)}</td>
              <td className="px-3 py-2"><ChipList values={item.flags} empty="ok" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityTable(props: { tenantId: string; items: SemanticMemoryActivityItem[]; isLoading: boolean; onSelectKey: (key: string) => void }): React.ReactElement {
  if (props.isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading activity...</div>;
  if (props.items.length === 0) return <div className="p-4"><Notice title="No memory activity matches the current filters" /></div>;
  return (
    <div className="overflow-auto">
      <table className="min-w-[1060px] w-full text-sm">
        <thead className="bg-muted text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">When</th>
            <th className="px-3 py-2 text-left">Op</th>
            <th className="px-3 py-2 text-left">Agent</th>
            <th className="px-3 py-2 text-left">Task</th>
            <th className="px-3 py-2 text-left">Turn</th>
            <th className="px-3 py-2 text-left">Keys</th>
            <th className="px-3 py-2 text-left">Result keys</th>
            <th className="px-3 py-2 text-left">Status</th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((item) => (
            <tr key={item.id} className="border-t border-border">
              <td className="px-3 py-2">{formatRelative(item.timestamp)}</td>
              <td className="px-3 py-2 font-medium">{item.op}</td>
              <td className="px-3 py-2">{item.agentId ?? 'Not captured'}</td>
              <td className="px-3 py-2">
                <Button asChild variant="ghost" size="sm">
                  <Link to="/runs/$taskId" params={{ taskId: item.taskId }} search={{ tenantId: props.tenantId, tab: 'memory', turn: String(item.turnSeq ?? ''), nodeId: '', scope: 'roots', agentId: '', status: '', since: '', taskId: '', hasLlm: false, hasMemory: false, costState: '' }}>
                    {item.taskId.slice(0, 18)}
                  </Link>
                </Button>
              </td>
              <td className="px-3 py-2">{item.turnSeq ?? 'Not captured'}</td>
              <td className="px-3 py-2"><KeyButtons keys={item.keys} onSelectKey={props.onSelectKey} /></td>
              <td className="px-3 py-2"><KeyButtons keys={item.resultKeys} onSelectKey={props.onSelectKey} /></td>
              <td className="px-3 py-2">{item.status ?? 'Not captured'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EntitiesTable(props: { items: SemanticEntityItem[]; isLoading: boolean; onSelectKey: (key: string) => void }): React.ReactElement {
  if (props.isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading entities...</div>;
  if (props.items.length === 0) return <div className="p-4"><Notice title="No entities match the current filters" /></div>;
  return (
    <div className="overflow-auto">
      <table className="min-w-[920px] w-full text-sm">
        <thead className="bg-muted text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">Canonical name</th>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Aliases</th>
            <th className="px-3 py-2 text-left">Confidence</th>
            <th className="px-3 py-2 text-left">Alignments</th>
            <th className="px-3 py-2 text-left">Memory keys</th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((entity) => (
            <tr key={entity.id} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{entity.canonicalName}</td>
              <td className="px-3 py-2">{entity.entityType}</td>
              <td className="px-3 py-2"><ChipList values={entity.aliases} empty="none" /></td>
              <td className="px-3 py-2">{entity.confidence.toFixed(2)}</td>
              <td className="px-3 py-2">{formatNumber(entity.alignmentCount)}</td>
              <td className="px-3 py-2"><KeyButtons keys={entity.memoryKeys.slice(0, 8)} onSelectKey={props.onSelectKey} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemoryInspector(props: { tenantId: string; item?: SemanticMemoryItem; isLoading: boolean; error: unknown; canEdit: boolean; canDelete: boolean; onChanged: () => void; onKeyChanged: (key: string) => void }): React.ReactElement {
  const retag = useRetagSemanticMemory();
  const updateMemory = useUpdateSemanticMemory();
  const remove = useDeleteSemanticMemory();
  const auditQuery = useSemanticMemoryAudit(props.tenantId, props.item?.key, 10);
  const [draftTags, setDraftTags] = useState(props.item?.tags ?? []);
  const [newTag, setNewTag] = useState('');
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const [draftKey, setDraftKey] = useState(props.item?.key ?? '');
  const [valueEditorOpen, setValueEditorOpen] = useState(false);
  const [draftValue, setDraftValue] = useState(prettyJsonForEdit(props.item?.value ?? props.item?.valuePreview));

  useEffect(() => {
    setDraftTags(props.item?.tags ?? []);
    setNewTag('');
    setTagEditorOpen(false);
    setKeyEditorOpen(false);
    setDraftKey(props.item?.key ?? '');
    setValueEditorOpen(false);
    setDraftValue(prettyJsonForEdit(props.item?.value ?? props.item?.valuePreview));
  }, [props.item?.key, props.item?.tags, props.item?.value, props.item?.valuePreview]);

  const tagSuggestions = useMemo(() => props.item ? suggestTags(props.item) : [], [props.item]);
  const visibleTagSuggestions = useMemo(
    () => tagSuggestions
      .filter((tag) => !draftTags.includes(tag))
      .filter((tag) => newTag.trim().length === 0 || tag.toLowerCase().includes(newTag.trim().toLowerCase()))
      .slice(0, 8),
    [draftTags, newTag, tagSuggestions]
  );
  const tagsChanged = props.item ? !sameTags(draftTags, props.item.tags) : false;
  const valueChanged = draftValue !== prettyJsonForEdit(props.item?.value ?? props.item?.valuePreview);

  if (props.isLoading) return <aside className="min-h-0 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground xl:h-full">Loading selected memory...</aside>;
  if (props.error instanceof Error) return <aside className="min-h-0 rounded-lg border border-border bg-card p-4 xl:h-full"><Notice kind="error" title="Could not load selected memory">{props.error.message}</Notice></aside>;
  if (!props.item) return <aside className="min-h-0 rounded-lg border border-border bg-card p-4 xl:h-full"><Notice title="No memory selected">Select a memory row, result key, or entity alignment to inspect details.</Notice></aside>;
  const item = props.item;

  const saveTags = () => {
    const reason = window.prompt('Reason for retagging this memory?');
    if (reason === null || reason.trim().length === 0) return;
    retag.mutate({ tenantId: props.tenantId, key: item.key, tags: draftTags, reason: reason.trim() }, {
      onSuccess: () => {
        setTagEditorOpen(false);
        props.onChanged();
      },
    });
  };
  const saveKey = () => {
    const nextKey = draftKey.trim();
    if (!nextKey || nextKey === item.key) {
      setDraftKey(item.key);
      setKeyEditorOpen(false);
      return;
    }
    const reason = window.prompt('Reason for changing this memory key?');
    if (reason === null || reason.trim().length === 0) return;
    updateMemory.mutate({ tenantId: props.tenantId, key: item.key, nextKey, reason: reason.trim() }, {
      onSuccess: (result) => {
        setKeyEditorOpen(false);
        props.onKeyChanged(result.key);
        props.onChanged();
      },
    });
  };
  const saveValue = () => {
    const parsed = parseJsonAny(draftValue);
    if (!parsed.ok) {
      window.alert(`Invalid JSON: ${parsed.message}`);
      return;
    }
    const reason = window.prompt('Reason for changing this memory value?');
    if (reason === null || reason.trim().length === 0) return;
    updateMemory.mutate({ tenantId: props.tenantId, key: item.key, value: parsed.value, reason: reason.trim() }, {
      onSuccess: () => {
        setValueEditorOpen(false);
        props.onChanged();
      },
    });
  };
  const addTag = (tag: string) => {
    const normalized = tag.trim();
    if (!normalized || draftTags.includes(normalized)) return;
    setDraftTags([...draftTags, normalized]);
    setNewTag('');
  };
  const removeTag = (tag: string) => {
    setDraftTags(draftTags.filter((candidate) => candidate !== tag));
  };
  const removeTagAndEdit = (tag: string) => {
    setDraftTags(draftTags.filter((candidate) => candidate !== tag));
    setTagEditorOpen(true);
  };
  const runDelete = () => {
    const confirmKey = window.prompt(`Type the exact memory key to delete:\n${item.key}`);
    if (confirmKey === null) return;
    const reason = window.prompt('Reason for deleting this memory?');
    if (reason === null || reason.trim().length === 0) return;
    remove.mutate({ tenantId: props.tenantId, key: item.key, confirmKey, reason: reason.trim() }, { onSuccess: props.onChanged });
  };

  return (
    <>
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card xl:h-full">
      <div className="shrink-0 border-b border-border p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Selected memory</p>
        {keyEditorOpen ? (
          <div className="mt-1 grid gap-2">
            <input
              className="min-w-0 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm"
              value={draftKey}
              autoFocus
              onChange={(event) => setDraftKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveKey();
                if (event.key === 'Escape') {
                  setDraftKey(item.key);
                  setKeyEditorOpen(false);
                }
              }}
            />
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={saveKey} disabled={updateMemory.isPending || draftKey.trim() === item.key || draftKey.trim().length === 0}>
                {updateMemory.isPending ? 'Saving...' : 'Save key'}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => {
                setDraftKey(item.key);
                setKeyEditorOpen(false);
              }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate font-mono text-sm font-semibold">{props.item.key}</h3>
            {props.canEdit ? <Button type="button" variant="outline" size="icon" className="h-6 w-6 shrink-0" title="Edit key" aria-label="Edit key" onClick={() => setKeyEditorOpen(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button> : null}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {props.canDelete ? <Button variant="ghost" size="sm" onClick={runDelete} disabled={remove.isPending} className="text-danger hover:bg-danger-bg hover:text-danger">
            <Trash2 className="h-4 w-4" />
            Delete
          </Button> : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Updated {formatRelative(item.updatedAt)}</span>
          <span>{formatNumber(item.activity.reads)} reads</span>
          <span>{formatNumber(item.activity.writes)} writes</span>
          {item.hasBlob ? <span>blob</span> : null}
          {item.flags.length > 0 ? <ChipList values={item.flags} empty="ok" /> : null}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-4">
        {retag.error instanceof Error ? <Notice kind="error" title="Retag failed">{retag.error.message}</Notice> : null}
        {updateMemory.error instanceof Error ? <Notice kind="error" title="Update failed">{updateMemory.error.message}</Notice> : null}
        {remove.error instanceof Error ? <Notice kind="error" title="Delete failed">{remove.error.message}</Notice> : null}
        <Panel title="Tags">
          <div className="grid gap-3">
            {!props.canEdit ? <ChipList values={draftTags} empty="none" /> : !tagEditorOpen ? (
              <div className="flex items-center justify-between gap-2">
                <EditableTags tags={draftTags} onRemove={removeTagAndEdit} compact />
                <Button type="button" variant="outline" size="icon" className="h-6 w-6 shrink-0" title="Add tag" aria-label="Add tag" onClick={() => setTagEditorOpen(true)}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <>
                <EditableTags tags={draftTags} onRemove={removeTag} />
                <div className="flex gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    placeholder="Type to add or search tags"
                    value={newTag}
                    autoFocus
                    onChange={(event) => setNewTag(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addTag(newTag);
                      } else if (event.key === 'Escape') {
                        setDraftTags(item.tags);
                        setNewTag('');
                        setTagEditorOpen(false);
                      }
                    }}
                  />
                  <Button type="button" variant="outline" size="sm" onClick={() => addTag(newTag)} disabled={newTag.trim().length === 0}>Add</Button>
                </div>
                {visibleTagSuggestions.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {visibleTagSuggestions.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-info hover:bg-info-bg"
                        onClick={() => addTag(tag)}
                      >
                        + {tag}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" onClick={saveTags} disabled={!tagsChanged || retag.isPending}>
                    {retag.isPending ? 'Saving...' : 'Save tags'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraftTags(item.tags);
                      setNewTag('');
                      setTagEditorOpen(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        </Panel>
        <Panel title="Value">
          <div className="grid gap-2">
            <div className="flex justify-end">
              {props.canEdit ? <Button type="button" variant="outline" size="icon" className="h-7 w-7" title="Edit JSON" aria-label="Edit JSON" onClick={() => setValueEditorOpen(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button> : null}
            </div>
            <JsonPreview value={props.item.value ?? props.item.valuePreview} tenantId={props.tenantId} defaultExpanded maxRawHeight={420} />
          </div>
        </Panel>
        <Panel title="Audit history">
          <AuditHistory items={auditQuery.data?.items ?? []} isLoading={auditQuery.isLoading} error={auditQuery.error} tenantId={props.tenantId} />
        </Panel>
        <Panel title="Entities">
          {props.item.entities.length > 0 ? props.item.entities.map((entity) => (
            <div key={`${entity.entityId}:${entity.fieldPath}`} className="rounded-md border border-border bg-background p-2 text-sm">
              <div className="font-medium">{entity.canonicalName ?? entity.entityId}</div>
              <div className="text-xs text-muted-foreground">{entity.fieldPath} from {entity.originalValue ?? 'unknown'} ({entity.confidence ?? 'unknown'})</div>
            </div>
          )) : <p className="text-sm text-muted-foreground">No alignments captured.</p>}
        </Panel>
        {props.item.blobMetadata ? (
          <Panel title="Blob metadata">
            <JsonPreview value={props.item.blobMetadata} tenantId={props.tenantId} maxRawHeight={240} />
          </Panel>
        ) : null}
        <Notice kind="warning" title={props.canEdit ? 'Mutations are audited' : 'Read-only access'}>
          {props.canEdit ? 'Key, value, tag, and delete changes require a reason and are recorded as operator audit events.' : 'Your tenant role can inspect memory but cannot change it.'}
        </Notice>
      </div>
    </aside>
    {valueEditorOpen && props.canEdit ? (
      <JsonValueEditorModal
        memoryKey={item.key}
        value={draftValue}
        changed={valueChanged}
        saving={updateMemory.isPending}
        error={updateMemory.error instanceof Error ? updateMemory.error.message : undefined}
        onChange={setDraftValue}
        onSave={saveValue}
        onClose={() => {
          setDraftValue(prettyJsonForEdit(item.value ?? item.valuePreview));
          setValueEditorOpen(false);
        }}
      />
    ) : null}
    </>
  );
}

function AuditHistory(props: { items: SemanticMemoryAuditItem[]; isLoading: boolean; error: unknown; tenantId: string }): React.ReactElement {
  if (props.isLoading) return <p className="text-sm text-muted-foreground">Loading audit events...</p>;
  if (props.error instanceof Error) return <Notice kind="error" title="Could not load audit history">{props.error.message}</Notice>;
  if (props.items.length === 0) return <p className="text-sm text-muted-foreground">No operator changes recorded for this memory.</p>;
  return (
    <div className="grid gap-2">
      {props.items.map((item) => (
        <details key={item.id} className="group rounded-md border border-border bg-background p-2 text-sm">
          <summary className="grid cursor-pointer list-none gap-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {auditActionLabel(item)}
                </span>
                <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium', auditStatusClass(item))}>
                  {item.resultStatus ?? (item.accepted ? 'accepted' : 'rejected')}
                </span>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(item.requestedAt)}</span>
            </div>
            <p className="break-words text-sm text-foreground">{item.reason || 'No reason captured.'}</p>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>{item.actorId}</span>
              <span>{item.actorType}</span>
              <span>{auditChangeSummary(item)}</span>
            </div>
          </summary>
          <div className="mt-2 grid gap-2 border-t border-border pt-2">
            <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
              <span className="text-muted-foreground">Requested</span>
              <span>{formatDateTime(item.requestedAt)}</span>
              <span className="text-muted-foreground">Action</span>
              <span className="font-mono">{item.action}</span>
              {item.errorCode ? (
                <>
                  <span className="text-muted-foreground">Error</span>
                  <span>{item.errorCode}</span>
                </>
              ) : null}
            </div>
            {item.metadata ? <JsonPreview value={item.metadata} tenantId={props.tenantId} maxRawHeight={180} /> : null}
          </div>
        </details>
      ))}
    </div>
  );
}

function auditActionLabel(item: SemanticMemoryAuditItem): string {
  if (item.action === 'memory.retag') return 'tags changed';
  if (item.action === 'memory.delete') return item.accepted ? 'deleted' : 'delete attempted';
  const metadata = item.metadata ?? {};
  if (metadata.keyChanged === true) return 'key renamed';
  if (metadata.valueChanged === true) return 'value edited';
  return 'memory updated';
}

function auditStatusClass(item: SemanticMemoryAuditItem): string {
  if (item.resultStatus === 'completed' || item.accepted) return 'bg-emerald-50 text-emerald-800';
  if (item.resultStatus === 'failed') return 'bg-rose-50 text-rose-800';
  return 'bg-amber-50 text-amber-800';
}

function auditChangeSummary(item: SemanticMemoryAuditItem): string {
  const metadata = item.metadata ?? {};
  const changes: string[] = [];
  if (metadata.keyChanged === true) changes.push('key');
  if (metadata.valueChanged === true) changes.push('value');
  if (Array.isArray(metadata.tags)) changes.push(`${metadata.tags.length} tags`);
  if (typeof metadata.errorCode === 'string') changes.push(metadata.errorCode);
  return changes.length > 0 ? changes.join(', ') : 'metadata recorded';
}

function MiniMemoryList(props: { items: SemanticMemoryItem[]; onFilter: (patch: Partial<MemorySearch>) => void }): React.ReactElement {
  if (props.items.length === 0) return <p className="text-sm text-muted-foreground">No memory rows loaded.</p>;
  return (
    <div className="grid gap-2">
      {props.items.map((item) => (
        <button key={item.key} type="button" className="rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => props.onFilter({ selectedKey: item.key, tab: 'inventory' })}>
          <div className="truncate font-mono text-xs">{item.key}</div>
          <div className="mt-1 text-xs text-muted-foreground">Updated {formatRelative(item.updatedAt)}</div>
        </button>
      ))}
    </div>
  );
}

function JsonValueEditorModal(props: {
  memoryKey: string;
  value: string;
  changed: boolean;
  saving: boolean;
  error?: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}): React.ReactElement {
  const validation = useMemo(() => parseJsonAny(props.value), [props.value]);
  const [copied, setCopied] = useState(false);
  const formatValue = () => {
    if (!validation.ok) return;
    props.onChange(JSON.stringify(validation.value, null, 2));
  };
  const copyValue = () => {
    void navigator.clipboard.writeText(props.value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="memory-json-editor-title">
      <div className="flex max-h-[90vh] w-full max-w-5xl min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <header className="flex min-w-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Edit memory value</p>
            <h3 id="memory-json-editor-title" className="mt-1 truncate font-mono text-sm font-semibold">{props.memoryKey}</h3>
            <p className="mt-1 text-xs text-muted-foreground">Save requires an audit reason. The value must be valid JSON.</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" size="sm" onClick={props.onSave} disabled={!props.changed || props.saving || !validation.ok}>
              {props.saving ? 'Saving...' : 'Save value'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={props.onClose}>
              Cancel
            </Button>
          </div>
        </header>
        <div className="grid min-h-0 flex-1 gap-3 p-4">
          {props.error ? <Notice kind="error" title="Save failed">{props.error}</Notice> : null}
          <JsonEditor
            value={props.value}
            validation={validation}
            copied={copied}
            onChange={props.onChange}
            onFormat={formatValue}
            onCopy={copyValue}
            onSubmitShortcut={() => {
              if (props.changed && !props.saving && validation.ok) props.onSave();
            }}
            ariaLabel="Memory value JSON editor"
            minHeight={420}
            fullscreenHeightClass="h-[calc(100vh-9rem)]"
          />
        </div>
      </div>
    </div>
  );
}

function MiniActivityList(props: { items: SemanticMemoryActivityItem[] }): React.ReactElement {
  if (props.items.length === 0) return <p className="text-sm text-muted-foreground">No activity captured.</p>;
  return (
    <div className="grid gap-2">
      {props.items.map((item) => (
        <div key={item.id} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{item.op}</span>
            <span className="text-xs text-muted-foreground">{formatRelative(item.timestamp)}</span>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{[...item.keys, ...item.resultKeys].join(', ') || 'No keys captured'}</div>
        </div>
      ))}
    </div>
  );
}

function Panel(props: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="grid gap-3 rounded-lg border border-border bg-card p-3">
      <h4 className="text-sm font-semibold">{props.title}</h4>
      {props.children}
    </section>
  );
}

function Field(props: { label: string; children: React.ReactNode }): React.ReactElement {
  return <label className="grid gap-1 text-xs font-medium text-muted-foreground">{props.label}{props.children}</label>;
}

function ChipList(props: { values: string[]; empty: string }): React.ReactElement {
  if (props.values.length === 0) return <span className="text-xs text-muted-foreground">{props.empty}</span>;
  return (
    <span className="inline-flex max-w-full flex-wrap gap-1">
      {props.values.slice(0, 5).map((value) => (
        <span key={value} className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">{value}</span>
      ))}
      {props.values.length > 5 ? <span className="text-xs text-muted-foreground">+{props.values.length - 5}</span> : null}
    </span>
  );
}

function EditableTags(props: { tags: string[]; onRemove: (tag: string) => void; compact?: boolean }): React.ReactElement {
  if (props.tags.length === 0) return <span className="text-xs text-muted-foreground">none</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {props.tags.map((tag) => (
        <span key={tag} className={cn('inline-flex items-center gap-1 rounded border border-border bg-background text-foreground', props.compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-1.5 py-0.5 text-xs')}>
          {tag}
          <button
            type="button"
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded text-muted-foreground hover:bg-danger-bg hover:text-danger"
            aria-label={`Remove ${tag}`}
            title={`Remove ${tag}`}
            onClick={() => props.onRemove(tag)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

function KeyButtons(props: { keys: string[]; onSelectKey: (key: string) => void }): React.ReactElement {
  if (props.keys.length === 0) return <span className="text-muted-foreground">Not captured</span>;
  return (
    <span className="inline-flex max-w-[280px] flex-wrap gap-1">
      {props.keys.slice(0, 4).map((key) => (
        <button key={key} type="button" className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-info hover:bg-info-bg" onClick={() => props.onSelectKey(key)}>
          {key.length > 22 ? `${key.slice(0, 10)}...${key.slice(-8)}` : key}
        </button>
      ))}
      {props.keys.length > 4 ? <span className="text-xs text-muted-foreground">+{props.keys.length - 4}</span> : null}
    </span>
  );
}

function shortValue(value: unknown): string {
  if (value === undefined || value === null) return 'empty';
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return raw.length > 90 ? `${raw.slice(0, 87)}...` : raw;
}

function prettyJsonForEdit(value: unknown): string {
  try {
    const formatted = JSON.stringify(value, null, 2);
    return formatted === undefined ? 'null' : formatted;
  } catch {
    return String(value ?? null);
  }
}

function suggestTags(item: SemanticMemoryItem): string[] {
  const suggestions = new Set<string>();
  const keyPrefix = item.key.split(':')[0];
  if (keyPrefix && keyPrefix !== item.key) suggestions.add(keyPrefix);
  for (const flag of item.flags) {
    if (flag === 'blob' || flag === 'aligned') suggestions.add(flag);
  }
  for (const entity of item.entities) {
    if (entity.entityType) suggestions.add(entity.entityType);
    if (entity.fieldPath) suggestions.add(entity.fieldPath.split('.')[0] ?? entity.fieldPath);
  }
  if (item.activity.reads === 0) suggestions.add('needs-review');
  return [...suggestions].filter((tag) => tag.length > 0).slice(0, 12);
}

function sameTags(left: string[], right: string[]): boolean {
  const normalize = (values: string[]) => [...new Set(values)].sort().join('\u0000');
  return normalize(left) === normalize(right);
}

function labelForTab(tab: MemorySearch['tab']): string {
  switch (tab) {
    case 'overview':
      return 'Overview';
    case 'probe':
      return 'Probe';
    case 'inventory':
      return 'Inventory';
    case 'activity':
      return 'Activity';
    case 'entities':
      return 'Entities';
  }
}
