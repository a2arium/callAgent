/** Normalize scaffold `name` (kebab or snake) to npm package segment (kebab). */
export function toKebabPackageSegment(name: string): string {
    return name.replace(/_/g, '-');
}
