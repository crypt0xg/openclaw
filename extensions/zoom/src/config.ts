import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceAgentConsultToolPolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

export type ZoomTransport = "chrome" | "chrome-node";
export type ZoomMode = "realtime" | "transcribe" | "conversation";
export type ZoomChromeAudioFormat = "pcm16-24khz" | "g711-ulaw-8khz";
export type ZoomToolPolicy = RealtimeVoiceAgentConsultToolPolicy;

export type ZoomConfig = {
  enabled: boolean;
  defaults: {
    meeting?: string;
  };
  defaultTransport: ZoomTransport;
  defaultMode: ZoomMode;
  chrome: {
    audioBackend: "blackhole-2ch";
    audioFormat: ZoomChromeAudioFormat;
    launch: boolean;
    browserProfile?: string;
    guestName: string;
    reuseExistingTab: boolean;
    autoJoin: boolean;
    joinTimeoutMs: number;
    waitForInCallMs: number;
    audioInputCommand?: string[];
    audioOutputCommand?: string[];
    audioBridgeCommand?: string[];
    audioBridgeHealthCommand?: string[];
  };
  conversation: {
    agentId?: string;
    provider?: string;
    model?: string;
    instructions?: string;
    introMessage?: string;
    playbackCommand: string[];
    halfDuplex: boolean;
    echoSuppressionMs: number;
    minTranscriptChars: number;
    ttsTimeoutMs: number;
    vad: {
      rmsThreshold: number;
      minSpeechMs: number;
      silenceMs: number;
      maxUtteranceMs: number;
      preSpeechMs: number;
    };
  };
  chromeNode: {
    node?: string;
  };
  realtime: {
    provider?: string;
    model?: string;
    instructions?: string;
    introMessage?: string;
    agentId?: string;
    toolPolicy: ZoomToolPolicy;
    providers: Record<string, Record<string, unknown>>;
  };
};

export const DEFAULT_ZOOM_AUDIO_INPUT_COMMAND = [
  "sox",
  "-q",
  "-t",
  "coreaudio",
  "BlackHole 2ch",
  "-t",
  "raw",
  "-r",
  "24000",
  "-c",
  "1",
  "-e",
  "signed-integer",
  "-b",
  "16",
  "-L",
  "-",
] as const;

export const DEFAULT_ZOOM_AUDIO_OUTPUT_COMMAND = [
  "sox",
  "-q",
  "-t",
  "raw",
  "-r",
  "24000",
  "-c",
  "1",
  "-e",
  "signed-integer",
  "-b",
  "16",
  "-L",
  "-",
  "-t",
  "coreaudio",
  "BlackHole 2ch",
] as const;

export const LEGACY_ZOOM_AUDIO_INPUT_COMMAND = [
  "rec",
  "-q",
  "-t",
  "raw",
  "-r",
  "8000",
  "-c",
  "1",
  "-e",
  "mu-law",
  "-b",
  "8",
  "-",
] as const;

export const LEGACY_ZOOM_AUDIO_OUTPUT_COMMAND = [
  "play",
  "-q",
  "-t",
  "raw",
  "-r",
  "8000",
  "-c",
  "1",
  "-e",
  "mu-law",
  "-b",
  "8",
  "-",
] as const;

export const DEFAULT_ZOOM_CHROME_AUDIO_FORMAT: ZoomChromeAudioFormat = "pcm16-24khz";

export const DEFAULT_ZOOM_CONVERSATION_PLAYBACK_COMMAND = [
  "sox",
  "-q",
  "{{AudioPath}}",
  "-t",
  "coreaudio",
  "BlackHole 2ch",
] as const;

export const DEFAULT_ZOOM_CONVERSATION_INSTRUCTIONS =
  "Reply naturally in one short spoken answer for the Zoom participant.";
export const DEFAULT_ZOOM_CONVERSATION_INTRO_MESSAGE = "I'm here and listening.";

export const DEFAULT_ZOOM_REALTIME_INSTRUCTIONS = `You are joining a private Zoom meeting as an OpenClaw agent. Keep spoken replies brief and natural. When a question needs deeper reasoning, current information, or tools, call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} before answering.`;
export const DEFAULT_ZOOM_REALTIME_INTRO_MESSAGE = "Say exactly: I'm here and listening.";

