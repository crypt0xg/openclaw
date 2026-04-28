import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { consultOpenClawAgentForZoom } from "./agent-consult.js";
import type { ZoomConfig } from "./config.js";
import type { ZoomChromeHealth } from "./transports/types.js";

type BridgeProcess = {
  pid?: number;
  killed?: boolean;
  stdin?: Writable | null;
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"] },
) => BridgeProcess;

export type ZoomNativeConversationHandle = {
  inputCommand: string[];
  playbackCommand: string[];
  speak: (message?: string) => void;
  getHealth: () => ZoomChromeHealth;
  stop: () => Promise<void>;
};

type VadConfig = {
  sampleRate: number;
  rmsThreshold: number;
  minSpeechMs: number;
  silenceMs: number;
  maxUtteranceMs: number;
  preSpeechMs: number;
};

type VadUtterance = {
  pcm: Buffer;
  durationMs: number;
  rmsPeak: number;
};

const PCM16_BYTES_PER_SAMPLE = 2;
const CHANNELS = 1;

function splitCommand(argv: string[]): { command: string; args: string[] } {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error("audio command must not be empty");
  }
  return { command, args };
}

function applyTemplate(value: string, context: Record<string, string>): string {
  return value.replace(/{{\s*(\w+)\s*}}/gi, (_, key) => {
    const normalizedKey = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
    return context[normalizedKey] ?? context[key] ?? "";
  });
}

function scheduleTempCleanup(tempDir: string): void {
  const timer = setTimeout(
    () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup for transient utterance/TTS files.
      }
    },
    30 * 60 * 1000,
  );
  timer.unref?.();
}

export function buildPcm16WavBuffer(params: { pcm: Buffer; sampleRate: number }): Buffer {
  const dataSize = params.pcm.byteLength;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(params.sampleRate, 24);
  header.writeUInt32LE(params.sampleRate * CHANNELS * PCM16_BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(CHANNELS * PCM16_BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, params.pcm]);
}

