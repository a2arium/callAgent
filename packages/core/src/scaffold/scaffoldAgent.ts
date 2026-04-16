import fs from 'node:fs/promises';
import path from 'node:path';
import { ZodError } from 'zod';
import {
    ScaffoldOptionsSchema,
    type ScaffoldOptions,
    type ScaffoldResult,
    type ScaffoldFailure,
} from './types.js';
import { defaultAgentCard, defaultRuntimeManifest } from './manifestDefaults.js';
import { AgentCardSchema, AgentRuntimeManifestSchema } from '@a2arium/callagent-types';
import {
    buildMinimalContext,
    renderPackageJson,
    renderTsconfig,
    renderTypesTs,
    renderAttentionTs,
    renderPerceptionTs,
    renderLearningTs,
    renderPolicyTs,
    renderShieldTs,
    renderExecutionTs,
    renderTransitionTs,
    renderAgentTs,
    renderGoldenTest,
} from './renderMinimal.js';
import {
    renderFlowMd,
    renderSelectorsTs,
    renderReducersTs,
    renderNormalizerUserTs,
    renderNormalizerInternalTs,
    renderNormalizerToolTs,
    renderNormalizerChildTs,
    renderPerceptionNonTrivial,
    renderLearningNonTrivial,
    renderPolicyNonTrivial,
    renderEffectLlmPlaceholderTs,
    renderEffectToolPlaceholderTs,
    renderPromptPlaceholderTs,
    renderContractLlmPlaceholderTs,
    renderContractToolPlaceholderTs,
    renderResumeTest,
    renderFailureTest,
    renderInvariantTest,
} from './renderNonTrivial.js';

async function pathExists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

async function isDirEmpty(dir: string): Promise<boolean> {
    const entries = await fs.readdir(dir);
    return entries.length === 0;
}

async function writeFileEnsured(root: string, rel: string, content: string, created: string[]): Promise<void> {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
    created.push(rel);
}

