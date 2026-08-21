import assert from "node:assert/strict";
import test from "node:test";
import {
  compactNumber,
  compactPluginStatus,
  fitFooterParts,
  oneLine,
  shortenPath,
  splitResourceCommands,
  stripAnsi,
  toolSubject,
  toolSummary,
  type FooterPart,
} from "./layout.ts";

test("groups and sorts discoverable resources", () => {
  assert.deepEqual(splitResourceCommands([
    { name: "skill:rg-search", source: "skill" },
    { name: "plan", source: "extension" },
    { name: "review", source: "prompt" },
    { name: "skill:fd-search", source: "skill" },
    { name: "plan", source: "extension" },
  ]), {
    skills: ["fd-search", "rg-search"],
    commands: ["/plan"],
    prompts: ["/review"],
  });
});

test("shortens paths and keeps useful tool arguments", () => {
  assert.equal(shortenPath("/home/trev/Workspace/repo", "/home/trev"), "~/Workspace/repo");
  assert.equal(toolSubject("read", { path: "src/a.ts", offset: 5, limit: 3 }), "src/a.ts:5-7");
  assert.equal(toolSubject("grep", { pattern: "todo", path: "src", glob: "*.ts" }), "/todo/ in src · *.ts");
  assert.equal(toolSubject("bash", { command: "echo one\necho two" }), "echo one echo two");
});

test("summarizes built-in results without hiding failures", () => {
  assert.deepEqual(toolSummary("read", {}, { content: [{ type: "text", text: "a\nb\n" }] }, false), {
    text: "2 lines",
    negative: false,
  });
  assert.deepEqual(toolSummary("read", {}, { content: [{ type: "image" }] }, false), {
    text: "image",
    negative: false,
  });
  assert.deepEqual(toolSummary("grep", {}, { content: [{ type: "text", text: "No matches found" }] }, false), {
    text: "no matches",
    negative: true,
  });
  assert.deepEqual(toolSummary("bash", {}, { content: [{ type: "text", text: "" }] }, false), {
    text: "done",
    negative: false,
  });
  assert.equal(toolSummary("find", {}, { content: [{ type: "text", text: "No files found matching pattern" }] }, false).text, "0 files");
  assert.equal(toolSummary("ls", {}, { content: [{ type: "text", text: "(empty directory)" }] }, false).text, "0 entries");
  assert.deepEqual(toolSummary("edit", {}, {
    content: [{ type: "text", text: "ok" }],
    details: { diff: "--- a\n+++ b\n-old\n+new\n+more" },
  }, false), {
    text: "+2 −1",
    negative: false,
  });
  assert.deepEqual(toolSummary("write", { content: "one\ntwo" }, { content: [] }, false), {
    text: "2 lines",
    negative: false,
  });
  assert.deepEqual(toolSummary("bash", {}, { content: [{ type: "text", text: "first failure\nextra detail" }] }, true), {
    text: "first failure",
    negative: true,
  });
});

test("drops footer segments by declared priority at narrow widths", () => {
  const parts: FooterPart[] = [
    { id: "project", text: " trev-nix", priority: 1 },
    { id: "branch", text: " main", priority: 2 },
    { id: "model", text: "󰚩 model · high", priority: 3 },
    { id: "queue", text: "󰜎 queued", priority: 4 },
    { id: "context", text: "󰍛 12%/200k", priority: 5 },
  ];
  const measure = (text: string) => Array.from(stripAnsi(text)).length;

  const wide = fitFooterParts(parts, 120, measure);
  assert.equal(wide.length, 5);

  const medium = fitFooterParts(parts, 80, measure);
  assert.ok(medium.some((part) => part.id === "context"));

  const narrow = fitFooterParts(parts, 40, measure);
  assert.deepEqual(narrow.map((part) => part.id), ["model", "queue", "context"]);
});

test("sanitizes ANSI text and compact values", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  assert.equal(oneLine("one\n\ttwo"), "one two");
  assert.equal(compactNumber(999), "999");
  assert.equal(compactNumber(1_500), "1.5k");
  assert.equal(compactNumber(1_000_000), "1.0M");
  assert.equal(compactPluginStatus("caveman", "⠠⠄ caveman level: FULL"), "caveman ▰▰");
  assert.equal(compactPluginStatus("ponytail", "○ 🐴 ponytail: ⚡ FULL"), "ponytail ▰▰");
  assert.equal(compactPluginStatus("pi-lens-lsp", "LSP Inactive"), "󰒋");
  assert.equal(compactPluginStatus("pi-lens-lsp", "LSP Active: typescript"), "󰒋");
  assert.equal(compactPluginStatus("pi-lens-lsp", "LSP Failed: typescript"), "LSP Failed: typescript");
});
