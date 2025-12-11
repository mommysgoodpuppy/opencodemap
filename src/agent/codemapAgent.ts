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

import { generateText, CoreMessage } from 'ai';
import { getOpenAIClient, getModelName, isConfigured, getLanguage } from './baseClient';
import { loadPrompt, loadStagePrompt, loadTraceStagePrompt, loadMaximizeParallelToolCallsAddon, loadMermaidPrompt } from '../prompts';
import { allTools } from '../tools';
import type { Codemap } from '../types';
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
import * as logger from '../logger';

export interface CodemapCallbacks {
  onMessage?: (role: string, content: string) => void;
  onToolCall?: (tool: string, args: string, result: string) => void;
  onCodemapUpdate?: (codemap: Codemap) => void;
  onPhaseChange?: (phase: string, stageNumber: number) => void;
  onTraceProcessing?: (traceId: string, stage: number, status: 'start' | 'complete') => void;
}

export type CodemapMode = 'fast' | 'smart';

/**
 * Result from processing a single trace through stages 3-5
 */
interface TraceProcessingResult {
  traceId: string;
  diagram?: string;
  guide?: string;
  error?: string;
}

interface MermaidProcessingResult {
  diagram?: string;
  error?: string;
}

/**
 * Process a single trace through stages 3-5
 */
