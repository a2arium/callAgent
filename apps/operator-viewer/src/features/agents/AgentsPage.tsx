import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, Pencil, Plus, Play, RefreshCw, Rocket, X } from 'lucide-react';
import { useAgents } from '../../api/hooks';
import { runAgent, type ListedAgent } from '../../api/client';
import { Button } from '../../design/components/ui/button';
import { CopyableId } from '../../design/components/ui/copyable';
import { Notice } from '../../design/components/ui/notice';
import { cn } from '../../lib/utils';
import {
  createPayloadPreset,
  loadAgentPayloadPresetState,
  saveAgentPayloadPresetState,
  type AgentPayloadPresetState,
} from './payloadPresets';

type RunState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'error'; message: string }
  | { state: 'accepted'; taskId: string; status?: string };

const AGENT_USAGE_STORAGE_KEY = 'operator-viewer.agent-usage.v1';
const AGENT_VIEW_STORAGE_KEY = 'operator-viewer.agent-view.v1';
const DEFAULT_VISIBLE_AGENTS_PER_WORKSPACE = 5;

type AgentUsageState = {
  latestWorkspaceName?: string;
  usedAtByAgentId: Record<string, string>;
};

type AgentViewState = {
  selectedAgentId?: string;
  expandedWorkspaceNames: string[];
  showAllWorkspaceNames: string[];
};

