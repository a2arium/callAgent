import { createAgent } from '@callagent/core';

type SubtractionTask = {
    left: number;
    right: number;
    expression: string;
};

type SubtractionResult = {
    result: number;
    steps: string[];
    expression: string;
};

export default createAgent({
    manifest: {
        name: 'subtraction-agent',
        version: '1.0.0',
        description: 'Specializes in subtraction operations'
    },
    async handleTask(ctx) {
        const { left, right, expression } = ctx.task.input as SubtractionTask;

        await ctx.reply(`➖ Subtraction: Processing "${expression}"`);

        const steps: string[] = [];

        try {
            const result = left - right;
            steps.push(`Subtraction: ${left} - ${right} = ${result}`);
            await ctx.reply(`➖ Subtraction: ${left} - ${right} = ${result}`);
            await ctx.reply(`✅ Subtraction: Result = ${result}`);

            return {
                result,
                steps,
                expression
            } as SubtractionResult;

        } catch (error) {
            const errorMsg = `❌ Subtraction: Error processing "${expression}": ${error instanceof Error ? error.message : String(error)}`;
            await ctx.reply(errorMsg);
            throw new Error(errorMsg);
        }
    }
}, import.meta.url); 