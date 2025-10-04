export declare function createTraceparent(): string;
export declare function childTraceparent(parent: string | undefined): string;
export declare function parseTraceparent(tp: string | undefined): {
    traceId?: string;
    spanId?: string;
    flags?: string;
};
