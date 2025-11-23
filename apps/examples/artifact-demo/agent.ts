import {
    createAgent,
    ensureAgentContext,
    type MentalState,
    type EnvironmentState,
    Artifact,
    type TaskContext,
    type ProposedAction,
    type ExecutableAction,
    type ExecResult,
    type TransitionOut,
    type ObservationConfig
} from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import * as util from 'node:util';
import './child-agent.js';

/**
 * Artifact Demo Agent
 * 
 * This agent demonstrates the Artifact<T> pattern for handling large payloads
 * in the APLRET architecture across two turns:
 * 
 * Turn 1: Generate large data and offload it to an Artifact<string>
 * Turn 2: Load the data back from the artifact and process it
 */

type ArtifactDemoInput = {
    sizeKB?: number;
};

type DemoSensory = {
    largeDataArtifact?: Artifact<string>;
    stats?: {
        sizeKB: number;
        lineCount: number;
        wordCount: number;
    };
};

type DemoObservation = {
    // Internal observations for passing data between turns
    generatedArtifact?: Artifact<string>;
};

type AttentionSignal = {
    // No attention signal needed
};

export default createAgent<DemoSensory, DemoObservation, AttentionSignal>({
    manifest: './agent.json',
    tenantId: 'default',

    attention: () => ({}),

    perception: (env) => {
        // Extract internal observations (if any)
        const generatedObs = env.inbox.current.find((o: any) => o.kind === 'internal' && o.payload?.kind === 'generated');
        return {
            generatedArtifact: generatedObs ? (generatedObs as any).payload.artifact : undefined
        };
    },

    learning: (prev, _, obs) => {
        const sensory = (prev.memory?.sensory || {}) as DemoSensory;
        const nextSensory: DemoSensory = { ...sensory };

        if (obs.generatedArtifact) {
            nextSensory.largeDataArtifact = obs.generatedArtifact;
            logger.info('💾 [ARTIFACT-DEMO] Learned artifact handle from observation');
        }

        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: nextSensory
            }
        };
    },

    policy: (m: MentalState<DemoSensory>): ProposedAction => {
        const sensory = (m.memory?.sensory || {}) as DemoSensory;
        const vars = (m.memory?.vars || {}) as any;

        // Check if we have a pending artifact from Turn 1 (restored from snapshot)
        if (vars.pendingArtifact && !sensory.largeDataArtifact) {
            // We have it in vars, move it to sensory logic via an internal action
            // Or just use it directly.
            return {
                kind: 'internal' as const,
                intent: 'process',
                data: { artifact: vars.pendingArtifact }
            };
        }

        // Turn 1: Generate (if no artifact yet)
        if (!sensory.largeDataArtifact) {
            return {
                kind: 'internal' as const,
                intent: 'generate',
                data: {}
            };
        }

        // Turn 2: Process (if artifact exists but no stats yet)
        if (sensory.largeDataArtifact && !sensory.stats) {
            return {
                kind: 'internal' as const,
                intent: 'process',
                data: { artifact: sensory.largeDataArtifact }
            };
        }

        return { kind: 'internal' as const, intent: 'done' };
    },

    execution: async (
        intent: ProposedAction,
        ctx: TaskContext
    ): Promise<{ action: ExecutableAction; result: ExecResult }> => {
        // Ensure ctx has all required agent capabilities (including artifacts)
        const agentCtx = ensureAgentContext(ctx);
        const input = agentCtx.task.input as ArtifactDemoInput;

        if (intent.kind !== 'internal') {
            return { action: { kind: 'internal' as const, done: true }, result: { status: 'ok', ts: Date.now() } };
        }

        if (intent.intent === 'generate') {
            const sizeKB = input.sizeKB ?? 1024;
            logger.info('🔧 [ARTIFACT-DEMO] Turn 1: Generating large data', { sizeKB });

            const chunk = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10);
            const iterations = Math.ceil((sizeKB * 1024) / chunk.length);
            let largeText = '';
            for (let i = 0; i < iterations; i++) largeText += `[Chunk ${i}] ${chunk}\n`;

            // Use Artifact.create() to create a LocalArtifact (no ctx needed)
            const artifact = Artifact.create(largeText);

            logger.info('🚀 [ARTIFACT-DEMO] Turn 1: Dispatching child agent to force snapshot save/restore');

            // IMPORTANT: Save artifact to ctx.vars
            if (agentCtx.vars) {
                agentCtx.vars.set('pendingArtifact', artifact);
                const pending = agentCtx.vars.get ? agentCtx.vars.get('pendingArtifact') : undefined;
                logger.info('🧪 [ARTIFACT-DEMO] Stored pendingArtifact in ctx.vars', {
                    exists: !!pending,
                    type: pending && typeof pending,
                    kind: pending && (pending as any).kind,
                    varsDirty: (agentCtx as any).__varsDirty
                });
            }

            let childHandle: unknown;
            try {
                childHandle = await agentCtx.sendTaskToAgent(
                    'artifact-demo-child',
                    { reason: 'hydrate-artifact' },
                    { awaitCompletion: false }
                );
            } catch (error) {
                logger.error('❌ [ARTIFACT-DEMO] Failed to launch child agent', {
                    error: error instanceof Error ? error.message : String(error)
                });
                return {
                    action: { kind: 'internal', done: true },
                    result: { status: 'error', ts: Date.now(), error: { code: 'child_failed', message: 'Unable to launch child agent' } }
                };
            }

            const childToken = (childHandle as any)?.token ?? 'child-token';

            return {
                action: { kind: 'subagent' as const, token: childToken },
                result: {
                    status: 'ok',
                    ts: Date.now(),
                    data: { artifact }
                }
            };
        }

        if (intent.intent === 'process') {
            logger.info('📬 [ARTIFACT-DEMO] Turn 2: Loading data from artifact');
            const artifactHandle = (intent.data as any).artifact as Artifact<string>;
            const varsArtifact = agentCtx.vars?.get ? agentCtx.vars.get('pendingArtifact') : undefined;
            logger.info('🔎 [ARTIFACT-DEMO] Artifact sources before await', {
                intentHasThen: typeof (artifactHandle as any)?.then === 'function',
                intentKind: (artifactHandle as any)?.kind,
                varsHasThen: typeof (varsArtifact as any)?.then === 'function',
                varsKind: (varsArtifact as any)?.kind
            });

            // Log the handle before loading using toJSON() to prove lightweight nature
            // We cast to any to call toJSON because Artifact<T> interface hides it, but implementation has it
            const handleStructure = (artifactHandle as any).toJSON ? (artifactHandle as any).toJSON() : artifactHandle;

            logger.info('🔍 [ARTIFACT-DEMO] Lightweight Artifact Handle (Before Await):', {
                handleStructure
            });

            // This await triggers the lazy load
            const actualData = await artifactHandle;

            const lineCount = actualData.split('\n').length;
            const wordCount = actualData.split(/\s+/).length;

            logger.info('📦 [ARTIFACT-DEMO] Data loaded successfully', {
                preview: actualData.substring(0, 50) + '...',
                totalLength: actualData.length,
                type: typeof actualData
            });

            logger.info('✅ [ARTIFACT-DEMO] Analysis complete', { lineCount, wordCount });
            await agentCtx.complete(0);

            return {
                action: { kind: 'internal' as const, done: true },
                result: {
                    status: 'ok',
                    ts: Date.now(),
                    data: { lineCount, wordCount }
                }
            };
        }

        await agentCtx.complete(1);
        return { action: { kind: 'internal' as const, done: true }, result: { status: 'ok', ts: Date.now() } };
    },

    transition: (
        env: EnvironmentState,
        exec: { action: ExecutableAction; result: ExecResult },
        m: MentalState<DemoSensory>
    ): TransitionOut<ObservationConfig> => {
        if (exec.action.kind === 'subagent') {
            return { kind: 'await_child' as const, token: exec.action.token ?? 'child-token' };
        }

        // If execution produced an artifact (and not asking user), feed it back
        if (exec.result?.data && (exec.result.data as any).artifact) {
            return {
                kind: 'continue' as const,
                observations: [{
                    kind: 'internal',
                    source: 'internal' as const,
                    payload: {
                        kind: 'generated',
                        artifact: (exec.result.data as any).artifact
                    },
                    provenance: { ts: Date.now(), turn: env.turn, id: 'gen-obs', correlationId: 'gen-obs' }
                }]
            };
        }

        if (exec.action.kind === 'internal' && exec.action.done) {
            return { kind: 'complete' as const };
        }

        return {
            kind: 'continue' as const,
            observations: []
        };
    }
}, import.meta.url);
