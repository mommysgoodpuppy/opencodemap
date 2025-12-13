import React, { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, RefreshCw } from 'lucide-react';
import { TraceDiagramView } from './TraceDiagramView';
import type { Codemap, CodemapLocation, CodemapTrace } from '../types';

interface CodemapTreeViewProps {
  codemap: Codemap | null;
  onLocationClick: (location: CodemapLocation) => void;
  isProcessing?: boolean;
  canRetryTraces?: boolean;
  onRetryTrace?: (traceId: string) => void;
}

/**
 * Very small Markdown renderer for traceGuide (headings + paragraphs + lists + inline bold/code).
 * We keep it dependency-free to avoid bundling markdown libs into the webview.
 */
function parseFileTarget(target: string): { filePath: string; lineNumber?: number } | null {
  const t = target.trim();
  // common format: /abs/path/file.ts:123  or  e:/abs/path/file.ts:123
  const m = t.match(/^(.*):(\d+)$/);
  if (m) {
    const rawPath = m[1];
    const normalized =
      /^[a-zA-Z]:\//.test(rawPath) ? rawPath.replace(/\//g, '\\') : rawPath;
    return { filePath: normalized, lineNumber: parseInt(m[2], 10) };
  }
  // allow plain absolute paths without line number
  if (t.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(t)) {
    const normalized = /^[a-zA-Z]:\//.test(t) ? t.replace(/\//g, '\\') : t;
    return { filePath: normalized };
  }
  return null;
}

export function renderInlineMarkdown(
  text: string,
  opts?: {
    onOpenFile?: (filePath: string, lineNumber?: number) => void;
    onOpenLocationRef?: (locationId: string) => void;
  }
): React.ReactNode[] {
  // Supports **bold**, `code`, and [label](filePath[:line])
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  const pushText = (t: string) => {
    if (t) nodes.push(<React.Fragment key={`t-${key++}`}>{t}</React.Fragment>);
  };

  while (remaining.length > 0) {
    const boldIdx = remaining.indexOf('**');
    const codeIdx = remaining.indexOf('`');
    const linkIdx = remaining.indexOf('[');
    const nextIdxCandidates = [boldIdx, codeIdx, linkIdx].filter((n) => n >= 0);
    if (nextIdxCandidates.length === 0) {
      pushText(remaining);
      break;
    }

    const nextIdx = Math.min(...nextIdxCandidates);
    pushText(remaining.slice(0, nextIdx));
    remaining = remaining.slice(nextIdx);

    if (remaining.startsWith('**')) {
      const end = remaining.indexOf('**', 2);
      if (end > 2) {
        const content = remaining.slice(2, end);
        nodes.push(
          <strong key={`b-${key++}`}>{content}</strong>
        );
        remaining = remaining.slice(end + 2);
        continue;
      }
    }

    if (remaining.startsWith('`')) {
      const end = remaining.indexOf('`', 1);
      if (end > 1) {
        const content = remaining.slice(1, end);
        nodes.push(
          <code key={`c-${key++}`} className="trace-guide-code">{content}</code>
        );
        remaining = remaining.slice(end + 1);
        continue;
      }
    }

    if (remaining.startsWith('[')) {
      const closeBracket = remaining.indexOf(']');
      const openParen = closeBracket >= 0 ? remaining.indexOf('(', closeBracket) : -1;
      const closeParen = openParen >= 0 ? remaining.indexOf(')', openParen) : -1;
      // Case A: markdown link [label](target)
      if (closeBracket > 0 && openParen === closeBracket + 1 && closeParen > openParen + 1) {
        const rawLabel = remaining.slice(1, closeBracket);
        const target = remaining.slice(openParen + 1, closeParen);
        const parsed = parseFileTarget(target);

        const renderLabel = () => {
          // If label is wrapped in backticks, render as inline code
          const trimmed = rawLabel.trim();
          if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length > 2) {
            return <code className="trace-guide-code">{trimmed.slice(1, -1)}</code>;
          }
          return rawLabel;
        };

        if (parsed && opts?.onOpenFile) {
          nodes.push(
            <a
              key={`l-${key++}`}
              className="trace-guide-link"
              href="#"
              title={target}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                opts.onOpenFile?.(parsed.filePath, parsed.lineNumber);
              }}
            >
              {renderLabel()}
            </a>
          );
        } else {
          nodes.push(<React.Fragment key={`l-${key++}`}>{renderLabel()}</React.Fragment>);
        }
        remaining = remaining.slice(closeParen + 1);
        continue;
      }

      // Case B: location reference like [1a], [2b] in guide text
      if (closeBracket > 0) {
        const inside = remaining.slice(1, closeBracket).trim();
        const isLocRef = /^(\d+[a-z])$/.test(inside);
        if (isLocRef && opts?.onOpenLocationRef) {
          nodes.push(
            <button
              key={`r-${key++}`}
              type="button"
              className="trace-guide-ref"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                opts.onOpenLocationRef?.(inside);
              }}
              title={`Go to ${inside}`}
            >
              {inside}
            </button>
          );
          remaining = remaining.slice(closeBracket + 1);
          continue;
        }
      }
    }

    // Fallback: if we couldn't parse a valid token, emit first char and continue.
    pushText(remaining[0]);
    remaining = remaining.slice(1);
  }

  return nodes;
}

