import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Play,
  RefreshCw,
  Rocket,
  X,
} from 'lucide-react';
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

type PayloadParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string; line?: number; column?: number };

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

    if (selectedPreset) {
      const formattedPayload = JSON.stringify(parsed.value, null, 2);
      if (formattedPayload !== selectedPreset.payloadText) {
        setPresetState(updatePresetState(presetState, selectedPreset.id, { payloadText: formattedPayload }));
      }
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
          scope: 'roots',
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

        <div className="rounded-lg border border-border bg-card p-4 shadow-[0_12px_35px_hsl(220_20%_10%/0.04)]">
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
    <section className="rounded-lg border border-border bg-card p-3">
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
              'relative rounded-lg border p-3 pl-4 text-left transition-colors hover:border-primary/35 hover:bg-accent',
              props.selectedAgentId === agent.id
                ? 'border-primary/45 bg-accent text-accent-foreground shadow-sm before:absolute before:left-1 before:top-3 before:bottom-3 before:w-0.5 before:rounded-full before:bg-primary'
                : 'border-border'
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
  const [copiedPayload, setCopiedPayload] = useState(false);
  const initialPayloadsRef = useRef<Record<string, string>>({});
  const parsedPayload = useMemo(() => parsePayload(selectedPreset?.payloadText ?? '{}'), [selectedPreset?.payloadText]);

  useEffect(() => {
    initialPayloadsRef.current = Object.fromEntries(
      props.presetState.presets.map((preset) => [preset.id, preset.payloadText])
    );
  }, [props.agent.id]);

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

  const duplicatePreset = (presetId: string) => {
    const preset = props.presetState.presets.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    const copy = {
      ...createPayloadPreset(`${preset.name || 'Payload'} copy`),
      payloadText: preset.payloadText,
    };
    props.onPresetState({
      selectedPresetId: copy.id,
      presets: [...props.presetState.presets, copy],
    });
  };

  const formatPayload = () => {
    if (!selectedPreset || !parsedPayload.ok) return;
    updateSelectedPreset({ payloadText: JSON.stringify(parsedPayload.value, null, 2) });
  };

  const copyPayload = () => {
    if (!selectedPreset) return;
    void navigator.clipboard.writeText(selectedPreset.payloadText).then(() => {
      setCopiedPayload(true);
      window.setTimeout(() => setCopiedPayload(false), 1500);
    });
  };

  const selectedPayloadName = selectedPreset?.name || 'Untitled';

  return (
    <div className="grid gap-4 pb-2">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Rocket className="h-5 w-5 text-primary" />
              <h3 className="min-w-0 truncate text-xl font-semibold">{props.agent.name}</h3>
              <span className="rounded-md border border-border px-2 py-1 font-mono text-xs text-muted-foreground">
                {props.agent.workspace?.name ?? 'built-in'}
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{props.agent.description}</p>
          </div>
          <CopyableId value={props.agent.id} label="agent id" />
        </div>

        <div className="grid gap-3 rounded-lg border border-border bg-surface-muted p-3 md:grid-cols-[minmax(180px,260px)_1fr]">
          <Field label="Tenant">
            <input
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={props.tenantId}
              onChange={(event) => props.onTenantId(event.target.value)}
              aria-label="Tenant id"
            />
          </Field>
          <MetadataField label="Input modes">
            {props.agent.defaultInputModes.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {props.agent.defaultInputModes.map((mode) => (
                  <span key={mode} className="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs">
                    {mode}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">not specified</span>
            )}
          </MetadataField>
        </div>
      </div>

      <section className="grid gap-3">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <label className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Payload JSON</label>
              <p className="mt-1 text-xs text-muted-foreground">
                Developer mode: payloads are sent as raw JSON. Do not paste secrets.
              </p>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1 rounded-lg border border-border bg-surface-muted p-1">
          {props.presetState.presets.map((preset) => (
            <PayloadTab
              key={preset.id}
              name={preset.name}
              active={preset.id === selectedPreset?.id}
              invalid={!parsePayload(preset.payloadText).ok}
              dirty={
                initialPayloadsRef.current[preset.id] !== undefined &&
                initialPayloadsRef.current[preset.id] !== preset.payloadText
              }
              renaming={renamingPresetId === preset.id}
              canDelete={props.presetState.presets.length > 1}
              onSelect={() => props.onPresetState({ ...props.presetState, selectedPresetId: preset.id })}
              onNameChange={(name) => updatePreset(preset.id, { name })}
              onRename={() => setRenamingPresetId(preset.id)}
              onRenameDone={() => setRenamingPresetId(null)}
              onDuplicate={() => duplicatePreset(preset.id)}
              onDelete={() => deletePreset(preset.id)}
            />
          ))}
            <Button type="button" variant="outline" size="sm" onClick={addPreset} className="h-8 gap-1" aria-label="Add payload preset">
              <Plus className="h-3.5 w-3.5" />
              New payload
            </Button>
          </div>
        </div>

        <JsonEditor
          value={selectedPreset?.payloadText ?? '{}'}
          validation={parsedPayload}
          onChange={(payloadText) => updateSelectedPreset({ payloadText })}
          onFormat={formatPayload}
          onCopy={copyPayload}
          copied={copiedPayload}
        />
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

      <div className="sticky bottom-3 z-20 -mx-1 rounded-lg border border-primary/25 bg-card/95 p-3 shadow-[0_14px_40px_hsl(220_20%_10%/0.12)] backdrop-blur supports-[backdrop-filter]:bg-card/85">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {parsedPayload.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-700" aria-hidden="true" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-rose-700" aria-hidden="true" />
              )}
              <span className={cn(parsedPayload.ok ? 'text-emerald-800' : 'text-rose-800')}>
                {parsedPayload.ok ? 'Valid JSON object' : 'Invalid JSON'}
              </span>
              <span className="text-muted-foreground">· Payload: {selectedPayloadName}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Developer mode sends raw JSON. The payload will be formatted before the run starts.
            </p>
          </div>
          <Button type="button" onClick={props.onSubmit} disabled={props.runState.state === 'running' || !parsedPayload.ok}>
          <Play className="h-4 w-4" />
          {props.runState.state === 'running' ? 'Starting...' : 'Run agent'}
        </Button>
        </div>
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

function PayloadTab(props: {
  name: string;
  active: boolean;
  invalid: boolean;
  dirty: boolean;
  renaming: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onNameChange: (name: string) => void;
  onRename: () => void;
  onRenameDone: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}): React.ReactElement {
  return (
    <div
      className={cn(
        'group inline-flex h-8 max-w-full items-center gap-1 rounded-md border px-2 text-xs transition-colors',
        props.active
          ? 'border-primary bg-background text-foreground shadow-sm'
          : 'border-transparent text-muted-foreground hover:border-border hover:bg-background/70'
      )}
    >
      {props.renaming ? (
        <input
          className="h-6 w-32 rounded border border-input bg-background px-2 text-xs text-foreground"
          value={props.name}
          autoFocus
          onChange={(event) => props.onNameChange(event.target.value)}
          onBlur={props.onRenameDone}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'Escape') {
              props.onRenameDone();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 max-w-40 items-center gap-1 truncate"
          onClick={props.onSelect}
          onDoubleClick={props.onRename}
          title="Double-click to rename"
        >
          <span className="truncate">{props.name || 'Untitled'}</span>
          {props.dirty ? <span className="text-primary" aria-label="edited">*</span> : null}
          {props.invalid ? <AlertTriangle className="h-3 w-3 shrink-0 text-rose-700" aria-label="invalid JSON" /> : null}
        </button>
      )}
      <button
        type="button"
        className="rounded p-1 opacity-60 hover:bg-muted hover:opacity-100"
        aria-label={`Rename ${props.name}`}
        onClick={props.onRename}
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        type="button"
        className="rounded p-1 opacity-60 hover:bg-muted hover:opacity-100"
        aria-label={`Duplicate ${props.name}`}
        onClick={props.onDuplicate}
      >
        <Copy className="h-3 w-3" />
      </button>
      <button
        type="button"
        className="rounded p-1 opacity-60 hover:bg-muted hover:opacity-100 disabled:pointer-events-none disabled:opacity-25"
        aria-label={`Delete ${props.name}`}
        disabled={!props.canDelete}
        onClick={props.onDelete}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function JsonEditor(props: {
  value: string;
  validation: PayloadParseResult;
  copied: boolean;
  onChange: (value: string) => void;
  onFormat: () => void;
  onCopy: () => void;
}): React.ReactElement {
  const [fullscreen, setFullscreen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlighterRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const lineCount = Math.max(1, props.value.split('\n').length);
  const editorHeight = Math.max(360, lineCount * 20 + 24);

  const syncScroll = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (highlighterRef.current) {
      highlighterRef.current.style.transform = fullscreen
        ? `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`
        : `translateX(${-textarea.scrollLeft}px)`;
    }
    if (gutterRef.current) {
      gutterRef.current.style.transform = fullscreen ? `translateY(${-textarea.scrollTop}px)` : '';
    }
  };

  const insertText = (text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      props.onChange(text);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = `${props.value.slice(0, start)}${text}${props.value.slice(end)}`;
    props.onChange(next);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.selectionStart = start + text.length;
      textarea.selectionEnd = start + text.length;
    });
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.getData('text');
    const formatted = formatJsonIfObject(pasted);
    if (!formatted) return;
    event.preventDefault();
    insertText(formatted);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      props.onFormat();
    }
  };

  return (
    <div
      className={cn(
        'grid gap-0',
        fullscreen ? 'fixed inset-4 z-50 rounded-xl border border-border bg-card p-4 shadow-2xl' : ''
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-lg border border-b-0 border-border bg-muted/30 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {props.validation.ok ? null : (
            <span className="inline-flex items-center gap-1 text-rose-800">
              <AlertTriangle className="h-3.5 w-3.5" />
              {props.validation.message}
              {props.validation.line ? ` at line ${props.validation.line}, column ${props.validation.column}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={props.onFormat} disabled={!props.validation.ok}>
            Format
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={props.onCopy}>
            <Copy className="h-3.5 w-3.5" />
            {props.copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setFullscreen(!fullscreen)}
            aria-label={fullscreen ? 'Exit fullscreen editor' : 'Open fullscreen editor'}
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {fullscreen ? 'Exit' : 'Full screen'}
          </Button>
        </div>
      </div>

      <div
        className={cn(
          'grid min-h-[360px] grid-cols-[3.25rem_minmax(0,1fr)] overflow-hidden rounded-b-lg border border-input bg-background',
          fullscreen ? 'h-[calc(100vh-9rem)]' : ''
        )}
        style={fullscreen ? undefined : { height: editorHeight }}
      >
        <div className="relative overflow-hidden border-r border-border bg-muted/30 px-2 py-3 font-mono text-xs leading-5 text-muted-foreground">
          <div ref={gutterRef} className="text-right">
            {Array.from({ length: lineCount }, (_, index) => (
              <div key={index + 1}>{index + 1}</div>
            ))}
          </div>
        </div>
        <div className="relative min-w-0 overflow-hidden">
          <pre
            ref={highlighterRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 min-h-full min-w-full whitespace-pre p-3 font-mono text-xs leading-5"
          >
            <JsonHighlightedCode text={props.value} />
          </pre>
          <textarea
            ref={textareaRef}
            className={cn(
              'absolute inset-0 resize-none bg-transparent p-3 font-mono text-xs leading-5 text-transparent caret-foreground outline-none selection:bg-primary/20',
              fullscreen ? 'overflow-auto' : 'overflow-x-auto overflow-y-hidden'
            )}
            spellCheck={false}
            wrap="off"
            value={props.value}
            onBlur={() => {
              if (props.validation.ok) props.onFormat();
            }}
            onChange={(event) => props.onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={syncScroll}
            aria-label="Payload JSON editor"
            aria-invalid={!props.validation.ok}
          />
        </div>
      </div>
    </div>
  );
}

function JsonHighlightedCode(props: { text: string }): React.ReactElement {
  const lines = props.text.split('\n');
  return (
    <>
      {lines.map((line, index) => (
        <div key={index}>{highlightJsonLine(line)}</div>
      ))}
    </>
  );
}

function highlightJsonLine(line: string): React.ReactNode[] | string {
  if (line.length === 0) return '\u00a0';
  const tokenPattern =
    /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|[-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}\[\],:])/g;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      nodes.push(line.slice(cursor, index));
    }
    nodes.push(
      <span key={`${index}-${token}`} className={jsonTokenClass(token, line.slice(index + token.length))}>
        {token}
      </span>
    );
    cursor = index + token.length;
  }
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

function jsonTokenClass(token: string, afterToken: string): string {
  if (token.startsWith('"')) {
    return afterToken.match(/^\s*:/) ? 'text-sky-800' : 'text-emerald-800';
  }
  if (token === 'true' || token === 'false') return 'text-violet-800';
  if (token === 'null') return 'text-muted-foreground';
  if (/^-?\d/.test(token)) return 'text-amber-800';
  return 'text-muted-foreground';
}

function formatJsonIfObject(text: string): string | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function Field(props: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}

function MetadataField(props: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="grid gap-1 text-sm">
      <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{props.label}</span>
      <div className="min-h-9 py-1">{props.children}</div>
    </div>
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

function parsePayload(payloadText: string): PayloadParseResult {
  try {
    const value = JSON.parse(payloadText) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, message: 'Payload must be a JSON object.' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Payload is not valid JSON.';
    return {
      ok: false,
      message,
      ...jsonErrorPosition(payloadText, message),
    };
  }
}

function jsonErrorPosition(text: string, message: string): { line?: number; column?: number } {
  const positionMatch = message.match(/position\s+(\d+)/i);
  if (!positionMatch) return {};
  const position = Number(positionMatch[1]);
  if (!Number.isFinite(position)) return {};
  const before = text.slice(0, position);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}
