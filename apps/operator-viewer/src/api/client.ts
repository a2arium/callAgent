import type { AgentRunEvent, AgentRunGraph, AgentRunListPage, AgentRunMemoryView, CognitiveTurnRun, EffectRun, OperatorPage, TurnAttemptRun, TurnRun } from '../types';

export type ListAgentRunsInput = {
  tenantId: string;
  scope?: 'roots' | 'all';
  agentId?: string;
  status?: string;
  since?: string;
  cursor?: string;
  limit?: number;
  taskId?: string;
  hasLlm?: boolean;
  hasMemory?: boolean;
  costState?: 'captured' | 'missing' | '';
  scheduleId?: string;
};

export type AgentSchedule = {
  id: string;
  providerId: string;
  revision: number;
  kind: 'once' | 'cron';
  displayName: string;
  agentId: string;
  agentAvailable: boolean;
  state: string;
  createdAt: string;
  updatedAt: string;
  triggerAt?: string;
  cronExpression?: string;
  payloadKeys: string[];
  maxTurns?: number;
  cleanupRequired?: { providerIds: string[] };
};

export type AgentScheduleListPage = { items: AgentSchedule[]; nextCursor?: string };
export type CreateAgentScheduleRequest = {
  tenantId: string;
  kind: 'once' | 'cron';
  displayName: string;
  agentId: string;
  input: unknown;
  triggerAt?: string;
  cronExpression?: string;
  maxTurns?: number;
};

export type OperatorConfig = {
  hatchetDashboardUrl?: string;
  hatchetDashboardTenantId?: string;
  environment?: string;
};

export type ListedAgentSkill = {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
};

export type ListedAgent = {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    extendedAgentCard?: boolean;
    stateTransitionHistory?: boolean;
  };
  skills: ListedAgentSkill[];
  workspace?: {
    name: string;
    root: string;
  };
};

export type ListedAgentsPage = {
  items: ListedAgent[];
};

export type RunAgentInput = {
  tenantId: string;
  agentId: string;
  payload: Record<string, unknown>;
};

