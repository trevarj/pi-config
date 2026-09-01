import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  keyText,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import {
  dashboardDataFromContext,
  registerWorkMode,
  showDashboard,
  type SessionOwner,
} from "./menu.ts";
import {
  buildFooterRows,
  contextTelemetry,
  projectName,
  promptCacheTelemetry,
  shouldRefreshGit,
  splitResourceCommands,
  StartupDashboard,
  statusRank,
  TrevEditor,
  type EditorView,
  type HeaderData,
} from "./presentation.ts";
import { TelemetryCollector, type TelemetrySnapshot } from "./state.ts";
import {
  setupToolRenderers,
  sharedAnimationClock,
  ToolActivityController,
} from "./tools.ts";

interface UiState {
  generation: number;
  owner: (SessionOwner & { controller: AbortController }) | undefined;
  context: ExtensionContext | undefined;
  collector: TelemetryCollector | undefined;
  tui: TUI | undefined;
  footerData: ReadonlyFooterDataProvider | undefined;
  agentActive: boolean;
  agentSince: number | undefined;
  waiting: boolean;
  waitingSince: number | undefined;
  errorUntil: number;
  errorTimer: ReturnType<typeof setTimeout> | undefined;
}

function emptyTelemetry(): TelemetrySnapshot {
  return {
    git: { kind: "loading" },
    pullRequest: { kind: "loading" },
    notifications: { kind: "loading" },
    health: {
      git: { id: "git", command: "git status --porcelain=v2 --branch", refresh: "not started", requests: 0, runs: 0, coalesced: 0, inFlight: false, queued: false },
      "pull-request": { id: "pull-request", command: "gh pr view", refresh: "not started", requests: 0, runs: 0, coalesced: 0, inFlight: false, queued: false },
      notifications: { id: "notifications", command: "gh api notifications", refresh: "not started", requests: 0, runs: 0, coalesced: 0, inFlight: false, queued: false },
    },
  };
}

function currentActivity(state: UiState): "active" | "waiting" | "idle" {
  if (state.waiting) return "waiting";
  return state.agentActive ? "active" : "idle";
}

function titleFor(ctx: ExtensionContext): string {
  const session = ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId().slice(0, 8);
  const model = ctx.model?.id ?? "no model";
  return sanitizeTerminalText(`π ${projectName(ctx)} · ${session} · ${model}`);
}

