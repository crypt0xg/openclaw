import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";

const baseConfig = {} as OpenClawConfig;

describe("resolveFollowupDeliveryPayloads", () => {
  it("drops heartbeat ack payloads without media", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK" }],
      }),
    ).toEqual([]);
  });

  it("keeps media payloads when stripping heartbeat ack text", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "/tmp/image.png" }],
      }),
    ).toEqual([{ text: "", mediaUrl: "/tmp/image.png" }]);
  });

  it("drops text payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        sentTexts: ["hello world!"],
      }),
    ).toEqual([]);
  });

  it("drops media payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        sentMediaUrls: ["/tmp/img.png"],
      }),
    ).toEqual([{ mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("keeps final text after same-target media-only messaging sends", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "final answer" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentMediaUrls: ["/tmp/img.png"],
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "final answer" }]);
  });

  it("does not dedupe text for cross-target messaging sends", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "telegram",
        originatingTo: "telegram:123",
        sentTexts: ["hello world!"],
        sentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("dedupes short replies when originating channel resolves the provider", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "ok" }],
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        sentTexts: ["ok"],
        sentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      }),
    ).toEqual([]);
  });

  it("drops duplicate caption text after same-target media is stripped", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!", mediaUrl: "/tmp/img.png" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentMediaUrls: ["/tmp/img.png"],
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
        sentTexts: ["hello world!"],
      }),
    ).toEqual([]);
  });
});
