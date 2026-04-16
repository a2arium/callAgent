import type { MinimalRenderContext } from './renderMinimal.js';

export function renderFlowMd(ctx: MinimalRenderContext): string {
    const usesLlm = Boolean(ctx.usesLlm);
    const usesTools = Boolean(ctx.usesTools);
    const usesChildren = Boolean(ctx.usesChildren);
    const usesPlans = Boolean(ctx.usesPlans);
    return `---
agent: ${ctx.name}
entry: ./agent.ts
uses_llm: ${usesLlm}
uses_tools: ${usesTools}
uses_children: ${usesChildren}
uses_plans: ${usesPlans}
terminal_outcomes:
  - success
  - failure
---

# Flow: ${ctx.name}

## Purpose

<!-- TODO: 1–3 sentences describing what this agent does for the user or caller. -->

## Flow summary

<!-- TODO: 4–10 numbered steps: happy path, key failures, await/resume points. -->

## State vocabulary

### Stages
- \`idle\`
- \`running\`
- \`completed\`
- \`failed\`
<!-- TODO: Add agent-specific stages (e.g. \`awaiting_input\`, \`awaiting_tool\`). -->

### Normalized observations
<!-- TODO: List normalized observation kinds matching types.ts Obs union. -->

### Intents
<!-- TODO: List intent kinds matching Policy (framework Intent union). -->

### Execution result kinds
<!-- TODO: List result categories Transition consumes. -->

### Terminal outcomes
- Success: <!-- TODO -->
- Failure: <!-- TODO -->

## Flow table

| Current condition | Policy emits | Execution does | Transition outcome | Next turn consequence |
|---|---|---|---|---|
| <!-- TODO --> | | | | |

## Branches and failure paths

### B1: <!-- TODO: failure or alternate path -->
- **Trigger**:
- **Response**:
- **Outcome**:

## Turn semantics

<!-- TODO: APLRET-specific notes: when data is decision-visible, what is awaited, what resumes the loop. -->

## Code map

- \`agent.ts\`, \`types.ts\`, \`perception.ts\`, \`learning.ts\`, \`policy.ts\`, \`execution.ts\`, \`transition.ts\`
<!-- TODO: Update with normalizers/, effects/, selectors.ts, reducers.ts as applicable. -->
`;
}

export function renderSelectorsTs(): string {
    return `import type { MentalState, MemoryReader } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

/** Decision-ready view for Policy — keep reads out of deep nesting. */
export function readPolicyView(m: MentalState<Sensory>, _mem: MemoryReader): { latestUserText?: string } {
    return { latestUserText: m.memory?.sensory?.latestUserText };
}
`;
}

export function renderReducersTs(): string {
    return `import type { MentalState } from '@a2arium/callagent-core';
import type { Obs, Sensory } from './types.js';

export function applyObservation(prev: MentalState<Sensory>, obs: Obs): MentalState<Sensory> {
    if (obs.kind === 'idle') {
        return prev;
    }
    return {
        ...prev,
        memory: {
            ...prev.memory,
            sensory: {
                ...prev.memory.sensory,
                latestUserText: obs.text,
            },
        },
    };
}
`;
}

export function renderNormalizerUserTs(): string {
    return `import type { Observation } from '@a2arium/callagent-core';
import type { Obs } from '../types.js';

/** Normalize user inbox rows into agent Obs. */
export function normalizeUserObservation(obs: Observation): Obs | null {
    if (obs.source !== 'user' || obs.kind !== 'input.provided') {
        return null;
    }
    const payload = obs.payload as { value?: unknown };
    const v = payload?.value;
    const text =
        typeof v === 'string'
            ? v
            : v && typeof v === 'object' && v !== null && 'text' in v
              ? String((v as { text: unknown }).text)
              : undefined;
    if (!text) {
        return { kind: 'idle' };
    }
    return { kind: 'user_message', text };
}
`;
}

export function renderNormalizerInternalTs(): string {
    return `import type { Observation } from '@a2arium/callagent-core';
import type { Obs } from '../types.js';

/** Placeholder for internal/ framework observations — extend as needed. */
export function normalizeInternalObservation(_obs: Observation): Obs | null {
    return null;
}
`;
}

export function renderNormalizerToolTs(): string {
    return `import type { Observation } from '@a2arium/callagent-core';
import type { Obs } from '../types.js';

/** Placeholder — wire tool completions into \`Obs\` when \`usesTools\` is enabled. */
export function normalizeToolObservation(_obs: Observation): Obs | null {
    return null;
}
`;
}

export function renderNormalizerChildTs(): string {
    return `import type { Observation } from '@a2arium/callagent-core';
import type { Obs } from '../types.js';

/** Placeholder — wire child completions into \`Obs\` when \`usesChildren\` is enabled. */
export function normalizeChildObservation(_obs: Observation): Obs | null {
    return null;
}
`;
}

export function renderPerceptionNonTrivial(opts: { usesTools?: boolean; usesChildren?: boolean }): string {
    const toolImport = opts.usesTools ? "import { normalizeToolObservation } from './normalizers/tool.js';\n" : '';
    const childImport = opts.usesChildren ? "import { normalizeChildObservation } from './normalizers/child.js';\n" : '';
    const toolChain = opts.usesTools
        ? `        const t = normalizeToolObservation(obs);
        if (t) {
            return t;
        }
`
        : '';
    const childChain = opts.usesChildren
        ? `        const c = normalizeChildObservation(obs);
        if (c) {
            return c;
        }
`
        : '';

    return `import type { EnvironmentState, MemoryReader } from '@a2arium/callagent-core';
import type { Obs } from './types.js';
import { normalizeUserObservation } from './normalizers/user.js';
import { normalizeInternalObservation } from './normalizers/internal.js';
${toolImport}${childImport}

export function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
    for (const obs of env.inbox.current) {
        const u = normalizeUserObservation(obs);
        if (u) {
            return u;
        }
${toolChain}${childChain}        const i = normalizeInternalObservation(obs);
        if (i) {
            return i;
        }
    }
    return { kind: 'idle' };
}
`;
}

