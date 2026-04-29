import {
  getOAuthApiKey,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai/oauth";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { retryAsync } from "../../infra/retry.js";
import {
  formatProviderAuthProfileApiKeyWithPlugin,
  refreshProviderOAuthCredentialWithPlugin,
} from "../../plugins/provider-runtime.runtime.js";
import { resolveSecretRefString, type SecretRefResolveCache } from "../../secrets/resolve.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import { log } from "./constants.js";
import { resolveTokenExpiryState } from "./credential-state.js";
import { formatAuthDoctorHint } from "./doctor.js";
import { readManagedExternalCliCredential } from "./external-cli-sync.js";
import { createOAuthManager, OAuthManagerRefreshError } from "./oauth-manager.js";
import { assertNoOAuthSecretRefPolicyViolations } from "./policy.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import { loadAuthProfileStoreForSecretsRuntime } from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export {
  isSafeToCopyOAuthIdentity,
  isSameOAuthIdentity,
  normalizeAuthEmailToken,
  normalizeAuthIdentityToken,
  shouldMirrorRefreshedOAuthCredential,
} from "./oauth-identity.js";
export type { OAuthMirrorDecision, OAuthMirrorDecisionReason } from "./oauth-identity.js";

function listOAuthProviderIds(): string[] {
  if (typeof getOAuthProviders !== "function") {
    return [];
  }
  const providers = getOAuthProviders();
  if (!Array.isArray(providers)) {
    return [];
  }
  return providers
    .map((provider) =>
      provider &&
      typeof provider === "object" &&
      "id" in provider &&
      typeof provider.id === "string"
        ? provider.id
        : undefined,
    )
    .filter((providerId): providerId is string => typeof providerId === "string");
}

const OAUTH_PROVIDER_IDS = new Set<string>(listOAuthProviderIds());

const isOAuthProvider = (provider: string): provider is OAuthProvider =>
  OAUTH_PROVIDER_IDS.has(provider);

const resolveOAuthProvider = (provider: string): OAuthProvider | null =>
  isOAuthProvider(provider) ? provider : null;

/** Bearer-token auth modes that are interchangeable (oauth tokens and raw tokens). */
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);

const isCompatibleModeType = (mode: string | undefined, type: string | undefined): boolean => {
  if (!mode || !type) {
    return false;
  }
  if (mode === type) {
    return true;
  }
  // Both token and oauth represent bearer-token auth paths — allow bidirectional compat.
  return BEARER_AUTH_MODES.has(mode) && BEARER_AUTH_MODES.has(type);
};

function isProfileConfigCompatible(params: {
  cfg?: OpenClawConfig;
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  allowOAuthTokenCompatibility?: boolean;
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig && profileConfig.provider !== params.provider) {
    return false;
  }
  if (profileConfig && !isCompatibleModeType(profileConfig.mode, params.mode)) {
    return false;
  }
  return true;
}

async function buildOAuthApiKey(provider: string, credentials: OAuthCredential): Promise<string> {
  const formatted = await formatProviderAuthProfileApiKeyWithPlugin({
    provider,
    context: credentials,
  });
  return typeof formatted === "string" && formatted.length > 0 ? formatted : credentials.access;
}

function buildApiKeyProfileResult(params: { apiKey: string; provider: string; email?: string }) {
  return {
    apiKey: params.apiKey,
    provider: params.provider,
    email: params.email,
  };
}

function extractErrorMessage(error: unknown): string {
  return formatErrorMessage(error);
}

export function isRefreshTokenReusedError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(extractErrorMessage(error));
  return (
    message.includes("refresh_token_reused") ||
    message.includes("refresh token has already been used") ||
    message.includes("already been used to generate a new access token")
  );
}

const OAUTH_REFRESH_RETRY_ATTEMPTS = 3;
const OAUTH_REFRESH_RETRY_MIN_DELAY_MS = 100;
const OAUTH_REFRESH_RETRY_MAX_DELAY_MS = 500;

const TRANSIENT_OAUTH_REFRESH_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_OAUTH_REFRESH_ERRNO_CODES = new Set([
  "eai_again",
  "econnaborted",
  "econnrefused",
  "econnreset",
  "enetdown",
  "enetreset",
  "enotfound",
  "etimedout",
  "socketerror",
  "timeout",
]);

const PERMANENT_OAUTH_REFRESH_ERROR_RE =
  /\b(access_denied|expired or revoked|invalid refresh token|invalid_client|invalid_grant|revoked|sign in again|signing in again|unauthorized_client|unsupported_country_region_territory|unsupported_grant_type)\b/i;

