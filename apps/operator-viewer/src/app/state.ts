export type FleetSearch = {
  tenantId: string;
  scope: 'roots' | 'all';
  agentId: string;
  status: string;
  since: string;
  taskId: string;
  hasLlm: boolean;
  hasMemory: boolean;
  costState: '' | 'captured' | 'missing';
};

export type RunSearch = FleetSearch & {
  nodeId: string;
  turn: string;
  tab: RunInspectorTab;
};

export type RunInspectorTab = 'summary' | 'turns' | 'tools' | 'llm' | 'memory';

export type MemorySearch = {
  tenantId: string;
  tab: 'overview' | 'probe' | 'inventory' | 'activity' | 'entities';
  key: string;
  tag: string;
  entity: string;
  entityType: string;
  agentId: string;
  taskId: string;
  op: '' | 'read' | 'write' | 'delete';
  since: string;
  selectedKey: string;
};

export const defaultTenantId = 'default';

export function parseFleetSearch(value: Record<string, unknown>): FleetSearch {
  return {
    tenantId: stringParam(value.tenantId, defaultTenantId),
    scope: value.scope === 'all' ? 'all' : 'roots',
    agentId: stringParam(value.agentId, ''),
    status: stringParam(value.status, ''),
    since: stringParam(value.since, ''),
    taskId: stringParam(value.taskId, ''),
    hasLlm: boolParam(value.hasLlm),
    hasMemory: boolParam(value.hasMemory),
    costState: costStateParam(value.costState),
  };
}

export function parseRunSearch(value: Record<string, unknown>): RunSearch {
  const fleet = parseFleetSearch(value);
  return {
    ...fleet,
    nodeId: stringParam(value.nodeId, ''),
    turn: stringParam(value.turn, ''),
    tab: runInspectorTabParam(value.tab),
  };
}

export function parseMemorySearch(value: Record<string, unknown>): MemorySearch {
  const tab = value.tab === 'probe' || value.tab === 'inventory' || value.tab === 'activity' || value.tab === 'entities'
    ? value.tab
    : 'overview';
  const op = value.op === 'read' || value.op === 'write' || value.op === 'delete' ? value.op : '';
  return {
    tenantId: stringParam(value.tenantId, defaultTenantId),
    tab,
    key: stringParam(value.key, ''),
    tag: stringParam(value.tag, ''),
    entity: stringParam(value.entity, ''),
    entityType: stringParam(value.entityType, ''),
    agentId: stringParam(value.agentId, ''),
    taskId: stringParam(value.taskId, ''),
    op,
    since: stringParam(value.since, ''),
    selectedKey: stringParam(value.selectedKey, ''),
  };
}

function stringParam(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function boolParam(value: unknown): boolean {
  return value === true || value === 'true';
}

function runInspectorTabParam(value: unknown): RunInspectorTab {
  return value === 'turns' || value === 'tools' || value === 'llm' || value === 'memory'
    ? value
    : 'summary';
}

function costStateParam(value: unknown): FleetSearch['costState'] {
  return value === 'captured' || value === 'missing' ? value : '';
}
