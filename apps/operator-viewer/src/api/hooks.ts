import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cancelRun, getMemory, getOperatorConfig, getRunGraph, getTurn, listAgentRuns, listAgents, type CancelRunInput, type ListAgentRunsInput } from './client';
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

export function useInfiniteAgentRuns(input: ListAgentRunsInput) {
  return useInfiniteQuery({
    queryKey: ['agent-runs', 'infinite', input],
    queryFn: ({ pageParam }) => listAgentRuns({ ...input, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.pageInfo?.nextCursor ?? lastPage.nextCursor,
    refetchInterval: 5_000,
  });
}

export function useAgents(tenantId = 'default') {
  return useQuery({
    queryKey: ['agents', tenantId],
    queryFn: () => listAgents(tenantId),
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

export function useCancelRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CancelRunInput) => cancelRun(input),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
      void queryClient.invalidateQueries({ queryKey: ['run-graph', input.tenantId, input.taskId] });
      if (input.rootTaskId && input.rootTaskId !== input.taskId) {
        void queryClient.invalidateQueries({ queryKey: ['run-graph', input.tenantId, input.rootTaskId] });
      }
    },
  });
}

function shouldLiveRefreshGraph(graph: AgentRunGraph | undefined): boolean {
  if (graph === undefined) return true;
  const isLiveStatus = (status: string | undefined) => {
    const normalized = status?.toLowerCase();
    return normalized === 'queued' || normalized === 'running' || normalized === 'unknown';
  };
  return graph.nodes.some((node) => isLiveStatus(node.status))
    || graph.edges.some((edge) => isLiveStatus(edge.status))
    || graph.turns.some((turn) => isLiveStatus(turn.status));
}
