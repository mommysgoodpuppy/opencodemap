/**
 * Core Codemap Agent - shared logic for both Fast and Smart modes
 *
 * Flow:
 * 1. Stage 1: Research - explore codebase with tools
 * 2. Stage 2: Generate codemap structure with multiple traces
 * 3. Stage 3-5: For each trace in parallel, generate diagram and guide
 * 4. Aggregate all trace results into final codemap
 *
 * The only difference between Fast and Smart modes is the system prompt:
 * - Fast: smart/system.md + maximize_parallel_tool_calls.md
 * - Smart: smart/system.md
 */

import { ModelMessage, streamText } from "ai";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import {
  getAIClient,
  getLanguage,
  getModelName,
  isConfigured,
} from "./baseClient";
import {
  loadMaximizeParallelToolCallsAddon,
  loadMermaidPrompt,
  loadPrompt,
  loadStagePrompt,
  loadTraceStagePrompt,
} from "../prompts";
import { allTools } from "../tools";
import { getSelectedVsCodeTools } from "../tools/vscodeTools";
import { extensionContext } from "../extension";
import type { Codemap, DetailLevel } from "../types";
import {
  extractCodemapFromResponse,
  extractCodemapFromResponseDetailed,
  extractMermaidDiagram,
  extractTraceDiagram,
  extractTraceGuide,
  formatCurrentDate,
  generateWorkspaceLayout,
  getUserOs,
  isResearchComplete,
} from "./utils";
import { colorizeMermaidDiagram } from "./mermaidColorize";
import { validateMermaidDiagram } from "./mermaidValidate";
import * as logger from "../logger";
import { saveDebugLog } from "../storage/codemapStorage";

export interface CodemapCallbacks {
  onMessage?: (role: string, content: string) => void;
  onToolCall?: (tool: string, args: string, result: string) => void;
  onParallelToolState?: (activeCount: number) => void;
  onCodemapUpdate?: (codemap: Codemap) => void;
  onPhaseChange?: (phase: string, stageNumber: number) => void;
  onTraceProcessing?: (
    traceId: string,
    stage: number,
    status: "start" | "complete",
  ) => void;
  /**
   * Fired once Stage 1 (research) and Stage 2 (structure) are complete enough to
   * run downstream stages (trace processing / mermaid). This is the "shared context"
   * the user wants persisted for retries.
   */
  onStage12ContextReady?: (context: CodemapStage12ContextV1) => void;
  onToken?: (deltaText: string) => void;
}

export type CodemapMode = "fast" | "smart";

/**
 * Serializable "shared context" captured after Stage 1 & Stage 2.
 * Used to retry later stages without re-running research/structure.
 */
export interface CodemapStage12ContextV1 {
  schemaVersion: 1;
  createdAt: string;
  query: string;
  mode: CodemapMode;
  detailLevel: DetailLevel;
  workspaceRoot: string;
  currentDate: string;
  language: string;
  systemPrompt: string;
  /**
   * The exact messages array passed as baseMessages to stages 3-6.
   * Keep it JSON-serializable (role + string content).
   */
  baseMessages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Result from processing a single trace through stages 3-5
 */
interface TraceProcessingResult {
  traceId: string;
  diagram?: string;
  guide?: string;
  error?: string;
}

/**
 * Options for trace processing
 */
interface TraceProcessingOptions {
  includeGuide?: boolean; // Whether to execute Stage 5 to generate guide
  abortSignal?: AbortSignal;
}

interface MermaidProcessingResult {
  diagram?: string;
  error?: string;
}

interface LocationMismatch {
  traceId: string;
  locationId: string;
  path: string;
  lineNumber: number;
  expected: string;
  actual: string;
}

const LINE_NORMALIZE_REGEX = /\s+/g;
const MAX_FIX_SCAN_FILES = 5000;
const MAX_FIX_SCAN_BYTES = 2 * 1024 * 1024;
const MIN_APPROX_MATCH_LENGTH = 12;
const MIN_APPROX_MATCH_RATIO = 0.8;
const MIN_REPEAT_ALERT_CHARS = 300;
const REPEAT_LOG_SNIPPET = 500;
const ALLOWED_FIX_EXTS = new Set([
  ".re",
  ".ml",
  ".mli",
  ".res",
  ".resi",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".rb",
  ".php",
]);
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".vscode",
  ".idea",
  ".cache",
]);

let repetitionAlerted = false;

function normalizeLine(value: string): string {
  return value.replace(LINE_NORMALIZE_REGEX, " ").trim();
}

function normalizeRepeatContent(value: string): string {
  return value.replace(LINE_NORMALIZE_REGEX, " ").trim();
}

function recordRepeatedMessage(options: {
  role: "user" | "assistant";
  content: string;
  matchedRole: string;
  matchedIndex: number;
  matchedLength: number;
  context?: AppendContext;
}) {
  const { role, content, matchedRole, matchedIndex, matchedLength, context } =
    options;
  const length = content.length;
  const label = context?.label ? ` (${context.label})` : "";
  const message = `Detected large repeated ${role} message chunk${label}. ` +
    `length=${length}, matchedRole=${matchedRole}, matchedIndex=${matchedIndex}, matchedLength=${matchedLength}`;

  logger.error(message);
  context?.callbacks?.onMessage?.("error", message);

  if (!repetitionAlerted) {
    repetitionAlerted = true;
    try {
      vscode.window.showErrorMessage(
        "Codemap: repeated large prompt chunk detected. See debug logs for details.",
      );
    } catch {
      // ignore UI errors
    }
  }

  try {
    const snippet = content.length > REPEAT_LOG_SNIPPET
      ? `${content.slice(0, REPEAT_LOG_SNIPPET)}\n...\n${
        content.slice(-REPEAT_LOG_SNIPPET)
      }`
      : content;
    const diagnostics = [
      `[${new Date().toISOString()}] ${message}`,
      `role=${role}`,
      `contentLength=${length}`,
      `matchedRole=${matchedRole}`,
      `matchedIndex=${matchedIndex}`,
      `matchedLength=${matchedLength}`,
      "",
      "snippet:",
      snippet,
    ].join("\n");
    saveDebugLog(diagnostics, "codemap-repeated-chunk", context?.workspaceRoot);
  } catch {
    // ignore secondary logging errors
  }
}

interface AppendContext {
  workspaceRoot?: string;
  callbacks?: CodemapCallbacks;
  label?: string;
}

function guardLargeRepeat(
  messages: ModelMessage[],
  content: string,
  role: "user" | "assistant",
  context?: AppendContext,
): void {
  if (!context || content.length < MIN_REPEAT_ALERT_CHARS) {
    return;
  }
  const normalized = normalizeRepeatContent(content);
  if (normalized.length < MIN_REPEAT_ALERT_CHARS) {
    return;
  }
  for (let i = 0; i < messages.length; i++) {
    const existing = messages[i];
    if (!existing || typeof existing.content !== "string") continue;
    const existingNormalized = normalizeRepeatContent(existing.content);
    if (existingNormalized.length < MIN_REPEAT_ALERT_CHARS) continue;
    if (
      existingNormalized.includes(normalized) ||
      normalized.includes(existingNormalized)
    ) {
      recordRepeatedMessage({
        role,
        content,
        matchedRole: existing.role,
        matchedIndex: i,
        matchedLength: existing.content.length,
        context,
      });
      return;
    }
  }
}

function appendUserMessage(
  messages: ModelMessage[],
  content: string,
  context?: AppendContext,
): void {
  guardLargeRepeat(messages, content, "user", context);
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    last.content = `${last.content}\n\n${content}`;
  } else {
    messages.push({ role: "user", content });
  }
}

function appendAssistantMessage(
  messages: ModelMessage[],
  content: string,
  context?: AppendContext,
): void {
  guardLargeRepeat(messages, content, "assistant", context);
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    last.content = `${last.content}\n\n${content}`;
  } else {
    messages.push({ role: "assistant", content });
  }
}

function isApproximateLineMatch(target: string, candidate: string): boolean {
  if (!target || !candidate) return false;
  if (target === candidate) return true;
  const shorter = target.length <= candidate.length ? target : candidate;
  const longer = target.length <= candidate.length ? candidate : target;
  if (shorter.length < MIN_APPROX_MATCH_LENGTH) {
    return false;
  }
  if (!longer.includes(shorter)) {
    return false;
  }
  return shorter.length / longer.length >= MIN_APPROX_MATCH_RATIO;
}

function parseInlineToolCalls(
  text: string,
  tools: Record<string, unknown> | undefined,
): Array<{ toolName: string; args: unknown }> {
  if (!tools) return [];
  const matches: Array<{ toolName: string; args: unknown }> = [];
  const regex = /@([a-zA-Z0-9_]+)\(([\s\S]*?)\)/g;
  let match: RegExpExecArray | null = null;

  const parseNamedArgs = (raw: string): unknown => {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return { value: trimmed };
      }
    }

    const result: Record<string, unknown> = {};
    let depth = 0;
    let inString = false;
    let quoteChar = "";
    let start = 0;
    const pushSegment = (end: number) => {
      const seg = trimmed.slice(start, end).trim();
      if (!seg) return;
      const eq = seg.indexOf("=");
      if (eq === -1) return;
      const key = seg.slice(0, eq).trim();
      const valueRaw = seg.slice(eq + 1).trim();
      if (!key) return;
      try {
        if (valueRaw === "true") result[key] = true;
        else if (valueRaw === "false") result[key] = false;
        else if (valueRaw === "null") result[key] = null;
        else if (
          valueRaw.startsWith("{") || valueRaw.startsWith("[") ||
          valueRaw.startsWith('"')
        ) {
          result[key] = JSON.parse(valueRaw);
        } else if (!Number.isNaN(Number(valueRaw))) {
          result[key] = Number(valueRaw);
        } else {
          result[key] = valueRaw;
        }
      } catch {
        result[key] = valueRaw;
      }
    };

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i] ?? "";
      if (inString) {
        if (ch === quoteChar && trimmed[i - 1] !== "\\") {
          inString = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quoteChar = ch;
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      if (ch === ")" || ch === "}" || ch === "]") {
        depth = Math.max(0, depth - 1);
      }
      if (ch === "," && depth === 0) {
        pushSegment(i);
        start = i + 1;
      }
    }
    pushSegment(trimmed.length);
    return result;
  };

  while ((match = regex.exec(text))) {
    const toolName = match[1] ?? "";
    if (!toolName || !(toolName in tools)) continue;
    const rawArgs = match[2] ?? "";
    matches.push({ toolName, args: parseNamedArgs(rawArgs) });
    if (matches.length >= 8) break;
  }

  return matches;
}

