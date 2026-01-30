import * as vscode from "vscode";
import { LanguageModel } from "ai";

function toolResultOutputToText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return String(output ?? "");
  if ("type" in output) {
    const typed = output as { type: string; value?: unknown; reason?: string };
    if (typed.type === "text" || typed.type === "error-text") {
      return String(typed.value ?? "");
    }
    if (typed.type === "json" || typed.type === "error-json") {
      return JSON.stringify(typed.value ?? null);
    }
    if (typed.type === "execution-denied") {
      return String(typed.reason ?? "Execution denied");
    }
    if (typed.type === "content") return JSON.stringify(typed.value ?? []);
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function coerceToolCallInput(input: unknown): unknown {
  if (input && typeof input === "object") return input;
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return input;
    }
  }
  return input ?? {};
}

export function createVSCodeLM(
  modelSelector: vscode.LanguageModelChatSelector = { family: "gpt-4" },
): LanguageModel {
  const normalizeToolSchema = (
    schema: unknown,
  ): {
    type: "object";
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  } => {
    if (schema && typeof schema === "object" && !Array.isArray(schema)) {
      const record = schema as Record<string, unknown>;
      const properties =
        (record.properties && typeof record.properties === "object" &&
            !Array.isArray(record.properties))
          ? (record.properties as Record<string, unknown>)
          : {};
      return {
        type: "object",
        ...record,
        properties,
        additionalProperties: record.additionalProperties !== undefined
          ? Boolean(record.additionalProperties)
          : true,
      };
    }
    return { type: "object", properties: {}, additionalProperties: true };
  };

  const model: any = {
    specificationVersion: "v3",
    modelId: "vscode-lm",
    provider: "vscode",
    supportedUrls: {},
    async doGenerate(options: any): Promise<any> {
      const models = await vscode.lm.selectChatModels(modelSelector);
      if (models.length === 0) {
        throw new Error(
          "No VS Code language models found for the given selector",
        );
      }
      const model = models[0];

      const messages = (options.prompt as any[]).map((m: any) => {
        if (Array.isArray(m.content)) {
          const parts = (m.content as any[]).map((c: any) => {
            if (c.type === "text") {
              return new vscode.LanguageModelTextPart(c.text);
            }
            if (c.type === "tool-result") {
              return new vscode.LanguageModelToolResultPart(
                c.toolCallId,
                [
                  new vscode.LanguageModelTextPart(
                    toolResultOutputToText(c.output),
                  ),
                ],
              );
            }
            if (c.type === "tool-call") {
              return new vscode.LanguageModelToolCallPart(
                c.toolCallId,
                c.toolName,
                coerceToolCallInput(c.input),
              );
            }
            return null;
          }).filter((
            p:
              | vscode.LanguageModelTextPart
              | vscode.LanguageModelToolResultPart
              | vscode.LanguageModelToolCallPart
              | null,
          ): p is
            | vscode.LanguageModelTextPart
            | vscode.LanguageModelToolResultPart
            | vscode.LanguageModelToolCallPart => p !== null
          );

          if (m.role === "user") {
            return vscode.LanguageModelChatMessage.User(parts);
          }
          if (m.role === "assistant") {
            return vscode.LanguageModelChatMessage.Assistant(
              parts.filter((
                p,
              ): p is
                | vscode.LanguageModelTextPart
                | vscode.LanguageModelToolCallPart =>
                p instanceof vscode.LanguageModelTextPart ||
                p instanceof vscode.LanguageModelToolCallPart
              ),
            );
          }
          if (m.role === "tool") {
            return vscode.LanguageModelChatMessage.User(parts);
          }
          return vscode.LanguageModelChatMessage.User(parts);
        }

        const content = m.content as string;
        if (m.role === "user") {
          return vscode.LanguageModelChatMessage.User(content);
        } else if (m.role === "assistant") {
          return vscode.LanguageModelChatMessage.Assistant(content);
        } else {
          return vscode.LanguageModelChatMessage.User(
            `System context: ${content}`,
          );
        }
      });

      const vscodeTools: vscode.LanguageModelChatTool[] =
        ((options.tools as any[]) || []).map((t: any) => ({
          name: t.name,
          description: t.description || "",
          inputSchema: normalizeToolSchema(t.parameters || t.inputSchema),
        }));

      const cts = new vscode.CancellationTokenSource();
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          cts.cancel();
        } else {
          options.abortSignal.addEventListener("abort", () => cts.cancel(), {
            once: true,
          });
        }
      }

      const toolMode = vscodeTools.length === 0
        ? undefined
        : options.toolChoice === "required"
        ? vscode.LanguageModelChatToolMode.Required
        : vscode.LanguageModelChatToolMode.Auto;

      const response = await model.sendRequest(messages, {
        tools: vscodeTools,
        toolMode,
      }, cts.token);

      let text = "";
      const toolCalls: Array<
        { toolCallId: string; toolName: string; input: string }
      > = [];

      for await (const part of response.stream) {
        if (cts.token.isCancellationRequested) {
          throw new Error("Request cancelled");
        }
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            toolCallId: part.callId,
            toolName: part.name,
            input: JSON.stringify(part.input),
          });
        }
      }

      return {
        content: toolCalls.length > 0
          ? [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...toolCalls.map((tc) => ({ type: "tool-call" as const, ...tc })),
          ]
          : text
          ? [{ type: "text" as const, text }]
          : [],
        finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
    async doStream(options: any): Promise<any> {
      const models = await vscode.lm.selectChatModels(modelSelector);
      if (models.length === 0) {
        throw new Error(
          "No VS Code language models found for the given selector",
        );
      }
      const model = models[0];

      const messages = (options.prompt as any[]).map((m: any) => {
        if (Array.isArray(m.content)) {
          const parts = (m.content as any[]).map((c: any) => {
            if (c.type === "text") {
              return new vscode.LanguageModelTextPart(c.text);
            }
            if (c.type === "tool-result") {
              return new vscode.LanguageModelToolResultPart(
                c.toolCallId,
                [
                  new vscode.LanguageModelTextPart(
                    toolResultOutputToText(c.output),
                  ),
                ],
              );
            }
            if (c.type === "tool-call") {
              return new vscode.LanguageModelToolCallPart(
                c.toolCallId,
                c.toolName,
                coerceToolCallInput(c.input),
              );
            }
            return null;
          }).filter((
            p:
              | vscode.LanguageModelTextPart
              | vscode.LanguageModelToolResultPart
              | vscode.LanguageModelToolCallPart
              | null,
          ): p is
            | vscode.LanguageModelTextPart
            | vscode.LanguageModelToolResultPart
            | vscode.LanguageModelToolCallPart => p !== null
          );

          if (m.role === "user") {
            return vscode.LanguageModelChatMessage.User(parts);
          }
          if (m.role === "assistant") {
            return vscode.LanguageModelChatMessage.Assistant(
              parts.filter((
                p,
              ): p is
                | vscode.LanguageModelTextPart
                | vscode.LanguageModelToolCallPart =>
                p instanceof vscode.LanguageModelTextPart ||
                p instanceof vscode.LanguageModelToolCallPart
              ),
            );
          }
          if (m.role === "tool") {
            return vscode.LanguageModelChatMessage.User(parts);
          }
          return vscode.LanguageModelChatMessage.User(parts);
        }

        const content = m.content as string;
        if (m.role === "user") {
          return vscode.LanguageModelChatMessage.User(content);
        } else if (m.role === "assistant") {
          return vscode.LanguageModelChatMessage.Assistant(content);
        } else {
          return vscode.LanguageModelChatMessage.User(
            `System context: ${content}`,
          );
        }
      });

      const vscodeTools: vscode.LanguageModelChatTool[] =
        ((options.tools as any[]) || []).map((t: any) => ({
          name: t.name,
          description: t.description || "",
          inputSchema: normalizeToolSchema(t.parameters || t.inputSchema),
        }));

      const cts = new vscode.CancellationTokenSource();
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          cts.cancel();
        } else {
          options.abortSignal.addEventListener("abort", () => cts.cancel(), {
            once: true,
          });
        }
      }

      const toolMode = vscodeTools.length === 0
        ? undefined
        : options.toolChoice === "required"
        ? vscode.LanguageModelChatToolMode.Required
        : vscode.LanguageModelChatToolMode.Auto;

      const response = await model.sendRequest(messages, {
        tools: vscodeTools,
        toolMode,
      }, cts.token);

      return {
        stream: new ReadableStream({
          async start(controller) {
            try {
              for await (const part of response.stream) {
                if (cts.token.isCancellationRequested) {
                  controller.close();
                  return;
                }
                if (part instanceof vscode.LanguageModelTextPart) {
                  controller.enqueue({
                    type: "text-delta",
                    id: "text",
                    delta: part.value,
                  });
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: part.callId,
                    toolName: part.name,
                    input: JSON.stringify(part.input),
                  });
                }
              }
              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              });
            } catch (err) {
              controller.error(err);
            } finally {
              controller.close();
            }
          },
        }),
      };
    },
  };

  return model as LanguageModel;
}
