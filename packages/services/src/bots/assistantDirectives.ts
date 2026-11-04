import { statSync } from "node:fs";
import type { BotOutboundAttachment } from "@zcode/shared";

/**
 * Assistant messages can carry host-rendered inline directives such as
 * `::visualize{"path":...}` (Gen UI) and `::code-comment{file=... ...}`.
 * The desktop renderer parses these and renders widgets, hiding the raw
 * markup. Bot channels (Telegram / WeChat / Webhook / Feishu text cards) have
 * no renderer, so without stripping, end users receive raw directive source
 * text in chat. This module removes the directive grammar from outbound text
 * while preserving directives inside Markdown code ranges.
 *
 * Grammar is kept aligned with `packages/ui/src/lib/assistantDirectiveParser.ts`
 * (strict `::name{...}` prefix, quote-aware closing-brace scan). Legacy
 * private-use-area markers (`U+E200 …`) are not produced by current prompts
 * and are intentionally out of scope here.
 */
const ASSISTANT_DIRECTIVE_NAMES = ["visualize", "code-comment"] as const;

interface DirectiveRange {
  end: number;
  start: number;
}

type MarkdownCodeRange = readonly [start: number, end: number];

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * Fenced code blocks, inline code spans and <code>/<pre> regions must keep
 * directive text literal; stripping there would corrupt code that documents
 * the directive syntax itself.
 */
function findMarkdownCodeRanges(content: string): MarkdownCodeRange[] {
  const ranges: Array<[number, number]> = [];
  const fencedRanges: Array<[number, number]> = [];
  let fence: { character: "`" | "~"; length: number; start: number } | null = null;
  let lineStart = 0;
  while (lineStart < content.length) {
    const newlineIndex = content.indexOf("\n", lineStart);
    const lineEnd = newlineIndex < 0 ? content.length : newlineIndex + 1;
    const line = content.slice(lineStart, newlineIndex < 0 ? content.length : newlineIndex);
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) {
        fence = { character: marker[0] as "`" | "~", length: marker.length, start: lineStart };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fencedRanges.push([fence.start, lineEnd]);
        fence = null;
      }
    }
    lineStart = lineEnd;
  }
  if (fence) fencedRanges.push([fence.start, content.length]);
  ranges.push(...fencedRanges);

  for (const match of content.matchAll(/<(code|pre)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi)) {
    const start = match.index ?? 0;
    ranges.push([start, start + (match[0]?.length ?? 0)]);
  }

  const isFenced = (index: number) =>
    fencedRanges.some(([start, end]) => index >= start && index < end);
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "`" || isFenced(index)) continue;
    let markerLength = 1;
    while (content[index + markerLength] === "`") markerLength += 1;
    const marker = "`".repeat(markerLength);
    const closingIndex = content.indexOf(marker, index + markerLength);
    if (closingIndex < 0 || isFenced(closingIndex)) {
      index += markerLength - 1;
      continue;
    }
    ranges.push([index, closingIndex + markerLength]);
    index = closingIndex + markerLength - 1;
  }
  return mergeRanges(ranges);
}

function findClosingBrace(content: string, openBraceIndex: number): number {
  let quote: string | null = null;
  let escaped = false;
  for (let index = openBraceIndex + 1; index < content.length; index += 1) {
    const character = content[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "}") return index;
  }
  return -1;
}

/**
 * When the directive is the only non-whitespace content on its line, absorb
 * the surrounding whitespace so removing it does not leave an empty line.
 */
function expandToOwnLine(content: string, start: number, end: number): DirectiveRange {
  const lineStart = start === 0 ? 0 : content.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = content.indexOf("\n", end);
  const before = content.slice(lineStart, start);
  const after = content.slice(end, lineEnd < 0 ? content.length : lineEnd);
  if (before.trim() || after.trim()) return { start, end };
  if (lineEnd < 0) {
    // Last line without a newline: also consume the preceding newline so the
    // removal does not leave a trailing blank line.
    return { start: lineStart > 0 ? lineStart - 1 : lineStart, end };
  }
  return { start: lineStart, end: lineEnd + 1 };
}

