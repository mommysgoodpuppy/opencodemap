/**
 * Smart Codemap Agent
 * 
 * Uses smart/system.md as system prompt without additional addons.
 */

import { generateCodemap, CodemapCallbacks } from './codemapAgent';
import type { Codemap } from '../types';

export type { CodemapCallbacks as SmartCodemapCallbacks };

export async function generateSmartCodemap(
  query: string,
  workspaceRoot: string,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal
): Promise<Codemap | null> {
  return generateCodemap(query, workspaceRoot, 'smart', callbacks, abortSignal);
}
