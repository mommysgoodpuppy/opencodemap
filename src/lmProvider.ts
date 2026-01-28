import * as vscode from 'vscode';
import { generateText, streamText, CoreMessage, LanguageModelV1 } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

export class CodemapChatModelProvider implements vscode.LanguageModelChatProvider {
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const config = vscode.workspace.getConfiguration('codemap');
        const modelName = config.get<string>('model') || 'gpt-4o';
        
        // Return information about the configured model
        return [{
            id: 'codemap-model',
            name: `Codemap: ${modelName}`,
            family: modelName.includes('gpt-4') ? 'gpt-4' : 'gpt-3.5-turbo',
            version: '1.0.0',
            maxInputTokens: 128000,
            maxOutputTokens: 4096,
            capabilities: {
                imageInput: false,
                toolCalling: true
            },
            detail: 'Model configured in Codemap settings'
        }];
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const config = vscode.workspace.getConfiguration('codemap');
        const apiKey = config.get<string>('openaiApiKey');
        const baseUrl = config.get<string>('openaiBaseUrl') || 'https://api.openai.com/v1';
        const modelName = config.get<string>('model') || 'gpt-4o';

        if (!apiKey) {
            throw new Error('Please configure OpenAI API Key in Codemap settings');
        }

        const openai = createOpenAI({
            apiKey,
            baseURL: baseUrl,
        });

        const coreMessages: CoreMessage[] = messages.map(msg => {
            const role = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
            
            // Map complex content parts (text, tool results, tool calls)
            if (msg.content.some(part => !(part instanceof vscode.LanguageModelTextPart))) {
                const content: any[] = msg.content.map(part => {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        return { type: 'text', text: part.value };
                    }
                    if (part instanceof vscode.LanguageModelToolResultPart) {
                        return { type: 'tool-result', toolCallId: part.callId, result: part.content };
                    }
                    if (part instanceof vscode.LanguageModelToolCallPart) {
                        return { type: 'tool-call', toolCallId: part.callId, toolName: part.name, args: part.input };
                    }
                    return null;
                }).filter(p => p !== null);
                
                return { role, content } as CoreMessage;
            }

            // Simple text content
            return {
                role,
                content: msg.content
                    .filter(part => part instanceof vscode.LanguageModelTextPart)
                    .map(part => (part as vscode.LanguageModelTextPart).value)
                    .join('')
            };
        });

        // Convert VS Code tools to AI SDK tools
        const tools: Record<string, any> = {};
        if (options.tools) {
            options.tools.forEach(t => {
                // We create "intent-only" tools that don't execute, 
                // we just want AI SDK to recognize them.
                tools[t.name] = {
                    description: t.description,
                    parameters: t.inputSchema as any,
                };
            });
        }

        try {
            const { fullStream } = await streamText({
                model: openai(modelName) as LanguageModelV1,
                messages: coreMessages,
                tools: Object.keys(tools).length > 0 ? tools : undefined,
                abortSignal: (token as any).signal,
            });

            for await (const part of fullStream) {
                if (token.isCancellationRequested) break;

                if (part.type === 'text-delta') {
                    progress.report(new vscode.LanguageModelTextPart(part.textDelta));
                } else if (part.type === 'tool-call') {
                    progress.report(new vscode.LanguageModelToolCallPart(
                        part.toolCallId,
                        part.toolName,
                        JSON.parse(part.args)
                    ));
                }
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            progress.report(new vscode.LanguageModelTextPart(`Error: ${errorMessage}`));
        }
    }

    async provideTokenCount(
        model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        token: vscode.CancellationToken
    ): Promise<number> {
        const content = typeof text === 'string' ? text : 
            text.content
                .filter(part => part instanceof vscode.LanguageModelTextPart)
                .map(part => (part as vscode.LanguageModelTextPart).value)
                .join('');
        
        // Simple estimation: ~4 chars per token
        return Math.ceil(content.length / 4);
    }
}
