import type { ScaffoldOptions } from './types.js';
import { toKebabPackageSegment } from './naming.js';

export type MinimalRenderContext = ScaffoldOptions & {
    packageName: string;
    description: string;
};

export function buildMinimalContext(opts: ScaffoldOptions): MinimalRenderContext {
    const description = opts.description ?? 'An APLRET agent (scaffolded).';
    const packageName = `@a2arium/${toKebabPackageSegment(opts.name)}`;
    return { ...opts, packageName, description };
}

export function renderPackageJson(ctx: MinimalRenderContext): string {
    const deps = ctx.monorepo
        ? {
              '@a2arium/callagent-core': 'workspace:*',
              '@a2arium/callagent-types': 'workspace:*',
          }
        : {
              '@a2arium/callagent-core': '^0.2.0',
              '@a2arium/callagent-types': '^0.2.0',
          };

    const testFiles =
        ctx.preset === 'non-trivial'
            ? [
                  'tests/golden.test.ts',
                  'tests/resume.test.ts',
                  'tests/failure.test.ts',
                  'tests/invariant.test.ts',
              ]
            : ['tests/golden.test.ts'];
    const testScript = `node --experimental-vm-modules ../../../node_modules/jest/bin/jest.js --config ../../../jest.config.cjs --runTestsByPath ${testFiles.join(' ')}`;

    return `${JSON.stringify(
        {
            name: ctx.packageName,
            version: '0.1.0',
            private: true,
            type: 'module',
            main: 'dist/agent.js',
            exports: {
                '.': './dist/agent.js',
            },
            scripts: {
                build: 'tsc -p tsconfig.json',
                test: testScript,
            },
            dependencies: deps,
            devDependencies: {
                typescript: '^5.8.3',
            },
        },
        null,
        2
    )}\n`;
}

/** Relative path from scaffolded package dir to repo-root `tsconfig.base.json`. */
function monorepoTsconfigExtends(outputDir: string): string {
    const n = outputDir.replace(/\\/g, '/');
    if (n.includes('apps/examples/')) {
        return '../../../tsconfig.base.json';
    }
    return '../../tsconfig.base.json';
}

export function renderTsconfig(ctx: MinimalRenderContext): string {
    const extendsPath = ctx.monorepo ? monorepoTsconfigExtends(ctx.outputDir) : undefined;
    const base = extendsPath
        ? {
              extends: extendsPath,
              compilerOptions: {
                  module: 'nodenext',
                  moduleResolution: 'nodenext',
                  outDir: 'dist',
                  rootDir: '.',
                  noEmit: false,
              },
              include: ['*.ts', '**/*.ts'],
              exclude: ['node_modules', 'dist', 'tests'],
          }
        : {
              compilerOptions: {
                  target: 'ES2022',
                  module: 'nodenext',
                  moduleResolution: 'nodenext',
                  strict: true,
                  esModuleInterop: true,
                  skipLibCheck: true,
                  outDir: 'dist',
                  rootDir: '.',
                  declaration: true,
              },
              include: ['*.ts', '**/*.ts'],
              exclude: ['node_modules', 'dist', 'tests'],
          };
    return `${JSON.stringify(base, null, 2)}\n`;
}

export function renderTypesTs(): string {
    return `import type { MentalState } from '@a2arium/callagent-core';

export type Sensory = {
    latestUserText?: string;
};

export type Obs =
    | { kind: 'user_message'; text: string }
    | { kind: 'idle' };

export type AgentIntent =
    | { kind: 'complete'; result?: unknown }
    | { kind: 'wait' };

export type Stage = 'idle' | 'running' | 'completed' | 'failed';

export type ExecPayload = {
    idle?: boolean;
    echoed?: unknown;
};

export type ExecError = {
    code: string;
    message: string;
};

export type M = MentalState<Sensory>;
`;
}

export function renderAttentionTs(): string {
    return `import type { AttentionSignal, MentalState, EnvironmentState, MemoryReader } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

/** Minimal attention signal — replace with a real signal when needed. */
export function attention(
    _prev: MentalState<Sensory>,
    _env: EnvironmentState,
    _mem: MemoryReader
): AttentionSignal {
    return undefined as unknown as AttentionSignal;
}
`;
}

