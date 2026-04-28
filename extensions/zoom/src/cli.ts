import { format } from "node:util";
import type { Command } from "commander";
import type { ZoomConfig, ZoomMode, ZoomTransport } from "./config.js";
import type { ZoomRuntime } from "./runtime.js";

type JoinOptions = {
  transport?: ZoomTransport;
  mode?: ZoomMode;
  message?: string;
  json?: boolean;
};

type SetupOptions = {
  json?: boolean;
  transport?: ZoomTransport;
};

type JsonOptions = {
  json?: boolean;
};

type RecoverTabOptions = JsonOptions & {
  transport?: ZoomTransport;
};

function writeStdoutJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeStdoutLine(...values: unknown[]): void {
  process.stdout.write(`${format(...values)}\n`);
}

function resolveMeetingInput(config: ZoomConfig, value: string | undefined): string {
  const meeting = value?.trim() || config.defaults.meeting;
  if (!meeting) {
    throw new Error("Zoom meeting URL is required");
  }
  return meeting;
}

function writeSetupStatus(status: Awaited<ReturnType<ZoomRuntime["setupStatus"]>>): void {
  writeStdoutLine("Zoom setup: %s", status.ok ? "OK" : "needs attention");
  for (const check of status.checks) {
    writeStdoutLine("[%s] %s: %s", check.ok ? "ok" : "fail", check.id, check.message);
  }
}

function writeStatus(status: ReturnType<ZoomRuntime["status"]>): void {
  if (!status.found) {
    writeStdoutLine("Zoom session not found");
    return;
  }
  const sessions = status.session ? [status.session] : (status.sessions ?? []);
  if (sessions.length === 0) {
    writeStdoutLine("No Zoom sessions");
    return;
  }
  for (const session of sessions) {
    const health = session.chrome?.health;
    writeStdoutLine(
      "%s %s %s %s inCall=%s manual=%s",
      session.id,
      session.state,
      session.transport,
      session.mode,
      health?.inCall === undefined ? "unknown" : health.inCall ? "yes" : "no",
      health?.manualActionRequired ? (health.manualActionReason ?? "yes") : "no",
    );
    if (health?.manualActionMessage) {
      writeStdoutLine("  manual action: %s", health.manualActionMessage);
    }
    if (health?.browserUrl) {
      writeStdoutLine("  browser: %s", health.browserUrl);
    }
  }
}

export function registerZoomCli(params: {
  program: Command;
  config: ZoomConfig;
  ensureRuntime: () => Promise<ZoomRuntime>;
}): void {
  const command = params.program
    .command("zoom")
    .description("Join and manage Zoom meetings through Chrome transports");

  command
    .command("setup")
    .description("Check Zoom plugin setup")
    .option("--transport <transport>", "chrome or chrome-node")
    .option("--json", "Print JSON")
    .action(async (options: SetupOptions) => {
      const runtime = await params.ensureRuntime();
      const status = await runtime.setupStatus({ transport: options.transport });
      if (options.json) {
        writeStdoutJson(status);
      } else {
        writeSetupStatus(status);
      }
    });

  command
    .command("join [url]")
    .description("Join a Zoom meeting URL")
    .option("--transport <transport>", "chrome or chrome-node")
    .option("--mode <mode>", "realtime, conversation, or transcribe")
    .option("--message <message>", "Realtime instructions to speak after joining")
    .option("--json", "Print JSON")
    .action(async (url: string | undefined, options: JoinOptions) => {
      const runtime = await params.ensureRuntime();
      const result = await runtime.join({
        url: resolveMeetingInput(params.config, url),
        transport: options.transport,
        mode: options.mode,
        message: options.message,
      });
      if (options.json) {
        writeStdoutJson(result);
      } else {
        writeStdoutLine("session: %s", result.session.id);
        writeStdoutLine("transport: %s", result.session.transport);
        writeStdoutLine("mode: %s", result.session.mode);
        if (result.session.chrome?.health?.manualActionMessage) {
          writeStdoutLine("manual action: %s", result.session.chrome.health.manualActionMessage);
        }
      }
    });

  command
    .command("recover-current-tab [url]")
    .description("Inspect and report the current/reusable Zoom tab without opening a duplicate")
    .option("--transport <transport>", "chrome or chrome-node")
    .option("--json", "Print JSON")
    .action(async (url: string | undefined, options: RecoverTabOptions) => {
      const runtime = await params.ensureRuntime();
      const result = await runtime.recoverCurrentTab({ url, transport: options.transport });
      if (options.json) {
        writeStdoutJson(result);
      } else {
        writeStdoutLine(result.message);
      }
    });

  command
    .command("status [sessionId]")
    .description("List Zoom sessions or inspect one session")
    .option("--json", "Print JSON")
    .action(async (sessionId: string | undefined, options: JsonOptions) => {
      const runtime = await params.ensureRuntime();
      const status = runtime.status(sessionId);
      if (options.json) {
        writeStdoutJson(status);
      } else {
        writeStatus(status);
      }
    });

  command
    .command("speak <sessionId> [message]")
    .description("Make the realtime Zoom agent speak now")
    .option("--json", "Print JSON")
    .action(async (sessionId: string, message: string | undefined, options: JsonOptions) => {
      const runtime = await params.ensureRuntime();
      const result = runtime.speak(sessionId, message);
      if (options.json) {
        writeStdoutJson(result);
      } else {
        writeStdoutLine(result.spoken ? "spoken" : "not spoken");
      }
    });

  command
    .command("test-speech [url]")
    .description("Join or reuse a Zoom session and speak a known phrase")
    .option("--transport <transport>", "chrome or chrome-node")
    .option("--mode <mode>", "realtime, conversation, or transcribe")
    .option("--message <message>", "Phrase/instructions to speak")
    .option("--json", "Print JSON")
    .action(async (url: string | undefined, options: JoinOptions) => {
      const runtime = await params.ensureRuntime();
      const result = await runtime.testSpeech({
        url: resolveMeetingInput(params.config, url),
        transport: options.transport,
        mode: options.mode,
        message: options.message,
      });
      if (options.json) {
        writeStdoutJson(result);
      } else {
        writeStdoutLine("session: %s", result.session.id);
        writeStdoutLine("spoken: %s", result.spoken ? "yes" : "no");
        writeStdoutLine(
          "in call: %s",
          result.inCall === undefined ? "unknown" : result.inCall ? "yes" : "no",
        );
        if (result.manualActionMessage) {
          writeStdoutLine("manual action: %s", result.manualActionMessage);
        }
      }
    });

  command
    .command("leave <sessionId>")
    .description("End a Zoom session and stop its audio bridge")
    .option("--json", "Print JSON")
    .action(async (sessionId: string, options: JsonOptions) => {
      const runtime = await params.ensureRuntime();
      const result = await runtime.leave(sessionId);
      if (options.json) {
        writeStdoutJson(result);
      } else {
        writeStdoutLine(result.found ? "left" : "session not found");
      }
    });
}
