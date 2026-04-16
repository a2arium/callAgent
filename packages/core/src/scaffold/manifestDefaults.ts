import type { AgentCard, AgentRuntimeManifest } from '@a2arium/callagent-types';

export function defaultAgentCard(name: string, description: string): AgentCard {
    return {
        name,
        version: '0.1.0',
        description,
        supportedInterfaces: [
            {
                url: 'http://localhost:3000/a2a',
                protocolBinding: 'JSONRPC',
                protocolVersion: '1.0',
            },
        ],
        capabilities: {
            streaming: false,
            pushNotifications: false,
        },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [
            {
                id: 'default',
                name: 'Default',
                description: 'Scaffolded agent skill — replace with real capabilities.',
            },
        ],
        url: 'http://localhost:3000',
    };
}

export function defaultRuntimeManifest(name: string): AgentRuntimeManifest {
    return {
        name,
        version: '0.1.0',
        runMode: 'loop',
        budgets: {
            maxTurns: 50,
        },
        observability: {
            turnTrace: {
                enabled: true,
                level: 'summary',
            },
        },
    };
}
