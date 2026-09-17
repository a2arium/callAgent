import { createAgent } from '@a2arium/callagent-core';
import type { ModeratorExecPayload, ModeratorExecError } from './moderator-modules.js';
import { ethicalModeratorModules } from './moderator-modules.js';

type Sensory = {
    latestUser?: { runTriage: boolean; transcriptPath?: string };
};
type Obs =
    | { kind: 'idle' }
    | { kind: 'user_run'; runTriage: boolean; transcriptPath?: string };

export { ethicalModeratorModules } from './moderator-modules.js';

export default createAgent<Sensory, Obs, unknown, ModeratorExecPayload, ModeratorExecError>(
    {
        ...ethicalModeratorModules,
        llmConfig: {
            provider: 'openai',
            modelAliasOrName: 'fast',
            systemPrompt:
                'Moderator demo agent: send user JSON { "runTriage": true, "transcriptPath"?: string } to run the in-memory deliberation.',
            historyMode: 'stateless',
        },
    },
    import.meta.url
);