const TRANSIENT_OAUTH_REFRESH_MESSAGE_RE =
  /\b(429|500|502|503|504|bad gateway|fetch failed|gateway timeout|internal server error|network error|rate limit|service unavailable|socket hang up|temporarily unavailable|timeout|timed out|too many requests)\b/i;

function collectErrorObjects(error: unknown): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    objects.push(record);
    const response = record.response;
    if (response && typeof response === "object" && !seen.has(response)) {
      objects.push(response as Record<string, unknown>);
      seen.add(response);
    }
    current = record.cause;
  }
  return objects;
}

function readFiniteInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasTransientOAuthRefreshStatusCode(error: unknown): boolean {
  for (const object of collectErrorObjects(error)) {
    for (const key of ["status", "statusCode", "code"]) {
      const statusCode = readFiniteInteger(object[key]);
      if (statusCode !== undefined && TRANSIENT_OAUTH_REFRESH_STATUS_CODES.has(statusCode)) {
        return true;
      }
    }
  }
  return false;
}

function hasTransientOAuthRefreshErrnoCode(error: unknown): boolean {
  for (const object of collectErrorObjects(error)) {
    const code = normalizeLowercaseStringOrEmpty(
      typeof object.code === "string" || typeof object.code === "number"
        ? String(object.code)
        : undefined,
    );
    if (code && TRANSIENT_OAUTH_REFRESH_ERRNO_CODES.has(code)) {
      return true;
    }
  }
  return false;
}

export function isTransientOAuthRefreshError(error: unknown): boolean {
  if (isRefreshTokenReusedError(error)) {
    return false;
  }
  const message = extractErrorMessage(error);
  if (PERMANENT_OAUTH_REFRESH_ERROR_RE.test(message)) {
    return false;
  }
  return (
    hasTransientOAuthRefreshStatusCode(error) ||
    hasTransientOAuthRefreshErrnoCode(error) ||
    TRANSIENT_OAUTH_REFRESH_MESSAGE_RE.test(message)
  );
}

function shouldRetryOAuthRefreshError(provider: string, error: unknown): boolean {
  if (isTransientOAuthRefreshError(error)) {
    return true;
  }
  // pi-ai currently masks Codex HTTP/fetch refresh failures behind this exact message.
  return (
    provider === "openai-codex" &&
    normalizeLowercaseStringOrEmpty(extractErrorMessage(error)) ===
      "failed to refresh openai codex token"
  );
}

type ResolveApiKeyForProfileParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
};

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

async function refreshOAuthCredential(
  credential: OAuthCredential,
): Promise<OAuthCredentials | null> {
  return await retryAsync(() => refreshOAuthCredentialOnce(credential), {
    label: `oauth refresh ${credential.provider}`,
    attempts: OAUTH_REFRESH_RETRY_ATTEMPTS,
    minDelayMs: OAUTH_REFRESH_RETRY_MIN_DELAY_MS,
    maxDelayMs: OAUTH_REFRESH_RETRY_MAX_DELAY_MS,
    shouldRetry: (error) => shouldRetryOAuthRefreshError(credential.provider, error),
    onRetry: (info) => {
      log.debug("retrying transient OAuth refresh failure", {
        provider: credential.provider,
        attempt: info.attempt,
        maxAttempts: info.maxAttempts,
        delayMs: info.delayMs,
        error: formatErrorMessage(info.err),
      });
    },
  });
}

async function refreshOAuthCredentialOnce(
  credential: OAuthCredential,
): Promise<OAuthCredentials | null> {
  const pluginRefreshed = await refreshProviderOAuthCredentialWithPlugin({
    provider: credential.provider,
    context: credential,
  });
  if (pluginRefreshed) {
    return pluginRefreshed;
  }

  if (credential.provider === "chutes") {
    return await refreshChutesTokens({ credential });
  }

  const oauthProvider = resolveOAuthProvider(credential.provider);
  if (!oauthProvider || typeof getOAuthApiKey !== "function") {
    return null;
  }
  const result = await getOAuthApiKey(oauthProvider, {
    [credential.provider]: credential,
  });
  return result?.newCredentials ?? null;
}

const oauthManager = createOAuthManager({
  buildApiKey: buildOAuthApiKey,
  refreshCredential: refreshOAuthCredential,
  readBootstrapCredential: ({ profileId, credential }) =>
    readManagedExternalCliCredential({
      profileId,
      credential,
    }),
  isRefreshTokenReusedError,
});

export function resetOAuthRefreshQueuesForTest(): void {
  oauthManager.resetRefreshQueuesForTest();
}

