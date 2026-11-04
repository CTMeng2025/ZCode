// Covers bot-channel outbound sanitization: assistant directives must not leak
// raw markup into chat (see docs/bots.md), and local file paths mentioned by
// the assistant become native media on providers that support uploads.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractLocalFileAttachments,
  findLocalFileCandidates,
  stripAssistantDirectives,
} from "../src/bots/assistantDirectives.js";

describe("stripAssistantDirectives", () => {
  it("removes a Gen UI visualize directive and its now-empty line", () => {
    const input = [
      "Here is the view:",
      "",
      '::visualize{"path":"C:\\\\Users\\\\x\\\\viz\\\\a.html"}',
      "",
      "Done.",
    ].join("\n");
    expect(stripAssistantDirectives(input)).toBe("Here is the view:\n\nDone.");
  });

  it("removes the legacy key=value reference form", () => {
    expect(stripAssistantDirectives('::visualize{path="C:/x/a.html"}')).toBe("");
  });

  it("removes code-comment directives including quoted values with spaces", () => {
    const input = [
      "Review notes:",
      '::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end." file="a.ts" start=10 end=11 priority=2}',
      "End of notes.",
    ].join("\n");
    expect(stripAssistantDirectives(input)).toBe("Review notes:\nEnd of notes.");
  });

  it("keeps directives inside fenced code blocks literal", () => {
    const input = [
      "The syntax looks like this:",
      "```text",
      '::visualize{"path":"C:\\\\x\\\\a.html"}',
      "```",
    ].join("\n");
    expect(stripAssistantDirectives(input)).toBe(input);
  });

  it("keeps directives inside inline code literal", () => {
    const input = 'Do not emit ``::visualize{"path":"..."} `` verbatim.';
    expect(stripAssistantDirectives(input)).toBe(input);
  });

  it("leaves unrelated double-colon text untouched", () => {
    expect(stripAssistantDirectives("a::b and ::visualization and :visualize")).toBe(
      "a::b and ::visualization and :visualize",
    );
  });

  it("keeps unclosed directives visible instead of swallowing the tail", () => {
    const input = 'text before ::visualize{"path": "C:' + "back\\slash";
    expect(stripAssistantDirectives(input)).toBe(input);
  });

  it("removes multiple directives in one message", () => {
    const input = [
      '::visualize{"path":"C:\\\\a.html"}',
      '::visualize{"path":"C:\\\\b.html"}',
      "Done.",
    ].join("\n");
    expect(stripAssistantDirectives(input)).toBe("Done.");
  });
});

describe("findLocalFileCandidates", () => {
  it("finds absolute Windows and POSIX paths with supported extensions", () => {
    const text = "主文件夾截圖：C:\\Users\\meng\\shots\\main.png 同埋 /home/u/notes.md";
    const candidates = findLocalFileCandidates(text);
    expect(candidates).toContain("C:\\Users\\meng\\shots\\main.png");
    expect(candidates).toContain("/home/u/notes.md");
  });

  it("does not treat http(s) URLs as local files", () => {
    expect(findLocalFileCandidates("see https://example.com/a.png")).toEqual([]);
    expect(findLocalFileCandidates("file:///C:/x.png")).toEqual(["C:/x.png"]);
  });

  it("stops at CJK punctuation after a path", () => {
    expect(findLocalFileCandidates("見 C:\\a\\b.png。完毕")).toContain("C:\\a\\b.png");
  });
});

describe("extractLocalFileAttachments", () => {
  it("attaches existing local images and removes path tokens from the caption", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-bots-attach-"));
    const filePath = join(dir, "shot.png");
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = extractLocalFileAttachments(`截圖喺 ${filePath} ，請查收`);
    expect(result.attachments).toEqual([{ kind: "image", localPath: filePath }]);
    expect(result.text).not.toContain(filePath);
    expect(result.text).toContain("請查收");
  });

  it("ignores missing files and oversized files", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-bots-attach-"));
    const filePath = join(dir, "big.png");
    writeFileSync(filePath, Buffer.alloc(4096));
    expect(extractLocalFileAttachments("C:\\does\\not\\exist.png").attachments).toHaveLength(0);
    expect(extractLocalFileAttachments(filePath, { maxBytesPerImage: 1024 }).attachments).toHaveLength(0);
  });
});
