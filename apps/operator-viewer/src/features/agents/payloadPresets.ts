const STORAGE_KEY = 'callagent.operator.payloadPresets.v1';
const DEFAULT_PAYLOAD = `{
}`;

export type AgentPayloadPreset = {
  id: string;
  name: string;
  payloadText: string;
  updatedAt: string;
};

export type AgentPayloadPresetState = {
  selectedPresetId: string;
  presets: AgentPayloadPreset[];
};

type StoredPayloadPresets = {
  version: 1;
  agents: Record<string, AgentPayloadPresetState>;
};

export function loadAgentPayloadPresetState(agentId: string): AgentPayloadPresetState {
  const store = readStore();
  const existing = store.agents[agentId];
  if (existing && existing.presets.length > 0) {
    return existing;
  }
  return createDefaultPresetState();
}

export function saveAgentPayloadPresetState(agentId: string, state: AgentPayloadPresetState): void {
  const store = readStore();
  store.agents[agentId] = normalizePresetState(state);
  writeStore(store);
}

export function createPayloadPreset(name = 'New payload'): AgentPayloadPreset {
  return {
    id: `payload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    payloadText: DEFAULT_PAYLOAD,
    updatedAt: new Date().toISOString(),
  };
}

function createDefaultPresetState(): AgentPayloadPresetState {
  const preset = createPayloadPreset('Default');
  return {
    selectedPresetId: preset.id,
    presets: [preset],
  };
}

function normalizePresetState(state: AgentPayloadPresetState): AgentPayloadPresetState {
  if (state.presets.length === 0) {
    return createDefaultPresetState();
  }

  const selectedExists = state.presets.some((preset) => preset.id === state.selectedPresetId);
  return {
    selectedPresetId: selectedExists ? state.selectedPresetId : state.presets[0]?.id ?? '',
    presets: state.presets,
  };
}

function readStore(): StoredPayloadPresets {
  if (typeof window === 'undefined') {
    return emptyStore();
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    const candidate = parsed as Partial<StoredPayloadPresets>;
    if (candidate.version !== 1 || !candidate.agents || typeof candidate.agents !== 'object') {
      return emptyStore();
    }
    return {
      version: 1,
      agents: candidate.agents as Record<string, AgentPayloadPresetState>,
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: StoredPayloadPresets): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function emptyStore(): StoredPayloadPresets {
  return {
    version: 1,
    agents: {},
  };
}
