/**
 * Fast Codemap Agent
 * 
 * Same as Smart Agent but with maximize_parallel_tool_calls addon in system prompt.
 */

import { generateCodemap, CodemapCallbacks } from './codemapAgent';
import type { Codemap } from '../types';

export type { CodemapCallbacks as FastCodemapCallbacks };

export async function generateFastCodemap(
  query: string,
  workspaceRoot: string,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal
): Promise<Codemap | null> {
  return generateCodemap(query, workspaceRoot, 'fast', callbacks, abortSignal);
}