export type RunAgentResponse = {
  jsonrpc: '2.0';
  id: string | null;
  result?: {
    id: string;
    status?: {
      state?: string;
      timestamp?: string;
      metadata?: Record<string, unknown>;
    };
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type AgentRunReplayInput = {
  taskId: string;
  agentId: string;
  payload: Record<string, unknown>;
};

export type CancelRunInput = {
  tenantId: string;
  taskId: string;
  rootTaskId?: string;
  agentId?: string;
  reason?: string;
};

export type CancelRunResponse = {
  acknowledged: true;
};

export type ArtifactPayload = {
  artifactId: string;
  contentType: string;
  filename: string;
  sizeBytes: number;
  value: unknown;
};

export type SemanticMemoryItem = {
  key: string;
  valuePreview: unknown;
  value?: unknown;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  hasBlob: boolean;
  blobMetadata?: unknown;
  alignmentCount: number;
  entities: Array<{ entityId: string; entityType?: string; canonicalName?: string; fieldPath: string; originalValue?: string; confidence?: string }>;
  activity: {
    reads: number;
    writes: number;
    deletes: number;
    lastReadAt?: string;
    lastWriteAt?: string;
    lastDeleteAt?: string;
  };
  flags: string[];
};

export type SemanticMemoryPage = {
  items: SemanticMemoryItem[];
  pageInfo: { nextCursor?: string; hasMore: boolean; limit: number };
  summary: {
    totalOnPage: number;
    withBlob: number;
    withAlignment: number;
    noTags: number;
    recentlyRead: number;
    recentlyWritten: number;
  };
};

export type SemanticMemoryActivityItem = {
  id: string;
  taskId: string;
  seq: number;
  timestamp: string;
  op: 'read' | 'write' | 'delete';
  keys: string[];
  keyCount: number;
  resultKeys: string[];
  resultCount?: number;
  query?: unknown;
  status?: string;
  backend?: string;
  source?: string;
  turnSeq?: number;
  agentId?: string;
  traceId?: string;
  spanId?: string;
};

export type SemanticMemoryActivityPage = {
  items: SemanticMemoryActivityItem[];
  pageInfo: { nextCursor?: string; hasMore: boolean; limit: number };
};

export type SemanticEntityItem = {
  id: string;
  entityType: string;
  canonicalName: string;
  aliases: string[];
  confidence: number;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
  alignmentCount: number;
  memoryKeys: string[];
};

export type SemanticEntityPage = {
  items: SemanticEntityItem[];
  pageInfo: { nextCursor?: string; hasMore: boolean; limit: number };
};

export type SemanticProbeInput = {
  tenantId: string;
  pattern?: string;
  tag?: string;
  filters?: Array<{ path: string; operator: string; value: unknown }>;
  limit?: number;
  random?: boolean;
  expectedKey?: string;
};

export type SemanticProbeResult = {
  query: Record<string, unknown>;
  resultKeys: string[];
  items: SemanticMemoryItem[];
  expected?: { key: string; present: boolean; rank?: number };
  notes: string[];
};

export type SemanticMemoryAuditItem = {
  id: string;
  action: 'memory.update' | 'memory.retag' | 'memory.delete' | string;
  actorId: string;
  actorType: string;
  reason?: string;
  accepted: boolean;
  resultStatus?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
  requestedAt: string;
  createdAt: string;
};

export type SemanticMemoryAuditPage = {
  items: SemanticMemoryAuditItem[];
};

async function fetchJson<T>(path: string, tenantId?: string): Promise<T> {
  const response = await fetch(operatorPath(path), {
    credentials: 'same-origin',
    headers: tenantId
      ? {
          'x-tenant-id': tenantId,
        }
      : undefined,
  });
  if (response.status === 401) window.dispatchEvent(new Event('callagent:auth-required'));
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Expected JSON from ${path}, got ${contentType || 'unknown content type'}`);
  }
  return response.json() as Promise<T>;
}

async function writeJson<T>(path: string, input: { tenantId: string; method: 'POST' | 'PATCH' | 'DELETE'; body: unknown }): Promise<T> {
  const response = await fetch(operatorPath(path), {
    method: input.method,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': input.tenantId,
    },
    body: JSON.stringify(input.body),
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return response.json() as Promise<T>;
}

async function responseErrorMessage(response: Response): Promise<string> {
  const prefix = `${response.status} ${response.statusText}`.trim();
  const contentType = response.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as unknown;
      if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        const message = typeof record.message === 'string' ? record.message : undefined;
        const error = typeof record.error === 'string' ? record.error : undefined;
        return [prefix, error, message].filter(Boolean).join(': ');
      }
    }
    const text = (await response.text()).trim();
    if (text.length > 0) {
      const normalized = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return `${prefix}: ${normalized}`;
    }
  } catch {
    // Fall through to the status-only message.
  }
  return prefix;
}

export async function listAgentRuns(input: ListAgentRunsInput): Promise<AgentRunListPage> {
  const params = new URLSearchParams();
  if (input.scope) params.set('scope', input.scope);
  if (input.agentId) params.set('agentId', input.agentId);
  if (input.status) params.set('status', input.status);
  if (input.since) params.set('since', input.since);
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.taskId) params.set('taskId', input.taskId);
  if (input.hasLlm) params.set('hasLlm', 'true');
  if (input.hasMemory) params.set('hasMemory', 'true');
  if (input.costState) params.set('costState', input.costState);
  if (input.scheduleId) params.set('scheduleId', input.scheduleId);
  const suffix = params.toString();
  return fetchJson<AgentRunListPage>(`/agent-runs${suffix ? `?${suffix}` : ''}`, input.tenantId);
}

export async function getRunGraph(tenantId: string, taskId: string): Promise<AgentRunGraph> {
  return fetchJson<AgentRunGraph>(`/tasks/${encodeURIComponent(taskId)}/run-graph`, tenantId);
}

export async function cancelRun(input: CancelRunInput): Promise<CancelRunResponse> {
  const response = await fetch(operatorPath(`/tasks/${encodeURIComponent(input.taskId)}/cancel`), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': input.tenantId,
    },
    body: JSON.stringify({
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<CancelRunResponse>;
}

export async function getTurn(tenantId: string, taskId: string, turnSeq: number): Promise<TurnRun> {
  return fetchJson<TurnRun>(`/tasks/${encodeURIComponent(taskId)}/turns/${encodeURIComponent(String(turnSeq))}`, tenantId);
}

function detailPath(path: string, cursor?: string, limit?: number): string {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  if (limit) query.set('limit', String(limit));
  return `${path}${query.size ? `?${query}` : ''}`;
}

export async function listRunTurns(tenantId: string, taskId: string, cursor?: string, limit?: number): Promise<OperatorPage<TurnRun>> {
  return fetchJson(detailPath(`/tasks/${encodeURIComponent(taskId)}/turns`, cursor, limit), tenantId);
}
export async function listTurnAttempts(tenantId: string, taskId: string, turnSeq: number, cursor?: string, limit?: number): Promise<OperatorPage<TurnAttemptRun>> {
  return fetchJson(detailPath(`/tasks/${encodeURIComponent(taskId)}/turns/${turnSeq}/attempts`, cursor, limit), tenantId);
}
export async function listCognitiveTurns(tenantId: string, taskId: string, turnSeq: number, cursor?: string, limit?: number): Promise<OperatorPage<CognitiveTurnRun>> {
  return fetchJson(detailPath(`/tasks/${encodeURIComponent(taskId)}/turns/${turnSeq}/cognitive-turns`, cursor, limit), tenantId);
}
export async function listRunEffects(tenantId: string, taskId: string, cursor?: string, limit?: number): Promise<OperatorPage<EffectRun>> {
  return fetchJson(detailPath(`/tasks/${encodeURIComponent(taskId)}/effects`, cursor, limit), tenantId);
}
export async function listRunEvents(tenantId: string, taskId: string, cursor?: string, limit?: number): Promise<OperatorPage<AgentRunEvent>> {
  return fetchJson(detailPath(`/tasks/${encodeURIComponent(taskId)}/events`, cursor, limit), tenantId);
}

export async function getMemory(tenantId: string, taskId: string): Promise<AgentRunMemoryView> {
  return fetchJson<AgentRunMemoryView>(`/tasks/${encodeURIComponent(taskId)}/memory`, tenantId);
}

export async function getArtifact(tenantId: string, artifactId: string): Promise<ArtifactPayload> {
  return fetchJson<ArtifactPayload>(`/artifacts/${encodeURIComponent(artifactId)}`, tenantId);
}

export async function getOperatorConfig(): Promise<OperatorConfig> {
  try {
    const response = await fetch('/operator-api/config', { credentials: 'same-origin', headers: { 'x-tenant-id': preferredTenantId() } });
    if (!response.ok) return {};
    return response.json() as Promise<OperatorConfig>;
  } catch {
    return {};
  }
}

export type ListSemanticMemoryInput = {
  tenantId: string;
  key?: string;
  tag?: string;
  entity?: string;
  entityType?: string;
  agentId?: string;
  taskId?: string;
  since?: string;
  until?: string;
  hasBlob?: boolean;
  hasAlignment?: boolean;
  cursor?: string;
  limit?: number;
};

export async function listSemanticMemory(input: ListSemanticMemoryInput): Promise<SemanticMemoryPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (key === 'tenantId') continue;
    if (value !== undefined && value !== '' && value !== false) params.set(key, String(value));
  }
  const suffix = params.toString();
  return fetchJson<SemanticMemoryPage>(`/memory/semantic${suffix ? `?${suffix}` : ''}`, input.tenantId);
}

export async function getSemanticMemory(tenantId: string, key: string): Promise<SemanticMemoryItem> {
  return fetchJson<SemanticMemoryItem>(`/memory/semantic/${encodeURIComponent(key)}`, tenantId);
}

export async function listSemanticMemoryAudit(input: { tenantId: string; key: string; limit?: number }): Promise<SemanticMemoryAuditPage> {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  const suffix = params.toString();
  return fetchJson<SemanticMemoryAuditPage>(`/memory/semantic/${encodeURIComponent(input.key)}/audit${suffix ? `?${suffix}` : ''}`, input.tenantId);
}

export type ListMemoryActivityInput = {
  tenantId: string;
  key?: string;
  taskId?: string;
  agentId?: string;
  op?: 'read' | 'write' | 'delete' | '';
  since?: string;
  until?: string;
  cursor?: string;
  limit?: number;
};

export async function listMemoryActivity(input: ListMemoryActivityInput): Promise<SemanticMemoryActivityPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (key === 'tenantId') continue;
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const suffix = params.toString();
  return fetchJson<SemanticMemoryActivityPage>(`/memory/activity${suffix ? `?${suffix}` : ''}`, input.tenantId);
}

export async function listMemoryEntities(input: { tenantId: string; search?: string; entityType?: string; cursor?: string; limit?: number }): Promise<SemanticEntityPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (key === 'tenantId') continue;
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const suffix = params.toString();
  return fetchJson<SemanticEntityPage>(`/memory/entities${suffix ? `?${suffix}` : ''}`, input.tenantId);
}

export async function probeSemanticMemory(input: SemanticProbeInput): Promise<SemanticProbeResult> {
  return writeJson<SemanticProbeResult>('/memory/probe', {
    tenantId: input.tenantId,
    method: 'POST',
    body: input,
  });
}

export async function retagSemanticMemory(input: { tenantId: string; key: string; tags: string[]; reason: string }): Promise<SemanticMemoryItem> {
  return writeJson<SemanticMemoryItem>(`/memory/semantic/${encodeURIComponent(input.key)}/tags`, {
    tenantId: input.tenantId,
    method: 'PATCH',
    body: { tags: input.tags, reason: input.reason },
  });
}

export async function updateSemanticMemory(input: { tenantId: string; key: string; nextKey?: string; value?: unknown; reason: string }): Promise<SemanticMemoryItem> {
  return writeJson<SemanticMemoryItem>(`/memory/semantic/${encodeURIComponent(input.key)}`, {
    tenantId: input.tenantId,
    method: 'PATCH',
    body: {
      ...(input.nextKey !== undefined ? { key: input.nextKey } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'value') ? { value: input.value } : {}),
      reason: input.reason,
    },
  });
}

export async function deleteSemanticMemory(input: { tenantId: string; key: string; confirmKey: string; reason: string }): Promise<{ deleted: true; key: string }> {
  return writeJson<{ deleted: true; key: string }>(`/memory/semantic/${encodeURIComponent(input.key)}`, {
    tenantId: input.tenantId,
    method: 'DELETE',
    body: { confirmKey: input.confirmKey, reason: input.reason },
  });
}

export async function listAgents(tenantId = 'default'): Promise<ListedAgentsPage> {
  return fetchJson<ListedAgentsPage>('/agents', tenantId);
}

export async function listAgentSchedules(input: { tenantId: string; agentId?: string; kind?: string; state?: string; cursor?: string; limit?: number }): Promise<AgentScheduleListPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'tenantId' && value !== undefined && value !== '') params.set(key, String(value));
  }
  const suffix = params.toString();
  return fetchJson<AgentScheduleListPage>(`/agent-schedules${suffix ? `?${suffix}` : ''}`, input.tenantId);
}

export async function createAgentSchedule(input: CreateAgentScheduleRequest): Promise<AgentSchedule> {
  const { tenantId, ...body } = input;
  return writeJson<AgentSchedule>('/agent-schedules', { tenantId, method: 'POST', body });
}

export async function getAgentSchedulePayload(tenantId: string, scheduleId: string): Promise<{ scheduleId: string; input: unknown }> {
  return fetchJson(`/agent-schedules/${encodeURIComponent(scheduleId)}/payload`, tenantId);
}

export async function runAgentScheduleNow(tenantId: string, scheduleId: string): Promise<{ providerRunId: string }> {
  return writeJson(`/agent-schedules/${encodeURIComponent(scheduleId)}/run-now`, { tenantId, method: 'POST', body: {} });
}

export async function setAgentSchedulePaused(tenantId: string, scheduleId: string, paused: boolean): Promise<AgentSchedule> {
  return writeJson(`/agent-schedules/${encodeURIComponent(scheduleId)}/${paused ? 'pause' : 'resume'}`, { tenantId, method: 'POST', body: {} });
}

export async function rescheduleAgentSchedule(tenantId: string, scheduleId: string, triggerAt: string): Promise<AgentSchedule> {
  return writeJson(`/agent-schedules/${encodeURIComponent(scheduleId)}/reschedule`, { tenantId, method: 'POST', body: { triggerAt } });
}

export async function replaceAgentCron(tenantId: string, scheduleId: string, body: { expectedRevision: number; displayName: string; agentId: string; input: unknown; cronExpression: string; maxTurns?: number }): Promise<AgentSchedule> {
  return writeJson(`/agent-schedules/${encodeURIComponent(scheduleId)}/replace`, { tenantId, method: 'POST', body });
}

export async function deleteAgentSchedule(tenantId: string, scheduleId: string): Promise<{ deleted: true }> {
  return writeJson(`/agent-schedules/${encodeURIComponent(scheduleId)}`, { tenantId, method: 'DELETE', body: {} });
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResponse> {
  const taskId = requestedTaskId(input.payload) || createOperatorTaskId(input.agentId);
  const requestId = `operator-run-${Date.now()}`;
  const response = await fetch('/operator-api/rpc', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': input.tenantId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tasks/sendSubscribe',
      params: {
        ...input.payload,
        agentId: input.agentId,
        id: taskId,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return response.json() as Promise<RunAgentResponse>;
  }

  await response.body?.cancel();
  return {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      id: taskId,
      status: { state: 'submitted', timestamp: new Date().toISOString() },
    },
  };
}

export async function getAgentRunReplayInput(tenantId: string, taskId: string): Promise<AgentRunReplayInput> {
  return fetchJson<AgentRunReplayInput>(`/tasks/${encodeURIComponent(taskId)}/replay-input`, tenantId);
}

function operatorPath(path: string): string {
  return path.startsWith('/operator-api/') ? path : `/operator-api${path.startsWith('/') ? path : `/${path}`}`;
}

function requestedTaskId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : undefined;
}

function createOperatorTaskId(agentId: string): string {
  const prefix = agentId
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function preferredTenantId(): string {
  return window.localStorage.getItem('callagent.operator.tenant')?.trim() || 'default';
}

export function hatchetRunUrl(providerRunId: string, config: OperatorConfig): string {
  const base =
    config.hatchetDashboardUrl ||
    (import.meta.env.VITE_HATCHET_DASHBOARD_URL as string | undefined) ||
    'http://127.0.0.1:8080';
  const dashboardTenantId =
    config.hatchetDashboardTenantId ||
    (import.meta.env.VITE_HATCHET_DASHBOARD_TENANT_ID as string | undefined) ||
    '707d0855-80ab-4e1f-a156-f1c4546cbf52';
  return `${base.replace(/\/+$/, '')}/tenants/${encodeURIComponent(dashboardTenantId)}/runs/${encodeURIComponent(providerRunId)}`;
}