const TraceGuideMarkdown: React.FC<{
  markdown: string;
  onOpenFile: (filePath: string, lineNumber?: number) => void;
  onOpenLocationRef: (locationId: string) => void;
}> = ({ markdown, onOpenFile, onOpenLocationRef }) => {
  const blocks = useMemo(() => {
    const lines = markdown.split('\n');
    const out: Array<{ type: 'h1' | 'h2' | 'h3' | 'p' | 'ul'; lines: string[] }> = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trimEnd();
      if (!line.trim()) {
        i++;
        continue;
      }

      // Headings
      if (line.startsWith('### ')) {
        out.push({ type: 'h3', lines: [line.slice(4).trim()] });
        i++;
        continue;
      }
      if (line.startsWith('## ')) {
        out.push({ type: 'h2', lines: [line.slice(3).trim()] });
        i++;
        continue;
      }
      if (line.startsWith('# ')) {
        out.push({ type: 'h1', lines: [line.slice(2).trim()] });
        i++;
        continue;
      }

      // Unordered list
      if (line.startsWith('- ')) {
        const items: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith('- ')) {
          items.push(lines[i].trim().slice(2).trim());
          i++;
        }
        out.push({ type: 'ul', lines: items });
        continue;
      }

      // Paragraph (consume until blank)
      const para: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        para.push(lines[i].trim());
        i++;
      }
      out.push({ type: 'p', lines: [para.join(' ')] });
    }

    return out;
  }, [markdown]);

  return (
    <div className="trace-guide-markdown">
      {blocks.map((b, idx) => {
        if (b.type === 'h1') return <h1 key={idx}>{b.lines[0]}</h1>;
        if (b.type === 'h2') return <h2 key={idx}>{b.lines[0]}</h2>;
        if (b.type === 'h3') return <h3 key={idx}>{b.lines[0]}</h3>;
        if (b.type === 'ul') {
          return (
            <ul key={idx}>
              {b.lines.map((it, j) => (
                <li key={j}>{renderInlineMarkdown(it, { onOpenFile, onOpenLocationRef })}</li>
              ))}
            </ul>
          );
        }
        return <p key={idx}>{renderInlineMarkdown(b.lines[0], { onOpenFile, onOpenLocationRef })}</p>;
      })}
    </div>
  );
};

/**
 * Props for TraceSection
 */
interface TraceSectionProps {
  trace: CodemapTrace;
  traceIndex: number;
  allLocations: Map<string, CodemapLocation>;
  onLocationClick: (location: CodemapLocation) => void;
  onFileClick: (filePath: string, lineNumber?: number) => void;
  isProcessing?: boolean;
  canRetryTraces?: boolean;
  onRetryTrace?: (traceId: string) => void;
}

/**
 * A single trace section with collapsible header
 * The diagram inside is always fully expanded (no node-level folding)
 */
