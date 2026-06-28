import { describe, expect, it } from '@jest/globals';
import { makeSafeEventPreview } from '../src/orchestration/safeEventPreview.js';

describe('makeSafeEventPreview', () => {
    it('redacts env var containers while preserving env key names', () => {
        const preview = makeSafeEventPreview({
            url: 'https://example.test',
            env_vars: {
                OPENAI_API_KEY: 'sk-secret-value-that-should-not-persist',
                BROWSER_USE_API_KEY: 'bu_secret-value-that-should-not-persist',
            },
        });

        expect(preview).toEqual({
            url: 'https://example.test',
            env_vars: {
                OPENAI_API_KEY: '[redacted]',
                BROWSER_USE_API_KEY: '[redacted]',
            },
        });
    });

    it('redacts sensitive keys and secret-shaped strings recursively', () => {
        const preview = makeSafeEventPreview({
            headers: {
                authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
                trace: 'safe-trace',
            },
            prompt: 'call sk-1234567890abcdefghijklmnop then continue',
        });

        expect(preview).toEqual({
            headers: {
                authorization: '[redacted]',
                trace: 'safe-trace',
            },
            prompt: 'call [redacted] then continue',
        });
    });

    it('summarizes very large text values', () => {
        const html = `<html>${'x'.repeat(5000)}</html>`;
        const preview = makeSafeEventPreview({ html });

        expect(preview).toEqual({
            html: `[html/text truncated, ${html.length} chars]`,
        });
    });

    it('summarizes artifact markers without loading or expanding content', () => {
        const preview = makeSafeEventPreview({
            ok: true,
            data: {
                html: {
                    kind: 'artifact',
                    id: 'artifact-1',
                    mimeType: 'text/html',
                    estimatedSize: 524288,
                },
            },
        });

        expect(preview).toEqual({
            ok: true,
            data: {
                html: {
                    state: 'artifact_only',
                    artifactId: 'artifact-1',
                    summary: 'Artifact artifact-1',
                    mimeType: 'text/html',
                    estimatedSize: 524288,
                },
            },
        });
    });

    it('summarizes local artifacts without exposing local value', () => {
        const html = `<html>${'x'.repeat(5000)}</html>`;
        const preview = makeSafeEventPreview({
            result: {
                ok: true,
                data: {
                    html: {
                        kind: 'artifact_local',
                        value: html,
                        mimeType: 'text/html',
                    },
                    content: html,
                    statusCode: 200,
                },
            },
        }) as any;

        expect(preview.result.data.html).toEqual({
            state: 'artifact_only',
            artifactId: 'local',
            summary: `Local artifact, ${html.length} chars`,
            mimeType: 'text/html',
            estimatedSize: html.length,
        });
        expect(JSON.stringify(preview)).not.toContain(html);
        expect(preview.result.data.content).toBe(`[html/text truncated, ${html.length} chars]`);
    });
});