export function renderLearningNonTrivial(): string {
    return `import type { MentalState, MemoryReader, MemoryWriter } from '@a2arium/callagent-core';
import type { Intent } from '@a2arium/callagent-core';
import type { Obs, Sensory } from './types.js';
import { applyObservation } from './reducers.js';

export function learning(
    prev: MentalState<Sensory>,
    _prevAction: Intent | undefined,
    obs: Obs,
    _mem: MemoryReader,
    _writer: MemoryWriter
): MentalState<Sensory> {
    return applyObservation(prev, obs);
}
`;
}

export function renderPolicyNonTrivial(): string {
    return `import type { MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { AgentIntent, Sensory } from './types.js';
import { readPolicyView } from './selectors.js';

export function policy(m: MentalState<Sensory>, mem: MemoryReader): Intent {
    const v = readPolicyView(m, mem).latestUserText;
    if (v) {
        const next: AgentIntent = { kind: 'complete', result: { echoed: v } };
        return next;
    }
    const next: AgentIntent = { kind: 'wait' };
    return next;
}
`;
}

export function renderEffectLlmPlaceholderTs(): string {
    return `import type { TaskContext, MemoryReader, MentalState } from '@a2arium/callagent-core';
import type { Sensory } from '../../types.js';

/** Placeholder LLM effect handler for non-trivial scaffolded agents. */
export async function runLlmEffect(
    _ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<{ ok: true }> {
    return { ok: true };
}
`;
}

export function renderEffectToolPlaceholderTs(): string {
    return `import type { TaskContext, MemoryReader, MentalState } from '@a2arium/callagent-core';
import type { Sensory } from '../../types.js';

/** Placeholder tool effect handler for non-trivial scaffolded agents. */
export async function runToolEffect(
    _ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<{ ok: true }> {
    return { ok: true };
}
`;
}

export function renderPromptPlaceholderTs(): string {
    return `/** Placeholder prompt builder for non-trivial scaffolded agents. */
export function buildPrompt(input: string): string {
    return \`TODO: replace prompt template. Input: \${input}\`;
}
`;
}

export function renderContractLlmPlaceholderTs(): string {
    return `import { z } from 'zod';

/** Placeholder LLM output contract for non-trivial scaffolded agents. */
export const LlmOutputSchema = z.object({
    ok: z.boolean(),
});
`;
}

export function renderContractToolPlaceholderTs(): string {
    return `import { z } from 'zod';

/** Placeholder tool contract for non-trivial scaffolded agents. */
export const ToolResultSchema = z.object({
    ok: z.boolean(),
});
`;
}

export function renderResumeTest(ctx: MinimalRenderContext): string {
    return `import { createTestHarness } from '@a2arium/callagent-core';
import { attention } from '../attention.js';
import { perception } from '../perception.js';
import { learning } from '../learning.js';
import { policy } from '../policy.js';
import { shield } from '../shield.js';
import { execution } from '../execution.js';
import { transition } from '../transition.js';

describe('${ctx.packageName} — resume (stub)', () => {
    it('awaits input on empty turn and resumes to complete', async () => {
        const harness = createTestHarness({
            attention,
            perception,
            learning,
            policy,
            shield,
            execution,
            transition,
        });
        await harness.runTurn();
        expect(harness.lastTrace().transition?.kind).toBe('await_input');

        harness.injectUserInput({ text: 'resume me' });
        await harness.runTurn();
        expect(harness.lastTrace().transition?.kind).toBe('complete');
    });
});
`;
}

export function renderFailureTest(ctx: MinimalRenderContext): string {
    return `import { transition } from '../transition.js';
import type { EnvironmentState, MentalState, MemoryReader } from '@a2arium/callagent-core';
import type { ExecOutcome } from '@a2arium/callagent-core';
import type { ExecPayload, ExecError, Sensory } from '../types.js';

function fakeExecOutcome(): ExecOutcome<ExecPayload, ExecError> {
    return {
        action: { kind: 'internal', done: false },
        result: { status: 'ok', data: { idle: true } },
    };
}

describe('${ctx.packageName} — failure paths (stub)', () => {
    it('fails on unsupported execution action shape', () => {
        const env = { inbox: { current: [] }, pending: {}, turn: 0 } as unknown as EnvironmentState;
        const m = { memory: { sensory: {} } } as unknown as MentalState<Sensory>;
        const mem = {} as unknown as MemoryReader;
        const out = transition(env, fakeExecOutcome(), m, mem);
        expect(out.kind).toBe('fail');
    });
});
`;
}

export function renderInvariantTest(ctx: MinimalRenderContext): string {
    return `import { applyObservation } from '../reducers.js';
import type { MentalState } from '@a2arium/callagent-core';
import type { Sensory } from '../types.js';

describe('${ctx.packageName} — invariants (stub)', () => {
    it('idle observation keeps mental state unchanged', () => {
        const prev: MentalState<Sensory> = { memory: { sensory: {} } };
        const next = applyObservation(prev, { kind: 'idle' });
        expect(next).toBe(prev);
    });
});
`;
}
