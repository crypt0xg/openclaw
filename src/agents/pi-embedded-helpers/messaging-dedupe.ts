import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";

const MIN_DUPLICATE_TEXT_LENGTH = 10;

/**
 * Normalize text for duplicate comparison.
 * - Trims whitespace
 * - Lowercases
 * - Strips emoji (Emoji_Presentation and Extended_Pictographic)
 * - Collapses multiple spaces to single space
 */
export function normalizeTextForComparison(text: string): string {
  return normalizeLowercaseStringOrEmpty(text)
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMessagingToolDuplicateNormalized(
  normalized: string,
  normalizedSentTexts: string[],
  options: { allowShortExact?: boolean } = {},
): boolean {
  if (normalizedSentTexts.length === 0) {
    return false;
  }
  if (
    options.allowShortExact === true &&
    normalized.length > 0 &&
    normalizedSentTexts.some((normalizedSent) => normalizedSent === normalized)
  ) {
    return true;
  }
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) {
    return false;
  }
  return normalizedSentTexts.some((normalizedSent) => {
    if (!normalizedSent || normalizedSent.length < MIN_DUPLICATE_TEXT_LENGTH) {
      return false;
    }
    return normalized.includes(normalizedSent) || normalizedSent.includes(normalized);
  });
}

export function isMessagingToolDuplicate(
  text: string,
  sentTexts: string[],
  options: { allowShortExact?: boolean } = {},
): boolean {
  if (sentTexts.length === 0) {
    return false;
  }
  const normalized = normalizeTextForComparison(text);
  if (!normalized) {
    return false;
  }
  return isMessagingToolDuplicateNormalized(
    normalized,
    sentTexts.map(normalizeTextForComparison),
    options,
  );
}
