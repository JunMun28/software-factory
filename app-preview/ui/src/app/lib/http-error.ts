// Extracts the orchestrator's human-readable error ({ error: string } JSON)
// from a failed Response, falling back to `${fallback} (${status})`.
export async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error;
    }
  } catch {
    // non-JSON body (e.g. plain-text 500) — fall through
  }
  return `${fallback} (${response.status})`;
}
