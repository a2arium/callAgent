import type { Intent, MentalState, MemoryReader, MemoryWriter, TaskContext, ExecOutcome } from '@a2arium/callagent-core';
import type { EnvironmentState } from '@a2arium/callagent-core';
import { runLocalTranscriptDemo } from './local-run.js';

type Sensory = {
    latestUser?: { runTriage: boolean; transcriptPath?: string };
};

type Obs =
    | { kind: 'idle' }
    | { kind: 'user_run'; runTriage: boolean; transcriptPath?: string };

export type ModeratorExecPayload = { ran: boolean; transcriptPath: string };
export type ModeratorExecError = { code: string; message: string };

function attention(_prev: MentalState<Sensory>, _env: unknown, _mem: MemoryReader): unknown {
    return undefined;
}

function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
    const userObs = env.inbox.current.find(
        (o: { source?: string; kind?: string }) => o.source === 'user' && o.kind === 'input.provided'
    );
    if (!userObs) {
        return { kind: 'idle' };
    }
    const payload = userObs.payload as { value?: unknown };
    const v = payload?.value;
    if (!v || typeof v !== 'object' || v === null) {
        return { kind: 'idle' };
    }
    const runTriage = (v as { runTriage?: unknown }).runTriage === true;
    if (!runTriage) {
        return { kind: 'idle' };
    }
    const transcriptPath =
        typeof (v as { transcriptPath?: unknown }).transcriptPath === 'string'
            ? (v as { transcriptPath: string }).transcriptPath
            : undefined;
    return { kind: 'user_run', runTriage: true, transcriptPath };
}

function learning(
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
                latestUser: { runTriage: obs.runTriage, transcriptPath: obs.transcriptPath },
            },
        },
    };
}

function policy(m: MentalState<Sensory>, _mem: MemoryReader): Intent {
    const latest = m.memory?.sensory?.latestUser;
    if (latest?.runTriage === true) {
        return {
            kind: 'internal',
            intent: 'ethical_triage_run',
            data: { transcriptPath: latest.transcriptPath },
        };
    }
    return { kind: 'wait' };
}

function shield(_m: MentalState<Sensory>, intent: Intent, _mem: MemoryReader) {
    return { action: 'pass' as const, intent };
}

async function execution(
    intent: Intent,
    _ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<ExecOutcome<ModeratorExecPayload, ModeratorExecError>> {
    if (intent.kind === 'wait') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { ran: false, transcriptPath: '' } },
        };
    }
    if (intent.kind !== 'internal' || intent.intent !== 'ethical_triage_run') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'error', error: { code: 'bad_intent', message: 'expected ethical_triage_run' } },
        };
    }
    const data = intent.data as { transcriptPath?: string } | undefined;
    const transcriptPath = await runLocalTranscriptDemo(data?.transcriptPath);
    return {
        action: { kind: 'internal', done: true },
        result: { status: 'ok', data: { ran: true, transcriptPath } },
    };
}

function transition(): { kind: 'complete' } {
    return { kind: 'complete' };
}

export const ethicalModeratorModules = {
    attention,
    perception,
    learning,
    policy,
    shield,
    execution,
    transition,
};
