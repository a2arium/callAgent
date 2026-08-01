import type { Request } from 'express';
import {
  assertTrustedOriginMutation,
  OriginPolicyError,
  trustedOriginsFor,
} from '../src/originPolicy.js';

function request(options: {
  method?: string;
  origin?: string;
  fetchSite?: string;
  json?: boolean;
}): Request {
  const headers = new Map<string, string>();
  if (options.origin) headers.set('origin', options.origin);
  if (options.fetchSite) headers.set('sec-fetch-site', options.fetchSite);
  return {
    method: options.method ?? 'POST',
    header: (name: string) => headers.get(name.toLowerCase()),
    is: (type: string) => type === 'application/json' && options.json !== false ? type : false,
  } as Request;
}

describe('operator auth origin policy', () => {
  const trustedOrigins = trustedOriginsFor('http://127.0.0.1:8790', false);

  it.each([
    'http://127.0.0.1:8790',
    'http://localhost:8790',
    'http://127.0.0.1:8791',
    'http://localhost:8791',
  ])('accepts local mutation origin %s', (origin) => {
    expect(() => assertTrustedOriginMutation(request({ origin }), trustedOrigins)).not.toThrow();
  });

  it.each([
    undefined,
    'http://127.0.0.1:8792',
    'https://observer.example.test',
  ])('rejects untrusted mutation origin %s', (origin) => {
    expect(() => assertTrustedOriginMutation(request({ origin }), trustedOrigins)).toThrow(
      expect.objectContaining({ status: 403, code: 'ORIGIN_REJECTED' }),
    );
  });

  it('rejects cross-site fetch metadata even for an allowed origin', () => {
    expect(() => assertTrustedOriginMutation(
      request({ origin: 'http://127.0.0.1:8791', fetchSite: 'cross-site' }),
      trustedOrigins,
    )).toThrow(expect.objectContaining({ status: 403, code: 'ORIGIN_REJECTED' }));
  });

  it('requires JSON for mutations', () => {
    expect(() => assertTrustedOriginMutation(
      request({ origin: 'http://127.0.0.1:8791', json: false }),
      trustedOrigins,
    )).toThrow(expect.objectContaining({ status: 415, code: 'JSON_REQUIRED' }));
  });

  it('does not apply mutation checks to reads', () => {
    expect(() => assertTrustedOriginMutation(
      request({ method: 'GET', origin: 'https://untrusted.example.test', json: false }),
      trustedOrigins,
    )).not.toThrow();
  });

  it('exposes policy failures as typed HTTP errors', () => {
    expect(() => assertTrustedOriginMutation(request({}), trustedOrigins)).toThrow(OriginPolicyError);
  });
});
