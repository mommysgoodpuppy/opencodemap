/**
 * Core Codemap Agent - shared logic for both Fast and Smart modes
 * 
 * Flow:
 * 1. Stage 1: Research - explore codebase with tools
 * 2. Stage 2: Generate codemap structure with multiple traces
 * 3. Stage 3-5: For each trace in parallel, generate diagram and guide
 * 4. Aggregate all trace results into final codemap
 * 
 * The only difference between Fast and Smart modes is the system prompt:
 * - Fast: smart/system.md + maximize_parallel_tool_calls.md
 * - Smart: smart/system.md
 */

import { streamText, ModelMessage } from 'ai';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { getAIClient, getModelName, isConfigured, getLanguage } from './baseClient';
import { loadPrompt, loadStagePrompt, loadTraceStagePrompt, loadMaximizeParallelToolCallsAddon, loadMermaidPrompt } from '../prompts';
import { allTools } from '../tools';
import { getSelectedVsCodeTools } from '../tools/vscodeTools';
import { extensionContext } from '../extension';
import type { Codemap, DetailLevel } from '../types';
import {
  generateWorkspaceLayout,
  extractCodemapFromResponse,
  extractTraceDiagram,
  extractTraceGuide,
  extractMermaidDiagram,
  isResearchComplete,
  formatCurrentDate,
  getUserOs,
} from './utils';
import { colorizeMermaidDiagram } from './mermaidColorize';
import { validateMermaidDiagram } from './mermaidValidate';
import * as logger from '../logger';

export interface CodemapCallbacks {
  onMessage?: (role: string, content: string) => void;
  onToolCall?: (tool: string, args: string, result: string) => void;
  onParallelToolState?: (activeCount: number) => void;
  onCodemapUpdate?: (codemap: Codemap) => void;
  onPhaseChange?: (phase: string, stageNumber: number) => void;
  onTraceProcessing?: (traceId: string, stage: number, status: 'start' | 'complete') => void;
  /**
   * Fired once Stage 1 (research) and Stage 2 (structure) are complete enough to
   * run downstream stages (trace processing / mermaid). This is the "shared context"
   * the user wants persisted for retries.
   */
  onStage12ContextReady?: (context: CodemapStage12ContextV1) => void;
  onToken?: (deltaText: string) => void;
}

export type CodemapMode = 'fast' | 'smart';

/**
 * Serializable "shared context" captured after Stage 1 & Stage 2.
 * Used to retry later stages without re-running research/structure.
 */
