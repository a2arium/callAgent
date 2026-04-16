import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@a2arium/callagent-utils';
import type { TaskStatus, Artifact as StreamArtifact } from '../shared/types/StreamingEvents.js';

const transportLogger = logger.createLogger({ prefix: 'StreamTransport' });

export type TransportType = 'json' | 'sse' | 'console';

export interface StreamTransportOptions {
    outputType: TransportType;
    outputFile?: string;
}

export class StreamTransport {
    constructor(private options: StreamTransportOptions) { }

    handleStatus(status: TaskStatus, isFinal: boolean): void {
        const output = {
            type: 'status',
            status: status.state,
            timestamp: status.timestamp || new Date().toISOString(),
            final: isFinal,
            metadata: status.metadata ?? undefined
        };

        if (this.options.outputType === 'json') {
            this.writeJson(output);
        } else if (this.options.outputType === 'sse') {
            this.writeSse(output);
        } else {
            this.writeConsoleStatus(status, isFinal);
        }
    }

    handleArtifact(artifact: StreamArtifact): void {
        const output = {
            type: 'artifact',
            name: artifact.name || 'unnamed',
            index: artifact.index || 0,
            append: !!artifact.append,
            lastChunk: !!artifact.lastChunk
        };

        const textContent = this.extractTextContent(artifact);

        if (this.options.outputType === 'json') {
            this.writeJson({ ...output, content: textContent });
        } else if (this.options.outputType === 'sse') {
            this.writeSse({ ...output, content: textContent });
        } else {
            this.writeConsoleArtifact(textContent, artifact.name);
        }
    }

    private extractTextContent(artifact: StreamArtifact): string {
        return artifact.parts && artifact.parts.length > 0
            ? artifact.parts
                .filter(part => part.type === 'text')
                .map(part => (part as { text?: string }).text)
                .filter(Boolean)
                .join('')
            : '';
    }

    private writeJson(data: unknown): void {
        const jsonOutput = JSON.stringify(data, null, 2);
        console.log(jsonOutput);
        this.appendToFile(jsonOutput + '\n');
    }

    private writeSse(data: unknown): void {
        const sseOutput = `data: ${JSON.stringify(data)}\n\n`;
        console.log(sseOutput);
        this.appendToFile(sseOutput);
    }

    private writeConsoleStatus(status: TaskStatus, isFinal: boolean): void {
        if (status.state === 'input-required' || (status.state as any) === 'waiting_input') {
            console.log(`Status: waiting_input`);
            const promptText = this.extractPromptText(status);
            if (promptText) console.log(`Prompt: ${promptText}`);
            const token = (status as any).metadata?.token;
            if (token) console.log(`Token: ${token}`);
            console.log(`Session: (see earlier log: Starting TaskEngine.startTask { taskId: ... })`);
        } else if (isFinal) {
            const reason = (status as any)?.metadata?.reason;
            if (status.state === 'failed' && reason === 'budget_turns_exceeded') {
                return;
            }
            console.log(`Status: ${status.state} (FINAL)`);
            if (status.state === 'completed') {
                console.log('Loop outcome: kind: complete');
            } else if (status.state === 'failed') {
                console.log('Loop outcome: kind: fail');
            } else if (status.state === 'canceled') {
                console.log('Loop outcome: kind: canceled');
            }
            const md = status.metadata as { result?: unknown } | undefined;
            if (status.state === 'completed' && md && 'result' in md && md.result !== undefined) {
                try {
                    console.log(`Complete result: ${JSON.stringify(md.result, null, 2)}`);
                } catch {
                    console.log(`Complete result: ${String(md.result)}`);
                }
            }
            this.logAggregates(status);
        } else if (status.state === 'working') {
            this.logWorkingProgress(status);
        } else {
            console.log(`Status: ${status.state}`);
        }

        if (this.options.outputFile) {
            const statusText = isFinal ? `Status: ${status.state} (FINAL)` : `Status: ${status.state}`;
            this.appendToFile(statusText + '\n');
        }

        this.logMessage(status);
    }

    private writeConsoleArtifact(textContent: string, name?: string): void {
        if (textContent) {
            const header = `\n--- ${name || 'Artifact'} ---`;
            console.log(header);
            console.log(textContent);
            this.appendToFile(header + '\n' + textContent + '\n');
        }
    }

    private extractPromptText(status: TaskStatus): string {
        return status.message?.parts
            ?.filter(part => part.type === 'text')
            .map(part => (part as { text?: string }).text)
            .filter(Boolean)
            .join(' ') || '';
    }

    private logAggregates(status: TaskStatus): void {
        const md: any = status.metadata || {};
        const agg: any = md.timingsAgg || {};
        const rewAgg: any = md.rewardsAgg || {};
        const hasAgg = Object.keys(agg || {}).length > 0 || (rewAgg && (typeof rewAgg.sum === 'number'));

        if (hasAgg) {
            console.log('Aggregates:');
            if (agg && Object.keys(agg).length > 0) {
                console.log('  Timings:');
                for (const [k, v] of Object.entries(agg)) {
                    const vv: any = v;
                    console.log(`    ${k}: sum=${vv.sum}ms avg=${vv.avg.toFixed(2)}ms`);
                }
            }
            if (rewAgg && typeof rewAgg.sum === 'number') {
                console.log(`  Rewards: sum=${rewAgg.sum.toFixed(3)} avg=${rewAgg.avg.toFixed(3)}`);
            }
        }
    }

    private logWorkingProgress(status: TaskStatus): void {
        const textParts = this.extractTextParts(status);
        const progressPercentage = status.metadata?.progress;

        if (textParts.length > 0) {
            if (typeof progressPercentage === 'number') {
                console.log(`Progress: ${progressPercentage}% - ${textParts.join(' ')}`);
            } else {
                console.log(`Progress: ${textParts.join(' ')}`);
            }
        } else {
            if (typeof progressPercentage === 'number') {
                console.log(`Progress: ${progressPercentage}%`);
            } else {
                console.log(`Status: ${status.state}`);
            }
        }
    }

    private logMessage(status: TaskStatus): void {
        if (!status.message?.parts?.length) return;

        const reason = (status as any)?.metadata?.reason;
        if (status.state === 'failed' && reason === 'budget_turns_exceeded') return;

        const textParts = this.extractTextParts(status);
        if (textParts.length > 0) {
            console.log(`Message: ${textParts.join('\n')}`);
            this.appendToFile(`Message: ${textParts.join('\n')}\n`);
        }
    }

    private extractTextParts(status: TaskStatus): string[] {
        if (!status.message?.parts) return [];
        return status.message.parts
            .filter(part => part.type === 'text')
            .map(part => (part as { text?: string }).text)
            .filter(Boolean) as string[];
    }

    private appendToFile(content: string): void {
        if (!this.options.outputFile) return;
        try {
            const dir = path.dirname(this.options.outputFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.appendFileSync(this.options.outputFile, content, 'utf8');
        } catch (error) {
            transportLogger.error(`Failed to write to output file`, error, { path: this.options.outputFile });
        }
    }
}
