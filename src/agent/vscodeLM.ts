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
        const content = Array.isArray(m.content) 
          ? m.content.filter(c => c.type === 'text').map(c => (c as any).text).join('\n')
          : m.content;

        if (m.role === 'user') {
          return vscode.LanguageModelChatMessage.User(content);
        } else if (m.role === 'assistant') {
          return vscode.LanguageModelChatMessage.Assistant(content);
        } else {
          // System messages prepended as user message for compatibility
          return vscode.LanguageModelChatMessage.User(`System context: ${content}`);
        }
      });

      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
      
      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
      }

      return {
        text,
        finishReason: 'stop',
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
        const content = Array.isArray(m.content) 
          ? m.content.filter(c => c.type === 'text').map(c => (c as any).text).join('\n')
          : m.content;

        if (m.role === 'user') {
          return vscode.LanguageModelChatMessage.User(content);
        } else if (m.role === 'assistant') {
          return vscode.LanguageModelChatMessage.Assistant(content);
        } else {
          return vscode.LanguageModelChatMessage.User(`System context: ${content}`);
        }
      });

      const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

      return {
        stream: new ReadableStream({
          async start(controller) {
            try {
              for await (const fragment of response.text) {
                controller.enqueue({ type: 'text-delta', textDelta: fragment });
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
