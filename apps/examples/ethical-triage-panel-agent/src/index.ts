import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLocalTranscriptDemo } from './local-run.js';

export { runLocalTranscriptDemo } from './local-run.js';

const isMain =
    typeof process.argv[1] === 'string' &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
    runLocalTranscriptDemo(process.env.TRIAGE_TRANSCRIPT_PATH)
        .then((p) => {
            process.stdout.write(`Wrote transcript: ${p}\n`);
        })
        .catch((e) => {
            process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
            process.exit(1);
        });
}
