import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeWorkspaceDescriptor } from '@a2arium/callagent-core';

export type WrittenRuntimeDescriptor = {
    directory: string;
    path: string;
    cleanup: () => Promise<void>;
};

/** Writes a descriptor without values or credentials to a user-private, run-scoped directory. */
export async function writeRuntimeDescriptor(descriptor: RuntimeWorkspaceDescriptor): Promise<WrittenRuntimeDescriptor> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'callagent-runtime-'));
    await fs.chmod(directory, 0o700);
    const descriptorPath = path.join(directory, 'workspace-descriptor.json');
    await fs.writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
    return {
        directory,
        path: descriptorPath,
        cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    };
}
