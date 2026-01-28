/**
 * Base AI client configuration for all agents
 */

import { createOpenAI } from '@ai-sdk/openai';
import { LanguageModelV1 } from 'ai';
import * as vscode from 'vscode';
import { createVSCodeLM } from './vscodeLM';

let cachedClient: ((modelName: string) => LanguageModelV1) | null = null;
let cachedConfig: { provider: string; apiKey: string; baseUrl: string } | null = null;

export function getAIClient(callbacks?: { onToken?: () => void }): ((modelName: string) => LanguageModelV1) | null {
  const config = vscode.workspace.getConfiguration('codemap');
  const provider = config.get<string>('provider') || 'openai';
  const apiKey = config.get<string>('openaiApiKey') || '';
  const baseUrl = config.get<string>('openaiBaseUrl') || 'https://api.openai.com/v1';

  let clientFactory: (modelName: string) => LanguageModelV1;

  if (provider === 'vscode') {
    clientFactory = (modelName: string) => {
      // If modelName looks like a JSON selector, use it
      try {
        if (modelName.startsWith('{')) {
          return createVSCodeLM(JSON.parse(modelName));
        }
      } catch (e) {}
      
      // Default selector based on model name
      if (modelName.includes('gpt-4')) {
        return createVSCodeLM({ family: 'gpt-4' });
      }
      return createVSCodeLM({ family: 'gpt-3.5-turbo' });
    };
  } else {
    if (!apiKey) {
      return null;
    }

    const openai = createOpenAI({
      apiKey,
      baseURL: baseUrl,
    });
    clientFactory = (modelName: string) => openai(modelName) as LanguageModelV1;
  }

  // Wrap the client to support onToken callback if provided
  return (modelName: string) => {
    const model = clientFactory(modelName);
    if (!callbacks?.onToken) {
      return model;
    }

    const onToken = callbacks.onToken;
    return {
      ...model,
      async doGenerate(options) {
        const streamResult = await model.doStream(options);
        const reader = streamResult.stream.getReader();

        let text = '';
        const toolCalls: any[] = [];
        let finishReason: any = 'stop';
        let usage = { promptTokens: 0, completionTokens: 0 };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            if (value.type === 'text-delta') {
              text += value.textDelta;
              onToken();
            } else if (value.type === 'tool-call') {
              toolCalls.push(value);
              onToken();
            } else if (value.type === 'finish') {
              finishReason = value.finishReason;
              if (value.usage) {
                usage = value.usage;
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        return {
          text: text || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason,
          usage,
          rawCall: streamResult.rawCall,
        };
      },
      async doStream(options) {
        const streamResult = await model.doStream(options);
        return {
          ...streamResult,
          stream: new ReadableStream({
            async start(controller) {
              const reader = streamResult.stream.getReader();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value.type === 'text-delta' || value.type === 'tool-call-delta' || value.type === 'tool-call') {
                    onToken();
                  }
                  controller.enqueue(value);
                }
              } catch (err) {
                controller.error(err);
              } finally {
                controller.close();
                reader.releaseLock();
              }
            }
          })
        };
      }
    } as LanguageModelV1;
  };
}

export function getModelName(): string {
  const config = vscode.workspace.getConfiguration('codemap');
  return config.get<string>('model') || 'gpt-4o';
}

export function getLanguage(): string {
  const config = vscode.workspace.getConfiguration('codemap');
  return config.get<string>('language') || 'English';
}

export function isConfigured(): boolean {
  const config = vscode.workspace.getConfiguration('codemap');
  const provider = config.get<string>('provider') || 'openai';
  if (provider === 'vscode') {
    return true; // Assume VS Code models are available if selected
  }
  return config.get<string>('openaiApiKey') !== '';
}

export function refreshConfig(): boolean {
  // Force re-read of config
  cachedClient = null;
  cachedConfig = null;
  return isConfigured();
}

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  vendor: string;
  isFree?: boolean;
}

export async function getAvailableModels(): Promise<ModelInfo[]> {
  const allModels: ModelInfo[] = [];

  // 1. Fetch VS Code models (Copilot, etc.)
  try {
    const vscodeModels = await vscode.lm.selectChatModels();
    allModels.push(...vscodeModels.map(m => ({
      id: `vscode:${JSON.stringify({ vendor: m.vendor, family: m.family, name: m.name, version: m.version })}`,
      name: m.name,
      family: m.family,
      vendor: m.vendor,
      isFree: m.name.toLowerCase().includes('free') || m.id.toLowerCase().includes('free')
    })));
  } catch (e) {
    console.error('Failed to fetch VS Code models:', e);
  }

  // 2. Add Standard OpenAI models
  allModels.push(
    { id: 'openai:gpt-4o', name: 'GPT-4o', family: 'gpt-4', vendor: 'openai' },
    { id: 'openai:gpt-4o-mini', name: 'GPT-4o Mini', family: 'gpt-4', vendor: 'openai', isFree: true },
    { id: 'openai:gpt-4-turbo', name: 'GPT-4 Turbo', family: 'gpt-4', vendor: 'openai' },
    { id: 'openai:gpt-3.5-turbo', name: 'GPT-3.5 Turbo', family: 'gpt-3.5-turbo', vendor: 'openai' },
  );

  return allModels;
}

export async function setModel(modelId: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('codemap');
  
  if (modelId.startsWith('vscode:')) {
    const actualId = modelId.substring(7);
    await config.update('provider', 'vscode', vscode.ConfigurationTarget.Global);
    await config.update('model', actualId, vscode.ConfigurationTarget.Global);
  } else if (modelId.startsWith('openai:')) {
    const actualId = modelId.substring(7);
    await config.update('provider', 'openai', vscode.ConfigurationTarget.Global);
    await config.update('model', actualId, vscode.ConfigurationTarget.Global);
  } else {
    // Legacy/fallback
    await config.update('model', modelId, vscode.ConfigurationTarget.Global);
  }
  
  refreshConfig();
}
