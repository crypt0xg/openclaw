import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

type BrowserProxyResult = {
  result?: unknown;
};

export type BrowserTab = {
  targetId?: string;
  title?: string;
  url?: string;
};

function isZoomHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "zoom.us" || host.endsWith(".zoom.us");
}

function extractZoomMeetingKey(pathname: string): string | undefined {
  const meeting = /^\/(?:j|wc\/join|s)\/(\d{6,14})(?:\/)?$/i.exec(pathname);
  if (meeting?.[1]) {
    return `id:${meeting[1]}`;
  }
  const webClient = /^\/wc\/(\d{6,14})\/join(?:\/)?$/i.exec(pathname);
  if (webClient?.[1]) {
    return `id:${webClient[1]}`;
  }
  const personal = /^\/my\/([A-Za-z0-9._-]+)(?:\/)?$/i.exec(pathname);
  return personal?.[1] ? `my:${personal[1].toLowerCase()}` : undefined;
}

export function normalizeZoomUrlForReuse(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !isZoomHostname(parsed.hostname)) {
      return undefined;
    }
    const meetingKey = extractZoomMeetingKey(parsed.pathname);
    if (!meetingKey) {
      return undefined;
    }
    const pwd = parsed.searchParams.get("pwd") ?? "";
    return `${parsed.hostname.toLowerCase()}:${meetingKey}:${pwd}`;
  } catch {
    return undefined;
  }
}

export function isSameZoomUrlForReuse(a: string | undefined, b: string | undefined): boolean {
  const normalizedA = normalizeZoomUrlForReuse(a);
  const normalizedB = normalizeZoomUrlForReuse(b);
  return Boolean(normalizedA && normalizedB && normalizedA === normalizedB);
}

export type ZoomNodeInfo = {
  caps?: string[];
  commands?: string[];
  connected?: boolean;
  nodeId?: string;
  displayName?: string;
  remoteIp?: string;
};

function isZoomNode(node: ZoomNodeInfo) {
  const commands = Array.isArray(node.commands) ? node.commands : [];
  const caps = Array.isArray(node.caps) ? node.caps : [];
  return (
    node.connected === true &&
    commands.includes("zoom.chrome") &&
    (commands.includes("browser.proxy") || caps.includes("browser"))
  );
}

function matchesRequestedNode(node: ZoomNodeInfo, requested: string): boolean {
  return [node.nodeId, node.displayName, node.remoteIp].some((value) => value === requested);
}

function formatNodeLabel(node: ZoomNodeInfo): string {
  const parts = [node.displayName, node.nodeId, node.remoteIp].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "unknown node";
}

function describeNodeUsabilityIssues(node: ZoomNodeInfo): string[] {
  const commands = Array.isArray(node.commands) ? node.commands : [];
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const issues: string[] = [];
  if (node.connected !== true) {
    issues.push("offline");
  }
  if (!commands.includes("zoom.chrome")) {
    issues.push("missing zoom.chrome");
  }
  if (!commands.includes("browser.proxy") && !caps.includes("browser")) {
    issues.push("missing browser.proxy/browser capability");
  }
  return issues;
}

async function listZoomNodes(
  runtime: PluginRuntime,
  params?: { connected?: boolean },
): Promise<{ nodes: ZoomNodeInfo[] }> {
  try {
    return params ? await runtime.nodes.list(params) : await runtime.nodes.list();
  } catch (error) {
    throw new Error("Zoom node inventory unavailable", {
      cause: error,
    });
  }
}

export async function resolveChromeNodeInfo(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
}): Promise<ZoomNodeInfo> {
  const requested = params.requestedNode?.trim();
  if (requested) {
    const list = await listZoomNodes(params.runtime);
    const matches = list.nodes.filter((node) => matchesRequestedNode(node, requested));
    if (matches.length === 1) {
      const [node] = matches;
      if (isZoomNode(node)) {
        return node;
      }
      throw new Error(
        `Configured Zoom node ${requested} is not usable (${formatNodeLabel(node)}): ${describeNodeUsabilityIssues(node).join("; ")}. Start or reinstall \`openclaw node run\` on that Chrome host, approve pairing, and allow zoom.chrome plus browser.proxy.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Configured Zoom node ${requested} is ambiguous (${matches.length} matches). Pin chromeNode.node to a unique node id, display name, or remote IP.`,
      );
    }
    throw new Error(
      `Configured Zoom node ${requested} was not found. Run \`openclaw nodes status\` and start or approve the Chrome node.`,
    );
  }

  const list = await listZoomNodes(params.runtime, { connected: true });
  const nodes = list.nodes.filter(isZoomNode);
  if (nodes.length === 0) {
    throw new Error(
      "No connected Zoom-capable node with browser proxy. Run `openclaw node run` on the Chrome host with browser proxy enabled, approve pairing, and allow zoom.chrome plus browser.proxy.",
    );
  }
  if (nodes.length === 1) {
    return nodes[0];
  }
  throw new Error(
    "Multiple Zoom-capable nodes connected. Set plugins.entries.zoom.config.chromeNode.node.",
  );
}

export async function resolveChromeNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
}): Promise<string> {
  const node = await resolveChromeNodeInfo(params);
  if (!node.nodeId) {
    throw new Error("Zoom node did not include a node id.");
  }
  return node.nodeId;
}

function unwrapNodeInvokePayload(raw: unknown): unknown {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (typeof record.payloadJSON === "string" && record.payloadJSON.trim()) {
    return JSON.parse(record.payloadJSON);
  }
  if ("payload" in record) {
    return record.payload;
  }
  return raw;
}

function parseBrowserProxyResult(raw: unknown): unknown {
  const payload = unwrapNodeInvokePayload(raw);
  const proxy =
    payload && typeof payload === "object" ? (payload as BrowserProxyResult) : undefined;
  if (!proxy || !("result" in proxy)) {
    throw new Error("Zoom browser proxy returned an invalid result.");
  }
  return proxy.result;
}

export async function callBrowserProxyOnNode(params: {
  runtime: PluginRuntime;
  nodeId: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
}) {
  const raw = await params.runtime.nodes.invoke({
    nodeId: params.nodeId,
    command: "browser.proxy",
    params: {
      method: params.method,
      path: params.path,
      body: params.body,
      timeoutMs: params.timeoutMs,
    },
    timeoutMs: params.timeoutMs + 5_000,
  });
  return parseBrowserProxyResult(raw);
}

export function asBrowserTabs(result: unknown): BrowserTab[] {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  return Array.isArray(record.tabs) ? (record.tabs as BrowserTab[]) : [];
}

export function readBrowserTab(result: unknown): BrowserTab | undefined {
  return result && typeof result === "object" ? (result as BrowserTab) : undefined;
}
