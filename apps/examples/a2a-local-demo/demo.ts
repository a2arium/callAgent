import 'dotenv/config';
import { runAgentWithStreaming } from '@callagent/core/dist/runner/streamingRunner.js';
import { PluginManager } from '@callagent/core';
import CoordinatorAgent from './CoordinatorAgent.js';
import DataAnalysisAgent from './DataAnalysisAgent.js';
import ReportingAgent from './ReportingAgent.js';

console.log('🚀 A2A Local Demo - Multi-Agent Workflow\n');

// Register all agents
console.log('📝 Registering agents...');
PluginManager.registerAgent(CoordinatorAgent);
PluginManager.registerAgent(DataAnalysisAgent);
PluginManager.registerAgent(ReportingAgent);

console.log('✅ Agents registered:');
const agents = PluginManager.listAgents();
agents.forEach(agent => {
    console.log(`  - ${agent.name} v${agent.version}`);
});

console.log('\n🎯 Starting coordinator agent workflow...\n');

// Run the coordinator agent which will orchestrate the full workflow
const demoInput = {
    requestedBy: 'demo-user',
    workflow: 'quarterly-analysis',
    priority: 'high'
};

try {
    await runAgentWithStreaming('./dist/apps/examples/a2a-local-demo/CoordinatorAgent.js', demoInput, {
        isStreaming: false,
        outputType: 'console'
    });
    console.log('\n✅ Demo completed successfully!');
} catch (error) {
    console.error('\n❌ Demo failed:', error);
    process.exit(1);
} 