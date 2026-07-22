export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'canceled' | 'cancelled' | 'unknown';
export type RunSeverity = 'success' | 'info' | 'warning' | 'error' | 'neutral';

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
  summary?: FleetSummary;
  pageInfo?: {
    nextCursor?: string;
    hasMore: boolean;
    limit: number;
  };
  projection?: ProjectionInfo;
};

export type FleetSummary = {
  total: number;
  failed: number;
  waiting: number;
  stuck: number;
  completed: number;
  costCaptured: number;
  costUnavailable: number;
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
  severity: RunSeverity;
  inputPreview?: unknown;
  outputPreview?: unknown;
  error?: unknown;
  traceId?: string;
  providerRunId?: string;
  executionOrigin?: 'runtime' | 'cache' | 'projected';
  cancellation?: AgentRunCancellation;
  startedAt?: string;
  finishedAt?: string;
};

export type AgentRunCancellation = {
  requested: boolean;
  reason?: string;
  requestedAt?: string;
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
  executionOrigin?: 'runtime' | 'cache' | 'projected';
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
  resultKeys?: string[];
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

export type TurnAttemptRun = {
  id: string;
  rootTaskId: string;
  taskId: string;
  agentId?: string;
  status: AgentRunStatus;
  operation: 'turn.segment';
  turnSeq?: number;
  attemptKey?: string;
  attemptSeq?: number;
  disposition?: 'executed' | 'queued' | 'matching_replay' | 'superseded' | 'terminal_replay';
  claimId?: string;
  turnFence?: string;
  claimedGeneration?: string;
  authoritativeTerminal?: boolean;
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

export type TurnRun = TurnAttemptRun & {
  turnSeq: number;
  severity: RunSeverity;
  attempts: TurnAttemptRun[];
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
  schemaVersion: 3;
  tenantId: string;
  taskId: string;
  root: AgentRunNode;
  nodes: AgentRunNode[];
  edges: AgentRunEdge[];
  turns: TurnRun[];
  unassignedAttempts: TurnAttemptRun[];
  memoryOps: MemoryOperationRun[];
  effects: EffectRun[];
  events: AgentRunEvent[];
  coordination: TaskCoordinationView;
  debug: {
    driverRuns: DriverRunView[];
  };
  caps?: {
    nodeLimit: number;
    edgeLimit: number;
    depthLimit: number;
    truncated: boolean;
  };
  collapsedBranches?: Array<{
    parentTaskId: string;
    hiddenChildCount: number;
    expandCursor: string;
    reason: 'node_limit' | 'depth_limit' | 'manual';
  }>;
  projection?: ProjectionInfo;
};

export type ProjectionInfo = {
  source: 'bridge' | 'semantic';
  lagMs?: number;
  partial: boolean;
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
  rootRunKey?: string | null;
  attemptSeq?: number | null;
  turnSeq?: number | null;
  claimId?: string | null;
  turnFence?: string | null;
  claimedGeneration?: string | null;
  turnDisposition?: string | null;
  error?: unknown;
};

export type TaskCoordinationView = {
  taskId: string;
  state: 'idle' | 'owned' | 'queued' | 'recovering' | 'terminal';
  health: 'healthy' | 'attention' | 'stuck';
  observedAt: string;
  requestedGeneration: string;
  completedGeneration: string;
  active?: {
    claimId: string;
    fence: string;
    ownerId: string;
    turnSeq: number;
    phase: 'claimed' | 'executing' | 'committing';
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
    leaseState: 'live' | 'expiring' | 'expired';
  };
  dispatchIntent?: {
    generation: string;
    state: 'pending' | 'enqueued' | 'overdue';
    createdAt: string;
    enqueuedAt?: string;
  };
  issues: Array<
    | 'claim_expired'
    | 'runnable_without_owner'
    | 'dispatch_overdue'
    | 'terminal_projection_mismatch'
    | 'projection_partial'
  >;
};

export type AgentRunMemoryView = {
  taskId: string;
  tenantId: string;
  agentId?: string;
  memory?: unknown;
  operations: MemoryOperationRun[];
};
