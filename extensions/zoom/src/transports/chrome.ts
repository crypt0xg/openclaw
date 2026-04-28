import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { ZoomConfig, ZoomMode } from "../config.js";
import {
  startNativeConversationBridge,
  type ZoomNativeConversationHandle,
} from "../conversation.js";
import {
  startNodeRealtimeAudioBridge,
  type ChromeNodeRealtimeAudioBridgeHandle,
} from "../realtime-node.js";
import {
  startCommandRealtimeAudioBridge,
  type ChromeRealtimeAudioBridgeHandle,
} from "../realtime.js";
import {
  asBrowserTabs,
  callBrowserProxyOnNode,
  isSameZoomUrlForReuse,
  normalizeZoomUrlForReuse,
  readBrowserTab,
  resolveChromeNode,
  type BrowserTab,
} from "./chrome-browser-proxy.js";
import type { ZoomChromeHealth } from "./types.js";

export const ZOOM_SYSTEM_PROFILER_COMMAND = "/usr/sbin/system_profiler";

type BrowserRequestParams = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
};

type BrowserRequestCaller = (params: BrowserRequestParams) => Promise<unknown>;

const chromeTransportDeps: {
  callGatewayFromCli: typeof callGatewayFromCli;
} = {
  callGatewayFromCli,
};

export const __testing = {
  setDepsForTest(deps: { callGatewayFromCli?: typeof callGatewayFromCli } | null) {
    chromeTransportDeps.callGatewayFromCli = deps?.callGatewayFromCli ?? callGatewayFromCli;
  },
};

export function outputMentionsBlackHole2ch(output: string): boolean {
  return /\bBlackHole\s+2ch\b/i.test(output);
}

