import type { AgentRunGraph, AgentRunListPage, AgentRunMemoryView, TurnRun } from '../types';

export type ListAgentRunsInput = {
  tenantId: string;
  scope?: 'roots' | 'all';
  agentId?: string;
  status?: string;
  since?: string;
  cursor?: string;
  limit?: number;
};

export type OperatorConfig = {
  hatchetDashboardUrl?: string;
  hatchetDashboardTenantId?: string;
  opikDashboardUrl?: string;
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

async function fetchJson<T>(path: string, tenantId?: string): Promise<T> {
  const response = await fetch(path, {
    headers: tenantId
      ? {
          'x-tenant-id': tenantId,
        }
      : undefined,
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
  const suffix = params.toString();
  return fetchJson<AgentRunListPage>(`/agent-runs${suffix ? `?${suffix}` : ''}`, input.tenantId);
}

export async function getRunGraph(tenantId: string, taskId: string): Promise<AgentRunGraph> {
  return fetchJson<AgentRunGraph>(`/tasks/${encodeURIComponent(taskId)}/run-graph`, tenantId);
}

export async function getTurn(tenantId: string, taskId: string, turnSeq: number): Promise<TurnRun> {
  return fetchJson<TurnRun>(`/tasks/${encodeURIComponent(taskId)}/turns/${encodeURIComponent(String(turnSeq))}`, tenantId);
}

export async function getMemory(tenantId: string, taskId: string): Promise<AgentRunMemoryView> {
  return fetchJson<AgentRunMemoryView>(`/tasks/${encodeURIComponent(taskId)}/memory`, tenantId);
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

export async function listAgents(): Promise<ListedAgentsPage> {
  return fetchJson<ListedAgentsPage>('/agents');
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResponse> {
  const response = await fetch('/rpc', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': input.tenantId,
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

export function opikTraceUrl(traceId: string, spanId: string | undefined, config: OperatorConfig): string | undefined {
  const base = config.opikDashboardUrl || (import.meta.env.VITE_OPIK_DASHBOARD_URL as string | undefined);
  if (!base) return undefined;
  const url = new URL(`${base.replace(/\/$/, '')}/traces/${encodeURIComponent(traceId)}`);
  if (spanId) url.searchParams.set('spanId', spanId);
  return url.toString();
}
