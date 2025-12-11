import React, { useEffect, useRef, useState } from 'react';

interface MermaidDiagramProps {
  code: string;
  id?: string;
  onNodeClick?: (stepLabel: string) => void;
}

// Dynamic singletons
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaidInstance: any = null;
let mermaidInitialized = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svgPanZoomFactory: any = null;

function getCssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  return value?.trim() || fallback;
}

/**
 * After mermaid renders, apply transparency to subgraph cluster backgrounds.
 * Mermaid renders subgraph backgrounds as <rect> inside <g class="cluster">.
 */
function applySubgraphOpacity(svgElement: SVGSVGElement): void {
  const isDark = (getCssVar('--vscode-sideBar-background', '#1e1e1e') || '#1e1e1e').toLowerCase() !== '#ffffff';
  const opacity = isDark ? 0.25 : 0.15;

  // Subgraph clusters in mermaid have class "cluster"
  // Their background rect is the first rect child
  const clusters = svgElement.querySelectorAll('g.cluster > rect');
  clusters.forEach((rect) => {
    rect.setAttribute('fill-opacity', String(opacity));
  });
}

/**
 * Extract step label (e.g., "1a", "2b") from node text content.
 * Looks for patterns like "1a:" or "1a:" at the start of the label.
 */
function extractStepLabel(text: string): string | null {
  const match = text.match(/^(\d+[a-z]):/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Add click handlers to nodes that have step labels.
 */
function attachNodeClickHandlers(
  svgElement: SVGSVGElement,
  onNodeClick: (stepLabel: string) => void
): void {
  // Mermaid renders nodes as <g class="node"> elements
  const nodes = svgElement.querySelectorAll('g.node');
  
  nodes.forEach((node) => {
    // Get the text content of the node (from foreignObject or text elements)
    const textContent = node.textContent || '';
    const stepLabel = extractStepLabel(textContent.trim());
    
    if (stepLabel) {
      // Make the node clickable
      (node as SVGGElement).style.cursor = 'pointer';
      
      // Add hover effect
      node.addEventListener('mouseenter', () => {
        const rect = node.querySelector('rect');
        if (rect) {
          rect.setAttribute('data-original-stroke', rect.getAttribute('stroke') || '');
          rect.setAttribute('stroke', getCssVar('--vscode-focusBorder', '#007fd4'));
          rect.setAttribute('stroke-width', '2');
        }
      });
      
      node.addEventListener('mouseleave', () => {
        const rect = node.querySelector('rect');
        if (rect) {
          const originalStroke = rect.getAttribute('data-original-stroke') || '';
          rect.setAttribute('stroke', originalStroke);
          rect.setAttribute('stroke-width', '1');
        }
      });
      
      // Add click handler
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        onNodeClick(stepLabel);
      });
    }
  });
}

async function loadDeps() {
  if (!mermaidInstance) {
    const mermaidModule = await import('mermaid');
    mermaidInstance = mermaidModule.default;
  }

  if (!svgPanZoomFactory) {
    const panZoomModule = await import('svg-pan-zoom');
    svgPanZoomFactory = (panZoomModule as any).default || panZoomModule;
  }

  return { mermaid: mermaidInstance, svgPanZoom: svgPanZoomFactory };
}

/**
 * Component that renders a Mermaid diagram from code string with pan/zoom controls.
 */
