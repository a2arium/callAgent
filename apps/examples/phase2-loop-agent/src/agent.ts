import { createAgent } from '@a2arium/callagent-core';
import { attention } from './attention.js';
import { perception } from './perception.js';
import { learning } from './learning.js';
import { policy } from './policy.js';
import { shield } from './shield.js';
import { execution } from './execution.js';
import { transition } from './transition.js';
import type { Attention, ExecError, ExecPayload, Phase2Observation, Sensory } from './types.js';
import { PHASE2_LOOP_AGENT_ID } from './types.js';

export async function registerPhase2LoopAgent(): Promise<void> {
    await createAgent<Sensory, Phase2Observation, Attention, ExecPayload, ExecError>({
        agentCard: {
            inline: {
                name: PHASE2_LOOP_AGENT_ID,
                version: '0.1.0',
                description: 'Canonical loop-mode APLRET example for durable orchestration validation.',
                supportedInterfaces: [{
                    url: 'http://127.0.0.1:8790/rpc',
                    protocolBinding: 'JSONRPC',
                    protocolVersion: '1.0',
                }],
                capabilities: {
                    streaming: true,
                    pushNotifications: false,
                },
                defaultInputModes: ['text/plain', 'application/json'],
                defaultOutputModes: ['text/plain', 'application/json'],
                skills: [{
                    id: 'durable-loop-check',
                    name: 'Durable Loop Check',
                    description: 'Prompts once when asked for details, resumes, replies, and completes.',
                }],
                url: 'http://127.0.0.1:8790',
            },
        },
        runtimeManifest: {
            inline: {
                name: PHASE2_LOOP_AGENT_ID,
                version: '0.1.0',
                runMode: 'loop',
                budgets: { maxTurns: 3 },
                observability: {
                    turnTrace: {
                        enabled: true,
                        level: 'summary',
                    },
                },
            },
        },
        attention,
        perception,
        learning,
        policy,
        shield,
        execution,
        transition,
    }, import.meta.url);
}