export function AgentsPage(): React.ReactElement {
  const query = useAgents();
  const navigate = useNavigate();
  const agents = query.data?.items ?? [];
  const [usageState, setUsageState] = useState<AgentUsageState>(() => loadAgentUsageState());
  const [viewState, setViewState] = useState<AgentViewState>(() => loadAgentViewState());
  const [selectedAgentId, setSelectedAgentId] = useState<string>(viewState.selectedAgentId ?? '');
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? agents[0],
    [agents, selectedAgentId]
  );
  const [tenantId, setTenantId] = useState('default');
  const [presetState, setPresetState] = useState<AgentPayloadPresetState>(() => loadAgentPayloadPresetState('__initial__'));
  const [runState, setRunState] = useState<RunState>({ state: 'idle' });

  const groupedAgents = useMemo(() => groupAgents(agents, usageState), [agents, usageState]);
  const selectedPreset = presetState.presets.find((preset) => preset.id === presetState.selectedPresetId) ?? presetState.presets[0];

  const markAgentUsed = (agent: ListedAgent) => {
    const next = recordAgentUsage(usageState, agent);
    setUsageState(next);
    saveAgentUsageState(next);
  };

  const updateViewState = (next: AgentViewState) => {
    setViewState(next);
    saveAgentViewState(next);
  };

  const selectAgent = (agent: ListedAgent) => {
    setSelectedAgentId(agent.id);
    updateViewState({ ...viewState, selectedAgentId: agent.id });
  };

  useEffect(() => {
    if (!selectedAgent) return;
    setPresetState(loadAgentPayloadPresetState(selectedAgent.id));
    setRunState({ state: 'idle' });
  }, [selectedAgent?.id]);

  useEffect(() => {
    if (!selectedAgent) return;
    saveAgentPayloadPresetState(selectedAgent.id, presetState);
  }, [presetState, selectedAgent?.id]);

  async function submitRun(): Promise<void> {
    if (!selectedAgent) {
      setRunState({ state: 'error', message: 'Select an agent first.' });
      return;
    }

    const parsed = parsePayload(selectedPreset?.payloadText ?? '{}');
    if (!parsed.ok) {
      setRunState({ state: 'error', message: parsed.message });
      return;
    }

    setRunState({ state: 'running' });
    markAgentUsed(selectedAgent);
    try {
      const response = await runAgent({
        tenantId,
        agentId: selectedAgent.id,
        payload: parsed.value,
      });
      if (response.error) {
        setRunState({ state: 'error', message: response.error.message });
        return;
      }
      const taskId = response.result?.id;
      if (!taskId) {
        setRunState({ state: 'error', message: 'Runtime accepted the request but did not return a task id.' });
        return;
      }
      setRunState({ state: 'accepted', taskId, status: response.result?.status?.state });
      await navigate({
        to: '/runs/$taskId',
        params: { taskId },
        search: {
          tenantId,
          agentId: '',
          status: '',
          since: '',
          taskId: '',
          hasLlm: false,
          hasMemory: false,
          costState: '',
          nodeId: '',
          turn: '',
          tab: 'summary',
        },
      });
    } catch (error) {
      setRunState({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Agents</p>
          <h2 className="text-2xl font-semibold">Run an agent</h2>
          <p className="text-sm text-muted-foreground">
            Select a registered agent, provide JSON input, and launch it through the runtime host.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          <RefreshCw className={cn('h-4 w-4', query.isFetching ? 'animate-spin' : '')} />
          Refresh
        </Button>
      </header>

      {query.error instanceof Error ? (
        <Notice kind="error" title="Agent registry unavailable">
          Failed to load /agents: {query.error.message}. Make sure runtime-host is running.
        </Notice>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[minmax(280px,420px)_1fr]">
        <div className="grid gap-3 self-start">
          {groupedAgents.length === 0 && !query.isLoading ? (
            <Notice title="No agents registered">
              Configure `.callagent/workspaces.json`, restart the runtime, then refresh this page.
            </Notice>
          ) : null}
          {query.isLoading ? (
            <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Loading agents...</div>
          ) : null}
          {groupedAgents.map((group) => (
            <AgentGroup
              key={group.workspaceName}
              workspaceName={group.workspaceName}
              agents={group.agents}
              expanded={
                viewState.expandedWorkspaceNames.length > 0
                  ? viewState.expandedWorkspaceNames.includes(group.workspaceName)
                  : group.workspaceName === (usageState.latestWorkspaceName ?? groupedAgents[0]?.workspaceName)
              }
              showAll={viewState.showAllWorkspaceNames.includes(group.workspaceName)}
              selectedAgentId={selectedAgent?.id}
              onExpandedChange={(expanded) => {
                const names = new Set(viewState.expandedWorkspaceNames);
                if (expanded) names.add(group.workspaceName);
                else names.delete(group.workspaceName);
                updateViewState({ ...viewState, expandedWorkspaceNames: Array.from(names) });
              }}
              onShowAllChange={(showAll) => {
                const names = new Set(viewState.showAllWorkspaceNames);
                if (showAll) names.add(group.workspaceName);
                else names.delete(group.workspaceName);
                updateViewState({ ...viewState, showAllWorkspaceNames: Array.from(names) });
              }}
              onSelect={selectAgent}
            />
          ))}
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          {selectedAgent ? (
            <AgentRunner
              agent={selectedAgent}
              tenantId={tenantId}
              presetState={presetState}
              runState={runState}
              onTenantId={setTenantId}
              onPresetState={setPresetState}
              onSubmit={() => void submitRun()}
            />
          ) : (
            <Notice title="Select an agent">Choose an agent from the registry to prepare a run.</Notice>
          )}
        </div>
      </section>
    </div>
  );
}

function AgentGroup(props: {
  workspaceName: string;
  agents: ListedAgent[];
  expanded: boolean;
  showAll: boolean;
  selectedAgentId: string | undefined;
  onExpandedChange: (expanded: boolean) => void;
  onShowAllChange: (showAll: boolean) => void;
  onSelect: (agent: ListedAgent) => void;
}): React.ReactElement {
  const visibleAgents = props.showAll ? props.agents : props.agents.slice(0, DEFAULT_VISIBLE_AGENTS_PER_WORKSPACE);
  const hiddenCount = props.agents.length - visibleAgents.length;

  return (
    <section className="rounded-xl border border-border bg-card p-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left hover:bg-accent"
        onClick={() => props.onExpandedChange(!props.expanded)}
        aria-expanded={props.expanded}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', props.expanded ? '' : '-rotate-90')} />
          <h3 className="truncate text-sm font-semibold">{props.workspaceName}</h3>
        </div>
        <span className="rounded-full bg-secondary px-2 py-1 text-xs text-secondary-foreground">{props.agents.length}</span>
      </button>
      {props.expanded ? (
      <div className="mt-2 grid gap-2">
        {visibleAgents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={cn(
              'rounded-lg border p-3 text-left transition-colors hover:bg-accent',
              props.selectedAgentId === agent.id ? 'border-primary bg-accent text-accent-foreground' : 'border-border'
            )}
            onClick={() => props.onSelect(agent)}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{agent.name}</span>
              <span className="font-mono text-xs text-muted-foreground">v{agent.version}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{agent.description}</p>
          </button>
        ))}
        {hiddenCount > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={() => props.onShowAllChange(true)}>
            Show {hiddenCount} more
          </Button>
        ) : props.agents.length > DEFAULT_VISIBLE_AGENTS_PER_WORKSPACE ? (
          <Button type="button" variant="outline" size="sm" onClick={() => props.onShowAllChange(false)}>
            Show less
          </Button>
        ) : null}
      </div>
      ) : null}
    </section>
  );
}

function AgentRunner(props: {
  agent: ListedAgent;
  tenantId: string;
  presetState: AgentPayloadPresetState;
  runState: RunState;
  onTenantId: (value: string) => void;
  onPresetState: (value: AgentPayloadPresetState) => void;
  onSubmit: () => void;
}): React.ReactElement {
  const selectedPreset =
    props.presetState.presets.find((preset) => preset.id === props.presetState.selectedPresetId) ??
    props.presetState.presets[0];
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
  const parsedPayload = useMemo(() => parsePayload(selectedPreset?.payloadText ?? '{}'), [selectedPreset?.payloadText]);

  const updateSelectedPreset = (patch: { name?: string; payloadText?: string }) => {
    if (!selectedPreset) return;
    props.onPresetState(updatePresetState(props.presetState, selectedPreset.id, patch));
  };

  const updatePreset = (presetId: string, patch: { name?: string; payloadText?: string }) => {
    props.onPresetState(updatePresetState(props.presetState, presetId, patch));
  };

  const addPreset = () => {
    const preset = createPayloadPreset(`Payload ${props.presetState.presets.length + 1}`);
    props.onPresetState({
      selectedPresetId: preset.id,
      presets: [...props.presetState.presets, preset],
    });
  };

  const deletePreset = (presetId: string) => {
    if (props.presetState.presets.length <= 1) return;
    const remaining = props.presetState.presets.filter((preset) => preset.id !== presetId);
    const selectedPresetId =
      props.presetState.selectedPresetId === presetId
        ? remaining[0]?.id ?? ''
        : props.presetState.selectedPresetId;
    props.onPresetState({
      selectedPresetId,
      presets: remaining,
    });
    if (renamingPresetId === presetId) {
      setRenamingPresetId(null);
    }
  };

  const formatPayload = () => {
    if (!selectedPreset || !parsedPayload.ok) return;
    updateSelectedPreset({ payloadText: JSON.stringify(parsedPayload.value, null, 2) });
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Rocket className="h-5 w-5 text-primary" />
            <h3 className="text-xl font-semibold">{props.agent.name}</h3>
            <span className="rounded-md border border-border px-2 py-1 font-mono text-xs text-muted-foreground">
              {props.agent.workspace?.name ?? 'built-in'}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{props.agent.description}</p>
        </div>
        <CopyableId value={props.agent.id} label="agent id" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Field label="Tenant">
          <input
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={props.tenantId}
            onChange={(event) => props.onTenantId(event.target.value)}
          />
        </Field>
        <Field label="Input modes">
          <div className="flex min-h-9 flex-wrap items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground">
            {props.agent.defaultInputModes.join(', ') || 'not specified'}
          </div>
        </Field>
      </div>

      <section className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Payload JSON</label>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={formatPayload} disabled={!parsedPayload.ok}>
              Format JSON
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={addPreset} aria-label="Add payload preset">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {props.presetState.presets.map((preset) => (
            <div
              key={preset.id}
              className={cn(
                'group inline-flex h-9 items-center gap-1 rounded-md border px-2 text-xs transition-colors hover:bg-accent',
                preset.id === selectedPreset?.id
                  ? 'border-primary bg-accent text-accent-foreground'
                  : 'border-border text-muted-foreground'
              )}
            >
              {renamingPresetId === preset.id ? (
                <input
                  className="h-6 w-32 rounded border border-input bg-background px-2 text-xs text-foreground"
                  value={preset.name}
                  autoFocus
                  onChange={(event) => updatePreset(preset.id, { name: event.target.value })}
                  onBlur={() => setRenamingPresetId(null)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'Escape') {
                      setRenamingPresetId(null);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="max-w-40 truncate"
                  onClick={() => props.onPresetState({ ...props.presetState, selectedPresetId: preset.id })}
                  onDoubleClick={() => setRenamingPresetId(preset.id)}
                  title="Double-click to rename"
                >
                  {preset.name || 'Untitled'}
                </button>
              )}
              <button
                type="button"
                className="rounded p-1 opacity-60 hover:bg-background/70 hover:opacity-100"
                aria-label={`Rename ${preset.name}`}
                onClick={() => setRenamingPresetId(preset.id)}
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                className="rounded p-1 opacity-60 hover:bg-background/70 hover:opacity-100 disabled:pointer-events-none disabled:opacity-25"
                aria-label={`Delete ${preset.name}`}
                disabled={props.presetState.presets.length <= 1}
                onClick={() => deletePreset(preset.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        <textarea
          className="min-h-[420px] rounded-lg border border-input bg-background p-3 font-mono text-xs leading-5 text-foreground"
          spellCheck={false}
          value={selectedPreset?.payloadText ?? '{}'}
          onChange={(event) => updateSelectedPreset({ payloadText: event.target.value })}
          aria-invalid={!parsedPayload.ok}
        />
        {parsedPayload.ok ? (
          <p className="text-xs text-emerald-700 dark:text-emerald-300">Valid JSON object</p>
        ) : (
          <p className="text-xs text-rose-700 dark:text-rose-300">{parsedPayload.message}</p>
        )}
      </section>

      {props.runState.state === 'error' ? (
        <Notice kind="error" title="Run failed">{props.runState.message}</Notice>
      ) : null}
      {props.runState.state === 'accepted' ? (
        <Notice title="Run accepted">
          Task <span className="font-mono">{props.runState.taskId}</span>
          {props.runState.status ? ` is ${props.runState.status}.` : ' was created.'}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Notice kind="unsafe" title="Developer launcher">
          Payloads are sent as raw JSON. Do not paste secrets into the payload.
        </Notice>
        <Button type="button" onClick={props.onSubmit} disabled={props.runState.state === 'running' || !parsedPayload.ok}>
          <Play className="h-4 w-4" />
          {props.runState.state === 'running' ? 'Starting...' : 'Run agent'}
        </Button>
      </div>
    </div>
  );
}

function updatePresetState(
  state: AgentPayloadPresetState,
  presetId: string,
  patch: { name?: string; payloadText?: string }
): AgentPayloadPresetState {
  return {
    selectedPresetId: state.selectedPresetId,
    presets: state.presets.map((preset) =>
      preset.id === presetId
        ? {
            ...preset,
            ...patch,
            updatedAt: new Date().toISOString(),
          }
        : preset
    ),
  };
}

function Field(props: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}

function groupAgents(agents: ListedAgent[], usageState: AgentUsageState): Array<{ workspaceName: string; agents: ListedAgent[] }> {
  const groups = new Map<string, ListedAgent[]>();
  for (const agent of agents) {
    const workspaceName = agent.workspace?.name ?? 'built-in';
    groups.set(workspaceName, [...(groups.get(workspaceName) ?? []), agent]);
  }
  return Array.from(groups.entries())
    .map(([workspaceName, group]) => ({
      workspaceName,
      agents: [...group].sort((left, right) => compareAgentsByUsage(left, right, usageState)),
    }))
    .sort((left, right) => {
      if (left.workspaceName === usageState.latestWorkspaceName) return -1;
      if (right.workspaceName === usageState.latestWorkspaceName) return 1;
      return left.workspaceName.localeCompare(right.workspaceName);
    });
}

function compareAgentsByUsage(left: ListedAgent, right: ListedAgent, usageState: AgentUsageState): number {
  const leftUsedAt = usageState.usedAtByAgentId[left.id] ?? '';
  const rightUsedAt = usageState.usedAtByAgentId[right.id] ?? '';
  if (leftUsedAt !== rightUsedAt) {
    return rightUsedAt.localeCompare(leftUsedAt);
  }
  return left.name.localeCompare(right.name);
}

function recordAgentUsage(state: AgentUsageState, agent: ListedAgent): AgentUsageState {
  return {
    latestWorkspaceName: agent.workspace?.name ?? 'built-in',
    usedAtByAgentId: {
      ...state.usedAtByAgentId,
      [agent.id]: new Date().toISOString(),
    },
  };
}

function loadAgentUsageState(): AgentUsageState {
  try {
    const raw = window.localStorage.getItem(AGENT_USAGE_STORAGE_KEY);
    if (!raw) return { usedAtByAgentId: {} };
    const parsed = JSON.parse(raw) as Partial<AgentUsageState>;
    return {
      latestWorkspaceName: typeof parsed.latestWorkspaceName === 'string' ? parsed.latestWorkspaceName : undefined,
      usedAtByAgentId:
        parsed.usedAtByAgentId && typeof parsed.usedAtByAgentId === 'object' && !Array.isArray(parsed.usedAtByAgentId)
          ? Object.fromEntries(
              Object.entries(parsed.usedAtByAgentId).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            )
          : {},
    };
  } catch {
    return { usedAtByAgentId: {} };
  }
}

function saveAgentUsageState(state: AgentUsageState): void {
  window.localStorage.setItem(AGENT_USAGE_STORAGE_KEY, JSON.stringify(state));
}

function loadAgentViewState(): AgentViewState {
  try {
    const raw = window.localStorage.getItem(AGENT_VIEW_STORAGE_KEY);
    if (!raw) {
      return { expandedWorkspaceNames: [], showAllWorkspaceNames: [] };
    }
    const parsed = JSON.parse(raw) as Partial<AgentViewState>;
    return {
      selectedAgentId: typeof parsed.selectedAgentId === 'string' ? parsed.selectedAgentId : undefined,
      expandedWorkspaceNames: stringArray(parsed.expandedWorkspaceNames),
      showAllWorkspaceNames: stringArray(parsed.showAllWorkspaceNames),
    };
  } catch {
    return { expandedWorkspaceNames: [], showAllWorkspaceNames: [] };
  }
}

function saveAgentViewState(state: AgentViewState): void {
  window.localStorage.setItem(AGENT_VIEW_STORAGE_KEY, JSON.stringify(state));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parsePayload(payloadText: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const value = JSON.parse(payloadText) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, message: 'Payload must be a JSON object.' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Payload is not valid JSON.' };
  }
}
