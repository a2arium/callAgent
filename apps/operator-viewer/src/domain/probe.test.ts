import { describe, expect, it } from 'vitest';
import { parseProbeFilterValue, probeSelectionSearchPatch } from './probe';

describe('parseProbeFilterValue', () => {
  it('parses JSON primitive values for exact probe comparisons', () => {
    expect(parseProbeFilterValue('1')).toBe(1);
    expect(parseProbeFilterValue('true')).toBe(true);
    expect(parseProbeFilterValue('null')).toBeNull();
    expect(parseProbeFilterValue('"1"')).toBe('1');
  });

  it('preserves ordinary unquoted strings', () => {
    expect(parseProbeFilterValue('Ada')).toBe('Ada');
  });
});

describe('probeSelectionSearchPatch', () => {
  it('selects a probe result without changing the active tab or filters', () => {
    expect(probeSelectionSearchPatch('exercise-1')).toEqual({
      selectedKey: 'exercise-1',
    });
  });
});
