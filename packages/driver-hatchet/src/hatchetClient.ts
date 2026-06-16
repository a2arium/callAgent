import { Hatchet } from '@hatchet-dev/typescript-sdk';

export type HatchetClient = ReturnType<typeof Hatchet.init>;

export function createHatchetClient(): HatchetClient {
    return Hatchet.init();
}