export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({
  code,
  id = 'mermaid-diagram',
  onNodeClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const panZoomRef = useRef<any>(null);
  const onNodeClickRef = useRef(onNodeClick);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Keep the callback ref updated
  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
  }, [onNodeClick]);

  useEffect(() => {
    if (!code || !containerRef.current) {
      setError(code ? null : 'No diagram code provided');
      return;
    }

    let disposed = false;

    const renderDiagram = async () => {
      setLoading(true);
      setError(null);

      // Cleanup previous instance
      if (panZoomRef.current) {
        panZoomRef.current.destroy();
        panZoomRef.current = null;
      }

      try {
        const { mermaid, svgPanZoom } = await loadDeps();

        const fg = getCssVar('--vscode-foreground', '#cccccc');
        const bg = getCssVar('--vscode-sideBar-background', '#1e1e1e');
        const panelBorder = getCssVar('--vscode-panel-border', '#2b2b2b');
        const toolbarBg = getCssVar('--vscode-toolbar-hoverBackground', '#3a3a3a');

        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'loose',
          themeVariables: {
            fontFamily: getCssVar('--vscode-font-family', 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif'),
            fontSize: '16px',
            primaryColor: fg,
            primaryTextColor: fg,
            primaryBorderColor: panelBorder,
            lineColor: fg,
            background: bg,
            mainBkg: bg,
            edgeLabelBackground: bg,
          },
          themeCSS: `
            .label text { fill: ${fg} !important; }
            .edgeLabel text { fill: ${fg} !important; }
            .edgeLabel tspan { fill: ${fg} !important; }
            .nodeLabel { color: ${fg} !important; }
            .nodeLabel p { color: ${fg} !important; }
            .nodeLabel span { color: ${fg} !important; }
            foreignObject div { color: ${fg} !important; }
            foreignObject span { color: ${fg} !important; }
            .node rect { stroke: ${panelBorder}; }
            .cluster rect { stroke: ${panelBorder}; }
          `,
          flowchart: {
            useMaxWidth: false,
            htmlLabels: true,
            nodeSpacing: 50,
            rankSpacing: 50,
            padding: 16,
            curve: 'basis',
          },
        });

        // Clear previous content
        if (!containerRef.current) {
          return;
        }
        containerRef.current.innerHTML = '';

        const renderId = `${id}-${Date.now()}`;
        const { svg } = await mermaid.render(renderId, code);
        if (disposed || !containerRef.current) {
          return;
        }

        containerRef.current.innerHTML = svg;
        const svgElement = containerRef.current.querySelector('svg');

        if (svgElement) {

          // Add click handlers to nodes with step labels
          if (onNodeClickRef.current) {
            attachNodeClickHandlers(svgElement, (stepLabel) => {
              onNodeClickRef.current?.(stepLabel);
            });
          }

          const instance = svgPanZoom(svgElement, {
            zoomEnabled: true,
            controlIconsEnabled: false,
            fit: true,
            center: true,
            minZoom: 0.1,
            maxZoom: 10,
            zoomScaleSensitivity: 0.3,
            dblClickZoomEnabled: true,
            mouseWheelZoomEnabled: true,
            preventMouseEventsDefault: true,
            zoom: 1,
          });
          panZoomRef.current = instance;
          instance.fit();
          instance.center();
        }
      } catch (err) {
        console.error('Mermaid render error:', err);
        setError(err instanceof Error ? err.message : 'Failed to render diagram');
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };

    renderDiagram();

    return () => {
      disposed = true;
      if (panZoomRef.current) {
        panZoomRef.current.destroy();
        panZoomRef.current = null;
      }
    };
  }, [code, id]);

  const handleZoomIn = () => panZoomRef.current?.zoomIn?.();
  const handleZoomOut = () => panZoomRef.current?.zoomOut?.();
  const handleReset = () => {
    if (panZoomRef.current) {
      panZoomRef.current.reset();
      panZoomRef.current.fit();
      panZoomRef.current.center();
    }
  };

  if (!code) {
    return <div className="diagram-error">No diagram code provided</div>;
  }

  return (
    <div className="mermaid-viewer">
      <div className="mermaid-controls">
        <button className="mermaid-btn" onClick={handleZoomIn} title="Zoom In">+</button>
        <button className="mermaid-btn" onClick={handleZoomOut} title="Zoom Out">−</button>
        <button className="mermaid-btn" onClick={handleReset} title="Reset">⟳</button>
      </div>

      <div className="mermaid-stage" ref={containerRef}>
        {loading && (
          <div className="diagram-loading overlay">Rendering diagram...</div>
        )}
        {error && (
          <div className="diagram-error overlay">
            <div>Failed to render diagram:</div>
            <pre style={{ fontSize: '11px', marginTop: '8px', whiteSpace: 'pre-wrap' }}>
              {error}
            </pre>
            <details style={{ marginTop: '12px', fontSize: '11px' }}>
              <summary>View diagram code</summary>
              <pre style={{ marginTop: '8px', whiteSpace: 'pre-wrap', textAlign: 'left' }}>
                {code}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
};
