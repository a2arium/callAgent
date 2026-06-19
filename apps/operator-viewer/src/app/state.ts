export type FleetSearch = {
  tenantId: string;
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
  tab: string;
};

export const defaultTenantId = 'default';

export function parseFleetSearch(value: Record<string, unknown>): FleetSearch {
  return {
    tenantId: stringParam(value.tenantId, defaultTenantId),
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
    tab: stringParam(value.tab, 'summary'),
  };
}

function stringParam(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function boolParam(value: unknown): boolean {
  return value === true || value === 'true';
}

function costStateParam(value: unknown): FleetSearch['costState'] {
  return value === 'captured' || value === 'missing' ? value : '';
}
