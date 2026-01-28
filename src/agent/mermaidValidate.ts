let mermaidModulePromise: Promise<any> | null = null;

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((mod) => mod.default ?? mod);
  }
  return mermaidModulePromise;
}

export async function validateMermaidDiagram(code: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const mermaid = await loadMermaid();
    await mermaid.parse(code);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Mermaid uses DOMPurify for HTML labels; in Node this can be unavailable.
    // Treat DOMPurify-related errors as non-fatal to avoid false negatives.
    if (/DOMPurify|purify\.(addHook|sanitize)/i.test(msg)) {
      return { ok: true };
    }
    return { ok: false, error: msg };
  }
}
