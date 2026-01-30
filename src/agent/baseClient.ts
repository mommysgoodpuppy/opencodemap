/**
 * Base AI client configuration for all agents
 */

import { createOpenAI } from "@ai-sdk/openai";
import { LanguageModel } from "ai";
import * as vscode from "vscode";
import { createVSCodeLM } from "./vscodeLM";
import * as logger from "../logger";

let cachedClient: ((modelName: string) => LanguageModel) | null = null;
let cachedConfig: { provider: string; apiKey: string; baseUrl: string } | null =
  null;

export function getAIClient(
  _callbacks?: { onToken?: (deltaText: string) => void },
): ((modelName: string) => LanguageModel) | null {
  const config = vscode.workspace.getConfiguration("codemap");
  const provider = config.get<string>("provider") || "openai";
  const apiKey = config.get<string>("openaiApiKey") || "";
  const baseUrl = config.get<string>("openaiBaseUrl") ||
    "https://api.openai.com/v1";

  logger.debug(
    "getAIClient: provider =",
    provider,
    "apiKey present =",
    !!apiKey,
    "baseUrl =",
    baseUrl,
  );

  let clientFactory: (modelName: string) => LanguageModel;

  if (provider === "vscode") {
    logger.debug("Using VS Code LM provider");
    clientFactory = (modelName: string) => {
      // If modelName looks like a JSON selector, use it
      try {
        if (modelName.startsWith("{")) {
          logger.debug("Parsing modelName as JSON selector:", modelName);
          return createVSCodeLM(JSON.parse(modelName));
        }
      } catch (e) {
        logger.debug("Failed to parse modelName as JSON:", e);
      }

      // If modelName starts with "vscode:", treat it as a model ID
      if (modelName.startsWith("vscode:")) {
        logger.debug("Using model ID:", modelName);
        return createVSCodeLM(modelName);
      }

      // Default selector based on model name
      if (modelName.includes("gpt-4")) {
        logger.debug("Using default GPT-4 selector");
        return createVSCodeLM({ family: "gpt-4" });
      }
      logger.debug("Using default GPT-3.5 selector");
      return createVSCodeLM({ family: "gpt-3.5-turbo" });
    };
  } else {
    logger.debug("Using OpenAI provider");
    if (!apiKey) {
      logger.debug("No API key, returning null");
      return null;
    }

    const openai = createOpenAI({
      apiKey,
      baseURL: baseUrl,
    });
    clientFactory = (modelName: string) => {
      logger.debug("Creating OpenAI client with model:", modelName);
      return openai(modelName) as LanguageModel;
    };
  }

  return (modelName: string) => clientFactory(modelName);
}

export function getModelName(): string {
  const config = vscode.workspace.getConfiguration("codemap");
  const provider = config.get<string>("provider") || "openai";
  const model = config.get<string>("model") || "gpt-4o";
  const fullModel = provider === "vscode" && !model.startsWith("vscode:")
    ? `vscode:${model}`
    : model;
  logger.debug("getModelName returning:", fullModel);
  return fullModel;
}

export function getLanguage(): string {
  const config = vscode.workspace.getConfiguration("codemap");
  return config.get<string>("language") || "English";
}

export function isConfigured(): boolean {
  const config = vscode.workspace.getConfiguration("codemap");
  const provider = config.get<string>("provider") || "openai";
  if (provider === "vscode") {
    return true; // Assume VS Code models are available if selected
  }
  return config.get<string>("openaiApiKey") !== "";
}

export function refreshConfig(): boolean {
  logger.debug("refreshConfig called, clearing cache");
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
    allModels.push(...vscodeModels.map((m) => ({
      id: `vscode:${m.id}`,
      name: m.name,
      family: m.family,
      vendor: m.vendor,
      isFree: m.name.toLowerCase().includes("free") ||
        m.id.toLowerCase().includes("free"),
    })));
  } catch (e) {
    console.error("Failed to fetch VS Code models:", e);
  }

  // 2. Add Standard OpenAI models
  allModels.push(
    { id: "openai:gpt-4o", name: "GPT-4o", family: "gpt-4", vendor: "openai" },
    {
      id: "openai:gpt-4o-mini",
      name: "GPT-4o Mini",
      family: "gpt-4",
      vendor: "openai",
      isFree: true,
    },
    {
      id: "openai:gpt-4-turbo",
      name: "GPT-4 Turbo",
      family: "gpt-4",
      vendor: "openai",
    },
    {
      id: "openai:gpt-3.5-turbo",
      name: "GPT-3.5 Turbo",
      family: "gpt-3.5-turbo",
      vendor: "openai",
    },
  );

  return allModels;
}

export async function setModel(modelId: string): Promise<void> {
  logger.debug("setModel called with modelId:", modelId);
  const config = vscode.workspace.getConfiguration("codemap");

  // Determine the target: if the setting is set in workspace, update workspace, else global
  const inspect = config.inspect("provider");
  const target = inspect?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  logger.debug(
    "setModel target:",
    target === vscode.ConfigurationTarget.Workspace ? "Workspace" : "Global",
  );

  if (modelId.startsWith("vscode:")) {
    const actualId = modelId.substring(7);
    logger.debug("Setting provider to vscode, model to:", actualId);
    await config.update("provider", "vscode", target);
    await config.update("model", actualId, target);
  } else if (modelId.startsWith("openai:")) {
    const actualId = modelId.substring(7);
    logger.debug("Setting provider to openai, model to:", actualId);
    await config.update("provider", "openai", target);
    await config.update("model", actualId, target);
  } else {
    // Legacy/fallback
    logger.debug("Legacy setModel, setting model to:", modelId);
    await config.update("model", modelId, target);
  }

  // Log the current config after update
  const newProvider = config.get<string>("provider");
  const newModel = config.get<string>("model");
  logger.debug(
    "After setModel, config provider:",
    newProvider,
    "model:",
    newModel,
  );

  refreshConfig();
  logger.debug("setModel completed");
}
