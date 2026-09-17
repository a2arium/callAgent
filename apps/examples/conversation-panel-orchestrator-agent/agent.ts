import { createAgent } from '@a2arium/callagent-core';
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
        llmConfig: {
            provider: 'openai',
            modelAliasOrName: 'fast',
            systemPrompt: 'You are a short panel moderator. Output concise framing only when asked.',
            historyMode: 'stateless',
        },
    },
    import.meta.url
);
