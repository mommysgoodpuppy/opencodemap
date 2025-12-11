import React, { useMemo } from 'react';
import { MermaidDiagram } from './MermaidDiagram';
import type { Codemap, CodemapTrace, CodemapLocation } from '../types';

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
 * Builds a Mermaid flowchart from Codemap data.
 * Creates subgraphs for each trace and connects locations with edges.
 * Also parses descriptions for cross-references like [1a], [2b] etc.
 */
function buildMermaidFromCodemap(codemap: Codemap): string {
  const lines: string[] = ['graph TD'];
  
  // Build ID mapping: step label -> node ID
  // e.g., "1a" -> "N_0_0", "2b" -> "N_1_1"
  const stepToNodeId = new Map<string, string>();
  const nodeIdToStep = new Map<string, string>();
  
  // First pass: collect all node IDs
  codemap.traces.forEach((trace, traceIdx) => {
    trace.locations.forEach((loc, locIdx) => {
      const stepLabel = `${traceIdx + 1}${String.fromCharCode(97 + locIdx)}`;
      const nodeId = `N_${traceIdx}_${locIdx}`;
      stepToNodeId.set(stepLabel, nodeId);
      nodeIdToStep.set(nodeId, stepLabel);
    });
  });

  // Second pass: build subgraphs and edges
  const crossEdges: string[] = [];
  
  codemap.traces.forEach((trace, traceIdx) => {
    const subgraphId = `T${traceIdx}`;
    const subgraphTitle = escapeLabel(trace.title);
    
    lines.push(`  subgraph ${subgraphId}["${traceIdx + 1}. ${subgraphTitle}"]`);
    
    // Add location nodes
    trace.locations.forEach((loc, locIdx) => {
      const nodeId = `N_${traceIdx}_${locIdx}`;
      const stepLabel = `${traceIdx + 1}${String.fromCharCode(97 + locIdx)}`;
      const nodeLabel = escapeLabel(`${stepLabel}: ${loc.title}`);
      
      lines.push(`    ${nodeId}["${nodeLabel}"]`);
      
      // Parse description for cross-references
      const refs = parseReferences(loc.description);
      refs.forEach(ref => {
        const targetNodeId = stepToNodeId.get(ref);
        if (targetNodeId && targetNodeId !== nodeId) {
          crossEdges.push(`  ${nodeId} -.-> ${targetNodeId}`);
        }
      });
    });
    
    // Add sequential edges within trace
    for (let i = 0; i < trace.locations.length - 1; i++) {
      const fromId = `N_${traceIdx}_${i}`;
      const toId = `N_${traceIdx}_${i + 1}`;
      lines.push(`    ${fromId} --> ${toId}`);
    }
    
    lines.push('  end');
    
    // Parse trace description for cross-references to other traces
    const traceRefs = parseTraceReferences(trace.description);
    traceRefs.forEach(refTraceIdx => {
      if (refTraceIdx !== traceIdx && refTraceIdx < codemap.traces.length) {
        // Connect last node of current trace to first node of referenced trace
        const fromTrace = trace.locations.length > 0
          ? `N_${traceIdx}_${trace.locations.length - 1}`
          : `T${traceIdx}`;
        const toTrace = codemap.traces[refTraceIdx].locations.length > 0
          ? `N_${refTraceIdx}_0`
          : `T${refTraceIdx}`;
        crossEdges.push(`  ${fromTrace} ==> ${toTrace}`);
      }
    });
  });

  // Add cross-trace edges at the end
  if (crossEdges.length > 0) {
    lines.push('');
    lines.push('  %% Cross-references');
    crossEdges.forEach(edge => {
      if (!lines.includes(edge)) {
        lines.push(edge);
      }
    });
  }

  // Add styling
  lines.push('');
  lines.push('  %% Styling');
  lines.push('  classDef default fill:#2d2d2d,stroke:#555,stroke-width:1px,color:#ccc');
  lines.push('  classDef traceStyle fill:#252526,stroke:#404040,stroke-width:2px');
  
  return lines.join('\n');
}

/**
 * Escapes special characters for Mermaid labels.
 */
function escapeLabel(text: string): string {
  return text
    .replace(/"/g, "'")
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 50) + (text.length > 50 ? '...' : '');
}

/**
 * Parses step references like [1a], [2b] from text.
 */
function parseReferences(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/\[(\d+[a-z])\]/g);
  if (!matches) return [];
  return matches.map(m => m.slice(1, -1)); // Remove brackets
}

/**
 * Parses trace number references like [1], [2] from text.
 */
function parseTraceReferences(text: string): number[] {
  if (!text) return [];
  const matches = text.match(/\[(\d+)\]/g);
  if (!matches) return [];
  return matches
    .map(m => parseInt(m.slice(1, -1), 10) - 1) // Convert to 0-indexed
    .filter(n => !isNaN(n) && n >= 0);
}

/**
 * Diagram view for displaying Codemap as a Mermaid flowchart.
 */
export const CodemapDiagramView: React.FC<CodemapDiagramViewProps> = ({
  codemap,
  onLocationClick,
}) => {
  const mermaidCode = useMemo(() => {
    if (!codemap || codemap.traces.length === 0) {
      return '';
    }
    if (codemap.mermaidDiagram && codemap.mermaidDiagram.trim().length > 0) {
      return codemap.mermaidDiagram.trim();
    }
    return buildMermaidFromCodemap(codemap);
  }, [codemap]);

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

  if (!codemap) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📊</div>
        <div className="empty-state-text">
          No codemap selected. Go back to the Codemaps list to open or generate one.
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

  return (
    <div className="diagram-container">
      <MermaidDiagram code={mermaidCode} id="codemap-diagram" onNodeClick={handleNodeClick} />
    </div>
  );
};