export interface CodemapStage12ContextV1 {
  schemaVersion: 1;
  createdAt: string;
  query: string;
  mode: CodemapMode;
  detailLevel: DetailLevel;
  workspaceRoot: string;
  currentDate: string;
  language: string;
  systemPrompt: string;
  /**
   * The exact messages array passed as baseMessages to stages 3-6.
   * Keep it JSON-serializable (role + string content).
   */
  baseMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Result from processing a single trace through stages 3-5
 */
interface TraceProcessingResult {
  traceId: string;
  diagram?: string;
  guide?: string;
  error?: string;
}

/**
 * Options for trace processing
 */
interface TraceProcessingOptions {
  includeGuide?: boolean;  // Whether to execute Stage 5 to generate guide
  abortSignal?: AbortSignal;
}

interface MermaidProcessingResult {
  diagram?: string;
  error?: string;
}

function toCoreMessages(
  baseMessages: CodemapStage12ContextV1['baseMessages']
): ModelMessage[] {
  // ModelMessage supports richer shapes, but we only persist string content.
  return baseMessages.map((m) => ({ role: m.role, content: m.content }));
}

function logRequestPayload(stage: string, systemPrompt: string, messages: ModelMessage[]) {
  logger.agentRaw(`[${stage}] SYSTEM PROMPT:\n${systemPrompt}`);
  logger.agentRaw(`[${stage}] MESSAGES:\n${JSON.stringify(messages, null, 2)}`);
}

function normalizeToolArgs(args: unknown): unknown {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args;
}

function toToolResultOutput(value: unknown): ToolResultOutput {
  if (typeof value === 'string') {
    return { type: 'text', value };
  }
  if (value === undefined) {
    return { type: 'json', value: null };
  }
  try {
    return { type: 'json', value: JSON.parse(JSON.stringify(value)) as any };
  } catch {
    return { type: 'text', value: String(value) };
  }
}

async function runStreamedToolLoop(options: {
  label: string;
  systemPrompt: string;
  messages: ModelMessage[];
  tools?: Record<string, any>;
  client: NonNullable<ReturnType<typeof getAIClient>>;
  callbacks?: CodemapCallbacks;
  abortSignal?: AbortSignal;
  requireToolUse?: boolean;
  maxRounds?: number;
  maxOutputChars?: number;
  maxParallelTools?: number;
}): Promise<{ text?: string; usedTools: boolean }> {
  const {
    label,
    systemPrompt,
    messages,
    tools,
    client,
    callbacks,
    abortSignal,
    requireToolUse = false,
    maxRounds = 8,
    maxOutputChars = 400000,
    maxParallelTools = 4,
  } = options;

  let usedTools = false;
  let noToolRounds = 0;
  let totalChars = 0;
  const seenToolCalls = new Map<string, string>();
  let activeTools = 0;
  const waitQueue: Array<() => void> = [];

  const getListDirPath = (args: unknown): string | undefined => {
    if (!args || typeof args !== 'object') {
      return undefined;
    }
    const rec = args as Record<string, unknown>;
    if (Array.isArray(rec.directories) && rec.directories.length === 1) {
      const value = rec.directories[0];
      return typeof value === 'string' ? value : undefined;
    }
    const value = rec.DirectoryPath ?? rec.directory_path ?? rec.path;
    return typeof value === 'string' ? value : undefined;
  };

  for (let round = 1; round <= maxRounds; round++) {
    if (abortSignal?.aborted) throw new Error('Generation cancelled');

    logRequestPayload(`${label} Round ${round}`, systemPrompt, messages);
    const modelStreamStart = Date.now();
    let firstToolCallAt: number | null = null;
    let firstTextAt: number | null = null;
    const result = await streamText({
      model: client(getModelName()),
      system: systemPrompt,
      messages,
      tools: tools && Object.keys(tools).length > 0 ? tools : undefined,
      toolChoice: requireToolUse ? 'required' : 'auto',
      abortSignal,
    });

    let text = '';
    const toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
    const pending: Array<Promise<{ toolCallId: string; message: ModelMessage }>> = [];
    let sawToolCall = false;

    const acquire = async () => new Promise<void>((resolve) => {
      if (activeTools < maxParallelTools) {
        activeTools += 1;
        callbacks?.onParallelToolState?.(activeTools);
        resolve();
        return;
      }
      waitQueue.push(resolve);
    });

    const release = () => {
      activeTools = Math.max(0, activeTools - 1);
      callbacks?.onParallelToolState?.(activeTools);
      const next = waitQueue.shift();
      if (next) {
        activeTools += 1;
        callbacks?.onParallelToolState?.(activeTools);
        next();
      }
    };

    const runToolCall = async (call: { toolCallId: string; toolName: string; args: unknown }) => {
      const tool = tools?.[call.toolName];
      let resultValue: unknown;
      const normalizedArgs = normalizeToolArgs(call.args);
      const toolKey = `${call.toolName}:${JSON.stringify(normalizedArgs)}`;

      if (call.toolName === 'list_dir' && seenToolCalls.has(toolKey)) {
        const listPath = getListDirPath(normalizedArgs);
        resultValue = listPath
          ? `Skipped list_dir: already listed ${listPath}. Use grep_search or read_file.`
          : 'Skipped list_dir: already listed those directories. Use grep_search or read_file.';
      }

      if (resultValue === undefined && (!tool || typeof tool.execute !== 'function')) {
        resultValue = `Error: Tool not found: ${call.toolName}`;
      } else if (resultValue === undefined) {
        try {
          const toolStart = Date.now();
          resultValue = await tool.execute(normalizedArgs);
          const toolDuration = Date.now() - toolStart;
          logger.info(`[${label}] Tool ${call.toolName} completed in ${toolDuration}ms`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          resultValue = `Error executing tool "${call.toolName}": ${errorMsg}`;
        }
      }
      if (!seenToolCalls.has(toolKey)) {
        seenToolCalls.set(toolKey, call.toolName);
      }

      const argsText = typeof normalizedArgs === 'string'
        ? normalizedArgs
        : JSON.stringify(normalizedArgs, null, 2);
      const resultText = typeof resultValue === 'string'
        ? resultValue
        : JSON.stringify(resultValue, null, 2);
      callbacks?.onToolCall?.(call.toolName, argsText, resultText.slice(0, 500));

      return {
        role: 'tool' as const,
        content: [{
          type: 'tool-result' as const,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: toToolResultOutput(resultValue),
        }],
      };
    };

    for await (const part of result.fullStream) {
      if (abortSignal?.aborted) throw new Error('Generation cancelled');
      if (part.type === 'text-delta') {
        if (sawToolCall) {
          // If the model starts emitting text after tool calls, stop early.
          break;
        }
        if (!firstTextAt) {
          firstTextAt = Date.now();
        }
        text += part.text;
        totalChars += part.text.length;
        callbacks?.onToken?.(part.text);
      } else if (part.type === 'tool-call') {
        sawToolCall = true;
        if (!firstToolCallAt) {
          firstToolCallAt = Date.now();
        }
        const maybeBatch = part.input && typeof part.input === 'object'
          ? (part.input as { toolCalls?: Array<{ toolName: string; args?: unknown }> }).toolCalls
          : undefined;
        const emittedCalls = Array.isArray(maybeBatch)
          ? maybeBatch.map((c, idx) => ({
              toolCallId: `${part.toolCallId}:${idx}`,
              toolName: c.toolName,
              args: c.args ?? {},
            }))
          : [{
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.input,
            }];
        for (const call of emittedCalls) {
          toolCalls.push(call);
          const promise = (async () => {
            await acquire();
            try {
              const message = await runToolCall(call);
              return { toolCallId: call.toolCallId, message };
            } finally {
              release();
            }
          })();
          pending.push(promise);
        }
      }
      if (totalChars > maxOutputChars) {
        throw new Error(`Output budget reached (${maxOutputChars} chars) in ${label}`);
      }
    }
    const modelStreamEnd = Date.now();
    const modelStreamMs = modelStreamEnd - modelStreamStart;
    const toolDelayMs = firstToolCallAt ? firstToolCallAt - modelStreamStart : null;
    const textDelayMs = firstTextAt ? firstTextAt - modelStreamStart : null;
    const delayInfo = [
      toolDelayMs !== null ? `firstToolCall=${toolDelayMs}ms` : null,
      textDelayMs !== null ? `firstText=${textDelayMs}ms` : null,
    ].filter(Boolean).join(', ');
    logger.info(
      `[${label} Round ${round}] Model stream completed in ${modelStreamMs}ms` +
        (delayInfo ? ` (${delayInfo})` : '')
    );

    if (text.length > 0) {
      messages.push({ role: 'assistant', content: text });
      callbacks?.onMessage?.('assistant', text);
    }

    if (toolCalls.length === 0) {
      if (requireToolUse && !usedTools) {
        noToolRounds++;
        messages.push({
          role: 'system',
          content:
            'You must use the provided tools. Do not describe tool calls in text. Emit actual tool calls using the tool calling mechanism.',
        });
        if (noToolRounds < 3) {
          continue;
        }
      }
      return { text, usedTools };
    }

    usedTools = true;
    const resolved = await Promise.all(pending);
    const messageById = new Map<string, ModelMessage>();
    for (const entry of resolved) {
      messageById.set(entry.toolCallId, entry.message);
    }
    for (const call of toolCalls) {
      const message = messageById.get(call.toolCallId);
      if (message) {
        messages.push(message);
      }
    }
  }

  return { text: undefined, usedTools };
}

/**
 * Process a single trace through stages 3-5 (or 3-4 if includeGuide is false)
 */
async function processTraceStages(
  traceId: string,
  systemPrompt: string,
  baseMessages: ModelMessage[],
  currentDate: string,
  language: string,
  callbacks: CodemapCallbacks = {},
  options: TraceProcessingOptions = { includeGuide: true }
): Promise<TraceProcessingResult> {
  const stagesDescription = options.includeGuide ? 'stages 3-5' : 'stages 3-4';
  const client = getAIClient({ onToken: callbacks.onToken })!;

  const messages: ModelMessage[] = [...baseMessages];
  let diagram: string | undefined;
  let guide: string | undefined;

  try {
    // Stage 3: Generate trace text diagram
    logger.info(`[Trace ${traceId}] Stage 3: Starting - Generate trace text diagram`);
    callbacks.onTraceProcessing?.(traceId, 3, 'start');
    const stage3Prompt = loadTraceStagePrompt(3, traceId, { current_date: currentDate, language });
    logger.debug(`[Trace ${traceId}] Stage 3 prompt length: ${stage3Prompt.length}`);
    messages.push({ role: 'user', content: stage3Prompt });

    if (options.abortSignal?.aborted) throw new Error('Generation cancelled');

    logger.info(`[Trace ${traceId}] Stage 3: Calling API...`);
    const stage3Result = await runStreamedToolLoop({
      label: `Trace ${traceId} Stage 3`,
      systemPrompt,
      messages,
      client,
      callbacks,
      abortSignal: options.abortSignal,
      maxParallelTools: 4,
    });
    logger.info(`[Trace ${traceId}] Stage 3: API response received, text length: ${stage3Result.text?.length || 0}`);

    if (stage3Result.text) {
      logger.agentRaw(`[Trace ${traceId} Stage 3] RESPONSE:\n${stage3Result.text}`);
      callbacks.onMessage?.('assistant', `[Trace ${traceId} Stage 3] Generated initial diagram`);
    } else {
      logger.warn(`[Trace ${traceId}] Stage 3: No text in response`);
    }
    callbacks.onTraceProcessing?.(traceId, 3, 'complete');
    logger.info(`[Trace ${traceId}] Stage 3: Complete`);

    // Stage 4: Add location decorations to diagram
    logger.info(`[Trace ${traceId}] Stage 4: Starting - Add location decorations`);
    callbacks.onTraceProcessing?.(traceId, 4, 'start');
    const stage4Prompt = loadTraceStagePrompt(4, traceId, { current_date: currentDate, language });
    messages.push({ role: 'user', content: stage4Prompt });

    if (options.abortSignal?.aborted) throw new Error('Generation cancelled');

    logger.info(`[Trace ${traceId}] Stage 4: Calling API...`);
    const stage4Result = await runStreamedToolLoop({
      label: `Trace ${traceId} Stage 4`,
      systemPrompt,
      messages,
      client,
      callbacks,
      abortSignal: options.abortSignal,
      maxParallelTools: 4,
    });
    logger.info(`[Trace ${traceId}] Stage 4: API response received, text length: ${stage4Result.text?.length || 0}`);

    if (stage4Result.text) {
      logger.agentRaw(`[Trace ${traceId} Stage 4] RESPONSE:\n${stage4Result.text}`);
      diagram = extractTraceDiagram(stage4Result.text) || undefined;
      logger.info(`[Trace ${traceId}] Stage 4: Diagram extracted: ${diagram ? 'YES' : 'NO'}`);
      if (diagram) {
        logger.debug(`[Trace ${traceId}] Stage 4: Diagram length: ${diagram.length}`);
      }
      callbacks.onMessage?.('assistant', `[Trace ${traceId} Stage 4] Added location decorations`);
    } else {
      logger.warn(`[Trace ${traceId}] Stage 4: No text in response`);
    }
    callbacks.onTraceProcessing?.(traceId, 4, 'complete');
    logger.info(`[Trace ${traceId}] Stage 4: Complete`);

    // Stage 5: Generate trace guide (only if includeGuide is true)
    if (options.includeGuide) {
      logger.info(`[Trace ${traceId}] Stage 5: Starting - Generate trace guide`);
      callbacks.onTraceProcessing?.(traceId, 5, 'start');
      const stage5Prompt = loadTraceStagePrompt(5, traceId, { current_date: currentDate, language });
      messages.push({ role: 'user', content: stage5Prompt });

      if (options.abortSignal?.aborted) throw new Error('Generation cancelled');

      logger.info(`[Trace ${traceId}] Stage 5: Calling API...`);
      const stage5Result = await runStreamedToolLoop({
        label: `Trace ${traceId} Stage 5`,
        systemPrompt,
        messages,
        client,
        callbacks,
        abortSignal: options.abortSignal,
        maxParallelTools: 4,
      });
      logger.info(`[Trace ${traceId}] Stage 5: API response received, text length: ${stage5Result.text?.length || 0}`);

      if (stage5Result.text) {
        logger.agentRaw(`[Trace ${traceId} Stage 5] RESPONSE:\n${stage5Result.text}`);
        guide = extractTraceGuide(stage5Result.text) || undefined;
        logger.info(`[Trace ${traceId}] Stage 5: Guide extracted: ${guide ? 'YES' : 'NO'}`);
        if (guide) {
          logger.debug(`[Trace ${traceId}] Stage 5: Guide length: ${guide.length}`);
        }
        callbacks.onMessage?.('assistant', `[Trace ${traceId} Stage 5] Generated guide`);
      } else {
        logger.warn(`[Trace ${traceId}] Stage 5: No text in response`);
      }
      callbacks.onTraceProcessing?.(traceId, 5, 'complete');
      logger.info(`[Trace ${traceId}] Stage 5: Complete`);
    }

    return { traceId, diagram, guide };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (options.abortSignal?.aborted || errorMsg.includes('cancelled') || errorMsg.includes('aborted')) {
      logger.info(`[Trace ${traceId}] Trace processing cancelled`);
      throw error;
    }
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error(`[Trace ${traceId}] Error during trace processing: ${errorMsg}`);
    if (errorStack) {
      logger.error(`[Trace ${traceId}] Stack trace: ${errorStack}`);
    }
    return { traceId, error: errorMsg };
  }
}


/**
 * Generate a global mermaid diagram using the mermaid prompt
 */
async function processMermaidDiagram(
  systemPrompt: string,
  baseMessages: ModelMessage[],
  currentDate: string,
  language: string,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal
): Promise<MermaidProcessingResult> {
  logger.info('[Mermaid] Starting mermaid diagram generation');

  const client = getAIClient({ onToken: callbacks.onToken })!;

  const messages: ModelMessage[] = [...baseMessages];
  const maxAttempts = 8;
  let lastError: string | null = null;
  let lastDiagram: string | undefined;

  try {
    callbacks.onPhaseChange?.('Mermaid Diagram', 6);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isFirstAttempt = attempt === 1;
      const prompt = isFirstAttempt
        ? loadMermaidPrompt({ current_date: currentDate, language })
        : buildMermaidFixPrompt(lastError ?? 'Unknown parse error', lastDiagram ?? '');

      logger.debug(`[Mermaid] Prompt length (attempt ${attempt}/${maxAttempts}): ${prompt.length}`);
      messages.push({ role: 'user', content: prompt });
      callbacks.onMessage?.(
        'user',
        isFirstAttempt
          ? '[Mermaid] Generating global mermaid diagram...'
          : `[Mermaid] Fixing diagram (attempt ${attempt}/${maxAttempts})...`
      );

      if (abortSignal?.aborted) throw new Error('Generation cancelled');

      logger.info(`[Mermaid] Calling API (attempt ${attempt}/${maxAttempts})...`);
      const mermaidResult = await runStreamedToolLoop({
        label: `[Mermaid] Attempt ${attempt}`,
        systemPrompt,
        messages,
        client,
        callbacks,
        abortSignal,
        maxRounds: 1,
        maxParallelTools: 4,
      });
      logger.info(`[Mermaid] API response received, text length: ${mermaidResult.text?.length || 0}`);

      if (!mermaidResult.text) {
        logger.warn('[Mermaid] No text in response');
        lastError = 'No text in mermaid response';
        continue;
      }

      logger.agentRaw(`[Mermaid Stage 6 Attempt ${attempt}] RESPONSE:\n${mermaidResult.text}`);

      const extracted = extractMermaidDiagram(mermaidResult.text) || undefined;
      if (!extracted) {
        lastError = 'No mermaid code block found in response';
        logger.warn(`[Mermaid] ${lastError}`);
        continue;
      }

      const validation = await validateMermaidDiagram(extracted);
      if (!validation.ok) {
        lastError = validation.error || 'Mermaid parse error';
        lastDiagram = extracted;
        callbacks.onMessage?.('error', `[Mermaid] Parse error: ${lastError}`);
        logger.warn(`[Mermaid] Parse error on attempt ${attempt}: ${lastError}`);
        continue;
      }

      const diagram = colorizeMermaidDiagram(extracted);
      callbacks.onMessage?.('assistant', '[Mermaid] Mermaid diagram generated');
      logger.info(`[Mermaid] Diagram extracted: YES (attempt ${attempt})`);
      logger.debug(`[Mermaid] Diagram length: ${diagram.length}`);
      return { diagram };
    }

    return { error: `Mermaid diagram failed to compile after ${maxAttempts} attempts: ${lastError || 'Unknown error'}` };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (abortSignal?.aborted || errorMsg.includes('cancelled') || errorMsg.includes('aborted')) {
      logger.info('[Mermaid] Mermaid generation cancelled');
      throw error;
    }
    logger.error(`[Mermaid] Error during mermaid generation: ${errorMsg}`);
    return { error: errorMsg };
  }
}

function buildMermaidFixPrompt(errorMessage: string, diagram: string): string {
  const hasDiagram = diagram.trim().length > 0;
  return (
    `The Mermaid diagram you produced failed to parse. Fix it so it compiles.\n\n` +
    `Requirements:\n` +
    `- Output ONLY a single \`\`\`mermaid code block, no other text.\n` +
    `- Do not include XML tags or analysis text (e.g., <thinking>, <BRAINSTORMING>).\n` +
    `- Keep the diagram structure and labels, change only what is needed to fix parsing.\n` +
    `- Avoid reserved keywords as node IDs: end, subgraph, graph, flowchart.\n` +
    `- For subgraphs, use explicit IDs like: subgraph id [Label].\n\n` +
    `Parse error:\n${errorMessage}\n\n` +
    (hasDiagram
      ? `Current diagram:\n` +
        '```mermaid\n' +
        `${diagram}\n` +
        '```\n'
      : `No valid diagram was extracted. Generate a fresh, valid Mermaid diagram using the existing context.\n`)
  );
}

/**
 * Build system prompt based on mode
 */
function buildSystemPrompt(mode: CodemapMode, variables: Record<string, string>): string {
  const baseSystemPrompt = loadPrompt('smart', 'system', variables);
  
  if (mode === 'fast') {
    const parallelAddon = loadMaximizeParallelToolCallsAddon();
    return `${baseSystemPrompt}\n\n${parallelAddon}`;
  }
  
  return baseSystemPrompt;
}

/**
 * Generate codemap with specified mode
 */
export async function generateCodemap(
  query: string,
  workspaceRoot: string,
  mode: CodemapMode,
  detailLevel: DetailLevel = 'overview',
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal
): Promise<Codemap | null> {
  logger.separator(`CODEMAP GENERATION START - ${mode.toUpperCase()} MODE`);
  logger.info(`Query: ${query}`);
  logger.info(`Workspace: ${workspaceRoot}`);
  logger.info(`Mode: ${mode}`);
  logger.info(`Detail Level: ${detailLevel}`);
  
  if (!isConfigured()) {
    logger.error('OpenAI API key not configured');
    throw new Error('OpenAI API key not configured');
  }

  const client = getAIClient({ onToken: callbacks.onToken })!;
  logger.info('OpenAI client created successfully');

  // Prepare template variables
  logger.info('Preparing template variables...');
  const workspaceLayout = generateWorkspaceLayout(workspaceRoot);
  const workspaceUri = workspaceRoot.replace(/\\/g, '\\\\');
  const corpusName = workspaceRoot.replace(/\\/g, '/');
  const currentDate = formatCurrentDate();
  logger.debug(`Workspace layout length: ${workspaceLayout.length}`);
  logger.debug(`Current date: ${currentDate}`);

  // Build system prompt based on mode
  logger.info('Building system prompt...');
  const language = getLanguage();
  const systemPrompt = buildSystemPrompt(mode, {
    workspace_root: workspaceRoot,
    workspace_layout: workspaceLayout,
    workspace_uri: workspaceUri,
    corpus_name: corpusName,
    user_os: getUserOs(),
    language,
  });
  logger.debug(`System prompt length: ${systemPrompt.length}`);
  logger.agentRaw(`[System Prompt] ${mode.toUpperCase()} MODE:\n${systemPrompt}`);

  const messages: ModelMessage[] = [];
  let resultCodemap: Codemap | null = null;
  let mermaidPromise: Promise<MermaidProcessingResult | null> | null = null;
  
  callbacks.onMessage?.('system', `Starting ${mode} codemap generation...`);

  try {
    // ========== Stage 1: Research ==========
    logger.separator('STAGE 1: RESEARCH');
    callbacks.onPhaseChange?.('Research', 1);
    const stage1Prompt = loadStagePrompt(1, {
      query,
      current_date: currentDate,
      language,
      detail_level: detailLevel === 'overview' ? '' : `Please be very thorough and exhaustive. Aim for a high level of detail (level: ${detailLevel}).`,
    });
    logger.debug(`Stage 1 prompt length: ${stage1Prompt.length}`);
    
    messages.push({ role: 'user', content: stage1Prompt });
    callbacks.onMessage?.('user', `[Stage 1] Research query: ${query}`);

    const vsCodeTools = extensionContext ? getSelectedVsCodeTools(extensionContext) : {};
    const dynamicTools = { ...allTools, ...vsCodeTools };

    logger.info('Stage 1 - Calling API with streaming tool loop...');
    const stage1Result = await runStreamedToolLoop({
      label: 'Stage 1 Research',
      systemPrompt,
      messages,
      tools: dynamicTools,
      client,
      callbacks,
      abortSignal,
      requireToolUse: true,
      maxRounds: 12,
      maxParallelTools: mode === 'fast' ? 6 : 4,
    });
    if (stage1Result.text) {
      logger.agentRaw(`[Stage 1 Research] RESPONSE:\n${stage1Result.text}`);
      logger.debug(`Stage 1 - Response text length: ${stage1Result.text.length}`);
      if (!isResearchComplete(stage1Result.text)) {
        logger.warn('Stage 1 - Research did not emit completion marker');
      }
    } else {
      logger.warn('Stage 1 - No text in response');
    }
    if (!stage1Result.usedTools) {
      throw new Error('Stage 1 failed to use tools; aborting before Stage 2');
    }
    logger.info('Stage 1 - Research complete');

    // ========== Stage 2: Generate Codemap Structure ==========
    logger.separator('STAGE 2: CODEMAP STRUCTURE');
    callbacks.onPhaseChange?.('Codemap Generation', 2);
    const stage2Prompt = loadStagePrompt(2, {
      query,
      current_date: currentDate,
      language,
      detail_instruction: getDetailInstruction(detailLevel),
    });
    logger.debug(`Stage 2 prompt length: ${stage2Prompt.length}`);
    
    messages.push({ role: 'user', content: stage2Prompt });
    callbacks.onMessage?.('user', `[Stage 2] Generating codemap structure...`);

    if (abortSignal?.aborted) throw new Error('Generation cancelled');

    logger.info('Stage 2 - Calling API...');
    const stage2Result = await runStreamedToolLoop({
      label: 'Stage 2 Structure',
      systemPrompt,
      messages,
      client,
      callbacks,
      abortSignal,
      maxRounds: 1,
      maxParallelTools: mode === 'fast' ? 6 : 4,
    });
    logger.info(`Stage 2 - API response received: text=${!!stage2Result.text}`);

    if (stage2Result.text) {
      logger.agentRaw(`[Stage 2 Structure] RESPONSE:\n${stage2Result.text}`);
      logger.debug(`Stage 2 - Response text length: ${stage2Result.text.length}`);
      
      logger.info('Stage 2 - Extracting codemap from response...');
      const extracted = extractCodemapFromResponse(stage2Result.text);
      if (extracted) {
        resultCodemap = extracted;
        logger.info(`Stage 2 - Codemap extracted successfully: ${resultCodemap.traces.length} traces`);
        logger.debug(`Stage 2 - Codemap title: ${resultCodemap.title}`);
        for (const trace of resultCodemap.traces) {
          logger.debug(`Stage 2 - Trace ${trace.id}: ${trace.title} (${trace.locations.length} locations)`);
        }
        callbacks.onCodemapUpdate?.(resultCodemap);
        callbacks.onMessage?.('system', `Codemap structure generated with ${resultCodemap.traces.length} traces`);

        // Persist stage 1-2 shared context for retries (before we fork into downstream stages).
        try {
          callbacks.onStage12ContextReady?.({
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            query,
            mode,
            detailLevel,
            workspaceRoot,
            currentDate,
            language,
            systemPrompt,
            baseMessages: messages.map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: String(m.content),
            })),
          });
        } catch (e) {
          logger.warn(`Failed to emit stage12 context: ${e instanceof Error ? e.message : String(e)}`);
        }

        mermaidPromise = processMermaidDiagram(
          systemPrompt,
          messages,
          currentDate,
          language,
          callbacks,
          abortSignal
        );
      } else {
        logger.error('Stage 2 - FAILED to extract codemap from response!');
        logger.error(`Stage 2 - Response preview: ${stage2Result.text.slice(0, 500)}...`);
      }
    } else {
      logger.error('Stage 2 - No text in API response!');
    }

    // ========== Stage 3-5: Parallel Trace Processing ==========
    if (resultCodemap && resultCodemap.traces.length > 0) {
      logger.separator('STAGE 3-5: TRACE PROCESSING');
      callbacks.onPhaseChange?.('Trace Processing', 3);
      callbacks.onMessage?.('system', `Processing ${resultCodemap.traces.length} traces in parallel...`);
      logger.info(`Starting parallel processing of ${resultCodemap.traces.length} traces`);

      const tracePromises = resultCodemap.traces.map(trace =>
        processTraceStages(
          trace.id,
          systemPrompt,
          messages,
          currentDate,
          language,
          callbacks,
          { abortSignal }
        )
      );

      logger.info('Waiting for all trace processing to complete...');
      const mermaidRunner = mermaidPromise ?? Promise.resolve<MermaidProcessingResult | null>(null);
      
      if (abortSignal?.aborted) throw new Error('Generation cancelled');

      const [traceResults, mermaidResult] = await Promise.all([
        Promise.all(tracePromises),
        mermaidRunner,
      ]);
      
      if (abortSignal?.aborted) throw new Error('Generation cancelled');
      
      logger.info(`All ${traceResults.length} traces processed`);

      let successCount = 0;
      let errorCount = 0;
      for (const result of traceResults) {
        if (result.error) {
          errorCount++;
          logger.error(`Trace ${result.traceId} failed: ${result.error}`);
          callbacks.onMessage?.('error', `Error processing trace ${result.traceId}: ${result.error}`);
          continue;
        }

        successCount++;
        const trace = resultCodemap.traces.find(t => t.id === result.traceId);
        if (trace) {
          if (result.diagram) {
            trace.traceTextDiagram = result.diagram;
            logger.info(`Trace ${result.traceId}: Diagram added (${result.diagram.length} chars)`);
          }
          if (result.guide) {
            trace.traceGuide = result.guide;
            logger.info(`Trace ${result.traceId}: Guide added (${result.guide.length} chars)`);
          }
        }
      }
      
      logger.info(`Trace processing complete: ${successCount} success, ${errorCount} errors`);

      if (mermaidResult) {
        if (mermaidResult.error) {
          logger.error(`[Mermaid] Mermaid generation failed: ${mermaidResult.error}`);
          callbacks.onMessage?.('error', `Mermaid diagram error: ${mermaidResult.error}`);
          throw new Error(`Mermaid diagram failed to compile: ${mermaidResult.error}`);
        } else if (mermaidResult.diagram) {
          resultCodemap.mermaidDiagram = mermaidResult.diagram;
          logger.info(`[Mermaid] Diagram stored (${mermaidResult.diagram.length} chars)`);
          callbacks.onMessage?.('assistant', '[Mermaid] Diagram saved to codemap');
        }
      }

      callbacks.onCodemapUpdate?.(resultCodemap);
    } else {
      if (!resultCodemap) {
        logger.warn('No codemap was generated - skipping trace processing');
      } else {
        logger.warn('Codemap has no traces - skipping trace processing');
        if (mermaidPromise) {
          const mermaidResult = await mermaidPromise;
          if (mermaidResult?.diagram) {
            resultCodemap.mermaidDiagram = mermaidResult.diagram;
            logger.info(`[Mermaid] Diagram stored (${mermaidResult.diagram.length} chars)`);
            callbacks.onMessage?.('assistant', '[Mermaid] Diagram saved to codemap');
          } else if (mermaidResult?.error) {
            logger.error(`[Mermaid] Mermaid generation failed: ${mermaidResult.error}`);
            callbacks.onMessage?.('error', `Mermaid diagram error: ${mermaidResult.error}`);
            throw new Error(`Mermaid diagram failed to compile: ${mermaidResult.error}`);
          }
        }
      }
    }

    logger.separator('CODEMAP GENERATION COMPLETE');
    logger.info(`Final codemap: ${resultCodemap ? 'SUCCESS' : 'NULL'}`);
    if (resultCodemap) {
      logger.info(`Final codemap title: ${resultCodemap.title}`);
      logger.info(`Final codemap traces: ${resultCodemap.traces.length}`);
    }
    
    callbacks.onMessage?.('system', 'Codemap generation complete.');
    return resultCodemap;
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.separator('CODEMAP GENERATION ERROR');
    logger.error(`Error: ${errorMsg}`);
    if (errorStack) {
      logger.error(`Stack trace: ${errorStack}`);
    }
    callbacks.onMessage?.('error', `Error: ${errorMsg}`);
    throw error;
  }
}

