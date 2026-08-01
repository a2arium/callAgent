import type { Request } from 'express';

const LOCAL_DASHBOARD_PORT = '8791';

export class OriginPolicyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function trustedOriginsFor(baseURL: string, production: boolean): string[] {
  const url = new URL(baseURL);
  const origins = new Set([url.origin]);
  if (!production && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
    const runtimePort = url.port ? `:${url.port}` : '';
    for (const hostname of ['127.0.0.1', 'localhost']) {
      origins.add(`${url.protocol}//${hostname}${runtimePort}`);
      origins.add(`${url.protocol}//${hostname}:${LOCAL_DASHBOARD_PORT}`);
    }
  }
  return [...origins];
}

export function assertTrustedOriginMutation(req: Request, trustedOrigins: readonly string[]): void {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return;
  const requestOrigin = req.header('origin');
  const fetchSite = req.header('sec-fetch-site');
  if (!requestOrigin || !trustedOrigins.includes(requestOrigin)) {
    throw new OriginPolicyError(403, 'ORIGIN_REJECTED', 'Request origin is not trusted');
  }
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    throw new OriginPolicyError(403, 'ORIGIN_REJECTED', 'Cross-site request rejected');
  }
  if (!req.is('application/json')) {
    throw new OriginPolicyError(415, 'JSON_REQUIRED', 'Use application/json');
  }
}
