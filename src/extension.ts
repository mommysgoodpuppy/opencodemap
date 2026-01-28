/**
 * Codemap Extension - AI-powered code exploration
 */

import * as vscode from 'vscode';
import { CodemapViewProvider } from './views/CodemapViewProvider';
import { isConfigured, refreshConfig } from './agent';
import { getStoragePath, listCodemaps } from './storage/codemapStorage';
import { initLogger, initAgentLogger, info, show as showLogger, showRaw as showRawLogger } from './logger';
import { CodemapChatModelProvider } from './lmProvider';
import { pickVsCodeTools } from './tools/vscodeTools';

export let extensionContext: vscode.ExtensionContext;
let codemapViewProvider: CodemapViewProvider;

export function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	// Initialize logger first
	const outputChannel = initLogger();
	context.subscriptions.push(outputChannel);
	
	const agentOutputChannel = initAgentLogger();
	context.subscriptions.push(agentOutputChannel);
	
	info('Codemap extension is now active!');

	// Register Language Model Chat Provider
	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('codemap', new CodemapChatModelProvider())
	);

	// Initialize the webview provider
	codemapViewProvider = new CodemapViewProvider(context.extensionUri);

	// Register webview view provider for sidebar
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			CodemapViewProvider.viewType,
			codemapViewProvider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);

	// Command: Open Codemap Panel (focus sidebar view)
	context.subscriptions.push(
		vscode.commands.registerCommand('codemap.openPanel', () => {
			vscode.commands.executeCommand('codemap.mainView.focus');
		})
	);

	// Command: Back to Codemap list (shown in view title bar)
	context.subscriptions.push(
		vscode.commands.registerCommand('codemap.showHome', () => {
			vscode.commands.executeCommand('codemap.mainView.focus');
			codemapViewProvider.showHome();
		})
	);

	// Command: Generate from Selection (Fast mode)
	context.subscriptions.push(
		vscode.commands.registerCommand('codemap.generateFromSelection', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage('No active editor');
				return;
			}

			const selection = editor.document.getText(editor.selection);
			if (!selection) {
				vscode.window.showWarningMessage('No text selected');
				return;
			}

			// Open sidebar with selected text as query (Fast mode for quick exploration)
			vscode.commands.executeCommand('codemap.mainView.focus');
			codemapViewProvider.showWithQuery(
				`Explore the code flow related to: ${selection}`,
				'fast'
			);
		})
	);

	// Command: Set API Key
	context.subscriptions.push(
		vscode.commands.registerCommand('codemap.setApiKey', async () => {
			const apiKey = await vscode.window.showInputBox({
				prompt: 'Enter your OpenAI API Key',
				password: true,
				placeHolder: 'sk-...',
			});

			if (apiKey) {
				const config = vscode.workspace.getConfiguration('codemap');
				await config.update('openaiApiKey', apiKey, vscode.ConfigurationTarget.Global);
				
				// Refresh agent config
				if (refreshConfig()) {
					vscode.window.showInformationMessage('API Key saved successfully');
				}
			}
		})
	);

	// Command: Show Storage Path (for debugging)
	context.subscriptions.push(
		vscode.commands.registerCommand('codemap.showStoragePath', () => {
			const storagePath = getStoragePath();
			const codemaps = listCodemaps();
			vscode.window.showInformationMessage(
				`Codemap storage: ${storagePath}\nFound ${codemaps.length} saved codemap(s)`,
				'Open Folder'
			).then((selection) => {
				if (selection === 'Open Folder') {
					vscode.env.openExternal(vscode.Uri.file(storagePath));
				}
			});
		})
	);

	// Listen for configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('codemap')) {
				refreshConfig();
			}
		})
	);

	// Command: Show Agent Log (for debugging)
	context.subscriptions.push(
		vscode.commands.registerCommand('codemap.showAgentLog', () => {
			showLogger();
		})
	);

	// Command: Show Raw Agent Log (for debugging)
	context.subscriptions.push(
		vscode.commands.registerCommand('codemap.showRawAgentLog', () => {
			showRawLogger();
		})
	);

	// Command: Pick Tools
	context.subscriptions.push(
		vscode.commands.registerCommand('codemap.pickTools', () => {
			pickVsCodeTools(context);
		})
	);

	// Check if API key is configured on startup
	if (!isConfigured()) {
		vscode.window.showInformationMessage(
			'Codemap: Set your OpenAI API key to get started',
			'Set API Key'
		).then((selection) => {
			if (selection === 'Set API Key') {
				vscode.commands.executeCommand('codemap.setApiKey');
			}
		});
	}
	
	info('Extension activation complete');
}

export function deactivate() {
	info('Codemap extension deactivating...');
}