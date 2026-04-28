import { afterEach, describe, expect, it } from "vitest";
import plugin, { __testing as zoomPluginTesting } from "./index.js";
import { resolveZoomConfig, resolveZoomConfigWithEnv } from "./src/config.js";
import { Pcm16VadSegmenter, buildPcm16WavBuffer } from "./src/conversation.js";
import { handleZoomNodeHostCommand } from "./src/node-host.js";
import { normalizeZoomUrl } from "./src/runtime.js";
import {
  invokeZoomGatewayMethodForTest,
  setupZoomPlugin,
} from "./src/test-support/plugin-harness.js";
import { normalizeZoomUrlForReuse } from "./src/transports/chrome-browser-proxy.js";

afterEach(() => {
  zoomPluginTesting.setCallGatewayFromCliForTests();
});

describe("Zoom config", () => {
  it("resolves browser-only defaults", () => {
    const config = resolveZoomConfig({});

    expect(config.enabled).toBe(true);
    expect(config.defaultTransport).toBe("chrome");
    expect(config.defaultMode).toBe("realtime");
    expect(config.chrome.guestName).toBe("OpenClaw Agent");
    expect(config.conversation.playbackCommand).toEqual([
      "sox",
      "-q",
      "{{AudioPath}}",
      "-t",
      "coreaudio",
      "BlackHole 2ch",
    ]);
    expect(config.conversation.vad.silenceMs).toBe(700);
    expect(config.chrome.audioFormat).toBe("pcm16-24khz");
    expect(config.realtime.toolPolicy).toBe("safe-read-only");
  });

  it("accepts native conversation as a join mode", () => {
    const config = resolveZoomConfig({
      defaultMode: "conversation",
      conversation: {
        agentId: "meetings",
        playbackCommand: ["sox", "{{AudioPath}}", "-d"],
        vad: { rmsThreshold: 0.01, silenceMs: 500 },
      },
    });

    expect(config.defaultMode).toBe("conversation");
    expect(config.conversation.agentId).toBe("meetings");
    expect(config.conversation.playbackCommand).toEqual(["sox", "{{AudioPath}}", "-d"]);
    expect(config.conversation.vad.rmsThreshold).toBe(0.01);
    expect(config.conversation.vad.silenceMs).toBe(500);
  });

  it("reads a default meeting from Zoom environment fallback", () => {
    const config = resolveZoomConfigWithEnv(
      {},
      { OPENCLAW_ZOOM_DEFAULT_MEETING: "https://example.zoom.us/j/123456789" },
    );

    expect(config.defaults.meeting).toBe("https://example.zoom.us/j/123456789");
  });
});

describe("Zoom native conversation audio", () => {
  function toneBuffer(ms: number, amplitude: number, sampleRate = 24_000): Buffer {
    const samples = Math.floor((ms / 1000) * sampleRate);
    const buffer = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) {
      buffer.writeInt16LE(Math.round(amplitude * 32767), i * 2);
    }
    return buffer;
  }

  it("segments PCM into utterances after speech followed by silence", () => {
    const utterances: Array<{ pcm: Buffer; durationMs: number; rmsPeak: number }> = [];
    const vad = new Pcm16VadSegmenter(
      {
        sampleRate: 24_000,
        rmsThreshold: 0.01,
        minSpeechMs: 200,
        silenceMs: 300,
        maxUtteranceMs: 5_000,
        preSpeechMs: 100,
      },
      (utterance) => utterances.push(utterance),
    );

    vad.push(toneBuffer(100, 0));
    vad.push(toneBuffer(300, 0.05));
    vad.push(toneBuffer(350, 0));

    expect(utterances).toHaveLength(1);
    expect(utterances[0]?.durationMs).toBeGreaterThanOrEqual(700);
    expect(utterances[0]?.rmsPeak).toBeGreaterThan(0.04);
  });

  it("builds a valid PCM WAV header", () => {
    const wav = buildPcm16WavBuffer({ pcm: toneBuffer(100, 0.05), sampleRate: 24_000 });

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(24_000);
  });
});

