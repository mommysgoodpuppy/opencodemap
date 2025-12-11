import React, { useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import type { CodemapSuggestion } from '../types';

interface SuggestionSectionProps {
  suggestions: CodemapSuggestion[];
  onSuggestionClick: (suggestion: CodemapSuggestion) => void;
  onRefresh: () => void;
}

/**
 * Collapsible section showing AI-generated query suggestions.
 */
export const SuggestionSection: React.FC<SuggestionSectionProps> = ({
  suggestions,
  onSuggestionClick,
  onRefresh,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="suggestions-section">
      <div className="section-header">
        <button
          className="icon-btn"
          onClick={() => setIsExpanded(!isExpanded)}
          style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="section-title">Suggestions from recent activity</span>
        </button>
        <button
          className="icon-btn"
          onClick={onRefresh}
          title="Refresh suggestions"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {isExpanded && (
        <div>
          {suggestions.length === 0 ? (
            <div className="suggestion-empty">No suggestions.</div>
          ) : (
            suggestions.map((suggestion) => (
              <div
                key={suggestion.id}
                className="suggestion-item"
                onClick={() => onSuggestionClick(suggestion)}
              >
                <div className="suggestion-text">{suggestion.text}</div>
                {suggestion.sub && (
                  <div className="suggestion-sub">{suggestion.sub}</div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
