#!/usr/bin/env node
import { scaffoldAgent, formatScaffoldError } from './scaffoldAgent.js';
import { parseScaffoldCliArgs, printScaffoldCliHelp } from './scaffoldCliArgs.js';

async function main(): Promise<void> {
    const parsed = parseScaffoldCliArgs(process.argv.slice(2));
    if (parsed.help) {
        printScaffoldCliHelp();
        process.exit(0);
    }
    if (!parsed.name || !parsed.preset || !parsed.outputDir) {
        printScaffoldCliHelp();
        process.exit(1);
    }
    try {
        const result = await scaffoldAgent({
            name: parsed.name,
            preset: parsed.preset,
            outputDir: parsed.outputDir,
            description: parsed.description,
            usesLlm: parsed.usesLlm,
            usesTools: parsed.usesTools,
            usesChildren: parsed.usesChildren,
            usesPlans: parsed.usesPlans,
            force: parsed.force,
            monorepo: parsed.monorepo,
        });
        console.log(`Scaffolded ${result.preset} agent → ${result.outputDir}`);
        console.log(`Files: ${result.filesCreated.length}`);
    } catch (e) {
        console.error(formatScaffoldError(e));
        process.exit(1);
    }
}

main();