/**
 * Retry a single trace (stages 3-5) using a saved Stage 1-2 context.
 */
export async function retryTraceFromStage12Context(
  traceId: string,
  context: CodemapStage12ContextV1,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal
): Promise<{ diagram?: string; guide?: string; error?: string }> {
  const baseMessages = toCoreMessages(context.baseMessages);
  const result = await processTraceStages(
    traceId,
    context.systemPrompt,
    baseMessages,
    context.currentDate,
    context.language,
    callbacks,
    { abortSignal }
  );
  return { diagram: result.diagram, guide: result.guide, error: result.error };
}

/**
 * Retry trace diagram only (stages 3-4) using a saved Stage 1-2 context.
 */
export async function retryTraceDiagramFromStage12Context(
  traceId: string,
  context: CodemapStage12ContextV1,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal
): Promise<{ diagram?: string; error?: string }> {
  const baseMessages = toCoreMessages(context.baseMessages);
  const result = await processTraceStages(
    traceId,
    context.systemPrompt,
    baseMessages,
    context.currentDate,
    context.language,
    callbacks,
    { includeGuide: false, abortSignal }
  );
  return { diagram: result.diagram, error: result.error };
}

/**
 * Retry global Mermaid diagram (stage 6) using a saved Stage 1-2 context.
 */
