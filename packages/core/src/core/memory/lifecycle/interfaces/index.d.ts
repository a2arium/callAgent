/**
 * Memory Lifecycle Orchestrator (MLO) Interfaces
 *
 * This module provides comprehensive interface definitions for the MLO pipeline,
 * including all stage processors and the main orchestrator interface.
 */
export * from './IStageProcessor.js';
export * from './IAcquisitionStage.js';
export * from './IEncodingStage.js';
export * from './IDerivationStage.js';
export * from './IRetrievalStage.js';
export * from './INeuralMemoryStage.js';
export * from './IUtilizationStage.js';
export type { IAcquisitionFilter, IInformationCompressor, IExperienceConsolidator, } from '../1-acquisition/interfaces/index.js';
export type { ISelectiveAttention, IMultiModalFusion, } from '../2-encoding/interfaces/index.js';
export type { IReflectionEngine, ISummarizationEngine, IKnowledgeDistiller, ISelectiveForgetter, } from '../3-derivation/interfaces/index.js';
export type { IIndexingOrchestrator, IMatchingStrategy, } from '../4-retrieval/interfaces/index.js';
export type { IAssociativeMemory as IAssociativeMemoryComponent, IParameterIntegration as IParameterIntegrationComponent, } from '../5-neural-memory/interfaces/index.js';
export type { IRAGOrchestrator, ILongContextManager, IHallucinationMitigator, } from '../6-utilization/interfaces/index.js';
export * from './IMemoryLifecycleOrchestrator.js';
