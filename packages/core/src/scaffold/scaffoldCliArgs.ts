import type { AgentPreset, ScaffoldOptions } from './types.js';

/** Parse argv (without `node` / script path) into scaffold options. Exported for tests. */
export function parseScaffoldCliArgs(argv: string[]): Partial<ScaffoldOptions> & { help?: boolean } {
    const out: Partial<ScaffoldOptions> & { help?: boolean } = {};
    const rest = [...argv];
    while (rest.length) {
        const a = rest.shift();
        if (!a) break;
        if (a === '--help' || a === '-h') {
            out.help = true;
            continue;
        }
        if (a === '--name') {
            out.name = rest.shift();
            continue;
        }
        if (a === '--preset') {
            out.preset = rest.shift() as AgentPreset;
            continue;
        }
        if (a === '--output' || a === '-o') {
            out.outputDir = rest.shift();
            continue;
        }
        if (a === '--description') {
            out.description = rest.shift();
            continue;
        }
        if (a === '--uses-llm') {
            out.usesLlm = true;
            continue;
        }
        if (a === '--uses-tools') {
            out.usesTools = true;
            continue;
        }
        if (a === '--uses-children') {
            out.usesChildren = true;
            continue;
        }
        if (a === '--uses-plans') {
            out.usesPlans = true;
            continue;
        }
        if (a === '--force') {
            out.force = true;
            continue;
        }
        if (a === '--monorepo') {
            out.monorepo = true;
            continue;
        }
        if (a === '--no-monorepo') {
            out.monorepo = false;
            continue;
        }
        console.error(`Unknown argument: ${a}`);
        out.help = true;
    }
    return out;
}

export function printScaffoldCliHelp(): void {
    console.log(`callagent-scaffold — generate an APLRET agent directory

Usage:
  callagent-scaffold --name <kebab-or-snake> --preset <minimal|non-trivial> --output <dir> [options]

Options:
  --description <text>   Agent description (manifest)
  --uses-llm               Non-trivial: include LLM placeholders
  --uses-tools             Non-trivial: include tool normalizer
  --uses-children          Non-trivial: include child normalizer
  --uses-plans             Non-trivial: document plans in flow.md front matter
  --force                  Write into non-empty directory
  --monorepo / --no-monorepo  Override workspace:* vs semver deps (default: infer apps/examples)
  --help, -h
`);
}
