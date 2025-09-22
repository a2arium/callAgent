import { createAgent } from '@a2arium/core';

export default createAgent({
    manifest: { name: 'loop-agent-mini', version: '0.1.0' },
    async handleTask(ctx) {
        // Demonstrate goals and vars backed by MentalState
        const goalId = await (ctx as any).addGoal({ title: 'Greet user', type: 'short', priority: 1 });
        (ctx as any).vars.username = (ctx.task.input as any)?.name || undefined;

        if (!(ctx as any).vars.username) {
            await (ctx as any).requestInput('What is your name?', { onProvided: 'onNameProvided' });
            return; // await_input; engine persists M
        }

        await ctx.reply(`Hello, ${(ctx as any).vars.username}!`);
        await (ctx as any).completeGoal(goalId, { requireNoActiveChildren: false });
    }
}, import.meta.url);

export async function onNameProvided(ctx: any, ev: { token: string; input: string }) {
    (ctx as any).vars.username = ev.input;
    await ctx.reply(`Nice to meet you, ${ev.input}.`);
}


