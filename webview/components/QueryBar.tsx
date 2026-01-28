import React, { useRef, useEffect } from 'react';
import { ModelInfo, DetailLevel } from '../types';
import { Settings2, Sliders } from 'lucide-react';

interface QueryBarProps {
  query: string;
  mode: 'fast' | 'smart';
  detailLevel: DetailLevel;
  isProcessing: boolean;
  onQueryChange: (query: string) => void;
  onModeChange: (mode: 'fast' | 'smart') => void;
  onDetailLevelChange: (detail: DetailLevel) => void;
  onSubmit: () => void;
  availableModels: ModelInfo[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  onCancel: () => void;
  onPickTools: () => void;
}

/**
 * Query input bar with mode toggle and submit button.
 * Textarea auto-resizes between 1-5 lines.
 */
export const QueryBar: React.FC<QueryBarProps> = ({
  query,
  mode,
  detailLevel,
  isProcessing,
  onQueryChange,
  onModeChange,
  onDetailLevelChange,
  onSubmit,
  availableModels,
  selectedModel,
  onSelectModel,
  onCancel,
  onPickTools,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea between 1-5 lines
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = 'auto';

    // Calculate line height (approximately 20px per line)
    const lineHeight = 20;
    const minHeight = lineHeight; // 1 line
    const maxHeight = lineHeight * 5; // 5 lines

    // Clamp between min and max
    const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${newHeight}px`;
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isProcessing && query.trim()) {
      e.preventDefault();
      onSubmit();
    }
  };

  const detailLevels: DetailLevel[] = ['overview', 'low', 'medium', 'high', 'ultra'];
  const currentDetailIndex = detailLevels.indexOf(detailLevel);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fresh = detailLevels[parseInt(e.target.value)];
    if (fresh) onDetailLevelChange(fresh);
  };

  return (
    <div className="query-bar">
      <textarea
        ref={textareaRef}
        className="query-input query-textarea"
        placeholder="Enter a starting point for a new codemap (Ctrl+Shift+G)"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={isProcessing}
        rows={1}
      />
      <div className="query-controls">
        {availableModels.length > 0 && (
          <div className="model-selector">
            <select
              value={selectedModel}
              onChange={(e) => onSelectModel(e.target.value)}
              disabled={isProcessing}
              className="model-select"
              title="Select AI Model"
            >
              <option value="" disabled>Select Model</option>
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.vendor && `[${m.vendor}] `}{m.name}{m.isFree ? ' (Free)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <button
          className="icon-btn tool-pick-btn"
          onClick={onPickTools}
          title="Enable/Disable VS Code Agent Tools"
          disabled={isProcessing}
        >
          <Settings2 size={16} />
        </button>

        <div className="detail-slider-container" title={`Detail Level: ${detailLevel.toUpperCase()}`}>
          <Sliders size={14} className="slider-icon" />
          <input
            type="range"
            min="0"
            max="4"
            step="1"
            value={currentDetailIndex}
            onChange={handleSliderChange}
            disabled={isProcessing}
            className="detail-slider"
          />
          <span className="detail-label">{detailLevel === 'overview' ? 'Overview' : detailLevel.toUpperCase()}</span>
        </div>

        <div className="mode-toggle">
          <button
            className={`mode-btn ${mode === 'fast' ? 'active' : ''}`}
            onClick={() => onModeChange('fast')}
            disabled={isProcessing}
            title="Fast mode: Quick exploration with fewer tool calls"
          >
            Fast
          </button>
          <button
            className={`mode-btn ${mode === 'smart' ? 'active' : ''}`}
            onClick={() => onModeChange('smart')}
            disabled={isProcessing}
            title="Smart mode: Deep exploration with more context"
          >
            Smart
          </button>
        </div>
        <button
          className="submit-btn"
          onClick={onSubmit}
          disabled={isProcessing || !query.trim()}
        >
          {isProcessing ? 'Generating...' : 'Generate'}
        </button>
      </div>
    </div>
  );
};
