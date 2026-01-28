import * as vscode from 'vscode';
import { streamText, ModelMessage, LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';

function toToolResultOutput(value: unknown): ToolResultOutput {
    if (typeof value === 'string') {
        return { type: 'text', value };
    }
    if (value === undefined) {
        return { type: 'json', value: null };
    }
    try {
        return { type: 'json', value: JSON.parse(JSON.stringify(value)) };
    } catch {
        return { type: 'text', value: String(value) };
    }
}

function coerceToolInput(input: unknown): object {
    if (input && typeof input === 'object') return input as object;
    if (typeof input === 'string') {
        try {
            const parsed = JSON.parse(input);
            if (parsed && typeof parsed === 'object') return parsed as object;
            return { value: parsed };
        } catch {
            return { value: input };
        }
    }
    return { value: input };
}

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

        const coreMessages: ModelMessage[] = messages.map(msg => {
            const role = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
            
            // Map complex content parts (text, tool results, tool calls)
            if (msg.content.some(part => !(part instanceof vscode.LanguageModelTextPart))) {
                const content: any[] = msg.content.map(part => {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        return { type: 'text', text: part.value };
                    }
                    if (part instanceof vscode.LanguageModelToolResultPart) {
                        const contentParts = part.content as vscode.LanguageModelTextPart[];
                        const contentText = contentParts.map(p => p.value).join('');
                        return { type: 'tool-result', toolCallId: part.callId, toolName: 'tool', output: toToolResultOutput(contentText) };
                    }
                    if (part instanceof vscode.LanguageModelToolCallPart) {
                        return { type: 'tool-call', toolCallId: part.callId, toolName: part.name, input: JSON.stringify(part.input) };
                    }
                    return null;
                }).filter(p => p !== null);
                
                return { role, content } as ModelMessage;
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

        try {
            const { fullStream } = await streamText({
                model: openai(modelName) as LanguageModel,
                messages: coreMessages,
                tools: Object.keys(tools).length > 0 ? tools : undefined,
                abortSignal: (token as any).signal,
            });

            for await (const part of fullStream) {
                if (token.isCancellationRequested) break;

                if (part.type === 'text-delta') {
                    progress.report(new vscode.LanguageModelTextPart(part.text));
                } else if (part.type === 'tool-call') {
                    progress.report(new vscode.LanguageModelToolCallPart(
                        part.toolCallId,
                        part.toolName,
                        coerceToolInput(part.input)
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
