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

        const coreMessages: CoreMessage[] = messages.map(msg => ({
            role: msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
            content: msg.content
                .filter(part => part instanceof vscode.LanguageModelTextPart)
                .map(part => (part as vscode.LanguageModelTextPart).value)
                .join('')
        }));

        try {
            const { textStream } = await streamText({
                model: openai(modelName) as LanguageModelV1,
                messages: coreMessages,
                abortSignal: (token as any).signal, // Attempt to use cancellation token
            });

            for await (const chunk of textStream) {
                if (token.isCancellationRequested) {
                    break;
                }
                progress.report(new vscode.LanguageModelTextPart(chunk));
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