describe("Zoom URL handling", () => {
  it("accepts explicit Zoom meeting URLs", () => {
    expect(normalizeZoomUrl("https://example.zoom.us/j/123456789?pwd=abc")).toBe(
      "https://example.zoom.us/j/123456789?pwd=abc",
    );
    expect(normalizeZoomUrl("https://example.zoom.us/wc/join/123456789?pwd=abc")).toBe(
      "https://example.zoom.us/wc/join/123456789?pwd=abc",
    );
    expect(normalizeZoomUrl("https://yale.zoom.us/my/gumadeiras")).toBe(
      "https://yale.zoom.us/my/gumadeiras",
    );
  });

  it("rejects non-Zoom and non-meeting URLs", () => {
    expect(() => normalizeZoomUrl("https://meet.google.com/abc-defg-hij")).toThrow(/Zoom/i);
    expect(() => normalizeZoomUrl("https://example.zoom.us/profile")).toThrow(/meeting path/);
  });

  it("normalizes meeting id, personal URLs, and passcode for tab reuse", () => {
    expect(normalizeZoomUrlForReuse("https://example.zoom.us/j/123456789?pwd=abc&from=addon")).toBe(
      "example.zoom.us:id:123456789:abc",
    );
    expect(normalizeZoomUrlForReuse("https://example.zoom.us/wc/join/123456789?pwd=abc")).toBe(
      "example.zoom.us:id:123456789:abc",
    );
    expect(normalizeZoomUrlForReuse("https://app.zoom.us/wc/123456789/join?fromPWA=1")).toBe(
      "app.zoom.us:id:123456789:",
    );
    expect(normalizeZoomUrlForReuse("https://yale.zoom.us/my/gumadeiras")).toBe(
      "yale.zoom.us:my:gumadeiras:",
    );
  });
});

describe("Zoom plugin registration", () => {
  it("registers gateway methods, tool, CLI descriptor, and node command", () => {
    const harness = setupZoomPlugin(plugin);

    expect([...harness.methods.keys()].toSorted()).toEqual([
      "zoom.join",
      "zoom.leave",
      "zoom.recoverCurrentTab",
      "zoom.setup",
      "zoom.speak",
      "zoom.status",
      "zoom.testSpeech",
    ]);
    expect(harness.tools).toHaveLength(1);
    expect(harness.cliRegistrations).toEqual([
      {
        commands: ["zoom"],
        descriptors: [
          { name: "zoom", description: "Join and manage Zoom meetings", hasSubcommands: true },
        ],
      },
    ]);
    expect(harness.nodeHostCommands).toMatchObject([{ command: "zoom.chrome", cap: "zoom" }]);
  });

  it("joins through a chrome-node browser session without starting node audio in transcribe mode", async () => {
    const harness = setupZoomPlugin(plugin, {
      defaultTransport: "chrome-node",
      defaultMode: "transcribe",
      chromeNode: { node: "zoom-macos" },
    });

    const result = (await invokeZoomGatewayMethodForTest(harness.methods, "zoom.join", {
      url: "https://example.zoom.us/j/123456789?pwd=abc",
    })) as {
      session: { id: string; transport: string; mode: string; chrome?: { health?: unknown } };
    };

    expect(result.session.id).toMatch(/^zoom_/);
    expect(result.session.transport).toBe("chrome-node");
    expect(result.session.mode).toBe("transcribe");
    expect(result.session.chrome?.health).toMatchObject({ inCall: true, micMuted: false });
    expect(harness.nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ command: "browser.proxy" }),
    );
    expect(harness.nodesInvoke).not.toHaveBeenCalledWith(
      expect.objectContaining({
        command: "zoom.chrome",
        params: expect.objectContaining({ action: "start" }),
      }),
    );
  });

  it("returns manual passcode blockers from browser health", async () => {
    const harness = setupZoomPlugin(
      plugin,
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
        chromeNode: { node: "zoom-macos" },
      },
      {
        browserActResult: {
          inCall: false,
          manualActionRequired: true,
          manualActionReason: "zoom-passcode-required",
          manualActionMessage:
            "Enter the Zoom meeting passcode in the OpenClaw browser profile, then retry.",
          title: "Zoom",
          url: "https://example.zoom.us/j/123456789",
        },
      },
    );

    const result = (await invokeZoomGatewayMethodForTest(harness.methods, "zoom.join", {
      url: "https://example.zoom.us/j/123456789",
    })) as { session: { chrome?: { health?: Record<string, unknown> } } };

    expect(result.session.chrome?.health).toMatchObject({
      manualActionRequired: true,
      manualActionReason: "zoom-passcode-required",
    });
  });

  it("reports pinned offline chrome-node setup blockers", async () => {
    const harness = setupZoomPlugin(
      plugin,
      { defaultTransport: "chrome-node", chromeNode: { node: "zoom-macos" } },
      {
        nodesListResult: {
          nodes: [
            {
              nodeId: "node-1",
              displayName: "zoom-macos",
              connected: false,
              commands: ["browser.proxy", "zoom.chrome"],
            },
          ],
        },
      },
    );

    const status = (await invokeZoomGatewayMethodForTest(harness.methods, "zoom.setup", {})) as {
      ok: boolean;
      checks: Array<{ id: string; ok: boolean; message: string }>;
    };

    expect(status.ok).toBe(false);
    expect(status.checks.find((check) => check.id === "chrome-node-connected")).toMatchObject({
      ok: false,
    });
  });
});

describe("Zoom node host", () => {
  it("lists no active bridge sessions by default", async () => {
    await expect(handleZoomNodeHostCommand(JSON.stringify({ action: "list" }))).resolves.toBe(
      JSON.stringify({ bridges: [] }),
    );
  });
});
