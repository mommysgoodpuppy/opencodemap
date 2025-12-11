/**
 * Base OpenAI client configuration for all agents
 */

import { createOpenAI } from '@ai-sdk/openai';
import * as vscode from 'vscode';

let cachedClient: ReturnType<typeof createOpenAI> | null = null;
let cachedConfig: { apiKey: string; baseUrl: string } | null = null;

export function getOpenAIClient(): ReturnType<typeof createOpenAI> | null {
  const config = vscode.workspace.getConfiguration('codemap');
  const apiKey = config.get<string>('openaiApiKey') || '';
  const baseUrl = config.get<string>('openaiBaseUrl') || 'https://api.openai.com/v1';

  if (!apiKey) {
    cachedClient = null;
    cachedConfig = null;
    return null;
  }

  // Return cached client if config hasn't changed
  if (cachedClient && cachedConfig?.apiKey === apiKey && cachedConfig?.baseUrl === baseUrl) {
    return cachedClient;
  }

  cachedClient = createOpenAI({
    apiKey,
    baseURL: baseUrl,
  });
  cachedConfig = { apiKey, baseUrl };

  return cachedClient;
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
  return getOpenAIClient() !== null;
}

export function refreshConfig(): boolean {
  // Force re-read of config
  cachedClient = null;
  cachedConfig = null;
  return isConfigured();
}