export function stripAssistantDirectives(text: string): string {
  if (!text.includes("::")) return text;
  const codeRanges = findMarkdownCodeRanges(text);
  const removals: DirectiveRange[] = [];
  for (const name of ASSISTANT_DIRECTIVE_NAMES) {
    const startPattern = new RegExp(`(?<!:):{2}${name}\\s*\\{`, "gu");
    let consumedUntil = 0;
    for (const match of text.matchAll(startPattern)) {
      const start = match.index ?? 0;
      if (start < consumedUntil) continue;
      if (codeRanges.some(([from, to]) => start >= from && start < to)) continue;
      const openBraceIndex = start + (match[0]?.lastIndexOf("{") ?? -1);
      if (openBraceIndex < start) continue;
      const closingBraceIndex = findClosingBrace(text, openBraceIndex);
      if (closingBraceIndex < 0) continue;
      const end = closingBraceIndex + 1;
      consumedUntil = end;
      removals.push(expandToOwnLine(text, start, end));
    }
  }
  if (removals.length === 0) return text;
  let output = "";
  let cursor = 0;
  for (const [start, end] of mergeRanges(removals.map((r) => [r.start, r.end]))) {
    if (start < cursor) continue;
    output += text.slice(cursor, start);
    cursor = end;
  }
  output += text.slice(cursor);
  return output
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

const LOCAL_ATTACHMENT_EXTENSIONS = new Set([
  "csv",
  "docx",
  "gif",
  "jpeg",
  "jpg",
  "json",
  "md",
  "pdf",
  "png",
  "pptx",
  "txt",
  "webp",
  "xlsx",
]);
const LOCAL_ATTACHMENT_IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "webp"]);

// Absolute Windows (`C:\...` / `C:/...`) and POSIX (`/...`) paths with a known
// attachment extension. Fullwidth punctuation and Markdown delimiters terminate
// a match; URL-looking candidates (`http://…/x.png`) are filtered because the
// POSIX alternative rejects a leading character that is part of a scheme.
const LOCAL_FILE_PATTERN =
  /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![\w.:/\\-])\/)[^\s<>"'|*?\u3000-\u303F\uFF00-\uFFEF\uE000-\uF8FF]+?\.(?:csv|docx|gif|jpe?g|json|md|pdf|png|pptx|txt|webp|xlsx)(?![\w-])/giu;

export function findLocalFileCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(LOCAL_FILE_PATTERN)) {
    let candidate = match[0];
    // Drop trailing sentence punctuation that the boundary lookahead missed
    // for CJK-friendly reasons (e.g. a path at the end of "见 C:\a.png。").
    candidate = candidate.replace(/[.,;:]+$/u, "");
    const extension = candidate.slice(candidate.lastIndexOf(".") + 1).toLowerCase();
    if (!LOCAL_ATTACHMENT_EXTENSIONS.has(extension)) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

export interface LocalAttachmentExtractionOptions {
  maxBytesPerImage?: number;
  maxBytesPerFile?: number;
  maxFiles?: number;
}

export interface LocalAttachmentExtractionResult {
  attachments: BotOutboundAttachment[];
  text: string;
}

/**
 * Detects absolute local file paths the assistant mentioned in its reply and
 * turns them into outbound attachments (images sent as photos by providers
 * that support it, e.g. Telegram sendPhoto). The path tokens are removed from
 * the text so the caption stays readable. Files are only attached when they
 * exist, are regular files, and stay under the per-kind size budget.
 */
export function extractLocalFileAttachments(
  text: string,
  options: LocalAttachmentExtractionOptions = {},
): LocalAttachmentExtractionResult {
  const maxFiles = options.maxFiles ?? 4;
  const maxBytesPerImage = options.maxBytesPerImage ?? 10 * 1024 * 1024;
  const maxBytesPerFile = options.maxBytesPerFile ?? 48 * 1024 * 1024;
  const attachments: BotOutboundAttachment[] = [];
  let sanitized = text;
  for (const candidate of findLocalFileCandidates(text)) {
    if (attachments.length >= maxFiles) break;
    let stat;
    try {
      stat = statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const extension = candidate.slice(candidate.lastIndexOf(".") + 1).toLowerCase();
    const isImage = LOCAL_ATTACHMENT_IMAGE_EXTENSIONS.has(extension);
    const limit = isImage ? maxBytesPerImage : maxBytesPerFile;
    if (stat.size === 0 || stat.size > limit) continue;
    attachments.push({ kind: isImage ? "image" : "file", localPath: candidate });
    sanitized = sanitized.split(candidate).join("").replace(/[ \t]{2,}/gu, " ").replace(/\n{3,}/gu, "\n\n");
  }
  if (attachments.length === 0) return { attachments: [], text };
  return { attachments, text: sanitized.trim() };
}
