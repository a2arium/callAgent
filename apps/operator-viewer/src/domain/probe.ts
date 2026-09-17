export function parseProbeFilterValue(input: string): unknown {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return input;
  }
}

export function probeSelectionSearchPatch(key: string): {
  selectedKey: string;
} {
  return { selectedKey: key };
}