function readFileLines(filePath: string): string[] | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw.split(/\r?\n/);
  } catch {
    return null;
  }
}

function validateCodemapLocations(codemap: Codemap): LocationMismatch[] {
  const mismatches: LocationMismatch[] = [];
  const fileCache = new Map<string, string[]>();

  for (const trace of codemap.traces) {
    for (const location of trace.locations) {
      const expected = location.lineContent ?? "";
      if (!location.path || !Number.isFinite(location.lineNumber)) {
        mismatches.push({
          traceId: trace.id,
          locationId: location.id,
          path: location.path,
          lineNumber: location.lineNumber,
          expected,
          actual: "",
        });
        continue;
      }

      let lines = fileCache.get(location.path);
      if (!lines) {
        const loaded = readFileLines(location.path);
        if (!loaded) {
          mismatches.push({
            traceId: trace.id,
            locationId: location.id,
            path: location.path,
            lineNumber: location.lineNumber,
            expected,
            actual: "",
          });
          continue;
        }
        lines = loaded;
        fileCache.set(location.path, lines);
      }

      const idx = location.lineNumber - 1;
      if (idx < 0 || idx >= lines.length) {
        mismatches.push({
          traceId: trace.id,
          locationId: location.id,
          path: location.path,
          lineNumber: location.lineNumber,
          expected,
          actual: "",
        });
        continue;
      }

      const actual = lines[idx] ?? "";
      if (normalizeLine(actual) !== normalizeLine(expected)) {
        mismatches.push({
          traceId: trace.id,
          locationId: location.id,
          path: location.path,
          lineNumber: location.lineNumber,
          expected,
          actual,
        });
      }
    }
  }

  return mismatches;
}

