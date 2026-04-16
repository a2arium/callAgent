import { expectType } from 'tsd';
import { ScaffoldOptionsSchema, scaffoldAgent } from '../src/index.js';
import type { AgentPreset, ScaffoldOptions, ScaffoldResult } from '../src/scaffold/types.js';

const parsed = ScaffoldOptionsSchema.parse({
    name: 'demo-agent',
    preset: 'minimal',
    outputDir: './out',
});

expectType<ScaffoldOptions>(parsed);
expectType<AgentPreset>(parsed.preset);

expectType<Promise<ScaffoldResult>>(scaffoldAgent(parsed));