export async function assertBlackHole2chAvailable(params: {
  runtime: PluginRuntime;
  timeoutMs: number;
}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Chrome Zoom transport with blackhole-2ch audio is currently macOS-only");
  }

  const result = await params.runtime.system.runCommandWithTimeout(
    [ZOOM_SYSTEM_PROFILER_COMMAND, "SPAudioDataType"],
    { timeoutMs: params.timeoutMs },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.code !== 0 || !outputMentionsBlackHole2ch(output)) {
    const hint =
      params.runtime.system.formatNativeDependencyHint?.({
        packageName: "BlackHole 2ch",
        downloadCommand: "brew install blackhole-2ch",
      }) ?? "";
    throw new Error(
      [
        "BlackHole 2ch audio device not found.",
        "Install BlackHole 2ch and route Chrome input/output through the OpenClaw audio bridge.",
        hint,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}

export async function launchChromeZoom(params: {
  runtime: PluginRuntime;
  config: ZoomConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  mode: ZoomMode;
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  launched: boolean;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle)
    | ({ type: "native-conversation" } & ZoomNativeConversationHandle);
  browser?: ZoomChromeHealth;
}> {
  const needsAudioBridge = params.mode === "realtime" || params.mode === "conversation";
  if (needsAudioBridge) {
    await assertBlackHole2chAvailable({
      runtime: params.runtime,
      timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
    });

    if (params.config.chrome.audioBridgeHealthCommand) {
      const health = await params.runtime.system.runCommandWithTimeout(
        params.config.chrome.audioBridgeHealthCommand,
        { timeoutMs: params.config.chrome.joinTimeoutMs },
      );
      if (health.code !== 0) {
        throw new Error(
          `Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`,
        );
      }
    }
  }

  if (params.mode === "conversation" && params.config.chrome.launch) {
    const result = await openZoomWithBrowserRequest({
      callBrowser: callLocalBrowserRequest,
      config: params.config,
      url: params.url,
    });
    if (result.browser?.inCall !== true) {
      return result;
    }
    if (!params.config.chrome.audioInputCommand) {
      throw new Error("Chrome conversation mode requires chrome.audioInputCommand.");
    }
    params.logger.debug?.("[zoom] starting native conversation bridge");
    const bridge = await startNativeConversationBridge({
      config: params.config,
      fullConfig: params.fullConfig,
      runtime: params.runtime,
      meetingSessionId: params.meetingSessionId,
      inputCommand: params.config.chrome.audioInputCommand,
      playbackCommand: params.config.conversation.playbackCommand,
      logger: params.logger,
    });
    params.logger.debug?.("[zoom] native conversation bridge started");
    return {
      ...result,
      audioBridge: {
        type: "native-conversation",
        ...bridge,
      },
    };
  }

  let audioBridge:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle)
    | ({ type: "native-conversation" } & ZoomNativeConversationHandle)
    | undefined;

  if (needsAudioBridge && params.config.chrome.audioBridgeCommand) {
    const bridge = await params.runtime.system.runCommandWithTimeout(
      params.config.chrome.audioBridgeCommand,
      { timeoutMs: params.config.chrome.joinTimeoutMs },
    );
    if (bridge.code !== 0) {
      throw new Error(
        `failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`,
      );
    }
    audioBridge = { type: "external-command" };
  } else if (params.mode === "realtime") {
    if (!params.config.chrome.audioInputCommand || !params.config.chrome.audioOutputCommand) {
      throw new Error(
        "Chrome realtime mode requires chrome.audioInputCommand and chrome.audioOutputCommand, or chrome.audioBridgeCommand for an external bridge.",
      );
    }
    audioBridge = {
      type: "command-pair",
      ...(await startCommandRealtimeAudioBridge({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        meetingSessionId: params.meetingSessionId,
        inputCommand: params.config.chrome.audioInputCommand,
        outputCommand: params.config.chrome.audioOutputCommand,
        logger: params.logger,
      })),
    };
  } else if (params.mode === "conversation") {
    if (!params.config.chrome.audioInputCommand) {
      throw new Error("Chrome conversation mode requires chrome.audioInputCommand.");
    }
    audioBridge = {
      type: "native-conversation",
      ...(await startNativeConversationBridge({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        meetingSessionId: params.meetingSessionId,
        inputCommand: params.config.chrome.audioInputCommand,
        playbackCommand: params.config.conversation.playbackCommand,
        logger: params.logger,
      })),
    };
  }

  if (!params.config.chrome.launch) {
    return { launched: false, audioBridge };
  }

  let commandPairBridgeStopped = false;
  const stopCommandPairBridge = async () => {
    if (commandPairBridgeStopped) {
      return;
    }
    commandPairBridgeStopped = true;
    if (audioBridge?.type === "command-pair" || audioBridge?.type === "native-conversation") {
      await audioBridge.stop();
    }
  };

  try {
    const result = await openZoomWithBrowserRequest({
      callBrowser: callLocalBrowserRequest,
      config: params.config,
      url: params.url,
    });
    return { ...result, audioBridge };
  } catch (error) {
    await stopCommandPairBridge();
    throw error;
  }
}

function parseNodeStartResult(raw: unknown): {
  launched?: boolean;
  bridgeId?: string;
  audioBridge?: { type?: string };
  browser?: ZoomChromeHealth;
} {
  const value =
    raw && typeof raw === "object" && "payload" in raw
      ? (raw as { payload?: unknown }).payload
      : raw;
  if (!value || typeof value !== "object") {
    throw new Error("Zoom node returned an invalid start result.");
  }
  return value as {
    launched?: boolean;
    bridgeId?: string;
    audioBridge?: { type?: string };
    browser?: ZoomChromeHealth;
  };
}

function parseZoomBrowserStatus(result: unknown): ZoomChromeHealth | undefined {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const raw = record.result;
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const parsed = JSON.parse(raw) as {
    inCall?: boolean;
    micMuted?: boolean;
    manualActionRequired?: boolean;
    manualActionReason?: ZoomChromeHealth["manualActionReason"];
    manualActionMessage?: string;
    url?: string;
    title?: string;
    notes?: string[];
  };
  return {
    inCall: parsed.inCall,
    micMuted: parsed.micMuted,
    manualActionRequired: parsed.manualActionRequired,
    manualActionReason: parsed.manualActionReason,
    manualActionMessage: parsed.manualActionMessage,
    browserUrl: parsed.url,
    browserTitle: parsed.title,
    status: "browser-control",
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.filter((note): note is string => typeof note === "string")
      : undefined,
  };
}

async function callLocalBrowserRequest(params: BrowserRequestParams) {
  return await chromeTransportDeps.callGatewayFromCli(
    "browser.request",
    {
      json: true,
      timeout: String(params.timeoutMs + 5_000),
    },
    {
      method: params.method,
      path: params.path,
      body: params.body,
      timeoutMs: params.timeoutMs,
    },
    { progress: false },
  );
}

function mergeBrowserNotes(
  browser: ZoomChromeHealth | undefined,
  notes: string[],
): ZoomChromeHealth | undefined {
  if (!browser || notes.length === 0) {
    return browser;
  }
  return {
    ...browser,
    notes: [...new Set([...(browser.notes ?? []), ...notes])],
  };
}

function resolveBrowserPermissionOrigin(value: string | undefined): string {
  if (!value) {
    return "https://zoom.us";
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "zoom.us" || host.endsWith(".zoom.us"))
      ? url.origin
      : "https://zoom.us";
  } catch {
    return "https://zoom.us";
  }
}

