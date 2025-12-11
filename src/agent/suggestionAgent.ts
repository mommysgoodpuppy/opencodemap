/**
 * Suggestion Agent - generates codemap suggestions based on recent activity
 */

import { generateText } from 'ai';
import { getOpenAIClient, getModelName, isConfigured, getLanguage } from './baseClient';
import { loadPrompt } from '../prompts';
import type { CodemapSuggestion } from '../types';

interface SuggestionResponse {
  title: string;
  subtitle: string;
  starting_points: string[];
}

export async function generateSuggestions(
  recentFiles: string[]
): Promise<CodemapSuggestion[]> {
  if (!isConfigured()) {
    return [];
  }

  const client = getOpenAIClient();
  if (!client) {
    return [];
  }

  // Load user prompt with recent files - no system prompt for this agent
  const userPrompt = loadPrompt('suggestion', 'user', {
    recent_files: recentFiles.map((f, i) => `${i + 1}. ${f}`).join('\n'),
    language: getLanguage(),
  });

  try {
    const result = await generateText({
      model: client(getModelName()),
      prompt: userPrompt,
      maxTokens: 500,
    });

    // Parse JSON from response
    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const suggestions = JSON.parse(jsonMatch[0]) as SuggestionResponse[];
      // Take at most 3 suggestions
      return suggestions.slice(0, 3).map((s, i) => ({
        id: `suggestion-${i}`,
        text: s.title,
        sub: s.subtitle,
        startingPoints: s.starting_points,
        timestamp: Date.now(),
      }));
    }

    return [];
  } catch (error) {
    console.error('Failed to generate suggestions:', error);
    return [];
  }
}
