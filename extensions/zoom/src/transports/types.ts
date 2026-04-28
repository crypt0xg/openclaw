import type { ZoomMode, ZoomTransport } from "../config.js";

export type ZoomSessionState = "active" | "ended";

export type ZoomJoinRequest = {
  url: string;
  transport?: ZoomTransport;
  mode?: ZoomMode;
  message?: string;
};

export type ZoomManualActionReason =
  | "zoom-login-required"
  | "zoom-browser-join-required"
  | "zoom-name-required"
  | "zoom-passcode-required"
  | "zoom-admission-required"
  | "zoom-permission-required"
  | "zoom-audio-choice-required"
  | "zoom-meeting-ended"
  | "zoom-invalid-meeting"
  | "browser-control-unavailable";

export type ZoomChromeHealth = {
  inCall?: boolean;
  micMuted?: boolean;
  manualActionRequired?: boolean;
  manualActionReason?: ZoomManualActionReason;
  manualActionMessage?: string;
  providerConnected?: boolean;
  realtimeReady?: boolean;
  audioInputActive?: boolean;
  audioOutputActive?: boolean;
  lastInputAt?: string;
  lastOutputAt?: string;
  lastClearAt?: string;
  lastInputBytes?: number;
  lastOutputBytes?: number;
  consecutiveInputErrors?: number;
  lastInputError?: string;
  clearCount?: number;
  queuedInputChunks?: number;
  nativeConversationReady?: boolean;
  nativeConversationListening?: boolean;
  nativeConversationSpeaking?: boolean;
  nativeConversationProcessing?: boolean;
  nativeConversationTurns?: number;
  nativeConversationLastTranscript?: string;
  nativeConversationLastTranscriptAt?: string;
  nativeConversationLastUtterancePath?: string;
  browserUrl?: string;
  browserTitle?: string;
  bridgeClosed?: boolean;
  status?: string;
  notes?: string[];
};

export type ZoomSession = {
  id: string;
  url: string;
  transport: ZoomTransport;
  mode: ZoomMode;
  state: ZoomSessionState;
  createdAt: string;
  updatedAt: string;
  participantIdentity: string;
  realtime: {
    enabled: boolean;
    provider?: string;
    model?: string;
    toolPolicy: string;
  };
  chrome?: {
    audioBackend: "blackhole-2ch";
    launched: boolean;
    nodeId?: string;
    browserProfile?: string;
    audioBridge?: {
      type: "command-pair" | "node-command-pair" | "external-command" | "native-conversation";
      provider?: string;
    };
    health?: ZoomChromeHealth;
  };
  notes: string[];
};

export type ZoomJoinResult = {
  session: ZoomSession;
  spoken?: boolean;
};
