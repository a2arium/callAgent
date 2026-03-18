export * from './UnifiedMemoryService.js';
export * from './MLOBackends.js';
export * from './createMemoryRegistry.js';
export * from './errors.js';
export * from './prismaSingleton.js';
export * from './types/index.js'; // Assuming types/index.ts exists and exports essential types
export * from './lifecycle/config/index.js';
export * from './lifecycle/interfaces/index.js';
export * from './lifecycle/orchestrator/MemoryLifecycleOrchestrator.js';

// Additional exports needed by core
export * from './types/working/context/workingMemoryContext.js';
export * from './utils/hydrateArtifacts.js';
export * from './utils/offloadArtifacts.js';
export * from './stores/SessionStore.js';
export * from './cache/AgentResultCache.js';
export * from './cache/CacheCleanupService.js';
export * from './artifacts/ArtifactImpl.js';
export * from './shared/types/index.js'; // Ensure shared types are exported

export * from './lifecycle/ProcessorFactory.js';
export * from './lifecycle/2-encoding/implementations/fusion/ModalityFusion.js';
