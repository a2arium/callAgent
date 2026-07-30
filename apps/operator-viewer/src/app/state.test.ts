import { describe, expect, it } from 'vitest';
import { parseRunSearch } from './state';

describe('parseRunSearch', () => {
  it.each(['summary', 'turns', 'tools', 'llm', 'memory'] as const)('preserves supported inspector tab %s', (tab) => {
    expect(parseRunSearch({ tab }).tab).toBe(tab);
  });

  it.each(['links', 'unknown', '', 42, undefined])('falls back to summary for unsupported inspector tab %s', (tab) => {
    expect(parseRunSearch({ tab }).tab).toBe('summary');
  });
});
