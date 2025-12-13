/**
 * Mermaid post-processing: apply deterministic, rotating background fills to subgraphs.
 *
 * Rationale:
 * - We do NOT ask the model to output any colors.
 * - After model output, we append `style <subgraphId> fill:<placeholderHex>` lines.
 * - The webview later replaces these placeholder hex colors with VS Code theme colors.
 */

const SUBGRAPH_FILL_PLACEHOLDER_CYCLE = [
  // Keep in sync with webview's placeholder cycle (order matters for stable rotation)
  '#a5d8ff',
  '#ffd8a8',
  '#d0bfff',
  '#b2f2bb',
  '#fcc2d7',
  '#ffec99',
  '#99e9f2',
  '#eebefa',
] as const;

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, '\n');
}

function extractSubgraphIds(diagram: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const lines = normalizeLineEndings(diagram).split('\n');

  // Mermaid subgraph syntax we support:
  // - subgraph id [Label]
  // - subgraph id["Label"]
  // - subgraph id
  // We only take the first token after `subgraph` as the id.
  const re = /^\s*subgraph\s+([^\s\[]+)\s*(?:\[[^\]]*\]|\["[^"]*"\])?\s*$/i;

  for (const line of lines) {
    const m = line.match(re);
    if (!m) {
      continue;
    }
    const raw = (m[1] || '').trim();
    const id = raw.replace(/^"(.+)"$/, '$1').trim();
    if (!id) {
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

function stripFillFromStyleLine(line: string): string | null {
  const m = line.match(/^\s*style\s+([^\s]+)\s+(.+)\s*$/i);
  if (!m) {
    return line;
  }

  const target = m[1];
  const styles = m[2];

  const parts = styles
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const kept = parts.filter(
    (p) => !/^fill\s*:/i.test(p) && !/^fill-opacity\s*:/i.test(p)
  );

  if (kept.length === 0) {
    return null;
  }
  return `style ${target} ${kept.join(',')}`;
}

function stripFillFromClassDefLine(line: string): string | null {
  const m = line.match(/^\s*classDef\s+([^\s]+)\s+(.+)\s*$/i);
  if (!m) {
    return line;
  }

  const className = m[1];
  const styles = m[2];

  const parts = styles
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const kept = parts.filter(
    (p) => !/^fill\s*:/i.test(p) && !/^fill-opacity\s*:/i.test(p)
  );

  if (kept.length === 0) {
    return null;
  }
  return `classDef ${className} ${kept.join(',')}`;
}

/**
 * Apply rotating fills to all subgraphs in the diagram and return the updated Mermaid code.
 *
 * - Removes existing `fill:` / `fill-opacity:` directives from `style ...` and `classDef ...` lines.
 * - Appends `style <subgraphId> fill:<placeholder>` for each subgraph id in appearance order.
 * - If there are no subgraphs, returns the sanitized original.
 */
export function colorizeMermaidDiagram(diagram: string): string {
  const normalized = normalizeLineEndings(diagram).trim();
  if (!normalized) {
    return normalized;
  }

  const subgraphIds = extractSubgraphIds(normalized);

  const sanitizedLines: string[] = [];
  for (const line of normalized.split('\n')) {
    const maybeStyle = stripFillFromStyleLine(line);
    if (maybeStyle === null) {
      continue;
    }
    const maybeClassDef = stripFillFromClassDefLine(maybeStyle);
    if (maybeClassDef === null) {
      continue;
    }
    sanitizedLines.push(maybeClassDef);
  }

  const sanitized = sanitizedLines.join('\n').trim();
  if (subgraphIds.length === 0) {
    return sanitized;
  }

  const styleLines = subgraphIds.map((id, idx) => {
    const color =
      SUBGRAPH_FILL_PLACEHOLDER_CYCLE[idx % SUBGRAPH_FILL_PLACEHOLDER_CYCLE.length];
    return `style ${id} fill:${color}`;
  });

  // Append styles at the end (common Mermaid convention).
  return `${sanitized}\n\n${styleLines.join('\n')}`.trim();
}