function parsePermissionGrantNotes(result: unknown): string[] {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const unsupportedPermissions = Array.isArray(record.unsupportedPermissions)
    ? record.unsupportedPermissions.filter((value): value is string => typeof value === "string")
    : [];
  const notes = ["Granted Zoom microphone/camera permissions through browser control."];
  if (unsupportedPermissions.includes("speakerSelection")) {
    notes.push("Chrome did not accept the optional Zoom speaker-selection permission.");
  }
  return notes;
}

async function grantZoomMediaPermissions(params: {
  callBrowser: BrowserRequestCaller;
  origin: string;
  timeoutMs: number;
}): Promise<string[]> {
  try {
    const result = await params.callBrowser({
      method: "POST",
      path: "/permissions/grant",
      body: {
        origin: params.origin,
        permissions: ["audioCapture", "videoCapture"],
        optionalPermissions: ["speakerSelection"],
        timeoutMs: Math.min(params.timeoutMs, 5_000),
      },
      timeoutMs: Math.min(params.timeoutMs, 5_000),
    });
    return parsePermissionGrantNotes(result);
  } catch (error) {
    return [
      `Could not grant Zoom media permissions automatically: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

function zoomStatusScript(params: { guestName: string; autoJoin: boolean }) {
  return `async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const label = (node) => [
    node?.getAttribute?.("aria-label"),
    node?.getAttribute?.("title"),
    node?.getAttribute?.("data-tooltip"),
    node?.getAttribute?.("placeholder"),
    node?.value,
    text(node),
  ].filter(Boolean).join(" ");
  const docs = () => {
    const result = [document];
    for (const frame of [...document.querySelectorAll('iframe')]) {
      try {
        if (frame.contentDocument) result.push(frame.contentDocument);
      } catch {}
    }
    return result;
  };
  const queryAll = (selector) => docs().flatMap((doc) => [...doc.querySelectorAll(selector)]);
  const clickables = () => queryAll('button, a, [role="button"], input[type="button"], input[type="submit"], [role="menuitem"], li');
  const findClickable = (pattern) =>
    clickables().find((node) => pattern.test(label(node) || "") && !node.disabled);
  const clickIfFound = async (pattern, note) => {
    const node = findClickable(pattern);
    if (!node) return false;
    node.click();
    if (note) notes.push(note);
    await sleep(150);
    return true;
  };
  const notes = [];
  const pageUrl = location.href;
  const autoJoin = ${JSON.stringify(params.autoJoin)};
  const joinFromBrowser = findClickable(/join from (your )?browser/i);
  if (autoJoin && joinFromBrowser) {
    joinFromBrowser.click();
    notes.push("Clicked Zoom join-from-browser control.");
    await sleep(500);
  }

  const stopVideo = findClickable(/(^|\\b)stop video(\\b|$)/i);
  if (autoJoin && stopVideo) {
    stopVideo.click();
    notes.push("Turned Zoom camera off before joining.");
    await sleep(150);
  }

  const blackHoleMicSelected = () => clickables().some((node) => /select a microphone.*blackhole 2ch.*selected/i.test(label(node)));
  const blackHoleSpeakerSelected = () => clickables().some((node) => /select a speaker.*blackhole 2ch.*selected/i.test(label(node)));
  const ensureAudioMenuOpen = async () => {
    if (clickables().some((node) => /select a microphone|select a speaker/i.test(label(node)))) return;
    await clickIfFound(/more audio controls|audio controls|select audio/i, "Opened Zoom audio device menu.");
  };
  if (autoJoin && (!blackHoleMicSelected() || !blackHoleSpeakerSelected())) {
    await ensureAudioMenuOpen();
    if (!blackHoleMicSelected()) {
      await clickIfFound(/select a microphone.*blackhole 2ch/i, "Selected BlackHole 2ch as Zoom microphone.");
      await ensureAudioMenuOpen();
    }
    if (!blackHoleSpeakerSelected()) {
      await clickIfFound(/select a speaker.*blackhole 2ch/i, "Selected BlackHole 2ch as Zoom speaker.");
      await ensureAudioMenuOpen();
    }
  }

  const nameInput = queryAll('input').find((el) =>
    el.type !== 'hidden' &&
    /your name|display name|name/i.test(el.getAttribute('aria-label') || el.placeholder || el.name || '')
  ) ?? queryAll('input').find((el) => el.type !== 'hidden' && el.getBoundingClientRect().width > 100 && el.getBoundingClientRect().height > 10);
  if (autoJoin && nameInput && !nameInput.value) {
    nameInput.focus();
    const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(nameInput), "value")?.set;
    const guestName = ${JSON.stringify(params.guestName)};
    let previousValue = nameInput.value;
    if (valueSetter) valueSetter.call(nameInput, ""); else nameInput.value = "";
    nameInput._valueTracker?.setValue?.(previousValue);
    for (const ch of guestName) {
      previousValue = nameInput.value;
      if (valueSetter) valueSetter.call(nameInput, nameInput.value + ch); else nameInput.value = nameInput.value + ch;
      nameInput._valueTracker?.setValue?.(previousValue);
      nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      nameInput.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }));
      nameInput.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    }
    nameInput.dispatchEvent(new Event('change', { bubbles: true }));
    notes.push("Filled Zoom display name.");
    await sleep(300);
  }
  const passcodeInput = queryAll('input').find((el) =>
    /passcode|password/i.test(el.getAttribute('aria-label') || el.placeholder || el.name || '')
  );
  const audioChoice = findClickable(/use microphone and camera|continue without microphone and camera|join audio by computer|join with computer audio/i);
  if (autoJoin && audioChoice) {
    audioChoice.click();
    notes.push("Accepted Zoom audio/video choice with browser automation.");
    await sleep(500);
  }
  const join = autoJoin ? findClickable(/^(join|join meeting|join webinar)$/i) : null;
  const joinLooksDisabled = (node) =>
    !node || node.disabled || /\bdisabled\b/i.test(String(node.className || "")) || node.getAttribute?.("aria-disabled") === "true";
  if (join && !joinLooksDisabled(join)) {
    join.click();
    notes.push("Clicked Zoom Join.");
    await sleep(500);
  }
  const buttons = queryAll('button');
  const mic = buttons.find((button) => /mute|unmute|microphone/i.test(label(button)));
  const inCall = buttons.some((button) => /leave|end meeting|end webinar/i.test(label(button)));
  const pageText = docs().map((doc) => text(doc.body)).join("\\n").toLowerCase();
  const permissionNeeded = /allow.*(microphone|camera)|blocked.*(microphone|camera)|permission.*(microphone|camera|speaker)|browser prevents access/i.test(pageText);
  const preJoinVisible = Boolean(nameInput) || Boolean(join) || Boolean(stopVideo) || /enter meeting info|your name|remember my name|by clicking.*join/i.test(pageText);
  let manualActionReason;
  let manualActionMessage;
  if (!inCall && joinFromBrowser && !autoJoin) {
    manualActionReason = "zoom-browser-join-required";
    manualActionMessage = "Click Join from Browser in the OpenClaw browser profile, then retry.";
  } else if (!inCall && passcodeInput && !passcodeInput.value) {
    manualActionReason = "zoom-passcode-required";
    manualActionMessage = "Enter the Zoom meeting passcode in the OpenClaw browser profile, then retry.";
  } else if (!inCall && nameInput && !nameInput.value) {
    manualActionReason = "zoom-name-required";
    manualActionMessage = "Enter the Zoom display name in the OpenClaw browser profile, then retry.";
  } else if (!inCall && audioChoice && !autoJoin) {
    manualActionReason = "zoom-audio-choice-required";
    manualActionMessage = "Choose whether Zoom should use microphone/camera in the OpenClaw browser profile, then retry.";
  } else if (!inCall && !autoJoin && !preJoinVisible && /waiting room|host will let you in|please wait.*host|waiting for the host|host has another meeting in progress/i.test(pageText)) {
    manualActionReason = "zoom-admission-required";
    manualActionMessage = "Admit the OpenClaw browser participant in Zoom or wait for the host to start the meeting, then retry speech.";
  } else if (!inCall && !autoJoin && /sign in to (join|zoom)|login to join|need to sign in|authentication required/i.test(pageText)) {
    manualActionReason = "zoom-login-required";
    manualActionMessage = "Sign in to Zoom in the OpenClaw browser profile, then retry the Zoom join.";
  } else if (!inCall && !autoJoin && /meeting has ended|webinar has ended/i.test(pageText)) {
    manualActionReason = "zoom-meeting-ended";
    manualActionMessage = "Zoom reports that this meeting has ended.";
  } else if (!inCall && !autoJoin && /invalid meeting id|meeting id is invalid|unable to join this meeting/i.test(pageText)) {
    manualActionReason = "zoom-invalid-meeting";
    manualActionMessage = "Zoom reports that the meeting link or meeting id is invalid.";
  } else if (permissionNeeded) {
    manualActionReason = "zoom-permission-required";
    manualActionMessage = "Allow microphone/camera/speaker permissions for Zoom in the OpenClaw browser profile, then retry.";
  }
  return JSON.stringify({
    clickedJoin: Boolean(join && !joinLooksDisabled(join)),
    clickedJoinFromBrowser: Boolean(joinFromBrowser && autoJoin),
    inCall,
    micMuted: mic ? /unmute/i.test(label(mic)) : undefined,
    manualActionRequired: Boolean(manualActionReason),
    manualActionReason,
    manualActionMessage,
    title: document.title,
    url: pageUrl,
    notes
  });
}`;
}

async function openZoomWithBrowserProxy(params: {
  runtime: PluginRuntime;
  nodeId: string;
  config: ZoomConfig;
  url: string;
}): Promise<{ launched: boolean; browser?: ZoomChromeHealth }> {
  return await openZoomWithBrowserRequest({
    callBrowser: async (request) =>
      await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId: params.nodeId,
        method: request.method,
        path: request.path,
        body: request.body,
        timeoutMs: request.timeoutMs,
      }),
    config: params.config,
    url: params.url,
  });
}

async function openZoomWithBrowserRequest(params: {
  callBrowser: BrowserRequestCaller;
  config: ZoomConfig;
  url: string;
}): Promise<{ launched: boolean; browser?: ZoomChromeHealth }> {
  if (!params.config.chrome.launch) {
    return { launched: false };
  }

  const timeoutMs = Math.max(1_000, params.config.chrome.joinTimeoutMs);
  let targetId: string | undefined;
  let tab: BrowserTab | undefined;
  if (params.config.chrome.reuseExistingTab) {
    const tabs = asBrowserTabs(
      await params.callBrowser({
        method: "GET",
        path: "/tabs",
        timeoutMs: Math.min(timeoutMs, 5_000),
      }),
    );
    tab = tabs.find((entry) => isSameZoomUrlForReuse(entry.url, params.url));
    targetId = tab?.targetId;
    if (targetId) {
      await params.callBrowser({
        method: "POST",
        path: "/tabs/focus",
        body: { targetId },
        timeoutMs: Math.min(timeoutMs, 5_000),
      });
    }
  }
  if (!targetId) {
    tab = readBrowserTab(
      await params.callBrowser({
        method: "POST",
        path: "/tabs/open",
        body: { url: params.url },
        timeoutMs,
      }),
    );
    targetId = tab?.targetId;
  }
  if (!targetId) {
    return {
      launched: true,
      browser: {
        status: "browser-control",
        notes: ["Browser proxy opened Zoom but did not return a targetId."],
        browserUrl: tab?.url,
        browserTitle: tab?.title,
      },
    };
  }

  const permissionNotes = await grantZoomMediaPermissions({
    callBrowser: params.callBrowser,
    origin: resolveBrowserPermissionOrigin(params.url),
    timeoutMs,
  });
  const deadline = Date.now() + Math.max(0, params.config.chrome.waitForInCallMs);
  let browser: ZoomChromeHealth | undefined = {
    status: "browser-control",
    browserUrl: tab?.url,
    browserTitle: tab?.title,
    notes: permissionNotes,
  };
  do {
    try {
      const evaluated = await params.callBrowser({
        method: "POST",
        path: "/act",
        body: {
          kind: "evaluate",
          targetId,
          fn: zoomStatusScript({
            guestName: params.config.chrome.guestName,
            autoJoin: params.config.chrome.autoJoin,
          }),
        },
        timeoutMs: Math.min(timeoutMs, 10_000),
      });
      browser = mergeBrowserNotes(parseZoomBrowserStatus(evaluated) ?? browser, permissionNotes);
      if (browser?.inCall === true) {
        return { launched: true, browser };
      }
      if (browser?.manualActionRequired === true) {
        return { launched: true, browser };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transientNavigation = /execution context was destroyed|navigation|target closed/i.test(
        message,
      );
      browser = {
        ...browser,
        inCall: false,
        manualActionRequired: !transientNavigation,
        manualActionReason: transientNavigation ? undefined : "browser-control-unavailable",
        manualActionMessage: transientNavigation
          ? undefined
          : "Open the OpenClaw browser profile, finish Zoom login, admission, or permission prompts, then retry.",
        notes: [
          ...permissionNotes,
          `Browser control could not inspect or auto-join Zoom: ${message}`,
        ],
      };
      if (!transientNavigation) {
        break;
      }
    }
    if (Date.now() <= deadline) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  } while (Date.now() <= deadline);
  if (browser && browser.inCall !== true && browser.manualActionRequired !== true) {
    browser = {
      ...browser,
      manualActionRequired: true,
      manualActionReason: "zoom-admission-required",
      manualActionMessage:
        "Zoom did not reach the in-call state before the join timeout. Finish the visible Zoom prompt or admit the OpenClaw browser participant, then retry.",
    };
  }
  return { launched: true, browser };
}

function isRecoverableZoomTab(tab: BrowserTab, url?: string): boolean {
  if (url) {
    return isSameZoomUrlForReuse(tab.url, url);
  }
  if (normalizeZoomUrlForReuse(tab.url)) {
    return true;
  }
  const tabUrl = tab.url ?? "";
  return /^https:\/\/[^/]*zoom\.us\//i.test(tabUrl) || /zoom/i.test(tab.title ?? "");
}

async function inspectRecoverableZoomTab(params: {
  callBrowser: BrowserRequestCaller;
  config: ZoomConfig;
  timeoutMs: number;
  tab: BrowserTab;
  targetId: string;
}) {
  await params.callBrowser({
    method: "POST",
    path: "/tabs/focus",
    body: { targetId: params.targetId },
    timeoutMs: Math.min(params.timeoutMs, 5_000),
  });
  const permissionNotes = await grantZoomMediaPermissions({
    callBrowser: params.callBrowser,
    origin: resolveBrowserPermissionOrigin(params.tab.url),
    timeoutMs: params.timeoutMs,
  });
  const evaluated = await params.callBrowser({
    method: "POST",
    path: "/act",
    body: {
      kind: "evaluate",
      targetId: params.targetId,
      fn: zoomStatusScript({
        guestName: params.config.chrome.guestName,
        autoJoin: false,
      }),
    },
    timeoutMs: Math.min(params.timeoutMs, 10_000),
  });
  const browser = mergeBrowserNotes(
    parseZoomBrowserStatus(evaluated) ?? {
      status: "browser-control",
      browserUrl: params.tab.url,
      browserTitle: params.tab.title,
    },
    permissionNotes,
  );
  const manual = browser?.manualActionRequired
    ? browser.manualActionMessage || browser.manualActionReason
    : undefined;
  return {
    found: true,
    targetId: params.targetId,
    tab: params.tab,
    browser,
    message:
      manual ?? (browser?.inCall ? "Existing Zoom tab is in-call." : "Existing Zoom tab focused."),
  };
}

export async function recoverCurrentZoomTab(params: { config: ZoomConfig; url?: string }): Promise<{
  transport: "chrome";
  nodeId?: undefined;
  found: boolean;
  targetId?: string;
  tab?: BrowserTab;
  browser?: ZoomChromeHealth;
  message: string;
}> {
  const timeoutMs = Math.max(1_000, params.config.chrome.joinTimeoutMs);
  const tabs = asBrowserTabs(
    await callLocalBrowserRequest({
      method: "GET",
      path: "/tabs",
      timeoutMs: Math.min(timeoutMs, 5_000),
    }),
  );
  const tab = tabs.find((entry) => isRecoverableZoomTab(entry, params.url));
  const targetId = tab?.targetId;
  if (!tab || !targetId) {
    return {
      transport: "chrome",
      found: false,
      tab,
      message: params.url
        ? `No existing Zoom tab matched ${params.url}.`
        : "No existing Zoom tab found in local Chrome.",
    };
  }
  return {
    transport: "chrome",
    ...(await inspectRecoverableZoomTab({
      callBrowser: callLocalBrowserRequest,
      config: params.config,
      timeoutMs,
      tab,
      targetId,
    })),
  };
}

export async function recoverCurrentZoomTabOnNode(params: {
  runtime: PluginRuntime;
  config: ZoomConfig;
  url?: string;
}): Promise<{
  transport: "chrome-node";
  nodeId: string;
  found: boolean;
  targetId?: string;
  tab?: BrowserTab;
  browser?: ZoomChromeHealth;
  message: string;
}> {
  const nodeId = await resolveChromeNode({
    runtime: params.runtime,
    requestedNode: params.config.chromeNode.node,
  });
  const timeoutMs = Math.max(1_000, params.config.chrome.joinTimeoutMs);
  const tabs = asBrowserTabs(
    await callBrowserProxyOnNode({
      runtime: params.runtime,
      nodeId,
      method: "GET",
      path: "/tabs",
      timeoutMs: Math.min(timeoutMs, 5_000),
    }),
  );
  const tab = tabs.find((entry) => isRecoverableZoomTab(entry, params.url));
  const targetId = tab?.targetId;
  if (!tab || !targetId) {
    return {
      transport: "chrome-node",
      nodeId,
      found: false,
      tab,
      message: params.url
        ? `No existing Zoom tab matched ${params.url}.`
        : "No existing Zoom tab found on the selected Chrome node.",
    };
  }
  return {
    transport: "chrome-node",
    nodeId,
    ...(await inspectRecoverableZoomTab({
      callBrowser: async (request) =>
        await callBrowserProxyOnNode({
          runtime: params.runtime,
          nodeId,
          method: request.method,
          path: request.path,
          body: request.body,
          timeoutMs: request.timeoutMs,
        }),
      config: params.config,
      timeoutMs,
      tab,
      targetId,
    })),
  };
}

export type ZoomCurrentTabRecoveryResult = Awaited<
  ReturnType<typeof recoverCurrentZoomTab | typeof recoverCurrentZoomTabOnNode>
>;

export async function launchChromeZoomOnNode(params: {
  runtime: PluginRuntime;
  config: ZoomConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  mode: ZoomMode;
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  nodeId: string;
  launched: boolean;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "node-command-pair" } & ChromeNodeRealtimeAudioBridgeHandle);
  browser?: ZoomChromeHealth;
}> {
  const nodeId = await resolveChromeNode({
    runtime: params.runtime,
    requestedNode: params.config.chromeNode.node,
  });
  try {
    await params.runtime.nodes.invoke({
      nodeId,
      command: "zoom.chrome",
      params: {
        action: "stopByUrl",
        url: params.url,
        mode: params.mode,
      },
      timeoutMs: 5_000,
    });
  } catch (error) {
    params.logger.debug?.(
      `[zoom] node bridge cleanup before join ignored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const browserControl = await openZoomWithBrowserProxy({
    runtime: params.runtime,
    nodeId,
    config: params.config,
    url: params.url,
  });
  if (params.mode === "conversation") {
    throw new Error(
      "Zoom conversation mode is currently supported only with the local chrome transport.",
    );
  }
  if (params.mode !== "realtime") {
    return {
      nodeId,
      launched: browserControl.launched,
      browser: browserControl.browser,
    };
  }

  const raw = await params.runtime.nodes.invoke({
    nodeId,
    command: "zoom.chrome",
    params: {
      action: "start",
      url: params.url,
      mode: params.mode,
      launch: false,
      browserProfile: params.config.chrome.browserProfile,
      joinTimeoutMs: params.config.chrome.joinTimeoutMs,
      audioInputCommand: params.config.chrome.audioInputCommand,
      audioOutputCommand: params.config.chrome.audioOutputCommand,
      audioBridgeCommand: params.config.chrome.audioBridgeCommand,
      audioBridgeHealthCommand: params.config.chrome.audioBridgeHealthCommand,
    },
    timeoutMs: params.config.chrome.joinTimeoutMs + 5_000,
  });
  const result = parseNodeStartResult(raw);
  if (result.audioBridge?.type === "node-command-pair") {
    if (!result.bridgeId) {
      throw new Error("Zoom node did not return an audio bridge id.");
    }
    const bridge = await startNodeRealtimeAudioBridge({
      config: params.config,
      fullConfig: params.fullConfig,
      runtime: params.runtime,
      meetingSessionId: params.meetingSessionId,
      nodeId,
      bridgeId: result.bridgeId,
      logger: params.logger,
    });
    return {
      nodeId,
      launched: browserControl.launched || result.launched === true,
      audioBridge: bridge,
      browser: browserControl.browser ?? result.browser,
    };
  }
  if (result.audioBridge?.type === "external-command") {
    return {
      nodeId,
      launched: browserControl.launched || result.launched === true,
      audioBridge: { type: "external-command" },
      browser: browserControl.browser ?? result.browser,
    };
  }
  return {
    nodeId,
    launched: browserControl.launched || result.launched === true,
    browser: browserControl.browser ?? result.browser,
  };
}
