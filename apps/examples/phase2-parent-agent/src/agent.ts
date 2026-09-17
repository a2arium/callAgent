import { createAgent } from '@a2arium/callagent-core';
import { attention } from './attention.js';
import { perception } from './perception.js';
import { learning } from './learning.js';
import { policy } from './policy.js';
import { shield } from './shield.js';
import { execution } from './execution.js';
import { transition } from './transition.js';
import type { ParentAttention, ParentExecError, ParentExecPayload, ParentObservation, ParentSensory } from './types.js';
import { PHASE2_PARENT_AGENT_ID } from './types.js';

export async function registerPhase2ParentAgent(): Promise<void> {
    await createAgent<ParentSensory, ParentObservation, ParentAttention, ParentExecPayload, ParentExecError>({
        agentCard: {
            inline: {
                name: PHASE2_PARENT_AGENT_ID,
                version: '0.1.0',
                description: 'Parent APLRET agent for validating operator DAG child edges.',
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
                    id: 'operator-dag-parent-check',
                    name: 'Operator DAG Parent Check',
                    description: 'Delegates to phase2-loop-agent and completes with the child result.',
                }],
                url: 'http://127.0.0.1:8790',
            },
        },
        runtimeManifest: {
            inline: {
                name: PHASE2_PARENT_AGENT_ID,
                version: '0.1.0',
                runMode: 'loop',
                budgets: { maxTurns: 4 },
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
