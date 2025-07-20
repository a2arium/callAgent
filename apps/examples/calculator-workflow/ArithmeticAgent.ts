import { createAgent } from '@a2arium/callagent-core';

type ArithmeticTask = {
    expression: string;
    tokens: (number | string)[];
};

type ArithmeticResult = {
    result: number;
    expression: string;
    steps: string[];
};

type SubtractionResult = {
    result: number;
    steps: string[];
    expression: string;
};

export default createAgent({
    manifest: {
        name: 'arithmetic-agent',
        version: '1.0.0',
        description: 'Handles addition and subtraction operations, delegates subtraction to specialist agent',
        dependencies: {
            agents: ['subtraction-agent']
        }
    },
    async handleTask(ctx) {
        const { expression, tokens } = ctx.task.input as ArithmeticTask;

        await ctx.reply(`➕ Arithmetic: Processing "${expression}"`);

        const steps: string[] = [];
        steps.push(`Arithmetic: Received expression "${expression}"`);

        try {
            // Process the tokens left to right, handling additions and delegating subtractions
            let result = tokens[0] as number;
            steps.push(`Arithmetic: Starting with ${result}`);

            for (let i = 1; i < tokens.length; i += 2) {
                const operator = tokens[i] as string;
                const operand = tokens[i + 1] as number;

                if (operator === '+') {
                    // Handle addition ourselves
                    const oldResult = result;
                    result = result + operand;
                    steps.push(`Arithmetic: ${oldResult} + ${operand} = ${result}`);
                    await ctx.reply(`➕ Arithmetic: ${oldResult} + ${operand} = ${result}`);

                } else if (operator === '-') {
                    // Delegate subtraction to subtraction agent
                    const subExpression = `${result} - ${operand}`;
                    steps.push(`Arithmetic: Delegating "${subExpression}" to subtraction-agent`);
                    await ctx.reply(`➖ Arithmetic: Delegating "${subExpression}" to subtraction-agent`);

                    const subResult = await ctx.sendTaskToAgent('subtraction-agent', {
                        left: result,
                        right: operand,
                        expression: subExpression
                    }) as SubtractionResult;

                    result = subResult.result;
                    steps.push(`Arithmetic: Received ${result} from subtraction-agent`);
                    await ctx.reply(`✅ Arithmetic: Received ${result} from subtraction-agent`);

                } else {
                    throw new Error(`Unsupported operator: ${operator}`);
                }
            }

            await ctx.reply(`✅ Arithmetic: Final result = ${result}`);

            return {
                result,
                expression,
                steps
            } as ArithmeticResult;

        } catch (error) {
            const errorMsg = `❌ Arithmetic: Error processing "${expression}": ${error instanceof Error ? error.message : String(error)}`;
            await ctx.reply(errorMsg);
            throw new Error(errorMsg);
        }
    }
}, import.meta.url); 