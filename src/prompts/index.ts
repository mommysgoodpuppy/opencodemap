/**
 * Prompt Template System
 * 
 * Loads prompt templates from markdown files and handles variable substitution.
 * Templates use {{ variable_name }} syntax for placeholders.
 */

import * as fs from 'fs';
import * as path from 'path';

// Template types
export type PromptType = 'suggestion' | 'fast' | 'smart';
export type PromptRole = 'system' | 'user';

// Variable substitution map
export type PromptVariables = Record<string, string>;

// Cache for loaded templates
const templateCache = new Map<string, string>();

/**
 * Get the prompts directory path
 * In production, this will be in the extension's install directory
 * During development, it's relative to the source
 */
function getPromptsDir(): string {
  // __dirname will be dist/ in production, src/prompts/ during dev compilation
  // We need to go up and find the prompts directory
  const possiblePaths = [
    path.join(__dirname, '..', '..', 'prompts'),  // From dist/prompts/index.js
    path.join(__dirname, '..', 'prompts'),         // From dist/index.js
    path.join(__dirname, '..', '..', '..', 'prompts'), // Alternative
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error(`Prompts directory not found. Searched: ${possiblePaths.join(', ')}`);
}

/**
 * Load a template file from disk
 */
function loadTemplateFile(type: PromptType, role: PromptRole): string {
  const cacheKey = `${type}/${role}`;
  
  // Check cache first
  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey)!;
  }

  const promptsDir = getPromptsDir();
  const filePath = path.join(promptsDir, type, `${role}.md`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Template file not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf-8');
  
  // Remove markdown header if present (lines starting with #)
  content = content.replace(/^#[^\n]*\n+/, '').trim();

  // Cache the loaded template
  templateCache.set(cacheKey, content);

  return content;
}

/**
 * Load a stage template file from disk (stage1.md - stage5.md for smart prompts)
 */
function loadStageTemplateFile(stageNumber: number): string {
  const cacheKey = `smart/stage${stageNumber}`;
  
  // Check cache first
  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey)!;
  }

  const promptsDir = getPromptsDir();
  const filePath = path.join(promptsDir, 'smart', `stage${stageNumber}.md`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Stage template file not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf-8');
  
  // Remove markdown header if present (lines starting with #)
  content = content.replace(/^#[^\n]*\n+/, '').trim();

  // Cache the loaded template
  templateCache.set(cacheKey, content);

  return content;
}

/**
 * Load mermaid template file from disk
 */
function loadMermaidTemplateFile(): string {
  const cacheKey = 'smart/mermaid';

  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey)!;
  }

  const promptsDir = getPromptsDir();
  const filePath = path.join(promptsDir, 'smart', 'mermaid.md');

  if (!fs.existsSync(filePath)) {
    throw new Error(`Mermaid template file not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  // Remove markdown header if present (lines starting with #)
  content = content.replace(/^#[^\n]*\n+/, '').trim();

  templateCache.set(cacheKey, content);

  return content;
}

/**
 * Replace template variables with actual values
 * Variables are in the format {{ variable_name }}
 */
function substituteVariables(template: string, variables: PromptVariables): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, varName) => {
    if (varName in variables) {
      return variables[varName];
    }
    // Keep original placeholder if variable not provided
    console.warn(`Template variable not provided: ${varName}`);
    return match;
  });
}

/**
 * Load and process a prompt template
 * @param type - The prompt type (suggestion, fast, smart)
 * @param role - The role (system, user)
 * @param variables - Variables to substitute in the template
 */
export function loadPrompt(
  type: PromptType,
  role: PromptRole,
  variables: PromptVariables = {}
): string {
  const template = loadTemplateFile(type, role);
  return substituteVariables(template, variables);
}

/**
 * Load and process a stage prompt template (for smart multi-turn conversation)
 * @param stageNumber - The stage number (1-5)
 * @param variables - Variables to substitute in the template
 */
export function loadStagePrompt(
  stageNumber: number,
  variables: PromptVariables = {}
): string {
  if (stageNumber < 1 || stageNumber > 5) {
    throw new Error(`Invalid stage number: ${stageNumber}. Must be 1-5.`);
  }
  const template = loadStageTemplateFile(stageNumber);
  return substituteVariables(template, variables);
}

/**
 * Get total number of stage prompts available
 */
export function getStageCount(): number {
  return 5;
}

/**
 * Load and process mermaid prompt template
 */
export function loadMermaidPrompt(variables: PromptVariables = {}): string {
  const template = loadMermaidTemplateFile();
  return substituteVariables(template, variables);
}

/**
 * Load stage 3-5 prompts with trace_id substitution for parallel trace processing
 * @param stageNumber - The stage number (3-5)
 * @param traceId - The trace ID to process (e.g., "1", "2", "3")
 * @param variables - Additional variables to substitute
 */
export function loadTraceStagePrompt(
  stageNumber: number,
  traceId: string,
  variables: PromptVariables = {}
): string {
  if (stageNumber < 3 || stageNumber > 5) {
    throw new Error(`Invalid stage number for trace processing: ${stageNumber}. Must be 3-5.`);
  }
  const template = loadStageTemplateFile(stageNumber);
  return substituteVariables(template, {
    ...variables,
    trace_id: traceId,
  });
}

/**
 * Clear the template cache (useful for hot reloading during development)
 */
export function clearPromptCache(): void {
  templateCache.clear();
}

/**
 * Preload all templates into cache
 */
export function preloadTemplates(): void {
  const types: PromptType[] = ['suggestion', 'fast', 'smart'];
  const roles: PromptRole[] = ['system', 'user'];

  for (const type of types) {
    for (const role of roles) {
      try {
        loadTemplateFile(type, role);
      } catch (error) {
        console.warn(`Failed to preload template ${type}/${role}:`, error);
      }
    }
  }

  // Preload smart stage templates (stage1.md - stage5.md)
  for (let i = 1; i <= 5; i++) {
    try {
      loadStageTemplateFile(i);
    } catch (error) {
      console.warn(`Failed to preload stage template ${i}:`, error);
    }
  }

  // Preload mermaid template
  try {
    loadMermaidTemplateFile();
  } catch (error) {
    console.warn('Failed to preload mermaid template:', error);
  }
}

/**
 * Get available template types
 */
export function getTemplateTypes(): PromptType[] {
  return ['suggestion', 'fast', 'smart'];
}

/**
 * Load the maximize_parallel_tool_calls addon for fast mode
 */
export function loadMaximizeParallelToolCallsAddon(): string {
  const cacheKey = 'fast/maximize_parallel_tool_calls';
  
  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey)!;
  }

  const promptsDir = getPromptsDir();
  const filePath = path.join(promptsDir, 'fast', 'maximize_parallel_tool_calls.md');

  if (!fs.existsSync(filePath)) {
    throw new Error(`Maximize parallel tool calls addon not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8').trim();
  templateCache.set(cacheKey, content);

  return content;
}

