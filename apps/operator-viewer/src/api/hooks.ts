import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cancelRun, deleteSemanticMemory, getMemory, getOperatorConfig, getRunGraph, getSemanticMemory, getTurn, listAgentRuns, listAgents, listAgentSchedules, listMemoryActivity, listMemoryEntities, listSemanticMemory, listSemanticMemoryAudit, probeSemanticMemory, retagSemanticMemory, updateSemanticMemory, type CancelRunInput, type ListAgentRunsInput, type ListMemoryActivityInput, type ListSemanticMemoryInput, type SemanticProbeInput } from './client';
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

export function useInfiniteAgentSchedules(input: { tenantId: string; agentId?: string; kind?: string; state?: string }) {
  return useInfiniteQuery({
    queryKey: ['agent-schedules', 'infinite', input],
    queryFn: ({ pageParam }) => listAgentSchedules({ ...input, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    refetchInterval: 10_000,
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

export function useSemanticMemory(input: ListSemanticMemoryInput) {
  return useQuery({
    queryKey: ['semantic-memory', input],
    queryFn: () => listSemanticMemory(input),
    refetchInterval: 5_000,
  });
}

export function useSemanticMemoryDetail(tenantId: string, key: string | undefined) {
  return useQuery({
    queryKey: ['semantic-memory-detail', tenantId, key],
    queryFn: () => getSemanticMemory(tenantId, key ?? ''),
    enabled: key !== undefined && key.length > 0,
  });
}

export function useSemanticMemoryAudit(tenantId: string, key: string | undefined, limit = 10) {
  return useQuery({
    queryKey: ['semantic-memory-audit', tenantId, key, limit],
    queryFn: () => listSemanticMemoryAudit({ tenantId, key: key ?? '', limit }),
    enabled: key !== undefined && key.length > 0,
  });
}

export function useMemoryActivity(input: ListMemoryActivityInput) {
  return useQuery({
    queryKey: ['memory-activity', input],
    queryFn: () => listMemoryActivity(input),
    refetchInterval: 5_000,
  });
}

export function useMemoryEntities(input: { tenantId: string; search?: string; entityType?: string; cursor?: string; limit?: number }) {
  return useQuery({
    queryKey: ['memory-entities', input],
    queryFn: () => listMemoryEntities(input),
    refetchInterval: 15_000,
  });
}

export function useProbeSemanticMemory() {
  return useMutation({
    mutationFn: (input: SemanticProbeInput) => probeSemanticMemory(input),
  });
}

export function useRetagSemanticMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: retagSemanticMemory,
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ['semantic-memory'] });
      void queryClient.invalidateQueries({ queryKey: ['semantic-memory-detail', input.tenantId, input.key] });
      void queryClient.invalidateQueries({ queryKey: ['semantic-memory-audit', input.tenantId, input.key] });
    },
  });
}

export function useDeleteSemanticMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteSemanticMemory,
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ['semantic-memory'] });
      void queryClient.invalidateQueries({ queryKey: ['semantic-memory-detail', input.tenantId, input.key] });
      void queryClient.invalidateQueries({ queryKey: ['semantic-memory-audit', input.tenantId, input.key] });
      void queryClient.invalidateQueries({ queryKey: ['memory-activity'] });
    },
  });
}

export function useUpdateSemanticMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateSemanticMemory,
    onSuccess: (result, input) => {
      void queryClient.invalidateQueries({ queryKey: ['semantic-memory'] });
      void queryClient.invalidateQueries({ queryKey: ['semantic-memory-detail', input.tenantId, input.key] });
      void queryClient.invalidateQueries({ queryKey: ['semantic-memory-audit', input.tenantId, input.key] });
      if (result.key !== input.key) {
        void queryClient.invalidateQueries({ queryKey: ['semantic-memory-detail', input.tenantId, result.key] });
        void queryClient.invalidateQueries({ queryKey: ['semantic-memory-audit', input.tenantId, result.key] });
      }
      void queryClient.invalidateQueries({ queryKey: ['memory-activity'] });
    },
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
