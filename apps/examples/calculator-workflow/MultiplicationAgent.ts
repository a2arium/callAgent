import { createAgent } from '@a2arium/callagent-core';

type MultiplicationTask = {
    operation: string;
    left: number;
    right: number;
    expression: string;
};

type MultiplicationResult = {
    result: number;
    operation: string;
    expression: string;
};

export default createAgent({
    manifest: {
        name: 'multiplication-agent',
        version: '1.0.0',
        description: 'Handles multiplication and division operations'
    },
    async handleTask(ctx) {
        const { operation, left, right, expression } = ctx.task.input as MultiplicationTask;

        await ctx.reply(`✖️ Multiplication: Processing "${expression}"`);

        try {
            let result: number;

            if (operation === '*') {
                result = left * right;
                await ctx.reply(`✖️ Multiplication: ${left} × ${right} = ${result}`);
            } else if (operation === '/') {
                if (right === 0) {
                    throw new Error('Division by zero');
                }
                result = left / right;
                await ctx.reply(`➗ Multiplication: ${left} ÷ ${right} = ${result}`);
            } else {
                throw new Error(`Unsupported operation: ${operation}`);
            }

            return {
                result,
                operation,
                expression
            } as MultiplicationResult;

        } catch (error) {
            const errorMsg = `❌ Multiplication: Error processing "${expression}": ${error instanceof Error ? error.message : String(error)}`;
            await ctx.reply(errorMsg);
            throw new Error(errorMsg);
        }
    }
}, import.meta.url); 