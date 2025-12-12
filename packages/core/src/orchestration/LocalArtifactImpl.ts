import type { LocalArtifact } from '../shared/types/index.js';
import { LOCAL_ARTIFACT_KIND } from '../shared/types/index.js';

export class LocalArtifactImpl<T = unknown> implements LocalArtifact<T> {
    readonly kind = LOCAL_ARTIFACT_KIND;

    constructor(public value: T, public mimeType?: string) { }

    then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
    ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve(this.value).then(onfulfilled, onrejected);
    }
}

