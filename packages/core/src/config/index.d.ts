export type MemoryBackendConfig = {
    default: string;
    backends: string[];
};
export type MinimalConfig = {
    pluginDir: string;
    memory: {
        semantic: MemoryBackendConfig;
        episodic: MemoryBackendConfig;
        embed: MemoryBackendConfig;
    };
};
export declare function loadConfig(): MinimalConfig;
