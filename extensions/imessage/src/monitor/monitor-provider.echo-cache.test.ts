import { afterEach, describe, expect, it, vi } from "vitest";
import { createSentMessageCache } from "./echo-cache.js";

describe("iMessage sent-message echo cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches recent text within the same scope", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "  Reasoning:\r\n_step_  " });

    expect(cache.has("acct:imessage:+1555", { text: "Reasoning:\n_step_" })).toBe(true);
    expect(cache.has("acct:imessage:+1666", { text: "Reasoning:\n_step_" })).toBe(false);
  });

  it("matches delayed reflected text after known leading attributedBody corruption markers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();
    const scope = "acct:imessage:+1555";
    const leadingCorruption = String.fromCharCode(
      0xfffd,
      0xfffe,
      0xffff,
      0x00,
      0x1f,
      0x7f,
      0x80,
      0x9f,
    );

    cache.remember(scope, { text: "Cached reply\tline\nwith interior \ufffd intact" });
    vi.advanceTimersByTime(3_000);

    expect(
      cache.has(scope, {
        text: `${leadingCorruption}Cached reply\tline\nwith interior \ufffd intact`,
        messageId: "123456",
      }),
    ).toBe(true);
  });

  it("preserves interior corruption-looking user text while stripping only the prefix", () => {
    const cache = createSentMessageCache();
    const scope = "acct:imessage:+1555";
    const textWithInteriorMarkers = "Keep \ufffd and \u0001 inside\nnext\tline";

    cache.remember(scope, { text: textWithInteriorMarkers });

    expect(cache.has(scope, { text: `\u0002${textWithInteriorMarkers}` })).toBe(true);
    expect(cache.has(scope, { text: "Keep  and  inside\nnext\tline" })).toBe(false);
  });

  it("matches by outbound message id and ignores placeholder ids", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { messageId: "abc-123" });
    cache.remember("acct:imessage:+1555", { messageId: "ok" });

    expect(cache.has("acct:imessage:+1555", { messageId: "abc-123" })).toBe(true);
    expect(cache.has("acct:imessage:+1555", { messageId: "ok" })).toBe(false);
  });

  it("keeps message-id lookups longer than text fallback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00Z"));
    const cache = createSentMessageCache();

    cache.remember("acct:imessage:+1555", { text: "hello", messageId: "m-1" });
    // Text fallback stays short to avoid suppressing legitimate repeated user text.
    vi.advanceTimersByTime(6_000);

    expect(cache.has("acct:imessage:+1555", { text: "hello" })).toBe(false);
    expect(cache.has("acct:imessage:+1555", { messageId: "m-1" })).toBe(true);
  });
});
