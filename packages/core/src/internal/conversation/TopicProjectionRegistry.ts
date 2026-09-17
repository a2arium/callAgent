import type { TopicProjectionDefinition } from '../../public-types/conversation/topicProjection.js';

export class TopicProjectionRegistry {
    private readonly defs = new Map<string, TopicProjectionDefinition<unknown>>();

    register<T>(def: TopicProjectionDefinition<T>): void {
        this.defs.set(def.name, def as TopicProjectionDefinition<unknown>);
    }

    get(name: string): TopicProjectionDefinition<unknown> | undefined {
        return this.defs.get(name);
    }

    all(): TopicProjectionDefinition<unknown>[] {
        return [...this.defs.values()];
    }
}

let singleton: TopicProjectionRegistry | undefined;

export function getTopicProjectionRegistry(): TopicProjectionRegistry {
    if (!singleton) {
        singleton = new TopicProjectionRegistry();
    }
    return singleton;
}

/** Test hook: clears all non-builtin registrations; call `ensureBuiltinTopicProjectionsRegistered()` after if needed. */
export function resetTopicProjectionRegistryForTests(): void {
    singleton = new TopicProjectionRegistry();
}
