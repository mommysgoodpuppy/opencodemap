/**
 * Fast Codemap Agent
 * 
 * Same as Smart Agent but with maximize_parallel_tool_calls addon in system prompt.
 */

import { generateCodemap, CodemapCallbacks } from './codemapAgent';
import type { Codemap, DetailLevel } from '../types';

export type { CodemapCallbacks as FastCodemapCallbacks };

export async function generateFastCodemap(
  query: string,
  workspaceRoot: string,
  detailLevel?: DetailLevel,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal
): Promise<Codemap | null> {
  return generateCodemap(query, workspaceRoot, 'fast', detailLevel, callbacks, abortSignal);
}
