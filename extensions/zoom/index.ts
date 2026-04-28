import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  callGatewayFromCli,
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { Type } from "typebox";
import {
  resolveZoomConfig,
  type ZoomConfig,
  type ZoomMode,
  type ZoomTransport,
} from "./src/config.js";
import { handleZoomNodeHostCommand } from "./src/node-host.js";
import { ZoomRuntime } from "./src/runtime.js";

const zoomConfigSchema = {
  parse(value: unknown) {
    return resolveZoomConfig(value);
  },
  uiHints: {
    "defaults.meeting": {
      label: "Default Meeting",
      help: "Zoom URL used when CLI commands omit a meeting.",
    },
    defaultTransport: {
      label: "Default Transport",
      help: "Chrome uses a local browser profile. Chrome-node runs Chrome on a paired node.",
    },
    defaultMode: {
      label: "Default Mode",
      help: "Realtime starts the duplex voice model loop. Conversation uses native STT/TTS with Zoom-owned VAD. Transcribe joins/observes without talk-back.",
    },
    "chrome.audioBackend": {
      label: "Chrome Audio Backend",
      help: "BlackHole 2ch is required for local duplex audio routing.",
    },
    "chrome.launch": { label: "Launch Chrome" },
    "chrome.browserProfile": { label: "Chrome Profile", advanced: true },
    "chrome.guestName": {
      label: "Guest Name",
      help: "Used when Zoom asks for a display name.",
    },
    "chrome.reuseExistingTab": {
      label: "Reuse Existing Zoom Tab",
      help: "Avoids opening duplicate tabs for the same Zoom URL.",
    },
    "chrome.autoJoin": {
      label: "Auto Join Browser Flow",
      help: "Best-effort Join from Browser, display-name fill, and Join click through OpenClaw browser automation.",
    },
    "chrome.waitForInCallMs": {
      label: "Wait For In-Call (ms)",
      help: "Waits for Chrome to report that the Zoom tab is in-call before the realtime intro speaks.",
      advanced: true,
    },
    "chrome.audioFormat": {
      label: "Audio Format",
      help: "Command-pair audio format. PCM16 24 kHz is the default Chrome/Zoom path; G.711 mu-law 8 kHz remains available for legacy command pairs.",
      advanced: true,
    },
    "chrome.audioInputCommand": {
      label: "Audio Input Command",
      help: "Command that writes meeting audio to stdout in chrome.audioFormat.",
      advanced: true,
    },
    "chrome.audioOutputCommand": {
      label: "Audio Output Command",
      help: "Command that reads assistant audio from stdin in chrome.audioFormat.",
      advanced: true,
    },
    "chrome.audioBridgeCommand": { label: "Audio Bridge Command", advanced: true },
    "chrome.audioBridgeHealthCommand": { label: "Audio Bridge Health Command", advanced: true },
    "conversation.agentId": {
      label: "Conversation Agent",
      help: 'OpenClaw agent id used by native conversation mode. Defaults to realtime.agentId or "main".',
      advanced: true,
    },
    "conversation.provider": {
      label: "Conversation Model Provider",
      help: "Optional provider override for native conversation replies, for example openai-codex or a configured local provider.",
      advanced: true,
    },
    "conversation.model": {
      label: "Conversation Model",
      help: "Optional model override for native conversation replies, for example gpt-5.5 or a configured local model id.",
      advanced: true,
    },
    "conversation.instructions": {
      label: "Conversation Instructions",
      help: "Extra guidance for short native STT/TTS Zoom replies.",
      advanced: true,
    },
    "conversation.playbackCommand": {
      label: "Conversation Playback Command",
      help: "Command that plays a synthesized audio file into the Zoom microphone route. Supports {{AudioPath}}.",
      advanced: true,
    },
    "conversation.vad.rmsThreshold": {
      label: "Conversation VAD RMS Threshold",
      help: "RMS level that starts an utterance in native conversation mode.",
      advanced: true,
    },
    "conversation.vad.silenceMs": {
      label: "Conversation Silence Window (ms)",
      help: "Silence duration that commits an utterance for transcription.",
      advanced: true,
    },
    "chromeNode.node": {
      label: "Chrome Node",
      help: "Node id/name/IP that owns Chrome, BlackHole, and SoX for chrome-node transport.",
      advanced: true,
    },
    "realtime.provider": {
      label: "Realtime Provider",
      help: "Defaults to OpenAI; uses OPENAI_API_KEY when no provider config is set.",
    },
    "realtime.model": { label: "Realtime Model", advanced: true },
    "realtime.instructions": { label: "Realtime Instructions", advanced: true },
    "realtime.introMessage": {
      label: "Realtime Intro Message",
      help: "Spoken once when the realtime bridge is ready. Set to an empty string to join silently.",
    },
    "realtime.agentId": {
      label: "Realtime Consult Agent",
      help: 'OpenClaw agent id used by openclaw_agent_consult. Defaults to "main".',
      advanced: true,
    },
    "realtime.toolPolicy": {
      label: "Realtime Tool Policy",
      help: "Safe read-only tools are available by default; owner requests can unlock broader tools.",
      advanced: true,
    },
  },
};

