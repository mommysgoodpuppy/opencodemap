import React, { useEffect, useRef, useState } from "react";
import { MermaidPlaceholderToAccentKey } from "../mermaidPlaceholders";

interface MermaidDiagramProps {
  code: string;
  id?: string;
  onNodeClick?: (stepLabel: string) => void;
}

// Dynamic singletons
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaidInstance: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let svgPanZoomFactory: any = null;

function getCssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(
    name,
  );
  return value?.trim() || fallback;
}

function isVsCodeDarkTheme(): boolean {
  // VS Code webview sets theme classes on <body>
  return (
    document.body.classList.contains("vscode-dark") ||
    document.body.classList.contains("vscode-high-contrast")
  );
}

function colorToHex(input: string): string {
  const v = input.trim();
  if (!v) return v;
  if (v.startsWith("#")) return v;

  // Convert any CSS color string into computed rgb(...) then parse it.
  const el = document.createElement("div");
  el.style.color = v;
  document.body.appendChild(el);
  const computed = getComputedStyle(el).color;
  document.body.removeChild(el);

  const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return v;
  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);
  return `#${r.toString(16).padStart(2, "0")}${
    g.toString(16).padStart(2, "0")
  }${
    b
      .toString(16)
      .padStart(2, "0")
  }`;
}

type MermaidThemePalette = {
  sidebarBg: string;
  sidebarFg: string;
  editorBg: string;
  editorFg: string;
  panelBorder: string;
  toolbarHoverBg: string;
  focusBorder: string;
  accentBlue: string;
  accentOrange: string;
  accentPurple: string;
  accentGreen: string;
  accentRed: string;
  accentYellow: string;
  accentCyan: string;
  accentPink: string;
};

function getMermaidThemePalette(): MermaidThemePalette {
  // Align with windsurf's Code Map: take theme colors from VS Code injected CSS variables.
  return {
    sidebarBg: getCssVar("--vscode-sideBar-background", "#252526"),
    sidebarFg: getCssVar("--vscode-sideBar-foreground", "#cccccc"),
    editorBg: getCssVar("--vscode-editor-background", "#1e1e1e"),
    editorFg: getCssVar("--vscode-editor-foreground", "#d4d4d4"),
    panelBorder: getCssVar("--vscode-panel-border", "#3c3c3c"),
    toolbarHoverBg: getCssVar("--vscode-toolbar-hoverBackground", "#2a2d2e"),
    focusBorder: getCssVar("--vscode-focusBorder", "#007fd4"),
    accentBlue: getCssVar("--vscode-charts-blue", "#a5d8ff"),
    accentOrange: getCssVar("--vscode-charts-orange", "#ffd8a8"),
    accentPurple: getCssVar("--vscode-charts-purple", "#d0bfff"),
    accentGreen: getCssVar("--vscode-charts-green", "#b2f2bb"),
    accentRed: getCssVar("--vscode-charts-red", "#fcc2d7"),
    accentYellow: getCssVar("--vscode-charts-yellow", "#ffec99"),
    accentCyan: getCssVar("--vscode-debugIcon-breakpointForeground", "#99e9f2"),
    accentPink: getCssVar("--vscode-debugTokenExpression-string", "#eebefa"),
  };
}

function applyWindsurfColorSubstitutions(
  code: string,
  palette: MermaidThemePalette,
): string {
  // windsurf 的 Code Map 会把这些“占位色”替换为当前主题色，并附加 fill-opacity。
  const opacity = isVsCodeDarkTheme() ? 0.25 : 0.15;

  let out = code;
  for (
    const [placeholder, accentKey] of Object.entries(
      MermaidPlaceholderToAccentKey,
    )
  ) {
    const actualColor =
      palette[accentKey as keyof MermaidThemePalette] as string;
    const replacement = `${colorToHex(actualColor)},fill-opacity:${opacity}`;
    out = out.replace(new RegExp(placeholder, "g"), replacement);
  }
  return out;
}

/**
 * After mermaid renders, apply transparency to subgraph cluster backgrounds.
 * Mermaid renders subgraph backgrounds as <rect> inside <g class="cluster">.
 */
