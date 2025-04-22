// src/config/index.ts
export type MinimalConfig = {
    pluginDir: string; // Directory to scan for plugins (future)
    // Add other minimal settings needed for runner
}

export function loadConfig(): MinimalConfig {
    // Load from environment variables or use defaults
    return {
        // Placeholder: In minimal, runner specifies agent file directly
        pluginDir: process.env.PLUGIN_DIR || './examples',
        // ... add other minimal settings here
    };
} 