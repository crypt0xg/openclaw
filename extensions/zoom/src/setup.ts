import type { ZoomConfig } from "./config.js";

export type SetupCheck = {
  id: string;
  ok: boolean;
  message: string;
};

export type ZoomSetupStatus = {
  ok: boolean;
  checks: SetupCheck[];
};

export function getZoomSetupStatus(config: ZoomConfig): ZoomSetupStatus {
  const checks: SetupCheck[] = [];

  checks.push({
    id: "chrome-profile",
    ok: true,
    message: config.chrome.browserProfile
      ? "Local Chrome uses the OpenClaw browser profile; chrome.browserProfile is passed to chrome-node hosts"
      : "Local Chrome uses the OpenClaw browser profile; configure browser.defaultProfile to choose another profile",
  });

  checks.push({
    id: "audio-bridge",
    ok: Boolean(
      config.chrome.audioBridgeCommand ||
      (config.chrome.audioInputCommand && config.chrome.audioOutputCommand),
    ),
    message: config.chrome.audioBridgeCommand
      ? "Chrome audio bridge command configured"
      : config.chrome.audioInputCommand && config.chrome.audioOutputCommand
        ? `Chrome command-pair realtime audio bridge configured (${config.chrome.audioFormat})`
        : "Chrome realtime audio bridge not configured",
  });

  checks.push({
    id: "browser-join-defaults",
    ok: Boolean(
      config.chrome.guestName && config.chrome.autoJoin && config.chrome.reuseExistingTab,
    ),
    message:
      config.chrome.guestName && config.chrome.autoJoin && config.chrome.reuseExistingTab
        ? "Browser auto-join and tab reuse defaults are enabled"
        : "Set chrome.guestName, chrome.autoJoin, and chrome.reuseExistingTab for unattended browser joins",
  });

  checks.push({
    id: "chrome-node-target",
    ok: config.defaultTransport !== "chrome-node" || Boolean(config.chromeNode.node),
    message:
      config.defaultTransport === "chrome-node" && !config.chromeNode.node
        ? "chrome-node default should pin chromeNode.node when multiple nodes may be connected"
        : config.chromeNode.node
          ? `Chrome node pinned to ${config.chromeNode.node}`
          : "Chrome node not pinned; automatic selection works when exactly one capable node is connected",
  });

  checks.push({
    id: "intro-after-in-call",
    ok: config.chrome.waitForInCallMs > 0,
    message:
      config.chrome.waitForInCallMs > 0
        ? `Realtime intro waits up to ${config.chrome.waitForInCallMs}ms for the Zoom tab to be in-call`
        : "Set chrome.waitForInCallMs to delay realtime intro until the Zoom tab is in-call",
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export function addZoomSetupCheck(status: ZoomSetupStatus, check: SetupCheck): ZoomSetupStatus {
  const checks = [...status.checks, check];
  return {
    ok: checks.every((item) => item.ok),
    checks,
  };
}