export const DEFAULT_ZOOM_CONFIG: ZoomConfig = {
  enabled: true,
  defaults: {},
  defaultTransport: "chrome",
  defaultMode: "realtime",
  chrome: {
    audioBackend: "blackhole-2ch",
    audioFormat: DEFAULT_ZOOM_CHROME_AUDIO_FORMAT,
    launch: true,
    guestName: "OpenClaw Agent",
    reuseExistingTab: true,
    autoJoin: true,
    joinTimeoutMs: 30_000,
    waitForInCallMs: 20_000,
    audioInputCommand: [...DEFAULT_ZOOM_AUDIO_INPUT_COMMAND],
    audioOutputCommand: [...DEFAULT_ZOOM_AUDIO_OUTPUT_COMMAND],
  },
  conversation: {
    instructions: DEFAULT_ZOOM_CONVERSATION_INSTRUCTIONS,
    introMessage: DEFAULT_ZOOM_CONVERSATION_INTRO_MESSAGE,
    playbackCommand: [...DEFAULT_ZOOM_CONVERSATION_PLAYBACK_COMMAND],
    halfDuplex: true,
    echoSuppressionMs: 700,
    minTranscriptChars: 2,
    ttsTimeoutMs: 120_000,
    vad: {
      rmsThreshold: 0.003,
      minSpeechMs: 250,
      silenceMs: 700,
      maxUtteranceMs: 15_000,
      preSpeechMs: 250,
    },
  },
  chromeNode: {},
  realtime: {
    provider: "openai",
    instructions: DEFAULT_ZOOM_REALTIME_INSTRUCTIONS,
    introMessage: DEFAULT_ZOOM_REALTIME_INTRO_MESSAGE,
    toolPolicy: "safe-read-only",
    providers: {},
  },
};

