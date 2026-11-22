// The message of a caught value, which is not always an Error.
export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