function applySubgraphOpacity(svgElement: SVGSVGElement): void {
  const opacity = isVsCodeDarkTheme() ? 0.25 : 0.15;

  // Subgraph clusters in mermaid have class "cluster"
  // Their background rect is the first rect child
  const clusters = svgElement.querySelectorAll("g.cluster > rect");
  clusters.forEach((rect) => {
    rect.setAttribute("fill-opacity", String(opacity));
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
  onNodeClick: (stepLabel: string) => void,
): void {
  // Mermaid renders nodes as <g class="node"> elements
  const nodes = svgElement.querySelectorAll("g.node");

  nodes.forEach((node) => {
    // Get the text content of the node (from foreignObject or text elements)
    const textContent = node.textContent || "";
    const stepLabel = extractStepLabel(textContent.trim());

    if (stepLabel) {
      // Make the node clickable
      (node as SVGGElement).style.cursor = "pointer";

      // Add hover effect
      node.addEventListener("mouseenter", () => {
        const rect = node.querySelector("rect");
        if (rect) {
          rect.setAttribute(
            "data-original-stroke",
            rect.getAttribute("stroke") || "",
          );
          rect.setAttribute(
            "stroke",
            getCssVar("--vscode-focusBorder", "#007fd4"),
          );
          rect.setAttribute("stroke-width", "2");
        }
      });

      node.addEventListener("mouseleave", () => {
        const rect = node.querySelector("rect");
        if (rect) {
          const originalStroke = rect.getAttribute("data-original-stroke") ||
            "";
          rect.setAttribute("stroke", originalStroke);
          rect.setAttribute("stroke-width", "1");
        }
      });

      // Add click handler
      node.addEventListener("click", (e) => {
        e.stopPropagation();
        onNodeClick(stepLabel);
      });
    }
  });
}

async function loadDeps() {
  if (!mermaidInstance) {
    const mermaidModule = await import("mermaid");
    mermaidInstance = mermaidModule.default;
  }

  if (!svgPanZoomFactory) {
    const panZoomModule = await import("svg-pan-zoom");
    svgPanZoomFactory = (panZoomModule as any).default || panZoomModule;
  }

  return { mermaid: mermaidInstance, svgPanZoom: svgPanZoomFactory };
}

/**
 * Component that renders a Mermaid diagram from code string with pan/zoom controls.
 */
export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({
  code,
  id = "mermaid-diagram",
  onNodeClick,
}) => {
  // hostRef holds only the mermaid-generated SVG. Keep React-managed overlays outside this node
  // to avoid React attempting to remove DOM nodes that were replaced by Mermaid.
  const hostRef = useRef<HTMLDivElement>(null);
  const panZoomRef = useRef<any>(null);
  const onNodeClickRef = useRef(onNodeClick);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [themeVersion, setThemeVersion] = useState(0);

  // Keep the callback ref updated
  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
  }, [onNodeClick]);

  // Re-render when VS Code theme changes (body class changes in webviews)
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setThemeVersion((v) => v + 1);
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!code || !hostRef.current) {
      setError(code ? null : "No diagram code provided");
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

        const palette = getMermaidThemePalette();
        const diagramCode = applyWindsurfColorSubstitutions(code, palette);

        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          securityLevel: "loose",
          themeVariables: {
            fontFamily: getCssVar(
              "--vscode-font-family",
              "Segoe UI, Tahoma, Geneva, Verdana, sans-serif",
            ),
            fontSize: "18px",
            primaryColor: palette.editorFg,
            primaryTextColor: palette.editorFg,
            primaryBorderColor: palette.editorFg,
            lineColor: palette.editorFg,
            background: palette.sidebarBg,
            mainBkg: palette.sidebarBg,
            nodeBkg: palette.sidebarBg,
            edgeLabelBackground: palette.sidebarBg,
          },
          themeCSS: `
            .label text { fill: ${palette.editorFg} !important; }
            .edgeLabel text { fill: ${palette.editorFg} !important; }
            .edgeLabel tspan { fill: ${palette.editorFg} !important; }
            .nodeLabel { color: ${palette.editorFg} !important; }
            .nodeLabel p { color: ${palette.editorFg} !important; }
            .nodeLabel span { color: ${palette.editorFg} !important; }
            foreignObject div { color: ${palette.editorFg} !important; }
            foreignObject span { color: ${palette.editorFg} !important; }
            .node rect { fill: ${palette.sidebarBg} !important; stroke: ${palette.panelBorder} !important; }
            .cluster rect { stroke: ${palette.panelBorder} !important; }
          `,
          flowchart: {
            useMaxWidth: false,
            htmlLabels: true,
            nodeSpacing: 25,
            rankSpacing: 25,
            padding: 8,
            curve: "basis",
          },
        });

        // Clear previous content
        if (!hostRef.current) {
          return;
        }
        hostRef.current.innerHTML = "";

        const renderId = `${id}-${Date.now()}`;
        const { svg } = await mermaid.render(renderId, diagramCode);
        if (disposed || !hostRef.current) {
          return;
        }

        hostRef.current.innerHTML = svg;
        const svgElement = hostRef.current.querySelector("svg");

        if (svgElement) {
          applySubgraphOpacity(svgElement);

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
        console.error("Mermaid render error:", err);
        setError(
          err instanceof Error ? err.message : "Failed to render diagram",
        );
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
  }, [code, id, themeVersion]);

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
        <button className="mermaid-btn" onClick={handleZoomIn} title="Zoom In">
          +
        </button>
        <button
          className="mermaid-btn"
          onClick={handleZoomOut}
          title="Zoom Out"
        >
          −
        </button>
        <button className="mermaid-btn" onClick={handleReset} title="Reset">
          ⟳
        </button>
      </div>

      <div className="mermaid-stage">
        <div className="mermaid-canvas" ref={hostRef} />
        {loading && (
          <div className="diagram-loading overlay">Rendering diagram...</div>
        )}
        {error && (
          <div className="diagram-error overlay">
            <div>Failed to render diagram:</div>
            <pre
              style={{
                fontSize: "11px",
                marginTop: "8px",
                whiteSpace: "pre-wrap",
              }}
            >
              {error}
            </pre>
            <details style={{ marginTop: "12px", fontSize: "11px" }}>
              <summary>View diagram code</summary>
              <pre
                style={{
                  marginTop: "8px",
                  whiteSpace: "pre-wrap",
                  textAlign: "left",
                }}
              >
                {code}
              </pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
};
