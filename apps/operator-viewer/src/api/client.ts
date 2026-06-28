import type { AgentRunGraph, AgentRunListPage, AgentRunMemoryView, TurnRun } from '../types';

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

function operatorAuthHeaders(): Record<string, string> {
  const token = window.localStorage.getItem('callagent.operator.token')?.trim();
  return token ? { 'x-callagent-operator-key': token } : {};
}

async function fetchJson<T>(path: string, tenantId?: string): Promise<T> {
  const response = await fetch(path, {
    headers: tenantId
      ? {
          'x-tenant-id': tenantId,
          ...operatorAuthHeaders(),
        }
      : operatorAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Expected JSON from ${path}, got ${contentType || 'unknown content type'}`);
  }
  return response.json() as Promise<T>;
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
  const suffix = params.toString();
  return fetchJson<AgentRunListPage>(`/agent-runs${suffix ? `?${suffix}` : ''}`, input.tenantId);
}

export async function getRunGraph(tenantId: string, taskId: string): Promise<AgentRunGraph> {
  return fetchJson<AgentRunGraph>(`/tasks/${encodeURIComponent(taskId)}/run-graph`, tenantId);
}

export async function cancelRun(input: CancelRunInput): Promise<CancelRunResponse> {
  const response = await fetch(`/tasks/${encodeURIComponent(input.taskId)}/cancel`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': input.tenantId,
      ...operatorAuthHeaders(),
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

export async function getMemory(tenantId: string, taskId: string): Promise<AgentRunMemoryView> {
  return fetchJson<AgentRunMemoryView>(`/tasks/${encodeURIComponent(taskId)}/memory`, tenantId);
}

export async function getArtifact(tenantId: string, artifactId: string): Promise<ArtifactPayload> {
  return fetchJson<ArtifactPayload>(`/artifacts/${encodeURIComponent(artifactId)}`, tenantId);
}

export async function getOperatorConfig(): Promise<OperatorConfig> {
  try {
    const response = await fetch('/operator-config');
    if (!response.ok) return {};
    return response.json() as Promise<OperatorConfig>;
  } catch {
    return {};
  }
}

export async function listAgents(tenantId = 'default'): Promise<ListedAgentsPage> {
  return fetchJson<ListedAgentsPage>('/agents', tenantId);
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResponse> {
  const response = await fetch('/rpc', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': input.tenantId,
      'x-callagent-operator-launch': 'true',
      ...operatorAuthHeaders(),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `operator-run-${Date.now()}`,
      method: 'tasks/send',
      params: {
        ...input.payload,
        agentId: input.agentId,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<RunAgentResponse>;
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
  return `${base.replace(/\/$/, '')}/tenants/${encodeURIComponent(dashboardTenantId)}/runs/${encodeURIComponent(providerRunId)}`;
}