function findUniqueLineMatch(
  target: string,
  workspaceRoot: string | undefined,
  candidatePaths: string[],
  fileCache: Map<string, string[]>,
): { path: string; lineNumber: number; lineContent: string } | null {
  const normalizedTarget = normalizeLine(target);
  if (!normalizedTarget) {
    return null;
  }

  const matches: Array<
    { path: string; lineNumber: number; lineContent: string }
  > = [];

  const searchInFile = (filePath: string): void => {
    let lines = fileCache.get(filePath);
    if (!lines) {
      const loaded = readFileLines(filePath);
      if (!loaded) {
        return;
      }
      lines = loaded;
      fileCache.set(filePath, lines);
    }
    for (let i = 0; i < lines.length; i++) {
      if (normalizeLine(lines[i]) === normalizedTarget) {
        matches.push({
          path: filePath,
          lineNumber: i + 1,
          lineContent: lines[i],
        });
        if (matches.length > 1) {
          return;
        }
      }
    }
  };

  for (const filePath of candidatePaths) {
    searchInFile(filePath);
    if (matches.length > 1) {
      return null;
    }
  }
  if (matches.length === 1) {
    return matches[0];
  }

  if (!workspaceRoot) {
    return null;
  }

  let scanned = 0;
  const stack = [workspaceRoot];
  while (stack.length > 0 && scanned < MAX_FIX_SCAN_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (scanned >= MAX_FIX_SCAN_FILES) {
        break;
      }
      if (entry.name.startsWith(".")) {
        if (!IGNORED_DIRS.has(entry.name)) {
          continue;
        }
      }
      const fullPath = `${dir}/${entry.name}`.replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = fullPath.slice(fullPath.lastIndexOf("."));
      if (!ALLOWED_FIX_EXTS.has(ext)) {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_FIX_SCAN_BYTES) {
        continue;
      }
      scanned += 1;
      searchInFile(fullPath);
      if (matches.length > 1) {
        return null;
      }
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

function findApproximateLineMatchInFile(
  target: string,
  filePath: string,
  fileCache: Map<string, string[]>,
): { path: string; lineNumber: number; lineContent: string } | null {
  const normalizedTarget = normalizeLine(target);
  if (!normalizedTarget) {
    return null;
  }
  let lines = fileCache.get(filePath);
  if (!lines) {
    const loaded = readFileLines(filePath);
    if (!loaded) {
      return null;
    }
    lines = loaded;
    fileCache.set(filePath, lines);
  }

  const matches: Array<
    { path: string; lineNumber: number; lineContent: string }
  > = [];
  for (let i = 0; i < lines.length; i++) {
    const normalizedLine = normalizeLine(lines[i]);
    if (isApproximateLineMatch(normalizedTarget, normalizedLine)) {
      matches.push({
        path: filePath,
        lineNumber: i + 1,
        lineContent: lines[i],
      });
      if (matches.length > 1) {
        return null;
      }
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

function validateCodemapStructure(codemap: Codemap, workspaceRoot?: string): {
  fatal: string[];
  warnings: string[];
} {
  const fatal: string[] = [];
  const warnings: string[] = [];

  if (!codemap.title || typeof codemap.title !== "string") {
    fatal.push("Missing or invalid codemap.title (string required).");
  }
  if (!codemap.description || typeof codemap.description !== "string") {
    fatal.push("Missing or invalid codemap.description (string required).");
  }
  if (!Array.isArray(codemap.traces) || codemap.traces.length === 0) {
    fatal.push("codemap.traces must be a non-empty array.");
    return { fatal, warnings };
  }

  for (const trace of codemap.traces) {
    if (!trace.id || typeof trace.id !== "string") {
      fatal.push(`Trace missing id (string required).`);
    }
    if (!trace.title || typeof trace.title !== "string") {
      fatal.push(`Trace ${trace.id || "<unknown>"} missing title.`);
    }
    if (!trace.description || typeof trace.description !== "string") {
      fatal.push(`Trace ${trace.id || "<unknown>"} missing description.`);
    }
    if (!Array.isArray(trace.locations) || trace.locations.length === 0) {
      fatal.push(
        `Trace ${trace.id || "<unknown>"} must include at least 1 location.`,
      );
      continue;
    }
    for (const location of trace.locations) {
      if (!location.id || typeof location.id !== "string") {
        fatal.push(`Location missing id in trace ${trace.id || "<unknown>"}.`);
      }
      if (!location.path || typeof location.path !== "string") {
        fatal.push(`Location ${location.id || "<unknown>"} missing path.`);
      } else {
        if (/^\/[a-zA-Z]:[\\/]/.test(location.path)) {
          fatal.push(
            `Location ${location.id} path "${location.path}" must not start with "/<drive>:"; use "C:/..." or "C:\\\\...".`,
          );
        }
        if (location.path.endsWith("/") || location.path.endsWith("\\")) {
          fatal.push(
            `Location ${location.id} path "${location.path}" points to a directory; use a file path.`,
          );
        }
        if (!path.isAbsolute(location.path)) {
          fatal.push(
            `Location ${location.id} path "${location.path}" is not absolute.`,
          );
        }
        if (workspaceRoot) {
          try {
            const stat = fs.statSync(location.path);
            if (!stat.isFile()) {
              fatal.push(
                `Location ${location.id} path "${location.path}" is not a file.`,
              );
            }
          } catch {
            fatal.push(
              `Location ${location.id} path "${location.path}" does not exist.`,
            );
          }
        }
      }
      if (!Number.isFinite(location.lineNumber) || location.lineNumber <= 0) {
        fatal.push(
          `Location ${location.id || "<unknown>"} has invalid lineNumber.`,
        );
      }
      if (!location.lineContent || typeof location.lineContent !== "string") {
        fatal.push(
          `Location ${location.id || "<unknown>"} missing lineContent.`,
        );
      }
      if (!location.title || typeof location.title !== "string") {
        fatal.push(`Location ${location.id || "<unknown>"} missing title.`);
      }
      if (!location.description || typeof location.description !== "string") {
        fatal.push(
          `Location ${location.id || "<unknown>"} missing description.`,
        );
      }
    }
  }

  return { fatal, warnings };
}

function applyLocationFixes(
  codemap: Codemap,
  workspaceRoot?: string,
): {
  fixed: number;
  unmatched: number;
  details: Array<{
    traceId: string;
    locationId: string;
    from: { path: string; lineNumber: number };
    to: { path: string; lineNumber: number };
    matchKind?: "exact" | "approximate";
  }>;
} {
  let fixed = 0;
  let unmatched = 0;
  const details: Array<{
    traceId: string;
    locationId: string;
    from: { path: string; lineNumber: number };
    to: { path: string; lineNumber: number };
    matchKind?: "exact" | "approximate";
  }> = [];
  const fileCache = new Map<string, string[]>();
  const candidatePaths = Array.from(
    new Set(
      codemap.traces.flatMap((trace) =>
        trace.locations.map((location) => location.path).filter(Boolean)
      ),
    ),
  );

  for (const trace of codemap.traces) {
    for (const location of trace.locations) {
      if (!location.path) {
        unmatched += 1;
        continue;
      }
      let lines = fileCache.get(location.path);
      if (!lines) {
        const loaded = readFileLines(location.path);
        if (!loaded) {
          unmatched += 1;
          continue;
        }
        lines = loaded;
        fileCache.set(location.path, lines);
      }
      const idx = location.lineNumber - 1;
      const currentLine = idx >= 0 && idx < lines.length ? lines[idx] : "";
      if (
        normalizeLine(currentLine) === normalizeLine(location.lineContent ?? "")
      ) {
        continue;
      }
      const approxMatch = findApproximateLineMatchInFile(
        location.lineContent ?? "",
        location.path,
        fileCache,
      );
      if (approxMatch) {
        const from = { path: location.path, lineNumber: location.lineNumber };
        location.lineNumber = approxMatch.lineNumber;
        location.lineContent = approxMatch.lineContent;
        fixed += 1;
        details.push({
          traceId: trace.id,
          locationId: location.id,
          from,
          to: { path: approxMatch.path, lineNumber: approxMatch.lineNumber },
          matchKind: "approximate",
        });
        continue;
      }
      const match = findUniqueLineMatch(
        location.lineContent ?? "",
        workspaceRoot,
        candidatePaths,
        fileCache,
      );
      if (!match) {
        unmatched += 1;
        continue;
      }
      const from = { path: location.path, lineNumber: location.lineNumber };
      location.path = match.path;
      location.lineNumber = match.lineNumber;
      location.lineContent = match.lineContent;
      fixed += 1;
      details.push({
        traceId: trace.id,
        locationId: location.id,
        from,
        to: { path: match.path, lineNumber: match.lineNumber },
        matchKind: "exact",
      });
    }
  }

  return { fixed, unmatched, details };
}

function buildLocationMismatchFeedback(
  mismatches: LocationMismatch[],
  attempt?: number,
): string {
  const lines = mismatches.slice(0, 8).map((m) => {
    const actual = m.actual
      ? `actual="${m.actual.trim()}"`
      : 'actual="<missing>"';
    return `- ${m.path}:${m.lineNumber} (${m.locationId}) expected="${m.expected.trim()}" ${actual}`;
  });

  let guidance = "Some codemap locations do not match the file contents. ";
  const hasMissing = mismatches.some((m) => !m.actual);
  const hasMismatches = mismatches.some((m) =>
    m.actual && m.actual !== m.expected
  );

  if (hasMissing) {
    guidance +=
      "For missing locations, ensure the file path exists and the line number is within the file bounds. ";
  }
  if (hasMismatches) {
    guidance +=
      "For content mismatches, ensure lineContent exactly matches the code at that line (including whitespace). ";
  }
  guidance +=
    "Use absolute file paths, verify line numbers are 1-based, and include lineContent for every location. Keep direct call edges only.";
  if (attempt && attempt > 1) {
    guidance +=
      ` This is attempt ${attempt}, please double-check all locations carefully.`;
  }
  guidance += "\n";

  return guidance + lines.join("\n");
}

function buildCodemapStructureFeedback(
  issues: string[],
  attempt?: number,
): string {
  const bulletList = issues.slice(0, 12).map((issue) => `- ${issue}`).join(
    "\n",
  );
  let message =
    "The codemap JSON is invalid or incomplete. Fix the following issues and include a <CODEMAP>...</CODEMAP> block with valid JSON. " +
    "Extra text is fine as long as the <CODEMAP> block is present and parseable.";
  if (attempt && attempt > 1) {
    message +=
      ` This is attempt ${attempt}, please ensure the JSON is valid and complete.`;
  }
  return message + "\n" + bulletList;
}

function buildTraceStageFeedback(stageNumber: number, reason: string): string {
  const tag = stageNumber === 5 ? "TRACE_GUIDE" : "TRACE_TEXT_DIAGRAM";
  const stageLabel = `Stage ${stageNumber}`;
  return (
    `Your ${stageLabel} response is invalid: ${reason}. ` +
    `Output ONLY <${tag}>...</${tag}> with no extra text or code fences.`
  );
}

function toCoreMessages(
  baseMessages: CodemapStage12ContextV1["baseMessages"],
): ModelMessage[] {
  // ModelMessage supports richer shapes, but we only persist string content.
  return baseMessages.map((m) => ({ role: m.role, content: m.content }));
}

function logRequestPayload(
  stage: string,
  systemPromptSource: string,
  messages: ModelMessage[],
) {
  logger.agentRaw(`[${stage}] SYSTEM PROMPT SOURCE: ${systemPromptSource}`);
  const lastMessage = messages[messages.length - 1];
  if (lastMessage) {
    const contentLength = typeof lastMessage.content === "string"
      ? lastMessage.content.length
      : JSON.stringify(lastMessage.content).length;
    logger.agentRaw(
      `[${stage}] NEW MESSAGE (${lastMessage.role}, ${contentLength} chars)`,
    );
  } else {
    logger.agentRaw(`[${stage}] MESSAGES: []`);
  }
}

function normalizeToolArgs(args: unknown): unknown {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args;
}

function toToolResultOutput(value: unknown): ToolResultOutput {
  if (typeof value === "string") {
    return { type: "text", value };
  }
  if (value === undefined) {
    return { type: "json", value: null };
  }
  try {
    return { type: "json", value: JSON.parse(JSON.stringify(value)) as any };
  } catch {
    return { type: "text", value: String(value) };
  }
}

async function runStreamedToolLoop(options: {
  label: string;
  systemPrompt: string;
  systemPromptSource: string;
  messages: ModelMessage[];
  tools?: Record<string, any>;
  client: NonNullable<ReturnType<typeof getAIClient>>;
  callbacks?: CodemapCallbacks;
  abortSignal?: AbortSignal;
  requireToolUse?: boolean;
  maxRounds?: number;
  maxOutputChars?: number;
  maxParallelTools?: number;
}): Promise<{
  text?: string;
  usedTools: boolean;
  usedToolNames: string[];
  totalOutputChars: number;
}> {
  const {
    label,
    systemPrompt,
    systemPromptSource,
    messages,
    tools,
    client,
    callbacks,
    abortSignal,
    requireToolUse = false,
    maxRounds = 8,
    maxOutputChars = 400000,
    maxParallelTools = 4,
  } = options;

  let usedTools = false;
  const usedToolNames = new Set<string>();
  let noToolRounds = 0;
  let totalChars = 0;
  const seenToolCalls = new Map<string, string>();
  let activeTools = 0;
  const waitQueue: Array<() => void> = [];

  const getListDirPath = (args: unknown): string | undefined => {
    if (!args || typeof args !== "object") {
      return undefined;
    }
    const rec = args as Record<string, unknown>;
    if (Array.isArray(rec.directories) && rec.directories.length === 1) {
      const value = rec.directories[0];
      return typeof value === "string" ? value : undefined;
    }
    const value = rec.DirectoryPath ?? rec.directory_path ?? rec.path;
    return typeof value === "string" ? value : undefined;
  };

  for (let round = 1; round <= maxRounds; round++) {
    if (abortSignal?.aborted) throw new Error("Generation cancelled");

    logRequestPayload(`${label} Round ${round}`, systemPromptSource, messages);
    const modelStreamStart = Date.now();
    logger.debug(
      `[${label} Round ${round}] Tools provided: ${
        tools ? Object.keys(tools).join(",") : "<none>"
      }`,
    );
    let firstToolCallAt: number | null = null;
    let firstTextAt: number | null = null;
    const result = await streamText({
      model: client(getModelName()),
      system: systemPrompt,
      messages,
      tools: tools && Object.keys(tools).length > 0 ? tools : undefined,
      toolChoice: requireToolUse ? "required" : "auto",
      abortSignal,
    });

    let text = "";
    const toolCalls: Array<
      { toolCallId: string; toolName: string; args: unknown }
    > = [];
    const pending: Array<
      Promise<{ toolCallId: string; message: ModelMessage }>
    > = [];
    let sawToolCall = false;

    const acquire = async () =>
      new Promise<void>((resolve) => {
        if (activeTools < maxParallelTools) {
          activeTools += 1;
          callbacks?.onParallelToolState?.(activeTools);
          resolve();
          return;
        }
        waitQueue.push(resolve);
      });

    const release = () => {
      activeTools = Math.max(0, activeTools - 1);
      callbacks?.onParallelToolState?.(activeTools);
      const next = waitQueue.shift();
      if (next) {
        activeTools += 1;
        callbacks?.onParallelToolState?.(activeTools);
        next();
      }
    };

    const runToolCall = async (
      call: { toolCallId: string; toolName: string; args: unknown },
    ) => {
      const tool = tools?.[call.toolName];
      let resultValue: unknown;
      const normalizedArgs = normalizeToolArgs(call.args);
      logger.debug(
        `[RAW] Tool call ${call.toolName}: ${JSON.stringify(call.args)}`,
      );
      const toolKey = `${call.toolName}:${JSON.stringify(normalizedArgs)}`;
      usedToolNames.add(call.toolName);

      if (call.toolName === "list_dir" && seenToolCalls.has(toolKey)) {
        const listPath = getListDirPath(normalizedArgs);
        resultValue = listPath
          ? `Skipped list_dir: already listed ${listPath}. Use grep_search or read_file.`
          : "Skipped list_dir: already listed those directories. Use grep_search or read_file.";
      }

      if (
        resultValue === undefined &&
        (!tool || typeof tool.execute !== "function")
      ) {
        resultValue = `Error: Tool not found: ${call.toolName}`;
      } else if (resultValue === undefined) {
        try {
          const toolStart = Date.now();
          resultValue = await tool.execute(normalizedArgs);
          const toolDuration = Date.now() - toolStart;
          logger.info(
            `[${label}] Tool ${call.toolName} completed in ${toolDuration}ms`,
          );
        } catch (error) {
          const errorMsg = error instanceof Error
            ? error.message
            : String(error);
          resultValue = `Error executing tool "${call.toolName}": ${errorMsg}`;
        }
      }
      if (!seenToolCalls.has(toolKey)) {
        seenToolCalls.set(toolKey, call.toolName);
      }

      const argsText = typeof normalizedArgs === "string"
        ? normalizedArgs
        : JSON.stringify(normalizedArgs, null, 2);
      const resultText = typeof resultValue === "string"
        ? resultValue
        : JSON.stringify(resultValue, null, 2);
      callbacks?.onToolCall?.(
        call.toolName,
        argsText,
        resultText.slice(0, 500),
      );

      return {
        role: "tool" as const,
        content: [{
          type: "tool-result" as const,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: toToolResultOutput(resultValue),
        }],
      };
    };

    for await (const part of result.fullStream) {
      if (abortSignal?.aborted) throw new Error("Generation cancelled");
      if (part.type !== "error" && part.type !== "text-delta") {
        logger.debug(`[${label} Round ${round}] Stream part type=${part.type}`);
      }
      if (part.type === "tool-call") {
        logger.debug(
          `[${label} Round ${round}] Tool-call part: ${JSON.stringify(part)}`,
        );
      }
      if (part.type === "text-delta") {
        if (sawToolCall) {
          // If the model starts emitting text after tool calls, stop early.
          break;
        }
        if (!firstTextAt) {
          firstTextAt = Date.now();
        }
        text += part.text;
        totalChars += part.text.length;
        callbacks?.onToken?.(part.text);
      } else if (part.type === "tool-call") {
        sawToolCall = true;
        if (!firstToolCallAt) {
          firstToolCallAt = Date.now();
        }
        const maybeBatch = part.input && typeof part.input === "object"
          ? (part.input as {
            toolCalls?: Array<{ toolName: string; args?: unknown }>;
          }).toolCalls
          : undefined;
        const emittedCalls = Array.isArray(maybeBatch)
          ? maybeBatch.map((c, idx) => ({
            toolCallId: `${part.toolCallId}:${idx}`,
            toolName: c.toolName,
            args: c.args ?? {},
          }))
          : [{
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.input,
          }];
        for (const call of emittedCalls) {
          toolCalls.push(call);
          logger.debug(
            `[${label} Round ${round}] Emitted call: id=${call.toolCallId} name=${call.toolName} args=${
              JSON.stringify(call.args)
            }`,
          );
          const promise = (async () => {
            await acquire();
            try {
              const message = await runToolCall(call);
              return { toolCallId: call.toolCallId, message };
            } finally {
              release();
            }
          })();
          pending.push(promise);
        }
      }
      if (totalChars > maxOutputChars) {
        throw new Error(
          `Output budget reached (${maxOutputChars} chars) in ${label}`,
        );
      }
    }
    const modelStreamEnd = Date.now();
    const modelStreamMs = modelStreamEnd - modelStreamStart;
    const toolDelayMs = firstToolCallAt
      ? firstToolCallAt - modelStreamStart
      : null;
    const textDelayMs = firstTextAt ? firstTextAt - modelStreamStart : null;
    const delayInfo = [
      toolDelayMs !== null ? `firstToolCall=${toolDelayMs}ms` : null,
      textDelayMs !== null ? `firstText=${textDelayMs}ms` : null,
    ].filter(Boolean).join(", ");
    logger.info(
      `[${label} Round ${round}] Model stream completed in ${modelStreamMs}ms` +
        (delayInfo ? ` (${delayInfo})` : ""),
    );

    let usedInlineToolCalls = false;
    if (toolCalls.length === 0) {
      const inlineToolCalls = parseInlineToolCalls(text, tools);
      if (inlineToolCalls.length > 0) {
        usedInlineToolCalls = true;
        for (const call of inlineToolCalls) {
          const toolCallId = `${label}:inline:${toolCalls.length}`;
          toolCalls.push({
            toolCallId,
            toolName: call.toolName,
            args: call.args,
          });
          const promise = (async () => {
            await acquire();
            try {
              const message = await runToolCall({
                toolCallId,
                toolName: call.toolName,
                args: call.args,
              });
              return { toolCallId, message };
            } finally {
              release();
            }
          })();
          pending.push(promise);
        }
      }
    }

    if (toolCalls.length > 0) {
      const contentParts: Array<Record<string, unknown>> = [];
      if (text.length > 0 && !usedInlineToolCalls) {
        contentParts.push({ type: "text", text });
        callbacks?.onMessage?.("assistant", text);
      }
      for (const call of toolCalls) {
        contentParts.push({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.args,
        });
      }
      if (contentParts.length > 0) {
        messages.push({ role: "assistant", content: contentParts as any });
      }
    } else if (text.length > 0) {
      messages.push({ role: "assistant", content: text });
      callbacks?.onMessage?.("assistant", text);
    }

    if (toolCalls.length === 0) {
      if (requireToolUse && !usedTools) {
        noToolRounds++;
        messages.push({
          role: "system",
          content:
            "You must use the provided tools. Do not describe tool calls in text. Emit actual tool calls using the tool calling mechanism.",
        });
        if (noToolRounds < 3) {
          continue;
        }
      }
      return {
        text,
        usedTools,
        usedToolNames: Array.from(usedToolNames),
        totalOutputChars: totalChars,
      };
    }

    usedTools = true;
    const resolved = await Promise.all(pending);
    logger.debug(
      `[${label} Round ${round}] Resolved ${resolved.length} tool call results`,
    );
    const messageById = new Map<string, ModelMessage>();
    for (const entry of resolved) {
      messageById.set(entry.toolCallId, entry.message);
    }
    logger.debug(
      `[${label} Round ${round}] messageById keys: ${
        Array.from(messageById.keys()).join(",")
      }`,
    );
    logger.debug(
      `[${label} Round ${round}] expected toolCalls: ${
        toolCalls.map((c) => c.toolCallId).join(",")
      }`,
    );
    for (const call of toolCalls) {
      const message = messageById.get(call.toolCallId);
      if (message) {
        messages.push(message);
      } else {
        logger.warn(
          `[${label} Round ${round}] No message for toolCallId=${call.toolCallId} (tool=${call.toolName})`,
        );
      }
    }
  }

  return {
    text: undefined,
    usedTools,
    usedToolNames: Array.from(usedToolNames),
    totalOutputChars: totalChars,
  };
}

/**
 * Process a single trace through stages 3-5 (or 3-4 if includeGuide is false)
 */
async function processTraceStages(
  traceId: string,
  systemPrompt: string,
  systemPromptSource: string,
  baseMessages: ModelMessage[],
  workspaceRoot: string,
  currentDate: string,
  language: string,
  callbacks: CodemapCallbacks = {},
  options: TraceProcessingOptions = { includeGuide: true },
): Promise<TraceProcessingResult> {
  const stagesDescription = options.includeGuide ? "stages 3-5" : "stages 3-4";
  const client = getAIClient({ onToken: callbacks.onToken })!;

  const messages: ModelMessage[] = [...baseMessages];
  let diagram: string | undefined;
  let guide: string | undefined;
  const maxTraceAttempts = 2;
  const appendContext: AppendContext = { workspaceRoot, callbacks };

  try {
    // Stage 3: Generate trace text diagram
    logger.info(
      `[Trace ${traceId}] Stage 3: Starting - Generate trace text diagram`,
    );
    callbacks.onTraceProcessing?.(traceId, 3, "start");
    const stage3Prompt = loadTraceStagePrompt(3, traceId, {
      current_date: currentDate,
      language,
    });
    logger.debug(
      `[Trace ${traceId}] Stage 3 prompt length: ${stage3Prompt.length}`,
    );
    appendUserMessage(messages, stage3Prompt, {
      ...appendContext,
      label: `Trace ${traceId} Stage 3 prompt`,
    });

    let stage3Error: string | null = null;
    let stage3Diagram: string | null = null;
    for (let attempt = 1; attempt <= maxTraceAttempts; attempt++) {
      if (attempt > 1 && stage3Error) {
        appendUserMessage(messages, buildTraceStageFeedback(3, stage3Error), {
          ...appendContext,
          label: `Trace ${traceId} Stage 3 retry`,
        });
        callbacks.onMessage?.(
          "user",
          `[Trace ${traceId} Stage 3] Retrying (${attempt}/${maxTraceAttempts})...`,
        );
      }

      if (options.abortSignal?.aborted) throw new Error("Generation cancelled");

      logger.info(`[Trace ${traceId}] Stage 3: Calling API...`);
      const stage3Result = await runStreamedToolLoop({
        label: `Trace ${traceId} Stage 3`,
        systemPrompt,
        systemPromptSource,
        messages,
        client,
        callbacks,
        abortSignal: options.abortSignal,
        maxParallelTools: 4,
      });
      logger.info(
        `[Trace ${traceId}] Stage 3: API response received, text length: ${
          stage3Result.text?.length || 0
        }`,
      );

      if (!stage3Result.text) {
        stage3Error = "No text in response";
        logger.warn(`[Trace ${traceId}] Stage 3: ${stage3Error}`);
        continue;
      }

      logger.agentRaw(
        `[Trace ${traceId} Stage 3] RESPONSE:\n${stage3Result.text}`,
      );
      stage3Diagram = extractTraceDiagram(stage3Result.text);
      if (!stage3Diagram) {
        stage3Error = "Missing <TRACE_TEXT_DIAGRAM> block";
        logger.warn(`[Trace ${traceId}] Stage 3: ${stage3Error}`);
        continue;
      }
      callbacks.onMessage?.(
        "assistant",
        `[Trace ${traceId} Stage 3] Generated initial diagram`,
      );
      break;
    }
    if (!stage3Diagram) {
      return {
        traceId,
        error: "Stage 3 did not produce a valid <TRACE_TEXT_DIAGRAM> block.",
      };
    }
    appendAssistantMessage(
      messages,
      `<TRACE_TEXT_DIAGRAM>\n${stage3Diagram}\n</TRACE_TEXT_DIAGRAM>`,
      { ...appendContext, label: `Trace ${traceId} Stage 3 output` },
    );
    callbacks.onTraceProcessing?.(traceId, 3, "complete");
    logger.info(`[Trace ${traceId}] Stage 3: Complete`);

    // Stage 4: Add location decorations to diagram
    logger.info(
      `[Trace ${traceId}] Stage 4: Starting - Add location decorations`,
    );
    callbacks.onTraceProcessing?.(traceId, 4, "start");
    const stage4Prompt = loadTraceStagePrompt(4, traceId, {
      current_date: currentDate,
      language,
    });
    appendUserMessage(messages, stage4Prompt, {
      ...appendContext,
      label: `Trace ${traceId} Stage 4 prompt`,
    });

    let stage4Error: string | null = null;
    for (let attempt = 1; attempt <= maxTraceAttempts; attempt++) {
      if (attempt > 1 && stage4Error) {
        appendUserMessage(messages, buildTraceStageFeedback(4, stage4Error), {
          ...appendContext,
          label: `Trace ${traceId} Stage 4 retry`,
        });
        callbacks.onMessage?.(
          "user",
          `[Trace ${traceId} Stage 4] Retrying (${attempt}/${maxTraceAttempts})...`,
        );
      }

      if (options.abortSignal?.aborted) throw new Error("Generation cancelled");

      logger.info(`[Trace ${traceId}] Stage 4: Calling API...`);
      const stage4Result = await runStreamedToolLoop({
        label: `Trace ${traceId} Stage 4`,
        systemPrompt,
        systemPromptSource,
        messages,
        client,
        callbacks,
        abortSignal: options.abortSignal,
        maxParallelTools: 4,
      });
      logger.info(
        `[Trace ${traceId}] Stage 4: API response received, text length: ${
          stage4Result.text?.length || 0
        }`,
      );

      if (!stage4Result.text) {
        stage4Error = "No text in response";
        logger.warn(`[Trace ${traceId}] Stage 4: ${stage4Error}`);
        continue;
      }

      logger.agentRaw(
        `[Trace ${traceId} Stage 4] RESPONSE:\n${stage4Result.text}`,
      );
      diagram = extractTraceDiagram(stage4Result.text) || undefined;
      logger.info(
        `[Trace ${traceId}] Stage 4: Diagram extracted: ${
          diagram ? "YES" : "NO"
        }`,
      );
      if (!diagram) {
        stage4Error = "Missing <TRACE_TEXT_DIAGRAM> block";
        logger.warn(`[Trace ${traceId}] Stage 4: ${stage4Error}`);
        continue;
      }
      logger.debug(
        `[Trace ${traceId}] Stage 4: Diagram length: ${diagram.length}`,
      );
      callbacks.onMessage?.(
        "assistant",
        `[Trace ${traceId} Stage 4] Added location decorations`,
      );
      break;
    }
    callbacks.onTraceProcessing?.(traceId, 4, "complete");
    logger.info(`[Trace ${traceId}] Stage 4: Complete`);
    if (!diagram) {
      return {
        traceId,
        error: "Stage 4 did not produce a valid <TRACE_TEXT_DIAGRAM> block.",
      };
    }

    // Stage 5: Generate trace guide (only if includeGuide is true)
    if (options.includeGuide) {
      logger.info(
        `[Trace ${traceId}] Stage 5: Starting - Generate trace guide`,
      );
      callbacks.onTraceProcessing?.(traceId, 5, "start");
      const stage5Prompt = loadTraceStagePrompt(5, traceId, {
        current_date: currentDate,
        language,
      });
      appendUserMessage(messages, stage5Prompt, {
        ...appendContext,
        label: `Trace ${traceId} Stage 5 prompt`,
      });

      let stage5Error: string | null = null;
      for (let attempt = 1; attempt <= maxTraceAttempts; attempt++) {
        if (attempt > 1 && stage5Error) {
          appendUserMessage(messages, buildTraceStageFeedback(5, stage5Error), {
            ...appendContext,
            label: `Trace ${traceId} Stage 5 retry`,
          });
          callbacks.onMessage?.(
            "user",
            `[Trace ${traceId} Stage 5] Retrying (${attempt}/${maxTraceAttempts})...`,
          );
        }

        if (options.abortSignal?.aborted) {
          throw new Error("Generation cancelled");
        }

        logger.info(`[Trace ${traceId}] Stage 5: Calling API...`);
        const stage5Result = await runStreamedToolLoop({
          label: `Trace ${traceId} Stage 5`,
          systemPrompt,
          systemPromptSource,
          messages,
          client,
          callbacks,
          abortSignal: options.abortSignal,
          maxParallelTools: 4,
        });
        logger.info(
          `[Trace ${traceId}] Stage 5: API response received, text length: ${
            stage5Result.text?.length || 0
          }`,
        );

        if (!stage5Result.text) {
          stage5Error = "No text in response";
          logger.warn(`[Trace ${traceId}] Stage 5: ${stage5Error}`);
          continue;
        }

        logger.agentRaw(
          `[Trace ${traceId} Stage 5] RESPONSE:\n${stage5Result.text}`,
        );
        guide = extractTraceGuide(stage5Result.text) || undefined;
        logger.info(
          `[Trace ${traceId}] Stage 5: Guide extracted: ${
            guide ? "YES" : "NO"
          }`,
        );
        if (!guide) {
          stage5Error = "Missing <TRACE_GUIDE> block";
          logger.warn(`[Trace ${traceId}] Stage 5: ${stage5Error}`);
          continue;
        }
        logger.debug(
          `[Trace ${traceId}] Stage 5: Guide length: ${guide.length}`,
        );
        callbacks.onMessage?.(
          "assistant",
          `[Trace ${traceId} Stage 5] Generated guide`,
        );
        break;
      }
      callbacks.onTraceProcessing?.(traceId, 5, "complete");
      logger.info(`[Trace ${traceId}] Stage 5: Complete`);
    }

    return { traceId, diagram, guide };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (
      options.abortSignal?.aborted || errorMsg.includes("cancelled") ||
      errorMsg.includes("aborted")
    ) {
      logger.info(`[Trace ${traceId}] Trace processing cancelled`);
      throw error;
    }
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error(
      `[Trace ${traceId}] Error during trace processing: ${errorMsg}`,
    );
    if (errorStack) {
      logger.error(`[Trace ${traceId}] Stack trace: ${errorStack}`);
    }
    return { traceId, error: errorMsg };
  }
}

/**
 * Generate a global mermaid diagram using the mermaid prompt
 */
async function processMermaidDiagram(
  systemPrompt: string,
  systemPromptSource: string,
  baseMessages: ModelMessage[],
  workspaceRoot: string,
  currentDate: string,
  language: string,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal,
): Promise<MermaidProcessingResult> {
  logger.info("[Mermaid] Starting mermaid diagram generation");

  const client = getAIClient({ onToken: callbacks.onToken })!;

  const messages: ModelMessage[] = [...baseMessages];
  const appendContext: AppendContext = { workspaceRoot, callbacks };
  const maxAttempts = 8;
  let lastError: string | null = null;
  let lastDiagram: string | undefined;

  try {
    callbacks.onPhaseChange?.("Mermaid Diagram", 6);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isFirstAttempt = attempt === 1;
      const prompt = isFirstAttempt
        ? loadMermaidPrompt({ current_date: currentDate, language })
        : buildMermaidFixPrompt(
          lastError ?? "Unknown parse error",
          lastDiagram ?? "",
        );

      logger.debug(
        `[Mermaid] Prompt length (attempt ${attempt}/${maxAttempts}): ${prompt.length}`,
      );
      appendUserMessage(messages, prompt, {
        ...appendContext,
        label: "Mermaid prompt",
      });
      callbacks.onMessage?.(
        "user",
        isFirstAttempt
          ? "[Mermaid] Generating global mermaid diagram..."
          : `[Mermaid] Fixing diagram (attempt ${attempt}/${maxAttempts})...`,
      );

      if (abortSignal?.aborted) throw new Error("Generation cancelled");

      logger.info(
        `[Mermaid] Calling API (attempt ${attempt}/${maxAttempts})...`,
      );
      const mermaidResult = await runStreamedToolLoop({
        label: `[Mermaid] Attempt ${attempt}`,
        systemPrompt,
        systemPromptSource,
        messages,
        client,
        callbacks,
        abortSignal,
        maxRounds: 1,
        maxParallelTools: 4,
      });
      logger.info(
        `[Mermaid] API response received, text length: ${
          mermaidResult.text?.length || 0
        }`,
      );

      if (!mermaidResult.text) {
        logger.warn("[Mermaid] No text in response");
        lastError = "No text in mermaid response";
        continue;
      }

      logger.agentRaw(
        `[Mermaid Stage 6 Attempt ${attempt}] RESPONSE:\n${mermaidResult.text}`,
      );

      const extracted = extractMermaidDiagram(mermaidResult.text) || undefined;
      if (!extracted) {
        lastError = "No mermaid code block found in response";
        logger.warn(`[Mermaid] ${lastError}`);
        continue;
      }

      const validation = await validateMermaidDiagram(extracted);
      if (!validation.ok) {
        lastError = validation.error || "Mermaid parse error";
        lastDiagram = extracted;
        callbacks.onMessage?.("error", `[Mermaid] Parse error: ${lastError}`);
        logger.warn(
          `[Mermaid] Parse error on attempt ${attempt}: ${lastError}`,
        );
        continue;
      }

      const diagram = colorizeMermaidDiagram(extracted);
      callbacks.onMessage?.("assistant", "[Mermaid] Mermaid diagram generated");
      logger.info(`[Mermaid] Diagram extracted: YES (attempt ${attempt})`);
      logger.debug(`[Mermaid] Diagram length: ${diagram.length}`);
      return { diagram };
    }

    return {
      error:
        `Mermaid diagram failed to compile after ${maxAttempts} attempts: ${
          lastError || "Unknown error"
        }`,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (
      abortSignal?.aborted || errorMsg.includes("cancelled") ||
      errorMsg.includes("aborted")
    ) {
      logger.info("[Mermaid] Mermaid generation cancelled");
      throw error;
    }
    logger.error(`[Mermaid] Error during mermaid generation: ${errorMsg}`);
    return { error: errorMsg };
  }
}

function buildMermaidFixPrompt(errorMessage: string, diagram: string): string {
  const hasDiagram = diagram.trim().length > 0;

  let specificAdvice = "";
  const lowerError = errorMessage.toLowerCase();

  if (lowerError.includes("dangling edge")) {
    specificAdvice =
      "- Ensure all edges have both source and target nodes.\n- Check for incomplete lines ending with --> or -.-> without a target.\n";
  } else if (lowerError.includes("syntax") || lowerError.includes("parse")) {
    specificAdvice =
      '- Check for spaces in node IDs - use camelCase or underscores.\n- Ensure subgraph syntax: subgraph id [Label]\n- Avoid reserved words like end, graph, subgraph as node IDs.\n- Wrap edge labels with special characters in quotes: -->|"label"| \n';
  } else if (lowerError.includes("node") || lowerError.includes("id")) {
    specificAdvice =
      '- Node IDs cannot contain spaces - use camelCase, PascalCase, or underscores.\n- Avoid reserved keywords: end, subgraph, graph, flowchart.\n- For nodes with special characters in labels, use quotes: A["Label with spaces"]\n';
  } else if (lowerError.includes("subgraph")) {
    specificAdvice =
      "- Subgraph syntax: subgraph uniqueId [Display Label]\n- Do not use spaces in subgraph IDs.\n- Ensure subgraph is properly closed.\n";
  }

  return (
    `The Mermaid diagram you produced failed to parse. Fix it so it compiles.\n\n` +
    `Parse error: ${errorMessage}\n\n` +
    `Requirements:\n` +
    `- Output ONLY a single \`\`\`mermaid code block, no other text.\n` +
    `- Do not include XML tags or analysis text (e.g., <thinking>, <BRAINSTORMING>).\n` +
    `- Keep the diagram structure and labels, change only what is needed to fix parsing.\n` +
    `- Avoid reserved keywords as node IDs: end, subgraph, graph, flowchart.\n` +
    `- For subgraphs, use explicit IDs like: subgraph id [Label].\n` +
    (specificAdvice
      ? `Specific fixes for this error:\n${specificAdvice}`
      : "") +
    (hasDiagram
      ? `\nCurrent diagram:\n` +
        "```mermaid\n" +
        `${diagram}\n` +
        "```\n"
      : `\nNo valid diagram was extracted. Generate a fresh, valid Mermaid diagram using the existing context.\n`)
  );
}

/**
 * Build system prompt based on mode
 */
function buildSystemPrompt(
  mode: CodemapMode,
  variables: Record<string, string>,
  includeAddon: boolean = true,
): string {
  const baseSystemPrompt = loadPrompt("smart", "system", variables);

  if (mode === "fast" && includeAddon) {
    const parallelAddon = loadMaximizeParallelToolCallsAddon();
    return `${baseSystemPrompt}\n\n${parallelAddon}`;
  }

  return baseSystemPrompt;
}

/**
 * Generate codemap with specified mode
 */
export async function generateCodemap(
  query: string,
  workspaceRoot: string,
  mode: CodemapMode,
  detailLevel: DetailLevel = "overview",
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal,
): Promise<Codemap | null> {
  repetitionAlerted = false;
  logger.separator(`CODEMAP GENERATION START - ${mode.toUpperCase()} MODE`);
  logger.info(`Query: ${query}`);
  logger.info(`Workspace: ${workspaceRoot}`);
  logger.info(`Mode: ${mode}`);
  logger.info(`Detail Level: ${detailLevel}`);

  if (!isConfigured()) {
    logger.error("OpenAI API key not configured");
    throw new Error("OpenAI API key not configured");
  }

  const client = getAIClient({ onToken: callbacks.onToken })!;
  logger.info("OpenAI client created successfully");

  // Prepare template variables
  logger.info("Preparing template variables...");
  const workspaceLayout = generateWorkspaceLayout(workspaceRoot);
  const workspaceUri = workspaceRoot.replace(/\\/g, "\\\\");
  const corpusName = workspaceRoot.replace(/\\/g, "/");
  const currentDate = formatCurrentDate();
  logger.debug(`Workspace layout length: ${workspaceLayout.length}`);
  logger.debug(`Current date: ${currentDate}`);

  // Build system prompt based on mode
  logger.info("Building system prompt...");
  const language = getLanguage();
  const variables = {
    workspace_root: workspaceRoot,
    workspace_layout: workspaceLayout,
    workspace_uri: workspaceUri,
    corpus_name: corpusName,
    user_os: getUserOs(),
    language,
  };
  const systemPrompt = buildSystemPrompt(mode, variables, true);
  const systemPromptSource = mode === "fast"
    ? "prompts/smart/system.md + prompts/smart/maximize_parallel_tool_calls.md"
    : "prompts/smart/system.md";
  logger.debug(`System prompt length: ${systemPrompt.length}`);
  logger.agentRaw(
    `[System Prompt] ${mode.toUpperCase()} MODE: ${systemPromptSource}`,
  );

  const messages: ModelMessage[] = [];
  let resultCodemap: Codemap | null = null;
  let mermaidPromise: Promise<MermaidProcessingResult | null> | null = null;
  const appendContext: AppendContext = { workspaceRoot, callbacks };

  callbacks.onMessage?.("system", `Starting ${mode} codemap generation...`);

  try {
    // ========== Stage 1: Research ==========
    logger.separator("STAGE 1: RESEARCH");
    callbacks.onPhaseChange?.("Research", 1);
    const stage1Prompt = loadStagePrompt(1, {
      query,
      current_date: currentDate,
      language,
      detail_level: detailLevel === "overview"
        ? ""
        : `Please be very thorough and exhaustive. Aim for a high level of detail (level: ${detailLevel}).`,
    });
    logger.debug(`Stage 1 prompt length: ${stage1Prompt.length}`);

    appendUserMessage(messages, stage1Prompt, {
      ...appendContext,
      label: "Stage 1 prompt",
    });
    callbacks.onMessage?.("user", `[Stage 1] Research query: ${query}`);

    const vsCodeTools = extensionContext
      ? getSelectedVsCodeTools(extensionContext)
      : {};
    const dynamicTools = { ...allTools, ...vsCodeTools };

    logger.info("Stage 1 - Calling API with streaming tool loop...");
    const requiredResearchTools = new Set(["read_file", "grep_search"]);
    const maxResearchAttempts = 3;
    const maxResearchChars = 12000;
    const stage1UsedToolNames = new Set<string>();
    let researchComplete = false;
    let totalResearchChars = 0;
    let anyAttemptUsedTools = false;

    for (let attempt = 1; attempt <= maxResearchAttempts; attempt++) {
      const stage1Result = await runStreamedToolLoop({
        label: "Stage 1 Research",
        systemPrompt,
        systemPromptSource,
        messages,
        tools: dynamicTools,
        client,
        callbacks,
        abortSignal,
        requireToolUse: true,
        maxRounds: 12,
        maxParallelTools: mode === "fast" ? 6 : 4,
      });
      totalResearchChars += stage1Result.totalOutputChars;
      anyAttemptUsedTools = anyAttemptUsedTools || stage1Result.usedTools;
      if (stage1Result.text) {
        logger.agentRaw(`[Stage 1 Research] RESPONSE:\n${stage1Result.text}`);
        logger.debug(
          `Stage 1 - Response text length: ${stage1Result.text.length}`,
        );
        researchComplete = isResearchComplete(stage1Result.text);
        if (!researchComplete) {
          logger.warn("Stage 1 - Research did not emit completion marker");
        }
      } else {
        logger.warn("Stage 1 - No text in response");
        researchComplete = false;
      }
      for (const toolName of stage1Result.usedToolNames) {
        stage1UsedToolNames.add(toolName);
      }

      const usedRequiredTool = Array.from(stage1UsedToolNames).some((
        toolName,
      ) => requiredResearchTools.has(toolName));
      const overBudget = totalResearchChars >= maxResearchChars;
      if (researchComplete && usedRequiredTool) {
        break;
      }

      if (attempt >= maxResearchAttempts || (overBudget && usedRequiredTool)) {
        if (!usedRequiredTool) {
          throw new Error(
            "Stage 1 did not read files; aborting before Stage 2",
          );
        }
        if (!researchComplete) {
          logger.warn(
            "Stage 1 - Completion marker missing; advancing after research budget.",
          );
        }
        break;
      }

      const missingToolHint = usedRequiredTool
        ? ""
        : " Use read_file or grep_search to inspect file contents.";
      const missingMarkerHint = researchComplete
        ? ""
        : ' When finished, end with: "I am done researching. 1 sentence summary: ... Would you like to hear more?"';
      appendUserMessage(
        messages,
        `Continue researching the codebase.${missingToolHint}${missingMarkerHint}`,
        { ...appendContext, label: "Stage 1 continue research" },
      );
      callbacks.onMessage?.(
        "user",
        `[Stage 1] Continue research (attempt ${
          attempt + 1
        }/${maxResearchAttempts})...`,
      );
    }
    if (!anyAttemptUsedTools) {
      throw new Error("Stage 1 failed to use tools; aborting before Stage 2");
    }
    logger.info("Stage 1 - Research complete");

    // ========== Stage 2: Generate Codemap Structure ==========
    logger.separator("STAGE 2: CODEMAP STRUCTURE");
    callbacks.onPhaseChange?.("Codemap Generation", 2);
    const stage2Prompt = loadStagePrompt(2, {
      query,
      current_date: currentDate,
      language,
      detail_instruction: getDetailInstruction(detailLevel),
    });
    logger.debug(`Stage 2 prompt length: ${stage2Prompt.length}`);

    appendUserMessage(messages, stage2Prompt, {
      ...appendContext,
      label: "Stage 2 prompt",
    });
    callbacks.onMessage?.("user", `[Stage 2] Generating codemap structure...`);

    if (abortSignal?.aborted) throw new Error("Generation cancelled");

    logger.info("Stage 2 - Calling API...");
    const maxStage2Attempts = 3;
    for (let attempt = 1; attempt <= maxStage2Attempts; attempt++) {
      const stage2Result = await runStreamedToolLoop({
        label: `Stage 2 Structure${attempt > 1 ? ` Attempt ${attempt}` : ""}`,
        systemPrompt: buildSystemPrompt(mode, variables, false),
        systemPromptSource: "prompts/smart/system.md",
        messages,
        tools: dynamicTools,
        client,
        callbacks,
        abortSignal,
        maxRounds: 1,
        maxParallelTools: mode === "fast" ? 6 : 4,
      });
      logger.info(
        `Stage 2 - API response received: text=${!!stage2Result.text}`,
      );

      if (!stage2Result.text) {
        logger.error("Stage 2 - No text in API response!");
        if (attempt < maxStage2Attempts) {
          appendUserMessage(
            messages,
            `Your response was empty. Return ONLY <CODEMAP>...</CODEMAP> with valid JSON and no extra text.${
              attempt > 1
                ? ` This is attempt ${attempt}, please provide a complete response.`
                : ""
            }`,
            { ...appendContext, label: "Stage 2 empty response retry" },
          );
          callbacks.onMessage?.(
            "user",
            `[Stage 2] Retrying due to empty response (attempt ${
              attempt + 1
            }/${maxStage2Attempts})...`,
          );
        }
        continue;
      }

      logger.agentRaw(`[Stage 2 Structure] RESPONSE:\n${stage2Result.text}`);
      logger.debug(
        `Stage 2 - Response text length: ${stage2Result.text.length}`,
      );

      logger.info("Stage 2 - Extracting codemap from response...");
      const extraction = extractCodemapFromResponseDetailed(stage2Result.text);
      if (!extraction.codemap) {
        logger.error("Stage 2 - FAILED to extract codemap from response!");
        if (extraction.error) {
          logger.error(`Stage 2 - Extraction error: ${extraction.error}`);
        }
        logger.error(
          `Stage 2 - Response preview: ${stage2Result.text.slice(0, 500)}...`,
        );
        if (attempt < maxStage2Attempts && extraction.issues.length > 0) {
          appendUserMessage(
            messages,
            buildCodemapStructureFeedback(extraction.issues, attempt),
            {
              ...appendContext,
              label: "Stage 2 extraction retry",
            },
          );
          callbacks.onMessage?.(
            "user",
            `[Stage 2] Retrying due to codemap extraction issues (attempt ${
              attempt + 1
            }/${maxStage2Attempts})...`,
          );
        }
        continue;
      }
      if (extraction.issues.length > 0) {
        logger.warn(
          `Stage 2 - Codemap output has formatting issues (${extraction.issues.length})`,
        );
        if (attempt < maxStage2Attempts) {
          appendUserMessage(
            messages,
            buildCodemapStructureFeedback(extraction.issues, attempt),
            {
              ...appendContext,
              label: "Stage 2 formatting retry",
            },
          );
          callbacks.onMessage?.(
            "user",
            `[Stage 2] Retrying due to codemap formatting issues (attempt ${
              attempt + 1
            }/${maxStage2Attempts})...`,
          );
          continue;
        }
      }

      const extracted = extraction.codemap;
      const structureIssues = validateCodemapStructure(
        extracted,
        workspaceRoot,
      );
      if (structureIssues.fatal.length > 0) {
        logger.error(
          `Stage 2 - Codemap structure validation failed (${structureIssues.fatal.length} issues)`,
        );
        if (attempt < maxStage2Attempts) {
          appendUserMessage(
            messages,
            buildCodemapStructureFeedback(structureIssues.fatal, attempt),
            {
              ...appendContext,
              label: "Stage 2 structure retry",
            },
          );
          callbacks.onMessage?.(
            "user",
            `[Stage 2] Retrying due to codemap structure issues (attempt ${
              attempt + 1
            }/${maxStage2Attempts})...`,
          );
          continue;
        }
        throw new Error(
          `Stage 2 failed: Invalid codemap structure. ${
            structureIssues.fatal[0]
          }`,
        );
      }

      const mismatches = validateCodemapLocations(extracted);
      if (mismatches.length > 0) {
        logger.warn(
          `Stage 2 - Location verification failed (${mismatches.length} mismatches)`,
        );
        const fixResult = applyLocationFixes(extracted, workspaceRoot);
        if (fixResult.fixed > 0) {
          logger.info(`Stage 2 - Auto-fixed ${fixResult.fixed} locations`);
        }
        const remaining = validateCodemapLocations(extracted);
        if (remaining.length > 0) {
          if (attempt < maxStage2Attempts) {
            appendUserMessage(
              messages,
              buildLocationMismatchFeedback(remaining, attempt),
              {
                ...appendContext,
                label: "Stage 2 location mismatch retry",
              },
            );
            callbacks.onMessage?.(
              "user",
              `[Stage 2] Retrying due to location mismatch (attempt ${
                attempt + 1
              }/${maxStage2Attempts})...`,
            );
            continue;
          }
          throw new Error(
            `Stage 2 failed: ${remaining.length} locations could not be verified after ${maxStage2Attempts} attempts`,
          );
        }
      }

      resultCodemap = extracted;
      logger.info(
        `Stage 2 - Codemap extracted successfully: ${resultCodemap.traces.length} traces`,
      );
      logger.debug(`Stage 2 - Codemap title: ${resultCodemap.title}`);
      for (const trace of resultCodemap.traces) {
        logger.debug(
          `Stage 2 - Trace ${trace.id}: ${trace.title} (${trace.locations.length} locations)`,
        );
      }
      callbacks.onCodemapUpdate?.(resultCodemap);
      callbacks.onMessage?.(
        "system",
        `Codemap structure generated with ${resultCodemap.traces.length} traces`,
      );

      // Persist stage 1-2 shared context for retries (before we fork into downstream stages).
      try {
        callbacks.onStage12ContextReady?.({
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          query,
          mode,
          detailLevel,
          workspaceRoot,
          currentDate,
          language,
          systemPrompt,
          baseMessages: messages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: String(m.content),
          })),
        });
      } catch (e) {
        logger.warn(
          `Failed to emit stage12 context: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }

      if (mode === "fast") {
        mermaidPromise = processMermaidDiagram(
          systemPrompt,
          systemPromptSource,
          messages,
          workspaceRoot,
          currentDate,
          language,
          callbacks,
          abortSignal,
        );
      }
      break;
    }

    // ========== Stage 3-5: Parallel Trace Processing ==========
    if (resultCodemap && resultCodemap.traces.length > 0) {
      logger.separator("STAGE 3-5: TRACE PROCESSING");
      callbacks.onPhaseChange?.("Trace Processing", 3);
      callbacks.onMessage?.(
        "system",
        `Processing ${resultCodemap.traces.length} traces in parallel...`,
      );
      logger.info(
        `Starting parallel processing of ${resultCodemap.traces.length} traces`,
      );

      const tracePromises = resultCodemap.traces.map((trace) =>
        processTraceStages(
          trace.id,
          systemPrompt,
          systemPromptSource,
          messages,
          workspaceRoot,
          currentDate,
          language,
          callbacks,
          { abortSignal },
        )
      );

      logger.info("Waiting for all trace processing to complete...");
      const mermaidRunner = mermaidPromise ??
        Promise.resolve<MermaidProcessingResult | null>(null);

      if (abortSignal?.aborted) throw new Error("Generation cancelled");

      const [traceResults, mermaidResult] = await Promise.all([
        Promise.all(tracePromises),
        mermaidRunner,
      ]);

      if (abortSignal?.aborted) throw new Error("Generation cancelled");

      logger.info(`All ${traceResults.length} traces processed`);

      let successCount = 0;
      let errorCount = 0;
      for (const result of traceResults) {
        if (result.error) {
          errorCount++;
          logger.error(`Trace ${result.traceId} failed: ${result.error}`);
          callbacks.onMessage?.(
            "error",
            `Error processing trace ${result.traceId}: ${result.error}`,
          );
          continue;
        }

        successCount++;
        const trace = resultCodemap.traces.find((t) => t.id === result.traceId);
        if (trace) {
          if (result.diagram) {
            trace.traceTextDiagram = result.diagram;
            logger.info(
              `Trace ${result.traceId}: Diagram added (${result.diagram.length} chars)`,
            );
          }
          if (result.guide) {
            trace.traceGuide = result.guide;
            logger.info(
              `Trace ${result.traceId}: Guide added (${result.guide.length} chars)`,
            );
          }
        }
      }

      logger.info(
        `Trace processing complete: ${successCount} success, ${errorCount} errors`,
      );

      let resolvedMermaid = mermaidResult;
      if (mode === "smart") {
        const diagramContext = resultCodemap.traces
          .filter((t) =>
            t.traceTextDiagram && t.traceTextDiagram.trim().length > 0
          )
          .map((t) => `Trace ${t.id}: ${t.title}\n${t.traceTextDiagram}`)
          .join("\n\n");
        const mermaidMessages = diagramContext
          ? [
            ...messages,
            {
              role: "user" as const,
              content:
                "Use these verified trace trees as the source of truth for structure and edges:\n\n" +
                diagramContext,
            },
          ]
          : messages;
        resolvedMermaid = await processMermaidDiagram(
          systemPrompt,
          systemPromptSource,
          mermaidMessages,
          workspaceRoot,
          currentDate,
          language,
          callbacks,
          abortSignal,
        );
      }

      if (resolvedMermaid) {
        if (resolvedMermaid.error) {
          logger.error(
            `[Mermaid] Mermaid generation failed: ${resolvedMermaid.error}`,
          );
          callbacks.onMessage?.(
            "error",
            `Mermaid diagram error: ${resolvedMermaid.error}`,
          );
          throw new Error(
            `Mermaid diagram failed to compile: ${resolvedMermaid.error}`,
          );
        } else if (resolvedMermaid.diagram) {
          resultCodemap.mermaidDiagram = resolvedMermaid.diagram;
          logger.info(
            `[Mermaid] Diagram stored (${resolvedMermaid.diagram.length} chars)`,
          );
          callbacks.onMessage?.(
            "assistant",
            "[Mermaid] Diagram saved to codemap",
          );
        }
      }

      callbacks.onCodemapUpdate?.(resultCodemap);
    } else {
      if (!resultCodemap) {
        logger.warn("No codemap was generated - skipping trace processing");
      } else {
        logger.warn("Codemap has no traces - skipping trace processing");
        if (mermaidPromise) {
          const mermaidResult = await mermaidPromise;
          if (mermaidResult?.diagram) {
            resultCodemap.mermaidDiagram = mermaidResult.diagram;
            logger.info(
              `[Mermaid] Diagram stored (${mermaidResult.diagram.length} chars)`,
            );
            callbacks.onMessage?.(
              "assistant",
              "[Mermaid] Diagram saved to codemap",
            );
          } else if (mermaidResult?.error) {
            logger.error(
              `[Mermaid] Mermaid generation failed: ${mermaidResult.error}`,
            );
            callbacks.onMessage?.(
              "error",
              `Mermaid diagram error: ${mermaidResult.error}`,
            );
            throw new Error(
              `Mermaid diagram failed to compile: ${mermaidResult.error}`,
            );
          }
        }
      }
    }

    if (resultCodemap) {
      const fixResult = applyLocationFixes(resultCodemap, workspaceRoot);
      if (fixResult.fixed > 0 || fixResult.unmatched > 0) {
        logger.info(
          `Verification stage: fixed ${fixResult.fixed} locations, ${fixResult.unmatched} unmatched`,
        );
        resultCodemap.metadata = {
          ...(resultCodemap.metadata ?? {}),
          verification: {
            fixedLocations: fixResult.fixed,
            unmatchedLocations: fixResult.unmatched,
            fixedDetails: fixResult.details,
          },
        };
        callbacks.onCodemapUpdate?.(resultCodemap);
      }
    }

    logger.separator("CODEMAP GENERATION COMPLETE");
    logger.info(`Final codemap: ${resultCodemap ? "SUCCESS" : "NULL"}`);
    if (resultCodemap) {
      logger.info(`Final codemap title: ${resultCodemap.title}`);
      logger.info(`Final codemap traces: ${resultCodemap.traces.length}`);
    }

    callbacks.onMessage?.("system", "Codemap generation complete.");
    return resultCodemap;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.separator("CODEMAP GENERATION ERROR");
    logger.error(`Error: ${errorMsg}`);
    if (errorStack) {
      logger.error(`Stack trace: ${errorStack}`);
    }
    callbacks.onMessage?.("error", `Error: ${errorMsg}`);
    throw error;
  }
}

/**
 * Retry a single trace (stages 3-5) using a saved Stage 1-2 context.
 */
export async function retryTraceFromStage12Context(
  traceId: string,
  context: CodemapStage12ContextV1,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal,
): Promise<{ diagram?: string; guide?: string; error?: string }> {
  repetitionAlerted = false;
  const baseMessages = toCoreMessages(context.baseMessages);
  const systemPromptSource = context.mode === "fast"
    ? "prompts/smart/system.md + prompts/smart/maximize_parallel_tool_calls.md"
    : "prompts/smart/system.md";
  const result = await processTraceStages(
    traceId,
    context.systemPrompt,
    systemPromptSource,
    baseMessages,
    context.workspaceRoot,
    context.currentDate,
    context.language,
    callbacks,
    { abortSignal },
  );
  return { diagram: result.diagram, guide: result.guide, error: result.error };
}

/**
 * Retry trace diagram only (stages 3-4) using a saved Stage 1-2 context.
 */
export async function retryTraceDiagramFromStage12Context(
  traceId: string,
  context: CodemapStage12ContextV1,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal,
): Promise<{ diagram?: string; error?: string }> {
  repetitionAlerted = false;
  const baseMessages = toCoreMessages(context.baseMessages);
  const systemPromptSource = context.mode === "fast"
    ? "prompts/smart/system.md + prompts/smart/maximize_parallel_tool_calls.md"
    : "prompts/smart/system.md";
  const result = await processTraceStages(
    traceId,
    context.systemPrompt,
    systemPromptSource,
    baseMessages,
    context.workspaceRoot,
    context.currentDate,
    context.language,
    callbacks,
    { includeGuide: false, abortSignal },
  );
  return { diagram: result.diagram, error: result.error };
}

/**
 * Retry global Mermaid diagram (stage 6) using a saved Stage 1-2 context.
 */
export async function retryMermaidFromStage12Context(
  context: CodemapStage12ContextV1,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal,
): Promise<{ diagram?: string; error?: string }> {
  repetitionAlerted = false;
  const baseMessages = toCoreMessages(context.baseMessages);
  const systemPromptSource = context.mode === "fast"
    ? "prompts/smart/system.md + prompts/smart/maximize_parallel_tool_calls.md"
    : "prompts/smart/system.md";
  const result = await processMermaidDiagram(
    context.systemPrompt,
    systemPromptSource,
    baseMessages,
    context.workspaceRoot,
    context.currentDate,
    context.language,
    callbacks,
    abortSignal,
  );
  return { diagram: result.diagram, error: result.error };
}

/**
 * Generate a Mermaid diagram from an existing codemap snapshot (no Stage 1-2 context).
 * This is used when older codemap files don't have `stage12Context` persisted.
 */
export async function generateMermaidFromCodemapSnapshot(
  codemap: Codemap,
  callbacks: CodemapCallbacks = {},
  abortSignal?: AbortSignal,
): Promise<{ diagram?: string; error?: string }> {
  try {
    repetitionAlerted = false;
    const workspaceRoot = codemap.workspacePath || "";
    const currentDate = formatCurrentDate();
    const language = getLanguage();

    const workspaceLayout = workspaceRoot
      ? generateWorkspaceLayout(workspaceRoot)
      : "";
    const workspaceUri = workspaceRoot.replace(/\\/g, "\\\\");
    const corpusName = workspaceRoot.replace(/\\/g, "/");

    const mode = codemap.mode === "fast" ? "fast" : "smart";
    const systemPrompt = buildSystemPrompt(mode, {
      workspace_root: workspaceRoot,
      workspace_layout: workspaceLayout,
      workspace_uri: workspaceUri,
      corpus_name: corpusName,
      user_os: getUserOs(),
      language,
    });
    const systemPromptSource = mode === "fast"
      ? "prompts/smart/system.md + prompts/smart/maximize_parallel_tool_calls.md"
      : "prompts/smart/system.md";

    // Provide a structured snapshot as base context so stage 6 can draw the global diagram.
    const snapshot = JSON.stringify(
      {
        title: codemap.title,
        description: codemap.description,
        traces: codemap.traces,
      },
      null,
      2,
    );

    const baseMessages: ModelMessage[] = [
      {
        role: "user",
        content:
          `Here is the codemap snapshot as JSON. Use it as the source of truth.\n\n` +
          `\`\`\`json\n${snapshot}\n\`\`\``,
      },
    ];

    const result = await processMermaidDiagram(
      systemPrompt,
      systemPromptSource,
      baseMessages,
      workspaceRoot,
      currentDate,
      language,
      callbacks,
      abortSignal,
    );

    return { diagram: result.diagram, error: result.error };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { error: msg };
  }
}

function getDetailInstruction(level: DetailLevel): string {
  switch (level) {
    case "low":
      return "The resulting codemap should be detailed, containing at least 10 nodes/locations across all traces combined.";
    case "medium":
      return "The resulting codemap should be very detailed, containing at least 30 nodes/locations across all traces combined.";
    case "high":
      return "The resulting codemap should be extremely detailed, containing at least 60 nodes/locations across all traces combined.";
    case "ultra":
      return "The resulting codemap MUST be massive and exhaustive (ULTRA detail). Aim for a minimum of 100 nodes/locations across all traces combined. Break down every significant component and interaction.";
    case "overview":
    default:
      return "";
  }
}
