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
  progress?: RunProgressView;
};

export type RunProgressSnapshot = {
  schemaVersion: 'run-progress-v1'; phase: string;
  state: 'working' | 'waiting' | 'blocked' | 'retrying'; summary?: string;
  units?: Array<{ key: string; completed: number; total?: number; label?: string }>;
  metrics?: Record<string, number>; next?: string;
  checkpoint?: { committedAt: string; version?: string };
};
export type RunProgressView = {
  status: 'reported'; taskId: string; rootTaskId: string; agentId: string;
  snapshot: RunProgressSnapshot; revision: string; reportedAt: string;
  terminal?: { state: string; at: string };
};
export type RunProgressResponse = RunProgressView | { status: 'unreported'; taskId: string };

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
  disposition?: 'executed' | 'queued' | 'matching_replay' | 'superseded' |
    'terminal_replay' | 'lease_expired_recovery_staged';
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
  cognitiveTurns?: CognitiveTurnRun[];
};

export type CognitiveTurnRun = {
  id: string;
  rootTaskId: string;
  taskId: string;
  agentId?: string;
  turnId?: string;
  cognitionTurnSeq: number;
  segmentSeq?: number;
  attemptKey?: string;
  claimId?: string;
  disposition: 'running' | 'observed' | 'committed' | 'superseded';
  cognition: TurnCognition;
  llmCalls: LlmCallRun[];
  toolCalls: unknown[];
  childCalls: unknown[];
  memoryOps: MemoryOperationRun[];
  startedAt?: string;
  startedAtEstimated?: boolean;
  finishedAt?: string;
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
  terminalReason?: 'completed' | 'provider_error' | 'timeout' | 'cancelled';
  errorCode?: string;
  errorMessage?: string;
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
  schemaVersion: 3 | 4;
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
  summary?: AgentRunGraphSummary;
  omissions?: AgentRunGraphOmission[];
  responseBudget?: OperatorResponseBudget;
};

export type GraphCollectionSummary = {
  total: number;
  returned: number;
  running?: number;
  completed?: number;
  failed?: number;
  latestTurnSeq?: number;
  nextCursor?: string;
};

export type AgentRunGraphSummary = {
  turns: GraphCollectionSummary;
  cognition: GraphCollectionSummary;
  attempts: GraphCollectionSummary;
  memoryOps: GraphCollectionSummary;
  events: GraphCollectionSummary;
  effects: GraphCollectionSummary;
  driverRuns: GraphCollectionSummary;
};

export type AgentRunGraphOmission = {
  collection: 'turns' | 'cognition' | 'attempts' | 'memoryOps' | 'events' | 'effects' | 'driverRuns' | 'previews';
  reason: 'collection_limit' | 'response_budget' | 'projection_unavailable';
  omitted: number;
};

export type OperatorResponseBudget = {
  limitBytes: number;
  actualBytes: number;
  truncated: boolean;
};

export type OperatorPage<T> = {
  items: T[];
  pageInfo: { limit: number; hasMore: boolean; nextCursor?: string };
  summary: GraphCollectionSummary;
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
    recoveryReason?: 'lease_expired' | 'worker_lifetime_lost';
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
