import * as vscode from 'vscode';
import { LanguageModelV1, LanguageModelV1Prompt } from 'ai';

export function createVSCodeLM(modelSelector: vscode.LanguageModelChatSelector = { family: 'gpt-4' }): LanguageModelV1 {
  return {
    specificationVersion: 'v1',
    defaultObjectGenerationMode: undefined,
    modelId: 'vscode-lm',
    provider: 'vscode',
    async doGenerate(options) {
      const models = await vscode.lm.selectChatModels(modelSelector);
      if (models.length === 0) {
        throw new Error('No VS Code language models found for the given selector');
      }
      const model = models[0];

      const messages = options.prompt.map(m => {
        if (Array.isArray(m.content)) {
          const parts = m.content.map(c => {
            if (c.type === 'text') return new vscode.LanguageModelTextPart(c.text);
            if (c.type === 'tool-result') return new vscode.LanguageModelToolResultPart(c.toolCallId, [new vscode.LanguageModelTextPart(String(c.result))]);
            return null;
          }).filter((p): p is vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart => p !== null);
          
          if (m.role === 'user') return vscode.LanguageModelChatMessage.User(parts);
          if (m.role === 'assistant') return vscode.LanguageModelChatMessage.Assistant(parts.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart));
          return vscode.LanguageModelChatMessage.User(parts);
        }

        const content = m.content as string;
        if (m.role === 'user') {
          return vscode.LanguageModelChatMessage.User(content);
        } else if (m.role === 'assistant') {
          return vscode.LanguageModelChatMessage.Assistant(content);
        } else {
          return vscode.LanguageModelChatMessage.User(`System context: ${content}`);
        }
      });

      const vscodeTools: vscode.LanguageModelChatTool[] = ((options as any).tools || []).map((t: any) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.parameters as any,
      }));

      const cts = new vscode.CancellationTokenSource();
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          cts.cancel();
        } else {
          options.abortSignal.addEventListener('abort', () => cts.cancel(), { once: true });
        }
      }

      const response = await model.sendRequest(messages, {
        tools: vscodeTools,
        toolMode: vscodeTools.length > 0 ? vscode.LanguageModelChatToolMode.Auto : undefined,
      }, cts.token);
      
      let text = '';
      const toolCalls: any[] = [];

      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            toolCallType: 'function',
            toolCallId: part.callId,
            toolName: part.name,
            args: JSON.stringify(part.input),
          });
        }
      }

      return {
        text: text || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
        rawCall: { rawPrompt: options.prompt, rawSettings: {} },
      };
    },
    async doStream(options) {
      const models = await vscode.lm.selectChatModels(modelSelector);
      if (models.length === 0) {
        throw new Error('No VS Code language models found for the given selector');
      }
      const model = models[0];

      const messages = options.prompt.map(m => {
        if (Array.isArray(m.content)) {
          const parts = m.content.map(c => {
            if (c.type === 'text') return new vscode.LanguageModelTextPart(c.text);
            if (c.type === 'tool-result') return new vscode.LanguageModelToolResultPart(c.toolCallId, [new vscode.LanguageModelTextPart(String(c.result))]);
            return null;
          }).filter((p): p is vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart => p !== null);
          
          if (m.role === 'user') return vscode.LanguageModelChatMessage.User(parts);
          if (m.role === 'assistant') return vscode.LanguageModelChatMessage.Assistant(parts.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart));
          return vscode.LanguageModelChatMessage.User(parts);
        }
        
        const content = m.content as string;
        if (m.role === 'user') {
          return vscode.LanguageModelChatMessage.User(content);
        } else if (m.role === 'assistant') {
          return vscode.LanguageModelChatMessage.Assistant(content);
        } else {
          return vscode.LanguageModelChatMessage.User(`System context: ${content}`);
        }
      });

      const vscodeTools: vscode.LanguageModelChatTool[] = ((options as any).tools || []).map((t: any) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.parameters as any,
      }));

      const cts = new vscode.CancellationTokenSource();
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          cts.cancel();
        } else {
          options.abortSignal.addEventListener('abort', () => cts.cancel(), { once: true });
        }
      }

      const response = await model.sendRequest(messages, {
        tools: vscodeTools,
        toolMode: vscodeTools.length > 0 ? vscode.LanguageModelChatToolMode.Auto : undefined,
      }, cts.token);

      return {
        stream: new ReadableStream({
          async start(controller) {
            try {
              for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                  controller.enqueue({ type: 'text-delta', textDelta: part.value });
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallType: 'function',
                    toolCallId: part.callId,
                    toolName: part.name,
                    args: JSON.stringify(part.input),
                  });
                }
              }
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } });
            } catch (err) {
              controller.error(err);
            } finally {
              controller.close();
            }
          }
        }),
        rawCall: { rawPrompt: options.prompt, rawSettings: {} },
      };
    }
  };
}
