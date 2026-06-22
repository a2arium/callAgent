import { useQuery } from '@tanstack/react-query';
import { getMemory, getOperatorConfig, getRunGraph, getTurn, listAgentRuns, listAgents, type ListAgentRunsInput } from './client';
import type { AgentRunGraph } from '../types';

export function useOperatorConfig() {
  return useQuery({
    queryKey: ['operator-config'],
    queryFn: getOperatorConfig,
    staleTime: 60_000,
  });
}

export function useAgentRuns(input: ListAgentRunsInput) {
  return useQuery({
    queryKey: ['agent-runs', input],
    queryFn: () => listAgentRuns(input),
    refetchInterval: 5_000,
  });
}

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: listAgents,
    staleTime: 30_000,
  });
}

export function useRunGraph(tenantId: string, taskId: string | undefined) {
  return useQuery({
    queryKey: ['run-graph', tenantId, taskId],
    queryFn: () => getRunGraph(tenantId, taskId ?? ''),
    enabled: taskId !== undefined && taskId.length > 0,
    refetchInterval: (query) => {
      const graph = query.state.data as AgentRunGraph | undefined;
      return shouldLiveRefreshGraph(graph) ? 2_000 : false;
    },
  });
}

export function useTurn(tenantId: string, taskId: string | undefined, turnSeq: number | undefined) {
  return useQuery({
    queryKey: ['turn', tenantId, taskId, turnSeq],
    queryFn: () => getTurn(tenantId, taskId ?? '', turnSeq ?? 0),
    enabled: taskId !== undefined && turnSeq !== undefined,
  });
}

export function useMemory(tenantId: string, taskId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['memory', tenantId, taskId],
    queryFn: () => getMemory(tenantId, taskId ?? ''),
    enabled: enabled && taskId !== undefined && taskId.length > 0,
  });
}

function shouldLiveRefreshGraph(graph: AgentRunGraph | undefined): boolean {
  if (graph === undefined) return true;
  return graph.nodes.some((node) => {
    const status = node.status.toLowerCase();
    return status === 'queued' || status === 'running' || status === 'unknown';
  });
}