async function processTraceStages(
  traceId: string,
  systemPrompt: string,
  baseMessages: CoreMessage[],
  currentDate: string,
  language: string,
  callbacks: CodemapCallbacks = {}
): Promise<TraceProcessingResult> {
  logger.info(`[Trace ${traceId}] Starting trace processing (stages 3-5)`);
  
  const client = getOpenAIClient();
  if (!client) {
    logger.error(`[Trace ${traceId}] Failed to create OpenAI client`);
    return { traceId, error: 'Failed to create OpenAI client' };
  }

  const messages: CoreMessage[] = [...baseMessages];
  let diagram: string | undefined;
  let guide: string | undefined;

  try {
    // Stage 3: Generate trace text diagram
    logger.info(`[Trace ${traceId}] Stage 3: Starting - Generate trace text diagram`);
    callbacks.onTraceProcessing?.(traceId, 3, 'start');
    const stage3Prompt = loadTraceStagePrompt(3, traceId, { current_date: currentDate, language });
    logger.debug(`[Trace ${traceId}] Stage 3 prompt length: ${stage3Prompt.length}`);
    messages.push({ role: 'user', content: stage3Prompt });

    logger.info(`[Trace ${traceId}] Stage 3: Calling API...`);
    const stage3Result = await generateText({
      model: client(getModelName()),
      system: systemPrompt,
      messages,
    });
    logger.info(`[Trace ${traceId}] Stage 3: API response received, text length: ${stage3Result.text?.length || 0}`);

    if (stage3Result.text) {
      messages.push({ role: 'assistant', content: stage3Result.text });
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

    logger.info(`[Trace ${traceId}] Stage 4: Calling API...`);
    const stage4Result = await generateText({
      model: client(getModelName()),
      system: systemPrompt,
      messages,
    });
    logger.info(`[Trace ${traceId}] Stage 4: API response received, text length: ${stage4Result.text?.length || 0}`);

    if (stage4Result.text) {
      messages.push({ role: 'assistant', content: stage4Result.text });
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

    // Stage 5: Generate trace guide
    logger.info(`[Trace ${traceId}] Stage 5: Starting - Generate trace guide`);
    callbacks.onTraceProcessing?.(traceId, 5, 'start');
    const stage5Prompt = loadTraceStagePrompt(5, traceId, { current_date: currentDate, language });
    messages.push({ role: 'user', content: stage5Prompt });

    logger.info(`[Trace ${traceId}] Stage 5: Calling API...`);
    const stage5Result = await generateText({
      model: client(getModelName()),
      system: systemPrompt,
      messages,
    });
    logger.info(`[Trace ${traceId}] Stage 5: API response received, text length: ${stage5Result.text?.length || 0}`);

    if (stage5Result.text) {
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

    logger.info(`[Trace ${traceId}] Trace processing complete - diagram: ${!!diagram}, guide: ${!!guide}`);
    return { traceId, diagram, guide };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
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
  baseMessages: CoreMessage[],
  currentDate: string,
  language: string,
  callbacks: CodemapCallbacks = {}
): Promise<MermaidProcessingResult> {
  logger.info('[Mermaid] Starting mermaid diagram generation');

  const client = getOpenAIClient();
  if (!client) {
    logger.error('[Mermaid] Failed to create OpenAI client');
    return { error: 'Failed to create OpenAI client' };
  }

  const messages: CoreMessage[] = [...baseMessages];

  try {
    callbacks.onPhaseChange?.('Mermaid Diagram', 6);
    const mermaidPrompt = loadMermaidPrompt({ current_date: currentDate, language });
    logger.debug(`[Mermaid] Prompt length: ${mermaidPrompt.length}`);
    messages.push({ role: 'user', content: mermaidPrompt });
    callbacks.onMessage?.('user', '[Mermaid] Generating global mermaid diagram...');

    logger.info('[Mermaid] Calling API...');
    const mermaidResult = await generateText({
      model: client(getModelName()),
      system: systemPrompt,
      messages,
    });
    logger.info(`[Mermaid] API response received, text length: ${mermaidResult.text?.length || 0}`);

    if (!mermaidResult.text) {
      logger.warn('[Mermaid] No text in response');
      return { error: 'No text in mermaid response' };
    }

    const diagram = extractMermaidDiagram(mermaidResult.text) || undefined;
    callbacks.onMessage?.('assistant', '[Mermaid] Mermaid diagram generated');
    logger.info(`[Mermaid] Diagram extracted: ${diagram ? 'YES' : 'NO'}`);
    if (diagram) {
      logger.debug(`[Mermaid] Diagram length: ${diagram.length}`);
    }
    return { diagram };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`[Mermaid] Error during mermaid generation: ${errorMsg}`);
    return { error: errorMsg };
  }
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
  callbacks: CodemapCallbacks = {}
): Promise<Codemap | null> {
  logger.separator(`CODEMAP GENERATION START - ${mode.toUpperCase()} MODE`);
  logger.info(`Query: ${query}`);
  logger.info(`Workspace: ${workspaceRoot}`);
  logger.info(`Mode: ${mode}`);
  
  if (!isConfigured()) {
    logger.error('OpenAI API key not configured');
    throw new Error('OpenAI API key not configured');
  }

  const client = getOpenAIClient();
  if (!client) {
    logger.error('Failed to create OpenAI client');
    throw new Error('Failed to create OpenAI client');
  }
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

  const messages: CoreMessage[] = [];
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
    });
    logger.debug(`Stage 1 prompt length: ${stage1Prompt.length}`);
    
    messages.push({ role: 'user', content: stage1Prompt });
    callbacks.onMessage?.('user', `[Stage 1] Research query: ${query}`);

    let researchComplete = false;
    let researchIteration = 0;

    while (!researchComplete) {
      researchIteration++;
      logger.info(`Stage 1 - Research iteration ${researchIteration}`);
      logger.info(`Stage 1 - Calling API with ${messages.length} messages...`);
      
      const result = await generateText({
        model: client(getModelName()),
        system: systemPrompt,
        messages,
        tools: allTools,
        onStepFinish: (step) => {
          logger.debug(`Stage 1 - Step finished: text=${!!step.text}, toolCalls=${step.toolCalls?.length || 0}`);
          
          if (step.text) {
            callbacks.onMessage?.('assistant', step.text);
            if (isResearchComplete(step.text)) {
              logger.info('Stage 1 - Research completion detected in step');
              researchComplete = true;
            }
          }

          if (step.toolCalls) {
            for (const tc of step.toolCalls) {
              logger.info(`Stage 1 - Tool call: ${tc.toolName}`);
              logger.debug(`Stage 1 - Tool args: ${JSON.stringify(tc.args)}`);
              
              const toolResult = step.toolResults?.find(
                (r: { toolCallId: string }) => r.toolCallId === tc.toolCallId
              );
              if (toolResult) {
                logger.debug(`Stage 1 - Tool result length: ${String(toolResult.result).length}`);
              }
              callbacks.onToolCall?.(
                tc.toolName,
                JSON.stringify(tc.args, null, 2),
                toolResult ? String(toolResult.result).slice(0, 500) : ''
              );
            }
          }
        },
      });

      logger.info(`Stage 1 - API response received: steps=${result.steps.length}, text=${!!result.text}`);
      
      if (result.text) {
        logger.debug(`Stage 1 - Response text length: ${result.text.length}`);
        messages.push({ role: 'assistant', content: result.text });
        if (isResearchComplete(result.text)) {
          logger.info('Stage 1 - Research completion detected in final result');
          researchComplete = true;
        }
      }
      
      // If model didn't use any tools and gave a response, it's done researching
      if (result.steps.length === 1 && !result.steps[0].toolCalls?.length) {
        logger.info('Stage 1 - No tool calls in response, ending research');
        break;
      }
      
      // Safety check to prevent infinite loops
      if (researchIteration > 20) {
        logger.warn('Stage 1 - Max research iterations reached, breaking loop');
        break;
      }
    }
    logger.info(`Stage 1 - Research complete after ${researchIteration} iterations`);

    // ========== Stage 2: Generate Codemap Structure ==========
    logger.separator('STAGE 2: CODEMAP STRUCTURE');
    callbacks.onPhaseChange?.('Codemap Generation', 2);
    const stage2Prompt = loadStagePrompt(2, {
      query,
      current_date: currentDate,
      language,
    });
    logger.debug(`Stage 2 prompt length: ${stage2Prompt.length}`);
    
    messages.push({ role: 'user', content: stage2Prompt });
    callbacks.onMessage?.('user', `[Stage 2] Generating codemap structure...`);

    logger.info('Stage 2 - Calling API...');
    const stage2Result = await generateText({
      model: client(getModelName()),
      system: systemPrompt,
      messages,
    });
    logger.info(`Stage 2 - API response received: text=${!!stage2Result.text}`);

    if (stage2Result.text) {
      logger.debug(`Stage 2 - Response text length: ${stage2Result.text.length}`);
      messages.push({ role: 'assistant', content: stage2Result.text });
      callbacks.onMessage?.('assistant', stage2Result.text);
      
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
        mermaidPromise = processMermaidDiagram(
          systemPrompt,
          messages,
          currentDate,
          language,
          callbacks
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
          callbacks
        )
      );

      logger.info('Waiting for all trace processing to complete...');
      const mermaidRunner = mermaidPromise ?? Promise.resolve<MermaidProcessingResult | null>(null);
      const [traceResults, mermaidResult] = await Promise.all([
        Promise.all(tracePromises),
        mermaidRunner,
      ]);
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
            callbacks.onCodemapUpdate?.(resultCodemap);
          } else if (mermaidResult?.error) {
            logger.error(`[Mermaid] Mermaid generation failed: ${mermaidResult.error}`);
            callbacks.onMessage?.('error', `Mermaid diagram error: ${mermaidResult.error}`);
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