export default function trevPi(pi: ExtensionAPI): void {
  const state: UiState = {
    generation: 0,
    owner: undefined,
    context: undefined,
    collector: undefined,
    tui: undefined,
    footerData: undefined,
    agentActive: false,
    agentSince: undefined,
    waiting: false,
    waitingSince: undefined,
    errorUntil: 0,
    errorTimer: undefined,
  };
  const toolActivity = new ToolActivityController();
  const toolRenderers = setupToolRenderers(pi, toolActivity);
  const workMode = registerWorkMode(pi, () => state.owner);

  const requestRender = () => state.tui?.requestRender();
  const owns = (ctx: ExtensionContext) =>
    state.context?.sessionManager === ctx.sessionManager && state.owner?.isCurrent() === true;
  const statuses = (): Array<[string, string]> => {
    const values = new Map(state.footerData?.getExtensionStatuses() ?? []);
    const mode = workMode.getMode();
    if (!values.has("work-mode") && mode) values.set("work-mode", `mode ${mode}`);
    return [...values.entries()].sort(([a], [b]) => statusRank(a) - statusRank(b) || a.localeCompare(b));
  };
  const telemetry = (): Readonly<TelemetrySnapshot> => state.collector?.get() ?? emptyTelemetry();
  const refreshTitle = (ctx: ExtensionContext) => {
    if (ctx.mode === "tui") ctx.ui.setTitle(titleFor(ctx));
  };
  const flashError = () => {
    state.errorUntil = Date.now() + 1_500;
    if (state.errorTimer) clearTimeout(state.errorTimer);
    state.errorTimer = setTimeout(() => {
      state.errorTimer = undefined;
      requestRender();
    }, 1_500);
    requestRender();
  };
  const stopSession = (restore = true) => {
    const ctx = state.context;
    state.generation += 1;
    state.owner?.controller.abort();
    state.owner = undefined;
    state.collector?.stop();
    state.collector = undefined;
    toolActivity.clear();
    toolRenderers.clear();
    sharedAnimationClock.stop("trev-pi:agent");
    if (state.errorTimer) clearTimeout(state.errorTimer);
    state.errorTimer = undefined;
    state.agentActive = false;
    state.agentSince = undefined;
    state.waiting = false;
    state.waitingSince = undefined;
    if (restore && ctx?.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setWorkingVisible(true);
      ctx.ui.setHiddenThinkingLabel();
      ctx.ui.setTitle("pi");
    }
    state.context = undefined;
    state.footerData = undefined;
    state.tui = undefined;
  };

  pi.registerCommand("dashboard", {
    description: "Browse read-only runtime, session, workspace, and collector details",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/dashboard does not accept arguments.", "error");
        return;
      }
      const owner = state.owner;
      if (!owner || owner.signal.aborted || !owner.isCurrent()) {
        ctx.ui.notify("/dashboard is unavailable because the session is closing.", "error");
        return;
      }
      await showDashboard(ctx, owner, () => dashboardDataFromContext(
        pi,
        ctx,
        telemetry(),
        currentActivity(state),
        statuses(),
      ));
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // Defensive replacement keeps exactly one generation, controller, and collector.
    if (state.owner || state.context) stopSession(false);
    const generation = ++state.generation;
    const controller = new AbortController();
    const owner: UiState["owner"] = {
      generation,
      controller,
      signal: controller.signal,
      isCurrent: () => state.owner?.generation === generation && !controller.signal.aborted,
    };
    state.owner = owner;
    state.context = ctx;
    state.agentActive = !ctx.isIdle();
    state.agentSince = state.agentActive ? Date.now() : undefined;
    state.waiting = false;
    state.waitingSince = undefined;
    state.errorUntil = 0;

    if (ctx.hasUI) {
      state.collector = new TelemetryCollector({
        exec: (command, args, options) => pi.exec(command, args, options),
        cwd: ctx.cwd,
        signal: controller.signal,
        isCurrent: owner.isCurrent,
        onChange: requestRender,
      });
      state.collector.start();
    }
    if (ctx.mode !== "tui") return;

    ctx.ui.setWorkingVisible(false);
    ctx.ui.setHiddenThinkingLabel(`reasoning hidden (${keyText("app.thinking.toggle")})`);

    ctx.ui.setFooter((tui, theme, footerData) => {
      state.tui = tui;
      state.footerData = footerData;
      const unsubscribe = footerData.onBranchChange(() => {
        if (!owner.isCurrent()) return;
        void state.collector?.refreshGit();
        void state.collector?.refreshPullRequest();
        tui.requestRender();
      });
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          const usage = ctx.getContextUsage();
          const cache = promptCacheTelemetry(
            ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []),
            ctx.model?.provider,
            ctx.model?.id,
          );
          const values = statuses();
          const activity = currentActivity(state);
          const activitySince = activity === "waiting" ? state.waitingSince : activity === "active" ? state.agentSince : undefined;
          return buildFooterRows({
            now: Date.now(),
            activity,
            activitySince,
            frame: sharedAnimationClock.frame,
            provider: ctx.model?.provider ?? "none",
            model: ctx.model?.id ?? "none",
            thinking: pi.getThinkingLevel(),
            context: contextTelemetry(usage?.tokens, usage?.contextWindow ?? ctx.model?.contextWindow),
            cache,
            providerUsage: values.find(([name]) => name === "usage")?.[1],
            queued: ctx.hasPendingMessages(),
            project: projectName(ctx),
            session: ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId().slice(0, 8),
            telemetry: telemetry(),
            statuses: values,
          }, width, theme);
        },
      };
    });

    ctx.ui.setHeader((tui, theme) => {
      state.tui = tui;
      const keybindings = {
        getKeys(binding: string): readonly string[] {
          try {
            return [keyText(binding as Parameters<typeof keyText>[0])];
          } catch {
            return [];
          }
        },
      } as Pick<KeybindingsManager, "getKeys">;
      const getData = (): HeaderData => {
        const resources = splitResourceCommands(pi.getCommands().map((command) => ({ name: command.name, source: command.source })));
        return {
          project: projectName(ctx),
          cwd: ctx.cwd,
          session: ctx.sessionManager.getSessionName() ?? "unnamed",
          sessionId: ctx.sessionManager.getSessionId(),
          provider: ctx.model?.provider ?? "none",
          model: ctx.model?.id ?? "none",
          thinking: pi.getThinkingLevel(),
          trusted: ctx.isProjectTrusted(),
          telemetry: telemetry(),
          skills: resources.skills,
          commands: resources.commands,
          prompts: resources.prompts,
          tools: [...pi.getActiveTools()].sort((a, b) => a.localeCompare(b)),
        };
      };
      return new StartupDashboard(theme, keybindings, getData, () => tui.requestRender());
    });

    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      state.tui = tui;
      const getView = (): EditorView => ({
        activity: currentActivity(state),
        frame: sharedAnimationClock.frame,
        error: Date.now() < state.errorUntil,
        queued: ctx.hasPendingMessages(),
        thinking: pi.getThinkingLevel(),
      });
      return new TrevEditor(tui, editorTheme, keybindings, ctx.ui.theme, getView);
    });
    refreshTitle(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!owns(ctx)) return;
    state.agentActive = true;
    state.agentSince ??= Date.now();
    sharedAnimationClock.start("trev-pi:agent", requestRender);
    requestRender();
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!owns(ctx)) return;
    state.agentActive = false;
    state.agentSince = undefined;
    sharedAnimationClock.stop("trev-pi:agent");
    void state.collector?.refreshGit();
    void state.collector?.refreshPullRequest();
    requestRender();
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    if (!owns(ctx)) return;
    state.waiting = true;
    state.waitingSince ??= Date.now();
    requestRender();
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    if (!owns(ctx)) return;
    state.waiting = false;
    state.waitingSince = undefined;
    requestRender();
  });
  pi.on("message_end", (event, ctx) => {
    if (!owns(ctx)) return;
    if (event.message.role === "assistant" && (event.message as AssistantMessage).stopReason === "error") flashError();
  });
  pi.on("turn_end", (_event, ctx) => {
    if (owns(ctx)) void state.collector?.refreshGit();
  });
  pi.on("tool_result", (event, ctx) => {
    if (!owns(ctx) || !shouldRefreshGit(event.toolName, event.input, event.isError)) return;
    void state.collector?.refreshGit();
    if (event.toolName === "bash") void state.collector?.refreshPullRequest();
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (owns(ctx) && event.isError) flashError();
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!owns(ctx)) return;
    void state.collector?.refreshGit();
    void state.collector?.refreshPullRequest();
    requestRender();
  });
  pi.on("model_select", (_event, ctx) => {
    if (!owns(ctx)) return;
    refreshTitle(ctx);
    requestRender();
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (owns(ctx)) requestRender();
  });
  pi.on("session_info_changed", (_event, ctx) => {
    if (!owns(ctx)) return;
    refreshTitle(ctx);
    requestRender();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (!state.context || state.context.sessionManager === ctx.sessionManager) stopSession(true);
  });
}
