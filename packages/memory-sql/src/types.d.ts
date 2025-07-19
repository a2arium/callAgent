export type EntityType = string;
export type EntityMatch = {
    entityId: string;
    canonicalName: string;
    similarity: number;
    confidence: 'high' | 'medium' | 'low';
};
export type EntityAlignment = {
    entityId: string;
    canonicalName: string;
    originalValue: string;
    confidence: 'high' | 'medium' | 'low';
    alignedAt: Date;
};
export type AlignedValue = {
    toString(): string;
    valueOf(): string;
    _entity: EntityAlignment;
    _wasAligned: boolean;
    _original: string;
    _canonical: string;
};
export type EntityFieldSpec = {
    [fieldName: string]: EntityType;
};
export type MemorySetOptions = {
    tags?: string[];
    entities?: EntityFieldSpec;
    alignmentThreshold?: number;
    autoCreateEntities?: boolean;
    backend?: string;
    tenantId?: string;
};
export type ParsedEntityField = {
    fieldName: string;
    entityType: string;
    value: string;
    threshold?: number;
};
export type EmbeddingConfig = {
    provider: string;
    model: string;
    apiKey?: string;
    dimensions?: number;
    encodingFormat?: 'float' | 'base64';
};
export type EntityAlignmentOptions = {
    defaultThreshold: number;
};
export type VectorEmbedding = number[] | null;
export type GetManyOptions = {
    limit?: number;
    orderBy?: {
        path: string;
        direction: 'asc' | 'desc';
    };
    backend?: string;
    tenantId?: string;
};
export type GetManyQuery = {
    tag?: string;
    filters?: import('@callagent/types').MemoryFilter[];
    limit?: number;
    orderBy?: {
        path: string;
        direction: 'asc' | 'desc';
    };
    backend?: string;
    tenantId?: string;
};
export type GetManyInput = string | GetManyQuery;
