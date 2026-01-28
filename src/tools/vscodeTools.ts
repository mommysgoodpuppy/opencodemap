import * as vscode from 'vscode';
import { tool } from 'ai';
import { z } from 'zod';

/**
 * Wraps a VS Code LM Tool into an AI SDK compatible tool.
 */
export function wrapVsCodeTool(info: vscode.LanguageModelToolInformation) {
  return tool({
    description: info.description,
    // VS Code uses JSON schema for inputSchema. 
    // AI SDK's 'tool' expects a Zod schema or a JSON schema object if using certain versions.
    // Since inputSchema is already a JSON schema, we can try to use it.
    // Note: AI SDK 'tool' usually wants a Zod schema for 'parameters'.
    // If we don't have a Zod schema, we can use z.any() and validate manually, 
    // or just pass the schema if the library supports it.
    parameters: z.any().describe(JSON.stringify(info.inputSchema)),
    execute: async (input) => {
      try {
        const result = await vscode.lm.invokeTool(
          info.name,
          {
            input,
            toolInvocationToken: undefined as any,
            tokenizationOptions: {
              tokenBudget: 4000,
              countTokens: async (content) => {
                // Better estimation: 1 token ~= 4 characters for English
                return Math.ceil(JSON.stringify(content).length / 4);
              }
            },
          },
          new vscode.CancellationTokenSource().token
        );

        // VS Code tool results are often strings or complex objects.
        // We'll return the string content for the AI.
        if (typeof result.content === 'string') {
          return result.content;
        }
        
        // Handle parts if result.content is an array of parts
        if (Array.isArray(result.content)) {
          return result.content
            .map(part => {
              if (part instanceof vscode.LanguageModelTextPart) {
                return part.value;
              }
              return JSON.stringify(part);
            })
            .join('\n');
        }

        return String(result.content);
      } catch (error) {
        return `Error invoking VS Code tool "${info.name}": ${error}`;
      }
    },
  });
}

const SELECTED_TOOLS_KEY = 'codemap.selectedVsCodeTools';

/**
 * QuickPick UI to select tools from the VS Code registry.
 */
export async function pickVsCodeTools(context: vscode.ExtensionContext) {
  const tools = vscode.lm.tools;
  if (tools.length === 0) {
    vscode.window.showInformationMessage('No VS Code LM tools found in the registry.');
    return;
  }

  const current = new Set<string>(context.globalState.get<string[]>(SELECTED_TOOLS_KEY, []));

  const items: vscode.QuickPickItem[] = tools.map(t => ({
    label: t.name,
    description: t.tags?.length ? t.tags.map(x => `#${x}`).join(' ') : undefined,
    detail: t.description,
    picked: current.has(t.name),
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Select VS Code Tools for Codemap Agent',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) return;

  const names = picked.map(p => p.label);
  await context.globalState.update(SELECTED_TOOLS_KEY, names);

  vscode.window.showInformationMessage(`Enabled ${names.length} VS Code tools for Codemap.`);
}

/**
 * Gets the selected VS Code tools as AI SDK compatible tools.
 */
export function getSelectedVsCodeTools(context: vscode.ExtensionContext) {
  const names = context.globalState.get<string[]>(SELECTED_TOOLS_KEY, []);
  const registryTools = vscode.lm.tools;
  
  const wrappedTools: Record<string, any> = {};
  
  for (const name of names) {
    const info = registryTools.find(t => t.name === name);
    if (info) {
      // Use the tool name as the key for AI SDK
      wrappedTools[name.replace(/[^a-zA-Z0-9_]/g, '_')] = wrapVsCodeTool(info);
    }
  }
  
  return wrappedTools;
}
