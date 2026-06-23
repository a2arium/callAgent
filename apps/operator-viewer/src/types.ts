export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'cancelled' | 'unknown';

export type AgentRunListItem = {
  agentId?: string;
  taskId: string;
  rootTaskId: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  turns: number;
  children: number;
  llmCalls: number;
  memoryOps?: number;
  costUsd: number;
  error?: unknown;
  traceId?: string;
  providerRunId?: string | null;
};

export type AgentRunListPage = {
  items: AgentRunListItem[];
  nextCursor?: string;
};

export type AgentRunNode = {
  id: string;
  kind: 'agent';
  tenantId: string;
  rootTaskId: string;
  taskId: string;
  parentTaskId?: string;
  agentId?: string;
  status: AgentRunStatus;
  inputPreview?: unknown;
  outputPreview?: unknown;
  error?: unknown;
  traceId?: string;
  providerRunId?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type AgentRunEdge = {
  id: string;
  kind: 'agent-child';
  rootTaskId: string;
  parentTaskId: string;
  childTaskId?: string;
  parentAgentId?: string;
  childAgentId?: string;
  token?: string;
  edgeToken?: string;
  edgeKind: 'delegates_to';
  status: AgentRunStatus;
  resultPreview?: unknown;
  error?: unknown;
  startedAt?: string;
  finishedAt?: string;
};

export type TurnCognition = {
  turnId?: string;
  stageBefore?: string;
  stageAfter?: string;
  stageTransition?: Record<string, unknown>;
  transition?: Record<string, unknown>;
  intent?: Record<string, unknown>;
  shield?: Record<string, unknown>;
  perception?: Record<string, unknown>;
  execAction?: Record<string, unknown>;
  execResult?: Record<string, unknown>;
  timings?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  mentalStateBeforeHash?: string;
  mentalStateAfterHash?: string;
  level?: 'summary' | 'full';
};

export type MemoryOperationRun = {
  id: string;
  taskId: string;
  seq: number;
  timestamp: string;
  op: 'read' | 'write' | 'delete';
  keys: string[];
  keyCount: number;
  backend?: string;
  source?: string;
  turnSeq?: number;
  agentId?: string;
  traceId?: string;
  spanId?: string;
};

export type TurnRun = {
  id: string;
  rootTaskId: string;
  taskId: string;
  agentId?: string;
  status: AgentRunStatus;
  operation: 'turn.segment';
  turnSeq?: number;
  boundaryKind?: string;
  token?: string;
  traceId?: string;
  spanId?: string;
  idempotencyKey?: string;
  turnTraceRef?: {
    traceId?: string;
    spanId?: string;
    turnTraceId?: string;
  };
  cognition?: TurnCognition;
  llmCalls?: LlmCallRun[];
  memoryOps?: MemoryOperationRun[];
  providerRunId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: unknown;
};

export type EffectRun = {
  id: string;
  rootTaskId: string;
  taskId?: string;
  agentId?: string;
  operation: string;
  status: AgentRunStatus;
  token?: string;
  traceId?: string;
  providerRunId?: string;
  outboxRowId?: string;
  hiddenByDefault: boolean;
  error?: unknown;
};

export type LlmCallRun = {
  provider?: string;
  model?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  cost?: number;
  module?: string;
  status?: string;
  hasOutputContract?: boolean;
  outputContractName?: string;
  outputContractStatus?: string;
  traceId?: string;
  spanId?: string;
  [key: string]: unknown;
};

export type AgentRunEvent = {
  id: string;
  source: 'wm_event';
  type: string;
  taskId: string;
  seq: number;
  timestamp: string;
  visibility: 'operator' | 'debug';
  group: {
    taskId: string;
    agentId?: string;
    traceId?: string;
    spanId?: string;
    turnId?: string;
    token?: string;
  };
  payload: Record<string, unknown>;
};

export type AgentRunGraph = {
  schemaVersion: 1;
  tenantId: string;
  taskId: string;
  root: AgentRunNode;
  nodes: AgentRunNode[];
  edges: AgentRunEdge[];
  turns: TurnRun[];
  memoryOps: MemoryOperationRun[];
  effects: EffectRun[];
  events: AgentRunEvent[];
  debug: {
    driverRuns: DriverRunView[];
  };
};

export type DriverRunView = {
  id?: string;
  provider?: string;
  providerRunId?: string | null;
  providerTaskRunId?: string | null;
  tenantId: string;
  agentId?: string | null;
  taskId?: string | null;
  operation: string;
  status: string;
  rootTaskId?: string | null;
  error?: unknown;
};

export type AgentRunMemoryView = {
  taskId: string;
  tenantId: string;
  agentId?: string;
  memory?: unknown;
  operations: MemoryOperationRun[];
};
