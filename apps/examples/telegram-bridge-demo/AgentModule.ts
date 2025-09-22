import { createAgent } from '@a2arium/callagent-core';
import type { AgentTaskContext } from '@a2arium/callagent-core';

const llmConfig = {
    provider: 'openai',
    modelAliasOrName: 'fast',
    systemPrompt: 'You are a helpful AI assistant.'
};

// Interactive demo agent: asks a question, waits for input, then responds.
export async function handleTask(ctx: AgentTaskContext): Promise<void> {
    const inputText = ((ctx as any)?.task?.input as any)?.text || '';
    if (inputText) {
        await ctx.reply(`You said: ${inputText}`);
    }
    ctx.reply('What would you like me to remember?');
    await ctx.requestInput('Please type your message', { onProvided: 'onUserAnswer' });
}

export async function onUserAnswer(ctx: AgentTaskContext, ev: { input: unknown }): Promise<{ ok: true }> {
    const answer = (ev?.input as any)?.text || '';
    const res = await ctx.llm.call(answer);
    await ctx.reply(`${res[0].content}`);
    ctx.complete();
    return { ok: true };
}

createAgent({
    manifest: 'agent.json',
    llmConfig,
    handleTask
}, import.meta.url);
