import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  consultRealtimeVoiceAgent,
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { ZoomConfig, ZoomToolPolicy } from "./config.js";

export const ZOOM_AGENT_CONSULT_TOOL_NAME = REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME;
export const ZOOM_AGENT_CONSULT_TOOL = REALTIME_VOICE_AGENT_CONSULT_TOOL;

const ZOOM_CONSULT_SYSTEM_PROMPT = [
  "You are a behind-the-scenes consultant for a live Zoom meeting voice agent.",
  "Prioritize a fast, speakable answer over exhaustive investigation.",
  "For tool-backed status checks, prefer one or two bounded read-only queries before answering.",
  "Do not print secret values or dump environment variables; only check whether required configuration is present.",
  "Be accurate, brief, and speakable.",
].join(" ");

export function resolveZoomRealtimeTools(policy: ZoomToolPolicy): RealtimeVoiceTool[] {
  return resolveRealtimeVoiceAgentConsultTools(policy);
}

export function submitZoomConsultWorkingResponse(
  session: RealtimeVoiceBridgeSession,
  callId: string,
): void {
  if (!session.bridge.supportsToolResultContinuation) {
    return;
  }
  session.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("participant"), {
    willContinue: true,
  });
}

export async function consultOpenClawAgentForZoom(params: {
  config: ZoomConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  meetingSessionId: string;
  args: unknown;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}): Promise<{ text: string }> {
  const agentId = normalizeAgentId(params.config.realtime.agentId);
  const sessionKey = `agent:${agentId}:zoom:${params.meetingSessionId}`;
  return await consultRealtimeVoiceAgent({
    cfg: params.fullConfig,
    agentRuntime: params.runtime.agent,
    logger: params.logger,
    agentId,
    sessionKey,
    provider: params.config.conversation.provider,
    model: params.config.conversation.model,
    messageProvider: "zoom",
    lane: "zoom",
    runIdPrefix: `zoom:${params.meetingSessionId}`,
    args: params.args,
    transcript: params.transcript,
    surface: "a private Zoom meeting",
    userLabel: "Participant",
    assistantLabel: "Agent",
    questionSourceLabel: "participant",
    toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(params.config.realtime.toolPolicy),
    extraSystemPrompt: ZOOM_CONSULT_SYSTEM_PROMPT,
  });
}