async function tryResolveOAuthProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
    })
  ) {
    return null;
  }

  const resolved = await oauthManager.resolveOAuthAccess({
    store,
    profileId,
    credential: cred,
    agentDir: params.agentDir,
  });
  if (!resolved) {
    return null;
  }
  return buildApiKeyProfileResult({
    apiKey: resolved.apiKey,
    provider: resolved.credential.provider,
    email: resolved.credential.email ?? cred.email,
  });
}

async function resolveProfileSecretString(params: {
  profileId: string;
  provider: string;
  value: string | undefined;
  valueRef: unknown;
  refDefaults: SecretDefaults | undefined;
  configForRefResolution: OpenClawConfig;
  cache: SecretRefResolveCache;
  inlineFailureMessage: string;
  refFailureMessage: string;
}): Promise<string | undefined> {
  let resolvedValue = params.value?.trim();
  if (resolvedValue) {
    const inlineRef = coerceSecretRef(resolvedValue, params.refDefaults);
    if (inlineRef) {
      try {
        resolvedValue = await resolveSecretRefString(inlineRef, {
          config: params.configForRefResolution,
          env: process.env,
          cache: params.cache,
        });
      } catch (err) {
        log.debug(params.inlineFailureMessage, {
          profileId: params.profileId,
          provider: params.provider,
          error: formatErrorMessage(err),
        });
      }
    }
  }

  const explicitRef = coerceSecretRef(params.valueRef, params.refDefaults);
  if (!resolvedValue && explicitRef) {
    try {
      resolvedValue = await resolveSecretRefString(explicitRef, {
        config: params.configForRefResolution,
        env: process.env,
        cache: params.cache,
      });
    } catch (err) {
      log.debug(params.refFailureMessage, {
        profileId: params.profileId,
        provider: params.provider,
        error: formatErrorMessage(err),
      });
    }
  }

  return resolvedValue;
}

export async function resolveApiKeyForProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred) {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
      // Compatibility: treat "oauth" config as compatible with stored token profiles.
      allowOAuthTokenCompatibility: true,
    })
  ) {
    return null;
  }

  const refResolveCache: SecretRefResolveCache = {};
  const configForRefResolution = cfg ?? getRuntimeConfig();
  const refDefaults = configForRefResolution.secrets?.defaults;
  assertNoOAuthSecretRefPolicyViolations({
    store,
    cfg: configForRefResolution,
    profileIds: [profileId],
    context: `auth profile ${profileId}`,
  });

  if (cred.type === "api_key") {
    const key = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.key,
      valueRef: cred.keyRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile api_key ref",
      refFailureMessage: "failed to resolve auth profile api_key ref",
    });
    if (!key) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: key, provider: cred.provider, email: cred.email });
  }
  if (cred.type === "token") {
    const expiryState = resolveTokenExpiryState(cred.expires);
    if (expiryState === "expired" || expiryState === "invalid_expires") {
      return null;
    }
    const token = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.token,
      valueRef: cred.tokenRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile token ref",
      refFailureMessage: "failed to resolve auth profile token ref",
    });
    if (!token) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: token, provider: cred.provider, email: cred.email });
  }

  try {
    const resolved = await oauthManager.resolveOAuthAccess({
      store,
      agentDir: params.agentDir,
      profileId,
      credential: cred,
    });
    if (!resolved) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: resolved.apiKey,
      provider: resolved.credential.provider,
      email: resolved.credential.email ?? cred.email,
    });
  } catch (error) {
    const refreshedStore =
      error instanceof OAuthManagerRefreshError
        ? error.getRefreshedStore()
        : loadAuthProfileStoreForSecretsRuntime(params.agentDir);
    const surfacedCause =
      error instanceof OAuthManagerRefreshError && error.cause ? error.cause : error;
    const surfacedMessageError =
      error instanceof OAuthManagerRefreshError && error.code === "refresh_contention"
        ? error
        : surfacedCause;
    const fallbackProfileId = suggestOAuthProfileIdForLegacyDefault({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      legacyProfileId: profileId,
    });
    if (fallbackProfileId && fallbackProfileId !== profileId) {
      try {
        const fallbackResolved = await tryResolveOAuthProfile({
          cfg,
          store: refreshedStore,
          profileId: fallbackProfileId,
          agentDir: params.agentDir,
        });
        if (fallbackResolved) {
          return fallbackResolved;
        }
      } catch {
        // keep original error
      }
    }

    const message = extractErrorMessage(surfacedMessageError);
    const hint = await formatAuthDoctorHint({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      profileId,
    });
    throw new Error(
      `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        "Please try again or re-authenticate." +
        (hint ? `\n\n${hint}` : ""),
      { cause: error },
    );
  }
}
