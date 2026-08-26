import assert from "node:assert/strict";
import test from "node:test";
import {
  compactNumber,
  compactPluginStatus,
  statusRank,
  fitFooterParts,
  oneLine,
  promptCacheTelemetry,
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
    { id: "model", text: "󰚩 model · high", priority: 6 },
    { id: "project", text: " trev-nix", priority: 1 },
    { id: "branch", text: " main", priority: 2 },
    { id: "context", text: "󰍛 12%/200k", priority: 5 },
    { id: "queue", text: "󰜎 queued", priority: 3 },
    { id: "cache", text: "󰒍 84k read", priority: 4 },
  ];
  const measure = (text: string) => Array.from(stripAnsi(text)).length;
  const separatorWidth = 5;
  const fittedWidth = (fitted: FooterPart[]) => fitted.reduce(
    (sum, part, index) => sum + measure(part.text) + (index ? separatorWidth : 0),
    0,
  );

  const wide = fitFooterParts(parts, 120, measure, separatorWidth);
  assert.equal(wide.length, 6);
  assert.ok(fittedWidth(wide) <= 120);

  const medium = fitFooterParts(parts, 80, measure, separatorWidth);
  assert.ok(medium.some((part) => part.id === "context"));
  assert.ok(fittedWidth(medium) <= 80);

  const narrow = fitFooterParts(parts, 40, measure, separatorWidth);
  assert.deepEqual(narrow.map((part) => part.id), ["model", "context"]);
  assert.ok(fittedWidth(narrow) <= 40);
});

test("formats latest provider-reported prompt cache telemetry", () => {
  const message = (model: string, cacheRead: number, cacheWrite: number) => ({
    role: "assistant",
    provider: "openai-codex",
    model,
    usage: { cacheRead, cacheWrite },
  });

  assert.deepEqual(promptCacheTelemetry(
    [message("gpt-5.6", 1_500, 0)],
    "openai-codex",
    "gpt-5.6",
  ), { text: "󰒍 1.5k read", empty: false });
  assert.deepEqual(promptCacheTelemetry(
    [message("gpt-5.6", 0, 12_000)],
    "openai-codex",
    "gpt-5.6",
  ), { text: "󰒍 12k write", empty: false });
  assert.deepEqual(promptCacheTelemetry(
    [message("gpt-5.6", 84_000, 12_000)],
    "openai-codex",
    "gpt-5.6",
  ), { text: "󰒍 84k read / 12k write", empty: false });
  assert.deepEqual(promptCacheTelemetry(
    [message("gpt-5.6", 84_000, 0), message("gpt-5.6", 0, 0)],
    "openai-codex",
    "gpt-5.6",
  ), { text: "󰒍 0 read", empty: true });
  assert.equal(promptCacheTelemetry(
    [message("gpt-5.5", 84_000, 0)],
    "openai-codex",
    "gpt-5.6",
  ), undefined);
  assert.equal(promptCacheTelemetry(
    [message("gpt-5.6", 0, 0)],
    "openai-codex",
    "gpt-5.6",
  ), undefined);
  assert.equal(promptCacheTelemetry(
    [{ ...message("gpt-5.6", 84_000, 0), stopReason: "pending" }],
    "openai-codex",
    "gpt-5.6",
  ), undefined);
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

test("compacts goal status and ranks it ahead of decorative markers", () => {
  assert.equal(compactPluginStatus("workflow:goal", "active 12m · automatic 3/25"), "󰓾 3/25");
  assert.equal(compactPluginStatus("workflow:goal", "paused · automatic 25/25"), "󰓾 paused 25/25");
  assert.equal(
    compactPluginStatus("workflow:goal", "waiting user reply · automatic 4/25"),
    "󰓾 waiting 4/25",
  );
  assert.equal(compactPluginStatus("workflow:goal", "queued · automatic Unlimited"), "󰓾 queued Unlimited");
  assert.equal(compactPluginStatus("workflow:goal", "complete"), "󰓾 ✓");
  assert.equal(compactPluginStatus("workflow:goal", "something else"), "something else");
  const names = ["caveman", "memory", "ponytail", "telegram", "usage", "work-mode", "workflow:goal", "pi-lens-lsp"];
  const sorted = names.sort((a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b));
  assert.deepEqual(sorted, [
    "usage",
    "workflow:goal",
    "work-mode",
    "memory",
    "telegram",
    "caveman",
    "ponytail",
    "pi-lens-lsp",
  ]);
});
