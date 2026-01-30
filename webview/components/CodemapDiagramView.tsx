import React, { useEffect, useMemo, useRef } from "react";
import { MermaidDiagram } from "./MermaidDiagram";
import { useExtensionCommands } from "../extensionBridge";
import type { Codemap, CodemapLocation } from "../types";

interface CodemapDiagramViewProps {
  codemap: Codemap | null;
  onLocationClick?: (location: CodemapLocation) => void;
}

/**
 * Build a map from step label (e.g., "1a", "2b") to CodemapLocation
 */
function buildLocationMap(codemap: Codemap): Map<string, CodemapLocation> {
  const map = new Map<string, CodemapLocation>();
  codemap.traces.forEach((trace, traceIdx) => {
    trace.locations.forEach((loc, locIdx) => {
      const stepLabel = `${traceIdx + 1}${String.fromCharCode(97 + locIdx)}`;
      map.set(stepLabel, loc);
    });
  });
  return map;
}

/**
 * Diagram view for displaying Codemap as a Mermaid flowchart.
 */
export const CodemapDiagramView: React.FC<CodemapDiagramViewProps> = ({
  codemap,
  onLocationClick,
}) => {
  const commands = useExtensionCommands();
  const requestedKeyRef = useRef<string | null>(null);

  const mermaidCode = useMemo(() => codemap?.mermaidDiagram?.trim() || "", [
    codemap?.mermaidDiagram,
  ]);

  const locationMap = useMemo(() => {
    if (!codemap) return new Map<string, CodemapLocation>();
    return buildLocationMap(codemap);
  }, [codemap]);

  const handleNodeClick = (stepLabel: string) => {
    const location = locationMap.get(stepLabel);
    if (location && onLocationClick) {
      onLocationClick(location);
    }
  };

  // Ensure the mermaid diagram is generated (AI). No fallback diagram building.
  useEffect(() => {
    if (!codemap) return;
    if (mermaidCode) return;

    // Attempt to identify the current codemap instance to avoid spamming requests.
    const key = `${codemap.title}::${codemap.savedAt ?? ""}`;
    if (requestedKeyRef.current === key) return;
    requestedKeyRef.current = key;

    commands.ensureMermaidDiagram();
  }, [codemap, mermaidCode, commands]);

  if (!codemap) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📊</div>
        <div className="empty-state-text">
          No codemap selected. Go back to the Codemaps list to open or generate
          one.
        </div>
      </div>
    );
  }

  if (codemap.traces.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📊</div>
        <div className="empty-state-text">
          This codemap has no traces to visualize.
        </div>
      </div>
    );
  }

  if (!mermaidCode) {
    return (
      <div className="diagram-container">
        <div className="diagram-loading">
          Generating Mermaid diagram...
        </div>
      </div>
    );
  }

  return (
    <div className="diagram-container">
      <MermaidDiagram
        code={mermaidCode}
        id="codemap-diagram"
        onNodeClick={handleNodeClick}
      />
    </div>
  );
};
