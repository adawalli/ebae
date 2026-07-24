// A JSON mutation from the browser. Owns the fetch + parse + error-normalization that every
// form handler was copy-pasting, including the two magic strings: the `request failed (n)`
// fallback and the Error/String coercion. Never throws - both the HTTP-error and the
// thrown-error cases come back as `{ ok: false, error }`, so callers keep only their own
// busy/error state wiring and their success branch.
export async function submitJson<T = unknown>(
  input: string,
  opts?: { method?: string; body?: unknown },
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const hasBody = opts?.body !== undefined;
    const res = await fetch(input, {
      method: opts?.method ?? "GET",
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(opts?.body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: data?.error ?? `request failed (${res.status})` };
    return { ok: true, data: data as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
