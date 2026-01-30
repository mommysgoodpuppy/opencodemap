let mermaidModulePromise: Promise<any> | null = null;

import * as logger from "../logger";

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid").then((mod) => mod.default ?? mod);
  }
  return mermaidModulePromise;
}

function findDanglingEdge(code: string): string | null {
  const lines = code.split(/\r?\n/);
  const edgeRegex =
    /^([A-Za-z0-9_][\w-]*)\s*(-->|-\.-?>|==>)\s*(\|[^|]*\|\s*)?([A-Za-z0-9_][\w-]*)?/;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    if (!/(-->|-\.-?>|==>)/.test(line)) continue;
    const match = line.match(edgeRegex);
    if (!match) continue;
    const target = match[4];
    if (!target) {
      return line;
    }
  }
  return null;
}

export async function validateMermaidDiagram(
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    logger.debug(
      `[Mermaid Validate] Starting validation, code length: ${code.length}`,
    );

    const dangling = findDanglingEdge(code);
    if (dangling) {
      logger.debug(`[Mermaid Validate] Found dangling edge: ${dangling}`);
      return { ok: false, error: `Dangling edge missing target: ${dangling}` };
    }

    logger.debug("[Mermaid Validate] Loading mermaid module");
    const mermaid = await loadMermaid();

    logger.debug("[Mermaid Validate] Initializing mermaid");
    try {
      mermaid.initialize({ startOnLoad: false });
    } catch {
      logger.debug("[Mermaid Validate] Mermaid already initialized");
    }

    logger.debug("[Mermaid Validate] Parsing diagram");
    try {
      await mermaid.parse(code);
      logger.debug("[Mermaid Validate] Validation successful");
      return { ok: true };
    } catch (parseErr) {
      const parseMsg = parseErr instanceof Error
        ? parseErr.message
        : String(parseErr);
      logger.debug(`[Mermaid Validate] Parse error: ${parseMsg}`);
      // Mermaid uses DOMPurify for HTML labels; in Node this can be unavailable.
      // Treat DOMPurify-related errors as non-fatal to avoid false negatives.
      if (/DOMPurify|purify\.(addHook|sanitize)/i.test(parseMsg)) {
        logger.debug("[Mermaid Validate] DOMPurify error treated as non-fatal");
        return { ok: true };
      }
      return { ok: false, error: parseMsg || "Mermaid parse error" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`[Mermaid Validate] Unexpected error: ${msg}`);
    // Mermaid uses DOMPurify for HTML labels; in Node this can be unavailable.
    // Treat DOMPurify-related errors as non-fatal to avoid false negatives.
    if (/DOMPurify|purify\.(addHook|sanitize)/i.test(msg)) {
      logger.debug("[Mermaid Validate] DOMPurify error treated as non-fatal");
      return { ok: true };
    }
    return { ok: false, error: msg };
  }
}
