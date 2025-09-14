import Orchestrator from './OrchestratorAgent.js';
import Extractor from './ExtractorAgent.js';
import Analyzer from './AnalyzerAgent.js';
import { PluginManager } from '@a2arium/callagent-core';

// Register agents
PluginManager.registerAgent(Orchestrator);
PluginManager.registerAgent(Extractor);
PluginManager.registerAgent(Analyzer);

async function main() {
    const input = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'please run' }] }] };
    // In a real runtime, this would go through the API; here we call runner/engine indirectly
    console.log('Interactive A2A demo is ready. Use the API to start orchestrator.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});


