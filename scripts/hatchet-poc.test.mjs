import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  readHatchetPocTimeouts,
  runHatchetPoc,
} from './hatchet-poc.mjs';

const quietLogger = {
  info() {},
  error() {},
};

const success = { code: 0, signal: null, timedOut: false };
const timeout = { code: 1, signal: 'SIGKILL', timedOut: true };

describe('hatchet:poc lifecycle commands', () => {
  test('uses bounded graceful shutdown when Docker responds', async () => {
    const calls = [];
    const invoke = async (...args) => {
      calls.push(args);
      return success;
    };

    await runHatchetPoc('down', { invoke, logger: quietLogger, env: {} });

    assert.deepEqual(calls, [[
      ['down', '--timeout', '10', '--remove-orphans'],
      { timeoutMs: 30_000, label: 'graceful shutdown' },
    ]]);
  });

  test('falls back to SIGKILL and zero-grace cleanup after a timeout', async () => {
    const calls = [];
    const results = [timeout, success, success];
    const invoke = async (...args) => {
      calls.push(args);
      return results.shift();
    };

    await runHatchetPoc('down', { invoke, logger: quietLogger, env: {} });

    assert.deepEqual(calls, [
      [
        ['down', '--timeout', '10', '--remove-orphans'],
        { timeoutMs: 30_000, label: 'graceful shutdown' },
      ],
      [
        ['kill', '--signal', 'SIGKILL'],
        { timeoutMs: 15_000, label: 'forced container kill' },
      ],
      [
        ['down', '--timeout', '0', '--remove-orphans'],
        { timeoutMs: 15_000, label: 'forced shutdown cleanup' },
      ],
    ]);
  });

  test('fails clearly when Docker is unavailable during forced cleanup', async () => {
    let callCount = 0;
    const invoke = async () => {
      callCount += 1;
      return timeout;
    };

    await assert.rejects(
      runHatchetPoc('down', { invoke, logger: quietLogger, env: {} }),
      /Docker Engine may be unavailable/
    );
    assert.equal(callCount, 3);
  });

  test('restart completes shutdown before starting', async () => {
    const calls = [];
    const invoke = async (...args) => {
      calls.push(args);
      return success;
    };

    await runHatchetPoc('restart', { invoke, logger: quietLogger, env: {} });

    assert.deepEqual(calls, [
      [
        ['down', '--timeout', '10', '--remove-orphans'],
        { timeoutMs: 30_000, label: 'graceful shutdown' },
      ],
      [
        ['up', '-d'],
        { timeoutMs: 120_000, label: 'startup' },
      ],
    ]);
  });

  test('startup timeout is reported instead of hanging', async () => {
    const invoke = async () => timeout;

    await assert.rejects(
      runHatchetPoc('up', { invoke, logger: quietLogger, env: {} }),
      /startup timed out/
    );
  });

  test('validates timeout configuration', () => {
    assert.throws(
      () => readHatchetPocTimeouts({
        HATCHET_POC_DOWN_TIMEOUT_SECONDS: '0',
      }),
      /HATCHET_POC_DOWN_TIMEOUT_SECONDS must be a positive integer/
    );
  });
});
