// src/config/index.ts
export type MemoryBackendConfig = {
    default: string;
    backends: string[];
};

export type MinimalConfig = {
    pluginDir: string; // Directory to scan for plugins (future)
    memory: {
        semantic: MemoryBackendConfig;
        episodic: MemoryBackendConfig;
        embed: MemoryBackendConfig;
    };
    // Add other minimal settings needed for runner
}

export function loadConfig(): MinimalConfig {
    // Load from environment variables or use defaults
    return {
        // Placeholder: In minimal, runner specifies agent file directly
        pluginDir: process.env.PLUGIN_DIR || './examples',
        memory: {
            semantic: { default: 'sql', backends: ['sql'] },
            episodic: { default: 'sql', backends: ['sql'] },
            embed: { default: 'sql', backends: ['sql'] },
        },
        // ... add other minimal settings here
    };
} 