export async function scaffoldAgent(options: unknown): Promise<ScaffoldResult> {
    const parsed = ScaffoldOptionsSchema.safeParse(options);
    if (!parsed.success) {
        const err: ScaffoldFailure = { type: 'validation_failed', issues: parsed.error.issues };
        throw Object.assign(new Error('scaffoldAgent: invalid options'), { scaffold: err });
    }
    const opts = parsed.data as ScaffoldOptions;
    const outAbs = path.resolve(process.cwd(), opts.outputDir);
    const merged: ScaffoldOptions = {
        ...opts,
        monorepo: opts.monorepo ?? outAbs.includes(`apps${path.sep}examples`),
    };

    if (await pathExists(outAbs)) {
        if (!opts.force) {
            const empty = await isDirEmpty(outAbs);
            if (!empty) {
                const err: ScaffoldFailure = { type: 'output_exists', path: outAbs };
                throw Object.assign(new Error(`scaffoldAgent: output directory exists and is not empty: ${outAbs}`), {
                    scaffold: err,
                });
            }
        }
    } else {
        await fs.mkdir(outAbs, { recursive: true });
    }

    const ctx = buildMinimalContext(merged);
    const created: string[] = [];

    const card = defaultAgentCard(toCardName(ctx.name), ctx.description);
    const runtime = defaultRuntimeManifest(toCardName(ctx.name));
    AgentCardSchema.parse(card);
    AgentRuntimeManifestSchema.parse(runtime);

    await writeFileEnsured(outAbs, 'agent-card.json', `${JSON.stringify(card, null, 2)}\n`, created);
    await writeFileEnsured(outAbs, 'agent-runtime.json', `${JSON.stringify(runtime, null, 2)}\n`, created);

    await writeFileEnsured(outAbs, 'package.json', renderPackageJson(ctx), created);
    await writeFileEnsured(outAbs, 'tsconfig.json', renderTsconfig(ctx), created);
    await writeFileEnsured(outAbs, 'types.ts', renderTypesTs(), created);
    await writeFileEnsured(outAbs, 'attention.ts', renderAttentionTs(), created);

    if (opts.preset === 'non-trivial') {
        await writeFileEnsured(outAbs, 'flow.md', renderFlowMd(ctx), created);
        await writeFileEnsured(outAbs, 'selectors.ts', renderSelectorsTs(), created);
        await writeFileEnsured(outAbs, 'reducers.ts', renderReducersTs(), created);
        await writeFileEnsured(outAbs, 'normalizers/user.ts', renderNormalizerUserTs(), created);
        await writeFileEnsured(outAbs, 'normalizers/internal.ts', renderNormalizerInternalTs(), created);
        if (opts.usesTools) {
            await writeFileEnsured(outAbs, 'normalizers/tool.ts', renderNormalizerToolTs(), created);
        }
        if (opts.usesChildren) {
            await writeFileEnsured(outAbs, 'normalizers/child.ts', renderNormalizerChildTs(), created);
        }
        await writeFileEnsured(
            outAbs,
            'perception.ts',
            renderPerceptionNonTrivial({ usesTools: opts.usesTools, usesChildren: opts.usesChildren }),
            created
        );
        await writeFileEnsured(outAbs, 'learning.ts', renderLearningNonTrivial(), created);
        await writeFileEnsured(outAbs, 'policy.ts', renderPolicyNonTrivial(), created);
        if (opts.usesLlm) {
            await writeFileEnsured(outAbs, 'effects/llm/placeholder.ts', renderEffectLlmPlaceholderTs(), created);
            await writeFileEnsured(outAbs, 'prompts/placeholder.ts', renderPromptPlaceholderTs(), created);
            await writeFileEnsured(outAbs, 'contracts/llm/placeholder.schema.ts', renderContractLlmPlaceholderTs(), created);
        }
        if (opts.usesTools) {
            await writeFileEnsured(outAbs, 'effects/tools/placeholder.ts', renderEffectToolPlaceholderTs(), created);
            await writeFileEnsured(outAbs, 'contracts/tools/placeholder.schema.ts', renderContractToolPlaceholderTs(), created);
        }
    } else {
        await writeFileEnsured(outAbs, 'perception.ts', renderPerceptionTs(), created);
        await writeFileEnsured(outAbs, 'learning.ts', renderLearningTs(), created);
        await writeFileEnsured(outAbs, 'policy.ts', renderPolicyTs(), created);
    }

    await writeFileEnsured(outAbs, 'shield.ts', renderShieldTs(), created);
    await writeFileEnsured(outAbs, 'execution.ts', renderExecutionTs(), created);
    await writeFileEnsured(outAbs, 'transition.ts', renderTransitionTs(), created);
    await writeFileEnsured(outAbs, 'agent.ts', renderAgentTs(ctx), created);

    await writeFileEnsured(outAbs, 'tests/golden.test.ts', renderGoldenTest(ctx), created);

    if (opts.preset === 'non-trivial') {
        await writeFileEnsured(outAbs, 'tests/resume.test.ts', renderResumeTest(ctx), created);
        await writeFileEnsured(outAbs, 'tests/failure.test.ts', renderFailureTest(ctx), created);
        await writeFileEnsured(outAbs, 'tests/invariant.test.ts', renderInvariantTest(ctx), created);
    }

    return {
        outputDir: outAbs,
        preset: opts.preset,
        filesCreated: created.sort(),
    };
}

function toCardName(name: string): string {
    return name.replace(/_/g, '-');
}

export function formatScaffoldError(err: unknown): string {
    if (err instanceof ZodError) {
        return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    }
    if (err && typeof err === 'object' && 'scaffold' in err) {
        const s = (err as { scaffold: ScaffoldFailure }).scaffold;
        if (s.type === 'validation_failed') {
            return s.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        }
        if (s.type === 'output_exists') {
            return `output exists: ${s.path}`;
        }
        if (s.type === 'write_failed') {
            return `write failed: ${s.path}: ${s.cause}`;
        }
    }
    return err instanceof Error ? err.message : String(err);
}
