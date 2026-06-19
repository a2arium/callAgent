import { HatchetClient as HatchetV1 } from '@hatchet-dev/typescript-sdk/v1/client/client.js';

export type HatchetClient = ReturnType<typeof HatchetV1.init>;

export function createHatchetClient(): HatchetClient {
    return HatchetV1.init();
}