function rmsPcm16Le(buffer: Buffer): number {
  const samples = Math.floor(buffer.byteLength / PCM16_BYTES_PER_SAMPLE);
  if (samples <= 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let offset = 0; offset + 1 < buffer.byteLength; offset += PCM16_BYTES_PER_SAMPLE) {
    const sample = buffer.readInt16LE(offset) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}

function durationMsForPcm16(buffer: Buffer, sampleRate: number): number {
  return (Math.floor(buffer.byteLength / PCM16_BYTES_PER_SAMPLE) / sampleRate) * 1000;
}

export class Pcm16VadSegmenter {
  readonly #config: VadConfig;
  readonly #onUtterance: (utterance: VadUtterance) => void;
  #preSpeech: Buffer = Buffer.alloc(0);
  #current: Buffer[] = [];
  #speaking = false;
  #speechMs = 0;
  #silenceMs = 0;
  #utteranceMs = 0;
  #rmsPeak = 0;
  #carry: Buffer = Buffer.alloc(0);

  constructor(config: VadConfig, onUtterance: (utterance: VadUtterance) => void) {
    this.#config = config;
    this.#onUtterance = onUtterance;
  }

  reset(): void {
    this.#current = [];
    this.#speaking = false;
    this.#speechMs = 0;
    this.#silenceMs = 0;
    this.#utteranceMs = 0;
    this.#rmsPeak = 0;
    this.#carry = Buffer.alloc(0);
  }

  push(chunk: Buffer): void {
    const input = this.#carry.byteLength > 0 ? Buffer.concat([this.#carry, chunk]) : chunk;
    const evenLength = input.byteLength - (input.byteLength % PCM16_BYTES_PER_SAMPLE);
    if (evenLength <= 0) {
      this.#carry = input;
      return;
    }
    const frame = input.subarray(0, evenLength);
    this.#carry = evenLength < input.byteLength ? input.subarray(evenLength) : Buffer.alloc(0);
    const durationMs = durationMsForPcm16(frame, this.#config.sampleRate);
    const rms = rmsPcm16Le(frame);
    const hasSpeech = rms >= this.#config.rmsThreshold;
    this.#rmsPeak = Math.max(this.#rmsPeak, rms);

    if (!this.#speaking) {
      if (!hasSpeech) {
        this.#appendPreSpeech(frame);
        return;
      }
      this.#speaking = true;
      this.#current = this.#preSpeech.byteLength > 0 ? [this.#preSpeech, frame] : [frame];
      this.#preSpeech = Buffer.alloc(0);
      this.#speechMs = durationMs;
      this.#silenceMs = 0;
      this.#utteranceMs = durationMsForPcm16(Buffer.concat(this.#current), this.#config.sampleRate);
      return;
    }

    this.#current.push(frame);
    this.#utteranceMs += durationMs;
    if (hasSpeech) {
      this.#speechMs += durationMs;
      this.#silenceMs = 0;
    } else {
      this.#silenceMs += durationMs;
    }

    if (
      this.#utteranceMs >= this.#config.maxUtteranceMs ||
      (this.#speechMs >= this.#config.minSpeechMs && this.#silenceMs >= this.#config.silenceMs)
    ) {
      this.flush();
    }
  }

  flush(): void {
    if (!this.#speaking) {
      return;
    }
    const pcm = Buffer.concat(this.#current);
    const durationMs = durationMsForPcm16(pcm, this.#config.sampleRate);
    const speechMs = this.#speechMs;
    const rmsPeak = this.#rmsPeak;
    this.#current = [];
    this.#speaking = false;
    this.#speechMs = 0;
    this.#silenceMs = 0;
    this.#utteranceMs = 0;
    this.#rmsPeak = 0;
    if (speechMs >= this.#config.minSpeechMs && pcm.byteLength > 0) {
      this.#onUtterance({ pcm, durationMs, rmsPeak });
    }
  }

  #appendPreSpeech(chunk: Buffer): void {
    this.#preSpeech = Buffer.concat([this.#preSpeech, chunk]);
    const maxBytes = Math.max(
      0,
      Math.floor((this.#config.preSpeechMs / 1000) * this.#config.sampleRate) *
        PCM16_BYTES_PER_SAMPLE,
    );
    if (maxBytes > 0 && this.#preSpeech.byteLength > maxBytes) {
      this.#preSpeech = this.#preSpeech.subarray(this.#preSpeech.byteLength - maxBytes);
    }
  }
}

function normalizeTranscript(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const compact = normalized.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!compact || compact === "blankaudio") {
    return undefined;
  }
  return normalized;
}

function extractSpeakableAgentText(
  result: { text?: string } | { payloads?: Array<{ text?: string }> },
): string {
  if ("text" in result && typeof result.text === "string") {
    return result.text.trim();
  }
  if ("payloads" in result && Array.isArray(result.payloads)) {
    return result.payloads
      .map((payload) => (typeof payload.text === "string" ? payload.text.trim() : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function isStopRequest(transcript: string): boolean {
  const normalized = transcript.toLowerCase().replace(/[^a-z]+/g, "");
  return normalized === "stop" || normalized === "quit" || normalized === "goodbye";
}

export async function startNativeConversationBridge(params: {
  config: ZoomConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  meetingSessionId: string;
  inputCommand: string[];
  playbackCommand: string[];
  logger: RuntimeLogger;
  spawn?: SpawnFn;
}): Promise<ZoomNativeConversationHandle> {
  if (params.config.chrome.audioFormat !== "pcm16-24khz") {
    throw new Error("Zoom conversation mode requires chrome.audioFormat=pcm16-24khz");
  }

  const input = splitCommand(params.inputCommand);
  const playbackCommand = splitCommand(params.playbackCommand);
  const spawnFn: SpawnFn =
    params.spawn ??
    ((command, args, options) => spawn(command, args, options) as unknown as BridgeProcess);
  params.logger.debug?.(`[zoom] spawning native conversation input: ${input.command}`);
  const inputProcess = spawnFn(input.command, input.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tempDir = path.join(resolvePreferredOpenClawTmpDir(), `openclaw-zoom-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  scheduleTempCleanup(tempDir);

  let stopped = false;
  let listening = true;
  let speaking = false;
  let processing = false;
  let lastInputAt: string | undefined;
  let lastOutputAt: string | undefined;
  let lastInputBytes = 0;
  let lastOutputBytes = 0;
  let lastTranscript: string | undefined;
  let lastTranscriptAt: string | undefined;
  let lastUtterancePath: string | undefined;
  let lastError: string | undefined;
  let turnsProcessed = 0;
  let queuedTurns = 0;
  let suppressInputUntil = 0;
  const transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
  let turnQueue = Promise.resolve();

  const vad = new Pcm16VadSegmenter(
    {
      sampleRate: 24_000,
      rmsThreshold: params.config.conversation.vad.rmsThreshold,
      minSpeechMs: params.config.conversation.vad.minSpeechMs,
      silenceMs: params.config.conversation.vad.silenceMs,
      maxUtteranceMs: params.config.conversation.vad.maxUtteranceMs,
      preSpeechMs: params.config.conversation.vad.preSpeechMs,
    },
    (utterance) => {
      queuedTurns += 1;
      turnQueue = turnQueue
        .then(async () => {
          queuedTurns = Math.max(0, queuedTurns - 1);
          await handleUtterance(utterance);
        })
        .catch((error) => {
          lastError = formatErrorMessage(error);
          params.logger.warn(`[zoom] native conversation turn failed: ${lastError}`);
        });
    },
  );

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    listening = false;
    vad.reset();
    inputProcess.kill("SIGTERM");
  };

  async function handleUtterance(utterance: VadUtterance): Promise<void> {
    if (stopped) {
      return;
    }
    processing = true;
    try {
      const utterancePath = path.join(tempDir, `utterance-${Date.now()}.wav`);
      writeFileSync(utterancePath, buildPcm16WavBuffer({ pcm: utterance.pcm, sampleRate: 24_000 }));
      lastUtterancePath = utterancePath;
      params.logger.debug?.(
        `[zoom] native conversation utterance ${Math.round(utterance.durationMs)}ms rms=${utterance.rmsPeak.toFixed(4)}`,
      );
      const agentId = normalizeAgentId(
        params.config.conversation.agentId ?? params.config.realtime.agentId,
      );
      const result = await params.runtime.mediaUnderstanding.transcribeAudioFile({
        filePath: utterancePath,
        cfg: params.fullConfig,
        agentDir: params.runtime.agent.resolveAgentDir(params.fullConfig, agentId),
        mime: "audio/wav",
      });
      const text = normalizeTranscript(result.text);
      if (!text || text.length < params.config.conversation.minTranscriptChars) {
        params.logger.debug?.("[zoom] native conversation skipped empty transcript");
        return;
      }
      lastTranscript = text;
      lastTranscriptAt = new Date().toISOString();
      transcript.push({ role: "user", text });
      if (transcript.length > 40) {
        transcript.splice(0, transcript.length - 40);
      }
      if (isStopRequest(text)) {
        await speakText("Okay, stopping Zoom freeflow.");
        await stop();
        return;
      }
      const answer = await consultOpenClawAgentForZoom({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        meetingSessionId: params.meetingSessionId,
        args: {
          question: text,
          instructions:
            params.config.conversation.instructions ??
            "Reply naturally in one short spoken answer for the Zoom participant.",
        },
        transcript,
      });
      const reply = extractSpeakableAgentText(answer);
      if (!reply) {
        return;
      }
      transcript.push({ role: "assistant", text: reply });
      if (transcript.length > 40) {
        transcript.splice(0, transcript.length - 40);
      }
      await speakText(reply);
      turnsProcessed += 1;
    } finally {
      processing = false;
    }
  }

  async function speakText(text: string): Promise<void> {
    if (stopped) {
      return;
    }
    const tts = await params.runtime.tts.textToSpeech({
      text,
      cfg: params.fullConfig,
      channel: "zoom",
      agentId: normalizeAgentId(
        params.config.conversation.agentId ?? params.config.realtime.agentId,
      ),
      timeoutMs: params.config.conversation.ttsTimeoutMs,
    });
    if (!tts.success || !tts.audioPath) {
      throw new Error(`Zoom conversation TTS failed: ${tts.error ?? "no audio output"}`);
    }
    const context = {
      AudioPath: tts.audioPath,
      OutputPath: tts.audioPath,
      AudioFormat: tts.outputFormat ?? "",
    };
    const args = playbackCommand.args.map((arg) => applyTemplate(arg, context));
    await new Promise<void>((resolve, reject) => {
      speaking = true;
      listening = !params.config.conversation.halfDuplex;
      suppressInputUntil = Date.now() + params.config.conversation.echoSuppressionMs;
      vad.reset();
      const proc = spawnFn(playbackCommand.command, args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      proc.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.on("error", reject);
      proc.on("exit", (code, signal) => {
        speaking = false;
        listening = true;
        suppressInputUntil = Date.now() + params.config.conversation.echoSuppressionMs;
        lastOutputAt = new Date().toISOString();
        lastOutputBytes += 1;
        vad.reset();
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Zoom conversation playback exited ${code ?? signal}: ${stderr}`));
        }
      });
    });
  }

  inputProcess.stdout?.on("data", (chunk) => {
    if (stopped) {
      return;
    }
    if (Date.now() < suppressInputUntil || !listening) {
      vad.reset();
      return;
    }
    const audio = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (audio.byteLength === 0) {
      return;
    }
    lastInputAt = new Date().toISOString();
    lastInputBytes += audio.byteLength;
    vad.push(audio);
  });
  inputProcess.stderr?.on("data", (chunk) => {
    params.logger.debug?.(`[zoom] native conversation input: ${String(chunk).trim()}`);
  });
  inputProcess.on("error", (error) => {
    lastError = formatErrorMessage(error);
    params.logger.warn(`[zoom] native conversation input failed: ${lastError}`);
    void stop();
  });
  inputProcess.on("exit", (code, signal) => {
    if (!stopped) {
      lastError = `audio input command exited (${code ?? signal ?? "done"})`;
      params.logger.warn(`[zoom] native conversation ${lastError}`);
      void stop();
    }
  });

  params.logger.debug?.("[zoom] native conversation input handlers ready");
  return {
    inputCommand: params.inputCommand,
    playbackCommand: params.playbackCommand,
    speak: (message) => {
      const text = message || params.config.conversation.introMessage;
      if (!text) {
        return;
      }
      turnQueue = turnQueue
        .then(async () => {
          await speakText(text);
        })
        .catch((error) => {
          lastError = formatErrorMessage(error);
          params.logger.warn(`[zoom] native conversation speak failed: ${lastError}`);
        });
    },
    getHealth: () => ({
      providerConnected: !stopped,
      realtimeReady: !stopped,
      audioInputActive: lastInputBytes > 0,
      audioOutputActive: lastOutputBytes > 0,
      lastInputAt,
      lastOutputAt,
      lastInputBytes,
      lastOutputBytes,
      lastInputError: lastError,
      queuedInputChunks: queuedTurns,
      bridgeClosed: stopped,
      nativeConversationReady: !stopped,
      nativeConversationListening: listening,
      nativeConversationSpeaking: speaking,
      nativeConversationProcessing: processing,
      nativeConversationTurns: turnsProcessed,
      nativeConversationLastTranscript: lastTranscript,
      nativeConversationLastTranscriptAt: lastTranscriptAt,
      nativeConversationLastUtterancePath: lastUtterancePath,
    }),
    stop,
  };
}
