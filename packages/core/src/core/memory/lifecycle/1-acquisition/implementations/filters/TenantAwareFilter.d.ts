import { IAcquisitionFilter } from '../../interfaces/IAcquisitionFilter.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class TenantAwareFilter implements IAcquisitionFilter {
    readonly stageName: "acquisition";
    readonly componentName: "filter";
    readonly stageNumber = 1;
    private logger;
    private metrics;
    private filterStats;
    private allowedTenants;
    private maxInputSize;
    private relevanceThreshold;
    private conversationAware;
    private researchMode;
    private complexityAware;
    constructor(config?: {
        allowedTenants?: string[];
        maxInputSize?: number;
        relevanceThreshold?: number;
        conversationAware?: boolean;
        researchMode?: boolean;
        complexityAware?: boolean;
    });
    /**
     * PHASE 1: Basic tenant isolation
     * FUTURE: Could add more sophisticated tenant permissions, cross-tenant sharing rules
     *
     * @see https://www.osohq.com/ - Oso RBAC for advanced permissions
     * @see https://github.com/casbin/casbin - Authorization library
     *
     * ENHANCEMENT: Foreign Key / Namespace Isolation
     * While TenantAwareFilter enforces tenant isolation in Acquisition, consider adding
     * namespace or key-prefixing strategies for indexing, especially in vector databases
     * like Pinecone or Weaviate. Many hosted vector DBs support namespace segregation
     * at the API level, which can complement or replace manual filtering for larger deployments.
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown> | null>;
    shouldProcess(item: MemoryItem<unknown>): Promise<boolean>;
    private calculateRelevanceScore;
    configure(config: {
        maxInputSize?: number;
        tenantIsolation?: boolean;
        relevanceThreshold?: number;
        conversationAware?: boolean;
        researchMode?: boolean;
        complexityAware?: boolean;
        [key: string]: unknown;
    }): void;
    getMetrics(): ProcessorMetrics;
    getFilterStats(): {
        totalItemsEvaluated: number;
        itemsAccepted: number;
        itemsRejected: number;
        averageRelevanceScore: number;
    };
}
