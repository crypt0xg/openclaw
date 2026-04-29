function normalizeStringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isDeliveryMirrorTranscriptArtifact(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const record = message as Record<string, unknown>;
  return (
    record.role === "assistant" &&
    normalizeStringField(record.provider) === "openclaw" &&
    normalizeStringField(record.model) === "delivery-mirror"
  );
}

export function filterDeliveryMirrorTranscriptArtifacts<T>(messages: T[]): T[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const filtered: T[] = [];
  for (const message of messages) {
    if (isDeliveryMirrorTranscriptArtifact(message)) {
      changed = true;
      continue;
    }
    filtered.push(message);
  }
  return changed ? filtered : messages;
}
