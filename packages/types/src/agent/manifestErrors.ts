import { ZodError } from 'zod';

/**
 * Typed manifest error details for Rule 11 compliance.
 */
export type ManifestErrorDetail =
  | { type: 'identity_mismatch'; agentCardName: string; agentCardVersion: string; runtimeName: string; runtimeVersion: string }
  | { type: 'schema_validation'; manifest: 'agentCard' | 'runtimeManifest'; zodError: ZodError }
  | { type: 'file_not_found'; path: string; manifest: 'agentCard' | 'runtimeManifest' }
  | { type: 'parse_error'; path: string; manifest: 'agentCard' | 'runtimeManifest'; message: string };