const TraceSection: React.FC<TraceSectionProps> = ({
  trace,
  traceIndex,
  allLocations,
  onLocationClick,
  onFileClick,
  isProcessing,
  canRetryTraces,
  onRetryTrace,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isGuideExpanded, setIsGuideExpanded] = useState(false);

  const hasGuide = Boolean(trace.traceGuide && trace.traceGuide.trim().length > 0);

  return (
    <div className="trace-section">
      {/* Trace header - clickable to expand/collapse */}
      <div className="trace-section-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="trace-section-chevron">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>
        <div className="trace-section-content">
          <div className="trace-section-title-row">
            <span className="trace-section-step">{traceIndex + 1}</span>
            <span className="trace-section-title">{trace.title}</span>
            {onRetryTrace && (
              <button
                type="button"
                className="icon-btn"
                title={canRetryTraces ? 'Retry this trace' : 'Retry unavailable (missing stage12Context)'}
                style={{ marginLeft: 'auto' }}
                disabled={Boolean(isProcessing) || !canRetryTraces}
                onClick={(e) => {
                  e.stopPropagation();
                  onRetryTrace(trace.id);
                }}
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
          {isExpanded && trace.description && (
            <div className="trace-section-desc">
              <span className="trace-section-desc-text" onClick={(e) => e.stopPropagation()}>
                {renderInlineMarkdown(
                  trace.description.length > 120
                    ? `${trace.description.slice(0, 120)}...`
                    : trace.description,
                  {
                    onOpenFile: onFileClick,
                    onOpenLocationRef: (locationId) => {
                      const loc = allLocations.get(locationId);
                      if (loc) onLocationClick(loc);
                    },
                  }
                )}
              </span>
              {hasGuide && (
                <button
                  type="button"
                  className="trace-see-more"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsGuideExpanded((v) => !v);
                  }}
                >
                  {isGuideExpanded ? 'See less' : 'See more'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      
      {/* Diagram body - static tree, no folding */}
      {isExpanded && (
        <div className="trace-section-body">
          {hasGuide && isGuideExpanded && (
            <div className="trace-guide">
              <div className="trace-guide-label">AI generated guide</div>
              <TraceGuideMarkdown
                markdown={trace.traceGuide!}
                onOpenFile={onFileClick}
                onOpenLocationRef={(locationId) => {
                  const loc = allLocations.get(locationId);
                  if (loc) {
                    onLocationClick(loc);
                  }
                }}
              />
            </div>
          )}
          <TraceDiagramView
            trace={trace}
            allLocations={allLocations}
            onLocationClick={onLocationClick}
            onFileClick={onFileClick}
          />
        </div>
      )}
    </div>
  );
};

/**
 * Main tree view for displaying Codemap structure.
 * Each trace can be collapsed, but the diagram inside is always fully expanded.
 */
export const CodemapTreeView: React.FC<CodemapTreeViewProps> = ({
  codemap,
  onLocationClick,
  isProcessing,
  canRetryTraces,
  onRetryTrace,
}) => {
  // Build a map of all locations across all traces for cross-trace references
  const allLocations = useMemo(() => {
    const map = new Map<string, CodemapLocation>();
    if (codemap) {
      for (const trace of codemap.traces) {
        for (const loc of trace.locations) {
          map.set(loc.id, loc);
        }
      }
    }
    return map;
  }, [codemap]);

  // Handler for file clicks from diagram
  const handleFileClick = (filePath: string, lineNumber?: number) => {
    const syntheticLocation: CodemapLocation = {
      id: `file-${filePath}-${lineNumber || 0}`,
      path: filePath,
      lineNumber: lineNumber || 1,
      lineContent: '',
      title: filePath.split(/[/\\]/).pop() || filePath,
      description: '',
    };
    onLocationClick(syntheticLocation);
  };

  if (!codemap) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🗺️</div>
        <div className="empty-state-text">
          No codemap selected. Go back to the Codemaps list to open or generate one.
        </div>
      </div>
    );
  }

  return (
    <div className="tree-container">
      {codemap.traces.map((trace, idx) => (
        <TraceSection
          key={trace.id}
          trace={trace}
          traceIndex={idx}
          allLocations={allLocations}
          onLocationClick={onLocationClick}
          onFileClick={handleFileClick}
          isProcessing={isProcessing}
          canRetryTraces={canRetryTraces}
          onRetryTrace={onRetryTrace}
        />
      ))}
    </div>
  );
};