const ZOOM_DEFAULT_MEETING_KEYS = [
  "OPENCLAW_ZOOM_DEFAULT_MEETING",
  "ZOOM_DEFAULT_MEETING",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readEnvString(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = normalizeOptionalString(env[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

function resolveProvidersConfig(value: unknown): Record<string, Record<string, unknown>> {
  const raw = asRecord(value);
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const providerId = normalizeOptionalLowercaseString(key);
    if (!providerId) {
      continue;
    }
    providers[providerId] = asRecord(entry);
  }
  return providers;
}

function resolveTransport(value: unknown, fallback: ZoomTransport): ZoomTransport {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "chrome" || normalized === "chrome-node" ? normalized : fallback;
}

function resolveMode(value: unknown, fallback: ZoomMode): ZoomMode {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "realtime" || normalized === "transcribe" || normalized === "conversation"
    ? normalized
    : fallback;
}

function resolveChromeAudioFormat(value: unknown): ZoomChromeAudioFormat | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "pcm16-24khz":
    case "pcm16-24k":
    case "pcm24":
    case "pcm":
      return "pcm16-24khz";
    case "g711-ulaw-8khz":
    case "g711-ulaw-8k":
    case "g711-ulaw":
    case "mulaw":
    case "mu-law":
      return "g711-ulaw-8khz";
    default:
      return undefined;
  }
}

function defaultAudioInputCommand(format: ZoomChromeAudioFormat): readonly string[] {
  return format === "g711-ulaw-8khz"
    ? LEGACY_ZOOM_AUDIO_INPUT_COMMAND
    : DEFAULT_ZOOM_AUDIO_INPUT_COMMAND;
}

function defaultAudioOutputCommand(format: ZoomChromeAudioFormat): readonly string[] {
  return format === "g711-ulaw-8khz"
    ? LEGACY_ZOOM_AUDIO_OUTPUT_COMMAND
    : DEFAULT_ZOOM_AUDIO_OUTPUT_COMMAND;
}

export function resolveZoomConfig(input: unknown): ZoomConfig {
  return resolveZoomConfigWithEnv(input);
}

export function resolveZoomConfigWithEnv(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ZoomConfig {
  const raw = asRecord(input);
  const defaults = asRecord(raw.defaults);
  const chrome = asRecord(raw.chrome);
  const configuredAudioInputCommand = resolveStringArray(chrome.audioInputCommand);
  const configuredAudioOutputCommand = resolveStringArray(chrome.audioOutputCommand);
  const hasCustomAudioCommand =
    configuredAudioInputCommand !== undefined || configuredAudioOutputCommand !== undefined;
  const audioFormat =
    resolveChromeAudioFormat(chrome.audioFormat) ??
    (hasCustomAudioCommand ? "g711-ulaw-8khz" : DEFAULT_ZOOM_CONFIG.chrome.audioFormat);
  const conversation = asRecord(raw.conversation);
  const conversationVad = asRecord(conversation.vad);
  const chromeNode = asRecord(raw.chromeNode);
  const realtime = asRecord(raw.realtime);

  return {
    enabled: resolveBoolean(raw.enabled, DEFAULT_ZOOM_CONFIG.enabled),
    defaults: {
      meeting:
        normalizeOptionalString(defaults.meeting) ?? readEnvString(env, ZOOM_DEFAULT_MEETING_KEYS),
    },
    defaultTransport: resolveTransport(raw.defaultTransport, DEFAULT_ZOOM_CONFIG.defaultTransport),
    defaultMode: resolveMode(raw.defaultMode, DEFAULT_ZOOM_CONFIG.defaultMode),
    chrome: {
      audioBackend: "blackhole-2ch",
      audioFormat,
      launch: resolveBoolean(chrome.launch, DEFAULT_ZOOM_CONFIG.chrome.launch),
      browserProfile: normalizeOptionalString(chrome.browserProfile),
      guestName: normalizeOptionalString(chrome.guestName) ?? DEFAULT_ZOOM_CONFIG.chrome.guestName,
      reuseExistingTab: resolveBoolean(
        chrome.reuseExistingTab,
        DEFAULT_ZOOM_CONFIG.chrome.reuseExistingTab,
      ),
      autoJoin: resolveBoolean(chrome.autoJoin, DEFAULT_ZOOM_CONFIG.chrome.autoJoin),
      joinTimeoutMs: resolveNumber(chrome.joinTimeoutMs, DEFAULT_ZOOM_CONFIG.chrome.joinTimeoutMs),
      waitForInCallMs: resolveNumber(
        chrome.waitForInCallMs,
        DEFAULT_ZOOM_CONFIG.chrome.waitForInCallMs,
      ),
      audioInputCommand: configuredAudioInputCommand ?? [...defaultAudioInputCommand(audioFormat)],
      audioOutputCommand: configuredAudioOutputCommand ?? [
        ...defaultAudioOutputCommand(audioFormat),
      ],
      audioBridgeCommand: resolveStringArray(chrome.audioBridgeCommand),
      audioBridgeHealthCommand: resolveStringArray(chrome.audioBridgeHealthCommand),
    },
    conversation: {
      agentId: normalizeOptionalString(conversation.agentId),
      provider: normalizeOptionalString(conversation.provider),
      model: normalizeOptionalString(conversation.model),
      instructions:
        normalizeOptionalString(conversation.instructions) ??
        DEFAULT_ZOOM_CONFIG.conversation.instructions,
      introMessage:
        normalizeOptionalString(conversation.introMessage) ??
        DEFAULT_ZOOM_CONFIG.conversation.introMessage,
      playbackCommand: resolveStringArray(conversation.playbackCommand) ?? [
        ...DEFAULT_ZOOM_CONFIG.conversation.playbackCommand,
      ],
      halfDuplex: resolveBoolean(
        conversation.halfDuplex,
        DEFAULT_ZOOM_CONFIG.conversation.halfDuplex,
      ),
      echoSuppressionMs: resolveNumber(
        conversation.echoSuppressionMs,
        DEFAULT_ZOOM_CONFIG.conversation.echoSuppressionMs,
      ),
      minTranscriptChars: resolveNumber(
        conversation.minTranscriptChars,
        DEFAULT_ZOOM_CONFIG.conversation.minTranscriptChars,
      ),
      ttsTimeoutMs: resolveNumber(
        conversation.ttsTimeoutMs,
        DEFAULT_ZOOM_CONFIG.conversation.ttsTimeoutMs,
      ),
      vad: {
        rmsThreshold: resolveNumber(
          conversationVad.rmsThreshold,
          DEFAULT_ZOOM_CONFIG.conversation.vad.rmsThreshold,
        ),
        minSpeechMs: resolveNumber(
          conversationVad.minSpeechMs,
          DEFAULT_ZOOM_CONFIG.conversation.vad.minSpeechMs,
        ),
        silenceMs: resolveNumber(
          conversationVad.silenceMs,
          DEFAULT_ZOOM_CONFIG.conversation.vad.silenceMs,
        ),
        maxUtteranceMs: resolveNumber(
          conversationVad.maxUtteranceMs,
          DEFAULT_ZOOM_CONFIG.conversation.vad.maxUtteranceMs,
        ),
        preSpeechMs: resolveNumber(
          conversationVad.preSpeechMs,
          DEFAULT_ZOOM_CONFIG.conversation.vad.preSpeechMs,
        ),
      },
    },
    chromeNode: {
      node: normalizeOptionalString(chromeNode.node),
    },
    realtime: {
      provider: normalizeOptionalString(realtime.provider) ?? DEFAULT_ZOOM_CONFIG.realtime.provider,
      model: normalizeOptionalString(realtime.model) ?? DEFAULT_ZOOM_CONFIG.realtime.model,
      instructions:
        normalizeOptionalString(realtime.instructions) ?? DEFAULT_ZOOM_CONFIG.realtime.instructions,
      introMessage:
        normalizeOptionalString(realtime.introMessage) ?? DEFAULT_ZOOM_CONFIG.realtime.introMessage,
      agentId: normalizeOptionalString(realtime.agentId),
      toolPolicy: resolveRealtimeVoiceAgentConsultToolPolicy(
        realtime.toolPolicy,
        DEFAULT_ZOOM_CONFIG.realtime.toolPolicy,
      ),
      providers: resolveProvidersConfig(realtime.providers),
    },
  };
}
