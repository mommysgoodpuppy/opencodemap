import React, { useMemo } from "react";
import { Wrench } from "lucide-react";
import type { CodemapLocation, CodemapTrace } from "../types";

/**
 * Parsed node from traceTextDiagram
 */
interface DiagramNode {
  id: string;
  title: string;
  link?: {
    type: "location" | "file";
    locationId?: string;
    filePath?: string;
    lineNumber?: number;
  };
  children: DiagramNode[];
  level: number;
}

/**
 * Flattened row for rendering
 */
interface TreeRow {
  id: string;
  title: string;
  link?: DiagramNode["link"];
  depth: number;
  isLast: boolean;
  /** For each ancestor level, true = show vertical line (not last child at that level) */
  connectors: boolean[];
}

/**
 * Clean up title text - remove extra tree chars that may appear in content
 */
function cleanTitle(text: string): string {
  // Remove leading tree drawing chars that leaked into content
  return text.replace(/^[└├│─\s]+/, "").trim();
}

/**
 * Parse a single line from traceTextDiagram
 */
function parseDiagramLine(
  line: string,
): { level: number; title: string; link?: DiagramNode["link"] } {
  let level = 0;
  let i = 0;

  while (i < line.length) {
    const char = line[i];
    if (char === "│" || char === " " || char === "\t") {
      if (char === "│") {
        level++;
        i += 4;
      } else if (line.substring(i, i + 4) === "    ") {
        level++;
        i += 4;
      } else {
        i++;
      }
    } else if (char === "├" || char === "└") {
      // Skip tree branch chars (├── or └── or └─ etc)
      while (
        i < line.length &&
        (line[i] === "├" || line[i] === "└" || line[i] === "─" ||
          line[i] === " ")
      ) {
        i++;
      }
      break;
    } else {
      break;
    }
  }

  let content = line.substring(i).trim();
  // Clean any remaining tree chars from start of content
  content = cleanTitle(content);

  const linkMatch = content.match(/^(.+?)\s*<--\s*(.+)$/);

  if (linkMatch) {
    const title = cleanTitle(linkMatch[1]);
    const linkStr = linkMatch[2].trim();

    // Location reference: "1a", "2b", etc
    const locationMatch = linkStr.match(/^(\d+[a-z])$/i);
    if (locationMatch) {
      return {
        level,
        title,
        link: { type: "location", locationId: locationMatch[1].toLowerCase() },
      };
    }

    // File path with line number - use GREEDY match to handle Windows paths like e:\...:6
    // Match everything up to the LAST colon followed by digits
    const fileMatch = linkStr.match(/^(.+):(\d+)$/);
    if (fileMatch) {
      let filePath = fileMatch[1].replace(/\\\\/g, "\\");
      // Normalize forward slashes to backslashes on Windows paths
      if (/^[a-zA-Z][:\\/]/.test(filePath)) {
        filePath = filePath.replace(/\//g, "\\");
      }
      return {
        level,
        title,
        link: {
          type: "file",
          filePath,
          lineNumber: parseInt(fileMatch[2], 10),
        },
      };
    }

    // Just a file path without line number
    let filePath = linkStr.replace(/\\\\/g, "\\");
    if (/^[a-zA-Z][:\\/]/.test(filePath)) {
      filePath = filePath.replace(/\//g, "\\");
    }
    return {
      level,
      title,
      link: { type: "file", filePath },
    };
  }

  return { level, title: content };
}

/**
 * Parse traceTextDiagram string into tree structure
 */
function parseTraceTextDiagram(diagram: string): DiagramNode[] {
  const lines = diagram.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return [];

  const rootNodes: DiagramNode[] = [];
  const stack: { node: DiagramNode; level: number }[] = [];
  let nodeId = 0;

  for (const line of lines) {
    if (!line.includes("├") && !line.includes("└") && !line.includes("│")) {
      const parsed = parseDiagramLine(line);
      const node: DiagramNode = {
        id: `dn-${nodeId++}`,
        title: parsed.title,
        link: parsed.link,
        children: [],
        level: -1,
      };
      rootNodes.push(node);
      stack.length = 0;
      stack.push({ node, level: -1 });
      continue;
    }

    const parsed = parseDiagramLine(line);
    const node: DiagramNode = {
      id: `dn-${nodeId++}`,
      title: parsed.title,
      link: parsed.link,
      children: [],
      level: parsed.level,
    };

    while (stack.length > 0 && stack[stack.length - 1].level >= parsed.level) {
      stack.pop();
    }

    if (stack.length > 0) {
      stack[stack.length - 1].node.children.push(node);
    } else {
      rootNodes.push(node);
    }

    stack.push({ node, level: parsed.level });
  }

  return rootNodes;
}

/**
 * Flatten tree into rows with connector info
 */
function flattenTree(
  nodes: DiagramNode[],
  depth: number = 0,
  connectors: boolean[] = [],
): TreeRow[] {
  const rows: TreeRow[] = [];

  nodes.forEach((node, idx) => {
    const isLast = idx === nodes.length - 1;

    rows.push({
      id: node.id,
      title: node.title,
      link: node.link,
      depth,
      isLast,
      connectors: [...connectors],
    });

    if (node.children.length > 0) {
      const childRows = flattenTree(node.children, depth + 1, [
        ...connectors,
        !isLast,
      ]);
      rows.push(...childRows);
    }
  });

  return rows;
}

/**
 * Props for TraceDiagramView
 */
interface TraceDiagramViewProps {
  trace: CodemapTrace;
  allLocations: Map<string, CodemapLocation>;
  onLocationClick: (location: CodemapLocation) => void;
  onFileClick: (filePath: string, lineNumber?: number) => void;
  fixedLocationIds?: Set<string>;
}

/**
 * Renders traceTextDiagram as a static tree with drawn connectors (continuous vertical lines)
 */
export const TraceDiagramView: React.FC<TraceDiagramViewProps> = ({
  trace,
  allLocations,
  onLocationClick,
  onFileClick,
  fixedLocationIds,
}) => {
  const { rootTitle, rows } = useMemo(() => {
    if (!trace.traceTextDiagram) {
      return { rootTitle: null, rows: [] };
    }

    const nodes = parseTraceTextDiagram(trace.traceTextDiagram);
    if (nodes.length === 0) {
      return { rootTitle: null, rows: [] };
    }

    const firstNode = nodes[0];
    if (firstNode.level === -1 && firstNode.children.length > 0) {
      return {
        rootTitle: firstNode.title,
        rows: flattenTree(firstNode.children, 0, []),
      };
    }

    return {
      rootTitle: null,
      rows: flattenTree(nodes, 0, []),
    };
  }, [trace.traceTextDiagram]);

  if (!trace.traceTextDiagram || rows.length === 0) {
    return (
      <div className="diagram-empty">
        No diagram available for this trace.
      </div>
    );
  }

  const handleRowClick = (row: TreeRow) => {
    if (row.link?.type === "location" && row.link.locationId) {
      const loc = allLocations.get(row.link.locationId);
      if (loc) onLocationClick(loc);
    } else if (row.link?.type === "file" && row.link.filePath) {
      onFileClick(row.link.filePath, row.link.lineNumber);
    }
  };

  return (
    <div className="diagram-tree">
      {rootTitle && <div className="diagram-root-title">{rootTitle}</div>}
      <div className="diagram-body">
        {rows.map((row) => {
          const location = row.link?.type === "location" && row.link.locationId
            ? allLocations.get(row.link.locationId)
            : undefined;
          const isClickable = row.link != null;
          const isFixedLocation = row.link?.type === "location" &&
            row.link.locationId &&
            fixedLocationIds?.has(row.link.locationId);

          const fileRef = (() => {
            if (row.link?.type === "file" && row.link.filePath) {
              return { path: row.link.filePath, line: row.link.lineNumber };
            }
            if (location) {
              return { path: location.path, line: location.lineNumber };
            }
            return null;
          })();

          const codeSnippet = location?.lineContent?.trim();
          const nodeKind: "context" | "event" | "code" | "file" = location
            ? "code"
            : row.link?.type === "file"
            ? "file"
            : row.depth === 0
            ? "context"
            : "event";
          const isLocationNode = nodeKind === "code";

          const fileLabel = fileRef
            ? `${fileRef.path.split(/[/\\]/).pop() || fileRef.path}${
              fileRef.line ? `:${fileRef.line}` : ""
            }`
            : undefined;

          const locationFileLabel = isLocationNode && fileLabel && fileRef
            ? (
              <span
                className="diagram-file-label"
                title={fileRef.path}
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onFileClick(fileRef.path, fileRef.line);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onFileClick(fileRef.path, fileRef.line);
                  }
                }}
              >
                {fileLabel}
              </span>
            )
            : null;

          const isLinkBasicNode = !isLocationNode && isClickable;
          const showDot = nodeKind === "file" && !location && !isLinkBasicNode;
          const titleClassName = [
            "diagram-title",
            isLinkBasicNode ? "diagram-title-link" : "",
          ]
            .filter(Boolean)
            .join(" ");

          const rowClassName = [
            "diagram-row",
            isClickable ? "clickable" : "",
            isLocationNode ? "diagram-row-location" : "diagram-row-basic",
            `diagram-row-${nodeKind}`,
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <div
              key={row.id}
              className={rowClassName}
              onClick={isClickable ? () => handleRowClick(row) : undefined}
            >
              {/* Drawn tree connectors (continuous vertical lines + elbows) */}
              <div className="diagram-connectors" aria-hidden="true">
                {row.connectors.map((showLine, idx) => (
                  <span
                    key={idx}
                    className={`diagram-col ${showLine ? "has-line" : ""}`}
                  />
                ))}
                <span
                  className={`diagram-elbow ${row.isLast ? "last" : "mid"}`}
                />
              </div>

              {isLocationNode
                ? (
                  <div className="diagram-location-card">
                    <div className="diagram-location-title-row">
                      <div className="diagram-location-title-main">
                        {row.link?.locationId && (
                          <span className="diagram-badge">
                            {row.link.locationId}
                          </span>
                        )}
                        <span className="diagram-location-title">
                          {row.title}
                        </span>
                      </div>
                      {(isFixedLocation || locationFileLabel) && (
                        <div className="diagram-location-meta">
                          {isFixedLocation && (
                            <span
                              className="diagram-fix"
                              title="Auto-corrected location"
                            >
                              <Wrench size={12} />
                            </span>
                          )}
                          {locationFileLabel}
                        </div>
                      )}
                    </div>
                    {codeSnippet && (
                      <pre
                        className="diagram-location-code"
                        title={codeSnippet}
                      >
                      {codeSnippet}
                      </pre>
                    )}
                  </div>
                )
                : (
                  <div className="diagram-basic">
                    {showDot && <span className="diagram-dot" />}
                    <span className={titleClassName}>{row.title}</span>
                  </div>
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export { type DiagramNode, parseTraceTextDiagram };
