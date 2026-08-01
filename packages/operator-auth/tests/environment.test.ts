import { trustedOriginsFor, validateOperatorAuthEnvironment } from '../src/index.js';

describe('operator auth environment', () => {
  it('requires a durable secret in every environment', () => {
    expect(() => validateOperatorAuthEnvironment({}, false)).toThrow('BETTER_AUTH_SECRET');
  });

  it('requires the public URL in production', () => {
    expect(() => validateOperatorAuthEnvironment({ BETTER_AUTH_SECRET: 'x'.repeat(32) }, true)).toThrow('CALLAGENT_PUBLIC_URL');
  });

  it('rejects the removed shared bearer token in production', () => {
    expect(() => validateOperatorAuthEnvironment({
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      CALLAGENT_PUBLIC_URL: 'https://observer.example.test',
      CALLAGENT_OPERATOR_AUTH_TOKEN: 'obsolete',
    }, true)).toThrow('CALLAGENT_OPERATOR_AUTH_TOKEN was removed');
  });

  it('uses the local runtime URL only outside production', () => {
    expect(validateOperatorAuthEnvironment({ BETTER_AUTH_SECRET: 'x'.repeat(32) }, false)).toEqual({
      baseURL: 'http://127.0.0.1:8790',
      secret: 'x'.repeat(32),
    });
  });

  it('trusts both local loopback hostnames outside production', () => {
    expect(trustedOriginsFor('http://127.0.0.1:8790', false)).toEqual([
      'http://127.0.0.1:8790',
      'http://127.0.0.1:8791',
      'http://localhost:8790',
      'http://localhost:8791',
    ]);
    expect(trustedOriginsFor('http://localhost:8790', false)).toEqual([
      'http://localhost:8790',
      'http://127.0.0.1:8790',
      'http://127.0.0.1:8791',
      'http://localhost:8791',
    ]);
  });

  it('does not widen trusted origins in production', () => {
    expect(trustedOriginsFor('https://observer.example.test', true)).toEqual([
      'https://observer.example.test',
    ]);
  });
});