export async function retryMermaidFromStage12Context(
  context: CodemapStage12ContextV1,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal
): Promise<{ diagram?: string; error?: string }> {
  const baseMessages = toCoreMessages(context.baseMessages);
  const result = await processMermaidDiagram(
    context.systemPrompt,
    baseMessages,
    context.currentDate,
    context.language,
    callbacks,
    abortSignal
  );
  return { diagram: result.diagram, error: result.error };
}

/**
 * Generate a Mermaid diagram from an existing codemap snapshot (no Stage 1-2 context).
 * This is used when older codemap files don't have `stage12Context` persisted.
 */
export async function generateMermaidFromCodemapSnapshot(
  codemap: Codemap,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal
): Promise<{ diagram?: string; error?: string }> {
  try {
    const workspaceRoot = codemap.workspacePath || '';
    const currentDate = formatCurrentDate();
    const language = getLanguage();

    const workspaceLayout = workspaceRoot ? generateWorkspaceLayout(workspaceRoot) : '';
    const workspaceUri = workspaceRoot.replace(/\\/g, '\\\\');
    const corpusName = workspaceRoot.replace(/\\/g, '/');

    const systemPrompt = buildSystemPrompt(codemap.mode === 'fast' ? 'fast' : 'smart', {
      workspace_root: workspaceRoot,
      workspace_layout: workspaceLayout,
      workspace_uri: workspaceUri,
      corpus_name: corpusName,
      user_os: getUserOs(),
      language,
    });

    // Provide a structured snapshot as base context so stage 6 can draw the global diagram.
    const snapshot = JSON.stringify(
      {
        title: codemap.title,
        description: codemap.description,
        traces: codemap.traces,
      },
      null,
      2
    );

    const baseMessages: ModelMessage[] = [
      {
        role: 'user',
        content:
          `Here is the codemap snapshot as JSON. Use it as the source of truth.\n\n` +
          `\`\`\`json\n${snapshot}\n\`\`\``,
      },
    ];

    const result = await processMermaidDiagram(
      systemPrompt,
      baseMessages,
      currentDate,
      language,
      callbacks,
      abortSignal
    );

    return { diagram: result.diagram, error: result.error };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { error: msg };
  }
}

function getDetailInstruction(level: DetailLevel): string {
  switch (level) {
    case 'low':
      return 'The resulting codemap should be detailed, containing at least 10 nodes/locations across all traces combined.';
    case 'medium':
      return 'The resulting codemap should be very detailed, containing at least 30 nodes/locations across all traces combined.';
    case 'high':
      return 'The resulting codemap should be extremely detailed, containing at least 60 nodes/locations across all traces combined.';
    case 'ultra':
      return 'The resulting codemap MUST be massive and exhaustive (ULTRA detail). Aim for a minimum of 100 nodes/locations across all traces combined. Break down every significant component and interaction.';
    case 'overview':
    default:
      return '';
  }
}

