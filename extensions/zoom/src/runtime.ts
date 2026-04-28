import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { ZoomConfig, ZoomMode, ZoomTransport } from "./config.js";
import { addZoomSetupCheck, getZoomSetupStatus } from "./setup.js";
import { isSameZoomUrlForReuse, resolveChromeNodeInfo } from "./transports/chrome-browser-proxy.js";
import {
  assertBlackHole2chAvailable,
  launchChromeZoom,
  launchChromeZoomOnNode,
  recoverCurrentZoomTab,
  recoverCurrentZoomTabOnNode,
} from "./transports/chrome.js";
import type {
  ZoomChromeHealth,
  ZoomJoinRequest,
  ZoomJoinResult,
  ZoomSession,
} from "./transports/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeZoomUrl(input: unknown): string {
  const raw = normalizeOptionalString(input);
  if (!raw) {
    throw new Error("url required");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("url must be a valid Zoom URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(hostname === "zoom.us" || hostname.endsWith(".zoom.us"))) {
    throw new Error("url must be an explicit https://*.zoom.us/... URL");
  }
  if (!/^\/(?:(?:j|wc\/join|s)\/\d{6,14}|my\/[A-Za-z0-9._-]+)(?:\/)?$/i.test(url.pathname)) {
    throw new Error("url must include a Zoom meeting path such as /j/<meetingId> or /my/<name>");
  }
  return url.toString();
}

function resolveTransport(input: ZoomTransport | undefined, config: ZoomConfig) {
  return input ?? config.defaultTransport;
}

function resolveMode(input: ZoomMode | undefined, config: ZoomConfig) {
  return input ?? config.defaultMode;
}

function collectChromeAudioCommands(config: ZoomConfig): string[] {
  const commands = config.chrome.audioBridgeCommand
    ? [config.chrome.audioBridgeCommand[0]]
    : [
        config.chrome.audioInputCommand?.[0],
        config.chrome.audioOutputCommand?.[0],
        config.conversation.playbackCommand[0],
      ];
  return [...new Set(commands.filter((value): value is string => Boolean(value?.trim())))];
}

async function commandExists(runtime: PluginRuntime, command: string): Promise<boolean> {
  const result = await runtime.system.runCommandWithTimeout(
    ["/bin/sh", "-lc", 'command -v "$1" >/dev/null 2>&1', "sh", command],
    { timeoutMs: 5_000 },
  );
  return result.code === 0;
}

export class ZoomRuntime {
  readonly #sessions = new Map<string, ZoomSession>();
  readonly #sessionStops = new Map<string, () => Promise<void>>();
  readonly #sessionSpeakers = new Map<string, (instructions?: string) => void>();
  readonly #sessionHealth = new Map<string, () => ZoomChromeHealth>();

  constructor(
    private readonly params: {
      config: ZoomConfig;
      fullConfig: OpenClawConfig;
      runtime: PluginRuntime;
      logger: RuntimeLogger;
    },
  ) {}

