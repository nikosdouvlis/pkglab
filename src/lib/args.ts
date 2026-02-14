/**
 * Extract variadic positional arguments from citty args.
 * citty puts extra positional args in `_` but doesn't type it.
 */
export function getPositionalArgs(args: Record<string, unknown>): string[] {
  return ((args as any)._ as string[] | undefined) ?? [];
}

/**
 * Normalize a scope input like "clerk" or "@clerk" to "@clerk/" prefix.
 * Returns null with a logged error if the input is invalid.
 */
export function normalizeScope(input: string): string | null {
  const stripped = input.startsWith("@") ? input.slice(1) : input;
  if (!stripped || stripped.includes("/")) {
    return null;
  }
  return `@${stripped}/`;
}
