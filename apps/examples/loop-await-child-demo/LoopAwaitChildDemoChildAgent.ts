import { createAgent } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';

const HTML_SIZE = 520_000;
const HTML_PREFIX = '<html><body><h1 data-source="loop-await-child-demo">Child Result</h1><p url="';
const HTML_SUFFIX = '</p><section id="content">';
const HTML_FOOTER = '</section></body></html>';

const buildHtml = (url: string): string => {
    const repeated = 'X'.repeat(Math.max(0, HTML_SIZE - HTML_PREFIX.length - HTML_SUFFIX.length - HTML_FOOTER.length));
    return `${HTML_PREFIX}${url}${HTML_SUFFIX}${repeated}${HTML_FOOTER}`;
};

const childLog = logger.createLogger({ prefix: 'ChildAgent' });

export default createAgent({
    manifest: {
        name: 'loop-await-child-demo-child',
        version: '0.1.0',
        cache: {
            enabled: true,
            ttlSeconds: 3600
        }
    },

    async handleTask(ctx) {
        const input = (ctx.task.input ?? {}) as { url?: string };
        const url = typeof input.url === 'string' && input.url.trim().length > 0 ? input.url.trim() : 'https://example.com/demo';

        const html = buildHtml(url);

        childLog.info('[ChildAgent] Returning synthetic HTML payload', {
            url,
            htmlLength: html.length
        });

        await ctx.reply([
            {
                type: 'text',
                text: `Generated HTML for ${url} (length=${html.length.toLocaleString()})`
            }
        ]);

        ctx.complete();

        return {
            ok: true as const,
            data: {
                url,
                status: 'ok',
                html
            }
        };
    }
}, import.meta.url);