export function renderPerceptionTs(): string {
    return `import type { EnvironmentState, MemoryReader } from '@a2arium/callagent-core';
import type { Obs } from './types.js';

export function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
    const userObs = env.inbox.current.find((o) => o.source === 'user' && o.kind === 'input.provided');
    if (!userObs) {
        return { kind: 'idle' };
    }
    const payload = userObs.payload as { value?: unknown };
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

export function renderLearningTs(): string {
    return `import type { MentalState, MemoryReader, MemoryWriter } from '@a2arium/callagent-core';
import type { Intent } from '@a2arium/callagent-core';
import type { Obs, Sensory } from './types.js';

export function learning(
    prev: MentalState<Sensory>,
    _prevAction: Intent | undefined,
    obs: Obs,
    _mem: MemoryReader,
    _writer: MemoryWriter
): MentalState<Sensory> {
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

export function renderPolicyTs(): string {
    return `import type { MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { AgentIntent, Sensory } from './types.js';

export function policy(m: MentalState<Sensory>, _mem: MemoryReader): Intent {
    const t = m.memory?.sensory?.latestUserText;
    if (t) {
        const next: AgentIntent = { kind: 'complete', result: { echoed: t } };
        return next;
    }
    const next: AgentIntent = { kind: 'wait' };
    return next;
}
`;
}

export function renderShieldTs(): string {
    return `import type { MentalState, MemoryReader, Intent, ShieldOutcome } from '@a2arium/callagent-core';
import type { Sensory } from './types.js';

export function shield(_m: MentalState<Sensory>, intent: Intent, _mem: MemoryReader): ShieldOutcome {
    return { action: 'pass', intent };
}
`;
}

export function renderExecutionTs(): string {
    return `import type { TaskContext, MentalState, MemoryReader, Intent } from '@a2arium/callagent-core';
import type { ExecOutcome } from '@a2arium/callagent-core';
import type { ExecError, ExecPayload, Sensory } from './types.js';

async function handleWaitIntent(ctx: TaskContext): Promise<ExecOutcome<ExecPayload, ExecError>> {
    const handle = await ctx.requestInput('Please provide input');
    return {
        action: { kind: 'prompt_user', token: handle.token },
        result: { status: 'ok', data: { idle: true } },
    };
}

function handleCompleteIntent(intent: Intent): ExecOutcome<ExecPayload, ExecError> {
    return {
        action: { kind: 'internal', done: true },
        result: { status: 'ok', data: intent.kind === 'complete' ? intent.result ?? { echoed: true } : { echoed: true } },
    };
}

export async function execution(
    intent: Intent,
    _ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<ExecOutcome<ExecPayload, ExecError>> {
    if (intent.kind === 'complete') {
        return handleCompleteIntent(intent);
    }
    if (intent.kind === 'wait') {
        return handleWaitIntent(_ctx);
    }
    return {
        action: { kind: 'internal', done: true },
        result: {
            status: 'error',
            error: { code: 'unsupported_intent', message: 'Unsupported intent for scaffold template' },
        },
    };
}
`;
}

export function renderTransitionTs(): string {
    return `import type { EnvironmentState, MentalState, MemoryReader } from '@a2arium/callagent-core';
import type { ExecOutcome, TransitionOut } from '@a2arium/callagent-core';
import type { ExecPayload, ExecError, Sensory } from './types.js';

export function transition(
    _env: EnvironmentState,
    exec: ExecOutcome<ExecPayload, ExecError>,
    _m: MentalState<Sensory>,
    _mem: MemoryReader
): TransitionOut {
    if (exec.action.kind === 'prompt_user') {
        return { kind: 'await_input', token: exec.action.token };
    }
    if (exec.action.kind === 'internal' && exec.action.done) {
        return { kind: 'complete', result: exec.result.status === 'ok' ? exec.result.data : undefined };
    }
    return { kind: 'fail', reason: 'unexpected_exec_outcome' };
}
`;
}

export function renderAgentTs(ctx: MinimalRenderContext): string {
    return `import { createAgent } from '@a2arium/callagent-core';
import { attention } from './attention.js';
import { perception } from './perception.js';
import { learning } from './learning.js';
import { policy } from './policy.js';
import { shield } from './shield.js';
import { execution } from './execution.js';
import { transition } from './transition.js';
import type { Sensory, Obs, ExecPayload, ExecError } from './types.js';

export default createAgent<Sensory, Obs, unknown, ExecPayload, ExecError>(
    {
        attention,
        perception,
        learning,
        policy,
        shield,
        execution,
        transition,
    },
    import.meta.url
);
`;
}

export function renderGoldenTest(ctx: MinimalRenderContext): string {
    const pkg = ctx.packageName;
    return `import { createTestHarness } from '@a2arium/callagent-core';
import { attention } from '../attention.js';
import { perception } from '../perception.js';
import { learning } from '../learning.js';
import { policy } from '../policy.js';
import { shield } from '../shield.js';
import { execution } from '../execution.js';
import { transition } from '../transition.js';

describe('${pkg} — golden path', () => {
    it('completes after user input', async () => {
        const harness = createTestHarness({
            attention,
            perception,
            learning,
            policy,
            shield,
            execution,
            transition,
        });

        harness.injectUserInput({ text: 'hello' });
        await harness.runTurn();

        expect(harness.lastTrace().transition?.kind).toBe('complete');
    });
});
`;
}
