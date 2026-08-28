import { basename } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  CustomEditor,
  keyText,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type Theme,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  type EditorTheme,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  backgroundLine,
  branchTelemetry,
  compactPluginStatus,
  contextTelemetry,
  statusRank,
  fitFooterParts,
  oneLine,
  parseGitHubNotificationCount,
  promptCacheTelemetry,
  shouldRefreshDirtyState,
  shortenPath,
  splitResourceCommands,
  stripAnsi,
  toolSubject,
  toolSummary,
  type BuiltInToolName,
  type FooterPart,
  type ToolResultLike,
} from "./layout.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const EDITOR_BACKGROUND = "\x1b[48;2;37;42;52m"; // #252A34, subtle Nord shade.
const TOOL_ICONS: Record<BuiltInToolName, string> = {
  bash: "",
  read: "󰈙",
  edit: "",
  write: "󰆓",
  grep: "",
  find: "󰱼",
  ls: "",
};
const TOOL_NAMES = Object.keys(TOOL_ICONS) as BuiltInToolName[];

interface UiState {
  working: boolean;
  spinnerFrame: number;
  spinnerTimer?: ReturnType<typeof setInterval>;
  errorTimer?: ReturnType<typeof setTimeout>;
  errorUntil: number;
  githubRefreshTimer?: ReturnType<typeof setInterval>;
  githubNotifications?: number;
  githubNotificationsFailed: boolean;
  hasUserMessage: boolean;
  branch: string | null;
  dirty: boolean;
  tui?: TUI;
  footerData?: ReadonlyFooterDataProvider;
}

class SingleLine implements Component {
  constructor(private readonly value: string) {}

  render(width: number): string[] {
    return width > 0 ? [truncateToWidth(this.value, width, "…")] : [];
  }

  invalidate(): void {}
}

function emptyComponent(): Component {
  return new Container();
}

function isRail(line: string): boolean {
  const plain = stripAnsi(line);
  return plain.includes("─") && plain.replace(/[─↑↓0-9 ]/g, "") === "";
}

function scrollLabel(line: string | undefined): string {
  const plain = stripAnsi(line ?? "");
  const match = plain.match(/([↑↓])\s*(\d+)/);
  return match ? ` ${match[1]} ${match[2]} ` : "";
}

function resourceLines(label: string, values: string[], width: number, theme: Theme, limit?: number): string[] {
  const shown = limit === undefined ? values : values.slice(0, limit);
  const suffix = limit !== undefined && values.length > shown.length ? " · …" : "";
  const prefix = `${label.padEnd(10)} `;
  const content = shown.length ? shown.join(" · ") + suffix : "none";
  const wrapped = wrapTextWithAnsi(theme.fg("text", content), Math.max(1, width - visibleWidth(prefix)));
  return wrapped.map((line, index) => (index === 0 ? theme.fg("muted", prefix) : " ".repeat(visibleWidth(prefix))) + line);
}

function projectName(ctx: ExtensionContext): string {
  return basename(ctx.cwd) || shortenPath(ctx.cwd);
}

function modelName(ctx: ExtensionContext, includeProvider = false): string {
  if (!ctx.model) return "no model";
  return includeProvider ? `${ctx.model.provider}/${ctx.model.id}` : ctx.model.id;
}

function titleFor(ctx: ExtensionContext): string {
  return `π ${projectName(ctx)} · ${modelName(ctx)}`;
}

function contextText(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  return contextTelemetry(usage?.tokens, usage?.contextWindow ?? ctx.model?.contextWindow);
}

function setupToolRenderers(pi: ExtensionAPI): void {
  const factories = {
    bash: createBashToolDefinition,
    read: createReadToolDefinition,
    edit: createEditToolDefinition,
    write: createWriteToolDefinition,
    grep: createGrepToolDefinition,
    find: createFindToolDefinition,
    ls: createLsToolDefinition,
  } as const;
  const cache = new Map<string, Record<BuiltInToolName, any>>();
  const definitions = (cwd: string): Record<BuiltInToolName, any> => {
    let value = cache.get(cwd);
    if (!value) {
      value = Object.fromEntries(TOOL_NAMES.map((name) => [name, factories[name](cwd)])) as Record<BuiltInToolName, any>;
      cache.set(cwd, value);
    }
    return value;
  };

  for (const name of TOOL_NAMES) {
    const original = definitions(process.cwd())[name];
    pi.registerTool({
      ...original,
      renderShell: "self",
      async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext) {
        return definitions(ctx.cwd)[name].execute(toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall(args: Record<string, unknown>, theme: Theme, context: any) {
        if (context.expanded) {
          const state = context.state as {
            originalState?: Record<string, unknown>;
            originalCall?: Component;
          };
          state.originalState ??= {};
          const component = definitions(context.cwd)[name].renderCall?.(args, theme, {
            ...context,
            state: state.originalState,
            lastComponent: state.originalCall,
          }) ?? emptyComponent();
          state.originalCall = component;
          return component;
        }
        if (!context.isPartial && context.executionStarted) return emptyComponent();
        const status = theme.fg("accent", "…");
        const icon = theme.fg("accent", TOOL_ICONS[name]);
        const title = theme.fg("toolTitle", theme.bold(name));
        const subject = theme.fg("toolOutput", toolSubject(name, args));
        return new SingleLine(`${status} ${icon}  ${title}  ${subject}`);
      },
      renderResult(result: ToolResultLike, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: any) {
        const state = context.state as {
          originalState?: Record<string, any>;
          originalResult?: Component;
        };
        state.originalState ??= {};
        if (options.expanded) {
          const component = definitions(context.cwd)[name].renderResult?.(result, options, theme, {
            ...context,
            state: state.originalState,
            lastComponent: state.originalResult,
          }) ?? emptyComponent();
          state.originalResult = component;
          return component;
        }
        if (options.isPartial) return emptyComponent();
        if (state.originalState.interval) {
          clearInterval(state.originalState.interval);
          state.originalState.interval = undefined;
        }
        const summary = toolSummary(name, context.args, result, context.isError);
        const negative = context.isError || summary.negative;
        const status = theme.fg(negative ? "error" : "success", negative ? "✗" : "✓");
        const icon = theme.fg("accent", TOOL_ICONS[name]);
        const title = theme.fg("toolTitle", theme.bold(name));
        const subject = theme.fg("toolOutput", toolSubject(name, context.args));
        const detail = theme.fg(negative ? "error" : "dim", summary.text);
        return new SingleLine(`${status} ${icon}  ${title}  ${subject} · ${detail}`);
      },
    } as any);
  }
}

export default function trevPi(pi: ExtensionAPI) {
  setupToolRenderers(pi);

  const state: UiState = {
    working: false,
    spinnerFrame: 0,
    errorUntil: 0,
    githubNotificationsFailed: false,
    hasUserMessage: false,
    branch: null,
    dirty: false,
  };
  let lastContext: ExtensionContext | undefined;
  let dirtyRefreshGeneration = 0;
  let githubRefreshGeneration = 0;

  const stopSpinner = () => {
    if (state.spinnerTimer) clearInterval(state.spinnerTimer);
    state.spinnerTimer = undefined;
  };
  const stopGithubRefresh = () => {
    if (state.githubRefreshTimer) clearInterval(state.githubRefreshTimer);
    state.githubRefreshTimer = undefined;
  };
  const requestRender = () => state.tui?.requestRender();
  const flashError = () => {
    state.errorUntil = Date.now() + 1_500;
    if (state.errorTimer) clearTimeout(state.errorTimer);
    state.errorTimer = setTimeout(() => {
      state.errorTimer = undefined;
      requestRender();
    }, 1_500);
    requestRender();
  };
  const refreshTitle = (ctx: ExtensionContext) => ctx.ui.setTitle(titleFor(ctx));
  const refreshGithubNotifications = (ctx: ExtensionContext) => {
    const generation = ++githubRefreshGeneration;
    // gh's disk cache is shared by Pi sessions, avoiding normal duplicate API polls.
    void pi.exec("gh", ["api", "notifications", "--paginate", "--cache", "5m", "--jq", "length"], { timeout: 30_000 })
      .then(({ code, stdout }) => {
        if (generation !== githubRefreshGeneration) return;
        if (code !== 0) throw new Error("GitHub notification refresh failed");
        state.githubNotifications = parseGitHubNotificationCount(stdout);
        state.githubNotificationsFailed = false;
        requestRender();
      })
      .catch(() => {
        if (generation !== githubRefreshGeneration) return;
        state.githubNotifications = undefined;
        state.githubNotificationsFailed = true;
        requestRender();
      });
  };
  const refreshDirtyState = (ctx: ExtensionContext) => {
    const generation = ++dirtyRefreshGeneration;
    void pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd, timeout: 5_000 })
      .then(({ code, stdout }) => {
        if (generation !== dirtyRefreshGeneration) return;
        state.dirty = code === 0 && stdout.trim().length > 0;
        requestRender();
      })
      .catch(() => {
        if (generation !== dirtyRefreshGeneration) return;
        state.dirty = false;
        requestRender();
      });
  };

  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
    state.hasUserMessage = ctx.sessionManager.getBranch().some(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    if (ctx.mode !== "tui") return;
    state.dirty = false;
    state.githubNotifications = undefined;
    state.githubNotificationsFailed = false;
    refreshDirtyState(ctx);
    refreshGithubNotifications(ctx);
    stopGithubRefresh();
    state.githubRefreshTimer = setInterval(() => refreshGithubNotifications(ctx), 5 * 60_000);

    ctx.ui.setWorkingVisible(false);
    ctx.ui.setHiddenThinkingLabel(`󰧑 reasoning hidden (${keyText("app.thinking.toggle")})`);

    ctx.ui.setFooter((tui, theme, footerData) => {
      state.tui = tui;
      state.footerData = footerData;
      state.branch = footerData.getGitBranch();
      const unsubscribe = footerData.onBranchChange(() => {
        state.branch = footerData.getGitBranch();
        tui.requestRender();
      });

      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          state.branch = footerData.getGitBranch();
          const providerCount = footerData.getAvailableProviderCount();
          const statuses = [...footerData.getExtensionStatuses().entries()]
            .sort(([a], [b]) => statusRank(a) - statusRank(b) || a.localeCompare(b));
          const thinking = pi.getThinkingLevel();
          const styledModel = (includeProvider: boolean) =>
            `${theme.fg("accent", "󰚩")} ${theme.fg("text", modelName(ctx, includeProvider))} ${theme.fg("dim", `· ${thinking}`)}`;
          const usage = ctx.getContextUsage();
          const contextColor = usage?.percent !== null && usage?.percent !== undefined && usage.percent > 90
            ? "error"
            : usage?.percent !== null && usage?.percent !== undefined && usage.percent > 70
              ? "warning"
              : "dim";
          const queue = ctx.hasPendingMessages();
          const indent = width > 2 ? "  " : "";
          const innerWidth = Math.max(1, width - visibleWidth(indent));
          const separator = theme.fg("dim", "  ·  ");
          const separatorWidth = visibleWidth(separator);
          const cache = promptCacheTelemetry(
            ctx.sessionManager.getBranch().flatMap((entry) =>
              entry.type === "message" ? [entry.message] : []
            ),
            ctx.model?.provider,
            ctx.model?.id,
          );
          const parts = (useShortLabels: boolean): FooterPart[] => [
            { id: "model", text: styledModel(!useShortLabels && providerCount > 1), priority: 7 },
            {
              id: "project",
              text: `${theme.fg("accent", "")} ${theme.fg("muted", projectName(ctx))}`,
              priority: 1,
            },
            ...(state.branch ? [{ id: "branch", text: theme.fg("muted", branchTelemetry(state.branch, state.dirty)), priority: 2 } as FooterPart] : []),
            { id: "context", text: theme.fg(contextColor, contextText(ctx)), priority: 6 },
            ...(state.githubNotificationsFailed ? [{
              id: "github",
              text: theme.fg("error", " !"),
              priority: 5,
            } as FooterPart] : state.githubNotifications ? [{
              id: "github",
              text: theme.fg("warning", ` ${state.githubNotifications}`),
              priority: 5,
            } as FooterPart] : []),
            ...(queue ? [{
              id: "queue",
              text: theme.fg("warning", useShortLabels ? "󰜎" : "󰜎 queued"),
              priority: 3,
            } as FooterPart] : []),
            ...(cache ? [{
              id: "cache",
              text: theme.fg(cache.empty ? "warning" : "dim", cache.text),
              priority: 4,
            } as FooterPart] : []),
          ];

          const full = parts(false);
          const fullWidth = full.reduce(
            (sum, part, index) => sum + visibleWidth(part.text) + (index ? separatorWidth : 0),
            0,
          );
          const fitted = fitFooterParts(
            fullWidth <= innerWidth ? full : parts(true),
            innerWidth,
            visibleWidth,
            separatorWidth,
          );
          const primary = truncateToWidth(fitted.map((part) => part.text).join(separator), innerWidth, "…");

          const pluginValues = statuses.map(([name, text]) => compactPluginStatus(name, text));
          const pluginPrefix = theme.fg("dim", "󰐱");
          const plugins = truncateToWidth(
            `${pluginPrefix}  ${pluginValues.length ? pluginValues.join(separator) : theme.fg("dim", "—")}`,
            innerWidth,
            "…",
          );
          const row = (content: string) => `${indent}${truncateToWidth(content, innerWidth, "…")}`;

          return ["", row(primary), row(plugins)];
        },
      };
    });

    ctx.ui.setHeader((tui, theme) => {
      state.tui = tui;
      return new (class implements Component {
        private expanded = false;

        setExpanded(expanded: boolean): void {
          this.expanded = expanded;
          tui.requestRender();
        }

        invalidate(): void {}

        render(width: number): string[] {
          const resources = splitResourceCommands(pi.getCommands().map((command) => ({
            name: command.name,
            source: command.source,
          })));
          const tools = [...pi.getActiveTools()].sort((a, b) => a.localeCompare(b));
          const counts = `${resources.skills.length} skills · ${resources.commands.length} commands · ${resources.prompts.length} prompts · ${tools.length} tools`;
          const identity = `π pi · ${projectName(ctx)} · ${modelName(ctx)}`;
          if (state.hasUserMessage) return [truncateToWidth(theme.fg("accent", identity), width, "…")];
          if (width < 60) return [truncateToWidth(theme.fg("accent", `π pi v${VERSION}`) + theme.fg("dim", ` · ${counts}`), width, "…")];

          const logo = [
            `${theme.fg("accent", "╭───╮")}  ${theme.bold(theme.fg("accent", "pi"))}${theme.fg("dim", `  v${VERSION}`)}`,
            `${theme.fg("accent", "│ π │")}`,
            `${theme.fg("accent", "╰───╯")}`,
          ];
          const branch = state.branch ? `  ${theme.fg("muted", ` ${state.branch}`)}` : "";
          const project = `${theme.fg("accent", "")} ${theme.fg("text", projectName(ctx))}${branch}  ${theme.fg("dim", shortenPath(ctx.cwd))}`;
          const model = `${theme.fg("accent", "󰚩")} ${theme.fg("text", modelName(ctx, true))} ${theme.fg("dim", `· ${pi.getThinkingLevel()}`)}`;
          const lines = [...logo, "", truncateToWidth(project, width, "…"), truncateToWidth(model, width, "…"), ""];
          lines.push(...resourceLines("skills", resources.skills, width, theme, this.expanded ? undefined : 6));
          lines.push(...resourceLines("commands", resources.commands, width, theme, this.expanded ? undefined : 6));
          if (this.expanded) {
            lines.push(...resourceLines("prompts", resources.prompts, width, theme));
            lines.push(...resourceLines("tools", tools, width, theme));
          }
          lines.push(theme.fg("dim", counts));
          if (!ctx.isProjectTrusted()) lines.push(theme.fg("warning", "󰌾 project resources disabled (untrusted)"));
          lines.push("");
          const hints = [
            `${keyText("app.interrupt")} interrupt`,
            "/ commands",
            "! shell",
            `${keyText("app.tools.expand")} details`,
            `${keyText("app.thinking.toggle")} reasoning`,
            `${keyText("app.model.select")} model`,
            `${keyText("app.editor.external")} editor`,
          ].join(" · ");
          lines.push(...wrapTextWithAnsi(theme.fg("dim", hints), width));
          return lines;
        }
      })();
    });

    class TrevEditor extends CustomEditor {
      constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) {
        super(tui, editorTheme, keybindings, { paddingX: 0 });
        state.tui = tui;
      }

      private promptColor(theme: Theme): (text: string) => string {
        if (Date.now() < state.errorUntil) return (text) => theme.fg("error", text);
        if (this.getText().trimStart().startsWith("!")) return (text) => theme.fg("bashMode", text);
        if (state.working) return (text) => theme.fg("accent", text);
        const level = pi.getThinkingLevel();
        const token = {
          off: "thinkingOff",
          minimal: "thinkingMinimal",
          low: "thinkingLow",
          medium: "thinkingMedium",
          high: "thinkingHigh",
          xhigh: "thinkingXhigh",
          max: "thinkingMax",
        }[level] as Parameters<Theme["fg"]>[0];
        return (text) => theme.fg(token, text);
      }

      render(width: number): string[] {
        if (width < 10) return super.render(width);
        const theme = ctx.ui.theme;
        const color = this.promptColor(theme);
        const contentWidth = Math.max(1, width - 4);
        const base = super.render(contentWidth);
        let divider = base.length - 1;
        for (let index = base.length - 1; index > 0; index--) {
          if (isRail(base[index])) {
            divider = index;
            break;
          }
        }
        const editorLines = base.slice(1, divider);
        const autocomplete = base.slice(divider + 1);
        const output: string[] = [];
        const panel = (line: string) => {
          const clipped = truncateToWidth(line, width, "");
          const padded = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
          return backgroundLine(padded, EDITOR_BACKGROUND);
        };
        const cursor = "\x1b[7m \x1b[0m";
        editorLines.forEach((rawLine, index) => {
          let line = rawLine;
          if (index === 0 && this.getText() === "" && line.includes(cursor)) {
            line = truncateToWidth(line.replace(cursor, `${cursor}${theme.fg("dim", "Ask Pi…")}`), contentWidth, "");
          }
          const gutter = index === 0
            ? color(state.working ? `${SPINNER_FRAMES[state.spinnerFrame]} ` : "› ")
            : "  ";
          output.push(panel(`  ${gutter}${truncateToWidth(line, contentWidth, "")}`));
        });
        for (const line of autocomplete) {
          output.push(panel(`    ${truncateToWidth(line, contentWidth, "")}`));
        }
        const down = scrollLabel(base[divider]);
        if (down) {
          const label = theme.fg("dim", down.trim());
          output.push(panel(`    ${label}${" ".repeat(Math.max(0, width - 4 - visibleWidth(label)))}`));
        }
        return output;
      }
    }

    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new TrevEditor(tui, editorTheme, keybindings));
    refreshTitle(ctx);
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "user") {
      state.hasUserMessage = true;
      requestRender();
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      const message = event.message as AssistantMessage;
      if (message.stopReason === "error") flashError();
    }
  });
  pi.on("agent_start", () => {
    state.working = true;
    stopSpinner();
    state.spinnerTimer = setInterval(() => {
      state.spinnerFrame = (state.spinnerFrame + 1) % SPINNER_FRAMES.length;
      requestRender();
    }, 80);
    requestRender();
  });
  pi.on("agent_end", () => {
    state.working = false;
    stopSpinner();
    requestRender();
  });
  pi.on("tool_result", (event, ctx) => {
    if (ctx.mode === "tui" && shouldRefreshDirtyState(event.toolName, event.input, event.isError)) {
      refreshDirtyState(ctx);
    }
  });
  pi.on("tool_execution_end", (event) => {
    if (event.isError) flashError();
  });
  pi.on("model_select", (_event, ctx) => {
    if (ctx.mode === "tui") refreshTitle(ctx);
    requestRender();
  });
  pi.on("thinking_level_select", () => requestRender());
  pi.on("session_info_changed", (_event, ctx) => {
    if (ctx.mode === "tui") refreshTitle(ctx);
  });
  pi.on("session_shutdown", () => {
    dirtyRefreshGeneration += 1;
    githubRefreshGeneration += 1;
    stopSpinner();
    stopGithubRefresh();
    if (state.errorTimer) clearTimeout(state.errorTimer);
    state.errorTimer = undefined;
    if (lastContext?.mode === "tui") {
      lastContext.ui.setHeader(undefined);
      lastContext.ui.setFooter(undefined);
      lastContext.ui.setEditorComponent(undefined);
      lastContext.ui.setWorkingVisible(true);
      lastContext.ui.setHiddenThinkingLabel();
      lastContext.ui.setTitle("pi");
    }
    state.tui = undefined;
    state.footerData = undefined;
  });
}