  list(): ZoomSession[] {
    this.#refreshHealth();
    return [...this.#sessions.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  status(sessionId?: string): {
    found: boolean;
    session?: ZoomSession;
    sessions?: ZoomSession[];
  } {
    this.#refreshHealth(sessionId);
    if (!sessionId) {
      return { found: true, sessions: this.list() };
    }
    const session = this.#sessions.get(sessionId);
    return session ? { found: true, session } : { found: false };
  }

  async setupStatus(options: { transport?: ZoomTransport } = {}) {
    const transport = resolveTransport(options.transport, this.params.config);
    const shouldCheckChromeNode =
      transport === "chrome-node" ||
      (!options.transport && Boolean(this.params.config.chromeNode.node));
    let status = getZoomSetupStatus(this.params.config);
    if (shouldCheckChromeNode) {
      try {
        const node = await resolveChromeNodeInfo({
          runtime: this.params.runtime,
          requestedNode: this.params.config.chromeNode.node,
        });
        const label = node.displayName ?? node.remoteIp ?? node.nodeId ?? "connected node";
        status = addZoomSetupCheck(status, {
          id: "chrome-node-connected",
          ok: true,
          message: `Connected Zoom node ready: ${label}`,
        });
      } catch (error) {
        status = addZoomSetupCheck(status, {
          id: "chrome-node-connected",
          ok: false,
          message: formatErrorMessage(error),
        });
      }
    }
    if (transport === "chrome") {
      try {
        await assertBlackHole2chAvailable({
          runtime: this.params.runtime,
          timeoutMs: Math.min(this.params.config.chrome.joinTimeoutMs, 10_000),
        });
        status = addZoomSetupCheck(status, {
          id: "chrome-local-audio-device",
          ok: true,
          message: "BlackHole 2ch audio device found",
        });
      } catch (error) {
        status = addZoomSetupCheck(status, {
          id: "chrome-local-audio-device",
          ok: false,
          message: formatErrorMessage(error),
        });
      }

      const commands = collectChromeAudioCommands(this.params.config);
      const missingCommands: string[] = [];
      for (const command of commands) {
        try {
          if (!(await commandExists(this.params.runtime, command))) {
            missingCommands.push(command);
          }
        } catch {
          missingCommands.push(command);
        }
      }
      status = addZoomSetupCheck(status, {
        id: "chrome-local-audio-commands",
        ok: commands.length > 0 && missingCommands.length === 0,
        message:
          commands.length === 0
            ? "Chrome realtime audio commands are not configured"
            : missingCommands.length === 0
              ? `Chrome audio command${commands.length === 1 ? "" : "s"} available: ${commands.join(", ")}`
              : `Chrome audio command${missingCommands.length === 1 ? "" : "s"} missing: ${missingCommands.join(", ")}`,
      });
    }
    return status;
  }

  async recoverCurrentTab(request: { url?: string; transport?: ZoomTransport } = {}) {
    const transport = resolveTransport(request.transport, this.params.config);
    const url = request.url ? normalizeZoomUrl(request.url) : undefined;
    if (transport === "chrome-node") {
      return recoverCurrentZoomTabOnNode({
        runtime: this.params.runtime,
        config: this.params.config,
        url,
      });
    }
    return recoverCurrentZoomTab({
      config: this.params.config,
      url,
    });
  }

  async join(request: ZoomJoinRequest): Promise<ZoomJoinResult> {
    const url = normalizeZoomUrl(request.url);
    const transport = resolveTransport(request.transport, this.params.config);
    const mode = resolveMode(request.mode, this.params.config);
    const reusable = this.list().find(
      (session) =>
        session.state === "active" &&
        isSameZoomUrlForReuse(session.url, url) &&
        session.transport === transport &&
        session.mode === mode,
    );
    const speechInstructions =
      request.message ??
      (mode === "conversation"
        ? this.params.config.conversation.introMessage
        : this.params.config.realtime.introMessage);
    if (reusable) {
      reusable.notes = [
        ...reusable.notes.filter((note) => note !== "Reused existing active Zoom session."),
        "Reused existing active Zoom session.",
      ];
      reusable.updatedAt = nowIso();
      const spoken =
        (mode === "realtime" || mode === "conversation") && speechInstructions
          ? this.speak(reusable.id, speechInstructions).spoken
          : false;
      return { session: reusable, spoken };
    }
    const createdAt = nowIso();

    const session: ZoomSession = {
      id: `zoom_${randomUUID()}`,
      url,
      transport,
      mode,
      state: "active",
      createdAt,
      updatedAt: createdAt,
      participantIdentity:
        transport === "chrome-node"
          ? "signed-in Chrome profile on a paired node"
          : "signed-in Chrome profile",
      realtime: {
        enabled: mode === "realtime",
        provider: this.params.config.realtime.provider,
        model: this.params.config.realtime.model,
        toolPolicy: this.params.config.realtime.toolPolicy,
      },
      notes: [],
    };

    try {
      if (transport === "chrome" || transport === "chrome-node") {
        const result =
          transport === "chrome-node"
            ? await launchChromeZoomOnNode({
                runtime: this.params.runtime,
                config: this.params.config,
                fullConfig: this.params.fullConfig,
                meetingSessionId: session.id,
                mode,
                url,
                logger: this.params.logger,
              })
            : await launchChromeZoom({
                runtime: this.params.runtime,
                config: this.params.config,
                fullConfig: this.params.fullConfig,
                meetingSessionId: session.id,
                mode,
                url,
                logger: this.params.logger,
              });
        session.chrome = {
          audioBackend: this.params.config.chrome.audioBackend,
          launched: result.launched,
          nodeId: "nodeId" in result ? result.nodeId : undefined,
          browserProfile: this.params.config.chrome.browserProfile,
          audioBridge: result.audioBridge
            ? {
                type: result.audioBridge.type,
                provider:
                  result.audioBridge.type === "command-pair" ||
                  result.audioBridge.type === "node-command-pair"
                    ? result.audioBridge.providerId
                    : undefined,
              }
            : undefined,
          health: "browser" in result ? result.browser : undefined,
        };
        if (
          result.audioBridge?.type === "command-pair" ||
          result.audioBridge?.type === "node-command-pair" ||
          result.audioBridge?.type === "native-conversation"
        ) {
          this.#sessionStops.set(session.id, result.audioBridge.stop);
          this.#sessionSpeakers.set(session.id, result.audioBridge.speak);
          this.#sessionHealth.set(session.id, result.audioBridge.getHealth);
        }
        session.notes.push(
          result.audioBridge
            ? transport === "chrome-node"
              ? "Chrome node transport joins through the selected node and routes realtime audio through the node bridge."
              : "Chrome transport joins locally and routes realtime audio through the configured bridge."
            : "Chrome transport joins through the browser and expects BlackHole 2ch audio routing.",
        );
      }
    } catch (err) {
      this.params.logger.warn(`[zoom] join failed: ${formatErrorMessage(err)}`);
      throw err;
    }

    this.#sessions.set(session.id, session);
    const spoken =
      (mode === "realtime" || mode === "conversation") && speechInstructions
        ? this.speak(session.id, speechInstructions).spoken
        : false;
    return { session, spoken };
  }

  async leave(sessionId: string): Promise<{ found: boolean; session?: ZoomSession }> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false };
    }
    const stop = this.#sessionStops.get(sessionId);
    if (stop) {
      this.#sessionStops.delete(sessionId);
      this.#sessionSpeakers.delete(sessionId);
      this.#sessionHealth.delete(sessionId);
      await stop();
    }
    session.state = "ended";
    session.updatedAt = nowIso();
    return { found: true, session };
  }

  speak(
    sessionId: string,
    instructions?: string,
  ): { found: boolean; spoken: boolean; session?: ZoomSession } {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false, spoken: false };
    }
    const speak = this.#sessionSpeakers.get(sessionId);
    if (!speak || session.state !== "active") {
      return { found: true, spoken: false, session };
    }
    speak(
      instructions ||
        (session.mode === "conversation"
          ? this.params.config.conversation.introMessage
          : this.params.config.realtime.introMessage),
    );
    session.updatedAt = nowIso();
    this.#refreshHealth(sessionId);
    return { found: true, spoken: true, session };
  }

  async testSpeech(request: ZoomJoinRequest): Promise<{
    createdSession: boolean;
    inCall?: boolean;
    manualActionRequired?: boolean;
    manualActionReason?: ZoomChromeHealth["manualActionReason"];
    manualActionMessage?: string;
    spoken: boolean;
    session: ZoomSession;
  }> {
    const before = new Set(this.list().map((session) => session.id));
    const result = await this.join({
      ...request,
      message: request.message ?? "Say exactly: Zoom speech test complete.",
    });
    const health = result.session.chrome?.health;
    return {
      createdSession: !before.has(result.session.id),
      inCall: health?.inCall,
      manualActionRequired: health?.manualActionRequired,
      manualActionReason: health?.manualActionReason,
      manualActionMessage: health?.manualActionMessage,
      spoken: result.spoken ?? false,
      session: result.session,
    };
  }

  #refreshHealth(sessionId?: string) {
    const ids = sessionId ? [sessionId] : [...this.#sessionHealth.keys()];
    for (const id of ids) {
      const session = this.#sessions.get(id);
      const getHealth = this.#sessionHealth.get(id);
      if (!session?.chrome || !getHealth) {
        continue;
      }
      session.chrome.health = {
        ...session.chrome.health,
        ...getHealth(),
      };
    }
  }
}