const ZoomToolSchema = Type.Object({
  action: Type.String({
    enum: [
      "join",
      "status",
      "setup_status",
      "recover_current_tab",
      "leave",
      "speak",
      "test_speech",
    ],
    description:
      "Zoom action to run. After a timeout or unclear browser state, call recover_current_tab before retrying join.",
  }),
  url: Type.Optional(Type.String({ description: "Explicit https://*.zoom.us/j/... URL" })),
  transport: Type.Optional(
    Type.String({ enum: ["chrome", "chrome-node"], description: "Join transport" }),
  ),
  mode: Type.Optional(
    Type.String({
      enum: ["realtime", "conversation", "transcribe"],
      description:
        "Join mode. realtime starts a duplex realtime voice model; conversation uses native STT/TTS with VAD; transcribe joins without talk-back.",
    }),
  ),
  sessionId: Type.Optional(Type.String({ description: "Zoom session ID" })),
  message: Type.Optional(Type.String({ description: "Realtime instructions to speak now" })),
});

function asParamRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function json(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function normalizeTransport(value: unknown): ZoomTransport | undefined {
  return value === "chrome" || value === "chrome-node" ? value : undefined;
}

function normalizeMode(value: unknown): ZoomMode | undefined {
  return value === "realtime" || value === "conversation" || value === "transcribe"
    ? value
    : undefined;
}

function resolveMeetingInput(config: ZoomConfig, value: unknown): string {
  const meeting = normalizeOptionalString(value) ?? config.defaults.meeting;
  if (!meeting) {
    throw new Error("Zoom meeting URL is required");
  }
  return meeting;
}

const zoomToolDeps = {
  callGatewayFromCli,
};

export const __testing = {
  setCallGatewayFromCliForTests(next?: typeof callGatewayFromCli): void {
    zoomToolDeps.callGatewayFromCli = next ?? callGatewayFromCli;
  },
};

type ZoomGatewayToolAction =
  | "join"
  | "status"
  | "recover_current_tab"
  | "setup_status"
  | "leave"
  | "speak"
  | "test_speech";

function zoomGatewayMethodForToolAction(action: ZoomGatewayToolAction): string {
  switch (action) {
    case "recover_current_tab":
      return "zoom.recoverCurrentTab";
    case "setup_status":
      return "zoom.setup";
    case "test_speech":
      return "zoom.testSpeech";
    default:
      return `zoom.${action}`;
  }
}

function resolveZoomToolGatewayTimeoutMs(config: ZoomConfig): number {
  return Math.max(60_000, config.chrome.joinTimeoutMs + 30_000);
}

function readGatewayErrorDetails(err: unknown): unknown {
  if (!err || typeof err !== "object" || !("details" in err)) {
    return undefined;
  }
  return (err as { details?: unknown }).details;
}

async function callZoomGatewayFromTool(params: {
  config: ZoomConfig;
  action: ZoomGatewayToolAction;
  raw: Record<string, unknown>;
}): Promise<unknown> {
  try {
    return await zoomToolDeps.callGatewayFromCli(
      zoomGatewayMethodForToolAction(params.action),
      {
        json: true,
        timeout: String(resolveZoomToolGatewayTimeoutMs(params.config)),
      },
      params.raw,
      { progress: false },
    );
  } catch (err) {
    const details = readGatewayErrorDetails(err);
    if (details && typeof details === "object") {
      return details;
    }
    throw err;
  }
}

export default definePluginEntry({
  id: "zoom",
  name: "Zoom",
  description: "Join Zoom meetings through Chrome transports",
  configSchema: zoomConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = zoomConfigSchema.parse(api.pluginConfig);
    let runtime: ZoomRuntime | null = null;

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("Zoom plugin disabled in plugin config");
      }
      if (!runtime) {
        runtime = new ZoomRuntime({
          config,
          fullConfig: api.config,
          runtime: api.runtime,
          logger: api.logger,
        });
      }
      return runtime;
    };

    const formatGatewayError = (err: unknown) => ({ error: formatErrorMessage(err) });

    const sendError = (
      respond: GatewayRequestHandlerOptions["respond"],
      err: unknown,
      code: Parameters<typeof errorShape>[0] = ErrorCodes.UNAVAILABLE,
    ) => {
      const payload = formatGatewayError(err);
      respond(
        false,
        payload,
        errorShape(
          code,
          typeof payload.error === "string" ? payload.error : "Zoom request failed",
          { details: payload },
        ),
      );
    };

    api.registerGatewayMethod(
      "zoom.join",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const result = await rt.join({
            url: resolveMeetingInput(config, params?.url),
            transport: normalizeTransport(params?.transport),
            mode: normalizeMode(params?.mode),
            message: normalizeOptionalString(params?.message),
          });
          respond(true, result);
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "zoom.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(true, rt.status(normalizeOptionalString(params?.sessionId)));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "zoom.recoverCurrentTab",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(
            true,
            await rt.recoverCurrentTab({
              url: normalizeOptionalString(params?.url),
              transport: normalizeTransport(params?.transport),
            }),
          );
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "zoom.setup",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(true, await rt.setupStatus({ transport: normalizeTransport(params?.transport) }));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "zoom.leave",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sessionId = normalizeOptionalString(params?.sessionId);
          if (!sessionId) {
            sendError(respond, new Error("sessionId required"), ErrorCodes.INVALID_REQUEST);
            return;
          }
          const rt = await ensureRuntime();
          respond(true, await rt.leave(sessionId));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "zoom.speak",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sessionId = normalizeOptionalString(params?.sessionId);
          if (!sessionId) {
            sendError(respond, new Error("sessionId required"), ErrorCodes.INVALID_REQUEST);
            return;
          }
          const rt = await ensureRuntime();
          respond(true, rt.speak(sessionId, normalizeOptionalString(params?.message)));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "zoom.testSpeech",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const result = await rt.testSpeech({
            url: resolveMeetingInput(config, params?.url),
            transport: normalizeTransport(params?.transport),
            mode: normalizeMode(params?.mode),
            message: normalizeOptionalString(params?.message),
          });
          respond(true, result);
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerTool({
      name: "zoom_meeting",
      label: "Zoom Meeting",
      description:
        "Join and track Zoom sessions through Chrome. Call setup_status before join/test_speech; if it reports a Chrome node offline or local audio missing, surface that blocker instead of retrying or switching transports. If a Zoom tab is already open after a timeout, call recover_current_tab before retrying join to report login, passcode, permission, or admission blockers without opening another tab.",
      parameters: ZoomToolSchema,
      async execute(_toolCallId, params) {
        const raw = asParamRecord(params);
        try {
          switch (raw.action) {
            case "join":
            case "status":
            case "recover_current_tab":
            case "setup_status":
            case "leave":
            case "speak":
            case "test_speech":
              return json(
                await callZoomGatewayFromTool({
                  config,
                  action: raw.action,
                  raw,
                }),
              );
            default:
              throw new Error("unknown zoom_meeting action");
          }
        } catch (err) {
          return json({ error: formatErrorMessage(err) });
        }
      },
    });

    api.registerNodeHostCommand({
      command: "zoom.chrome",
      cap: "zoom",
      handle: handleZoomNodeHostCommand,
    });

    api.registerCli(
      async ({ program }) => {
        const { registerZoomCli } = await import("./src/cli.js");
        registerZoomCli({
          program,
          config,
          ensureRuntime,
        });
      },
      {
        commands: ["zoom"],
        descriptors: [
          {
            name: "zoom",
            description: "Join and manage Zoom meetings",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
