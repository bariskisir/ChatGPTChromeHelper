/** Handles ChatGPT auth tokens, response calls, and usage limit normalization. */
import { DEFAULT_MODEL, TEXT_SOLVER_PROMPT } from '../common/scanSettings';
import { broadcastRuntimeMessage } from '../common/messages';
import { getStorage, setStorage } from '../common/storage';
import { asRecord } from '../common/safe';
import type {
  AccessContext,
  AvailableModel,
  ExtensionStorage,
  LimitInfo,
  LimitInfoItem,
  ThinkingVariant,
  ResponseStyle,
  StoredLimitInfo,
  TokenResult
} from '../common/types';

export const CHATGPT_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CHATGPT_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_NPM_LATEST_URL = 'https://registry.npmjs.org/@openai/codex/latest';
const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CHATGPT_SCOPE = 'openid profile email offline_access';
const DEFAULT_CODEX_CLIENT_VERSION = '0.124.0';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const LIMIT_REFRESH_INTERVAL = 5;
const LIMIT_PERCENT_PRECISION = 1;
const DEFAULT_LIMIT_ID = 'codex';

interface AccessTokenClaimsResponse {
  response?: {
    output?: unknown[];
  };
  output?: unknown[];
}

interface ResponseAccumulator {
  text: string;
  completedText: string;
}

interface ParsedSsePayload {
  delta: string;
  completedText: string;
}

interface UsageRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number;
}

interface UsageRateLimitSnapshot {
  limitId: string;
  limitName: string;
  primary: UsageRateLimitWindow | null;
  secondary: UsageRateLimitWindow | null;
}

/** Builds the authorization URL for the ChatGPT OAuth PKCE flow. */
export function buildAuthorizationUrl(state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: CHATGPT_REDIRECT_URI,
    scope: CHATGPT_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs'
  });
  return `${CHATGPT_AUTH_URL}?${params.toString()}`;
}

/** Exchanges the OAuth authorization code for access and refresh tokens. */
export async function exchangeAuthorizationCode(code: string, verifier: string): Promise<TokenResult> {
  const response = await fetch(CHATGPT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: CHATGPT_CLIENT_ID,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: CHATGPT_REDIRECT_URI
    })
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed with status ${response.status}.`);
  }

  return parseTokenResponse(await response.json());
}

/** Persists tokens plus account metadata extracted from the returned JWT. */
export async function persistTokenResult(tokenResult: TokenResult): Promise<void> {
  const email = readJwtClaim(tokenResult.accessToken, ['https://api.openai.com/profile', 'email'])
    || readJwtClaim(tokenResult.accessToken, ['email']);
  const chatgptAccountId = readJwtClaim(tokenResult.accessToken, ['https://api.openai.com/auth', 'chatgpt_account_id']);

  await setStorage({
    accessToken: tokenResult.accessToken,
    refreshToken: tokenResult.refreshToken,
    expiresAt: tokenResult.expiresAt,
    accountEmail: email || null,
    chatgptAccountId: chatgptAccountId || null,
    authError: null
  });
}

/** Builds the minimal auth context required for ChatGPT API calls. */
export function createAccessContextFromAccessToken(accessToken: string): AccessContext {
  return {
    accessToken,
    chatgptAccountId: readJwtClaim(accessToken, ['https://api.openai.com/auth', 'chatgpt_account_id'])
  };
}

/** Returns a valid access context, refreshing tokens when the current token is too close to expiry. */
export async function getValidAccessContext(): Promise<AccessContext> {
  const stored = await getStorage(['accessToken', 'refreshToken', 'expiresAt', 'chatgptAccountId'] as const);
  if (!stored.refreshToken && !stored.accessToken) {
    throw new Error('Please sign in with ChatGPT first.');
  }

  if (stored.accessToken && stored.expiresAt && stored.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    return {
      accessToken: stored.accessToken,
      chatgptAccountId: stored.chatgptAccountId || readJwtClaim(stored.accessToken, ['https://api.openai.com/auth', 'chatgpt_account_id'])
    };
  }

  if (!stored.refreshToken) {
    throw new Error('Your ChatGPT session expired. Please sign in again.');
  }

  const tokenResult = await refreshAccessToken(stored.refreshToken);
  await persistTokenResult(tokenResult);
  return {
    accessToken: tokenResult.accessToken,
    chatgptAccountId: readJwtClaim(tokenResult.accessToken, ['https://api.openai.com/auth', 'chatgpt_account_id'])
  };
}

/** Sends a prompt and optional image to the ChatGPT responses endpoint and returns the final text. */
export async function callChatGpt({
  prompt,
  imageDataUrl,
  model = DEFAULT_MODEL,
  reasoningEffort = 'medium',
  instructions = TEXT_SOLVER_PROMPT,
  responseStyle = 'medium'
}: {
  prompt: string;
  imageDataUrl?: string | null;
  model?: string;
  reasoningEffort?: ThinkingVariant;
  instructions?: string;
  responseStyle?: ResponseStyle;
}): Promise<string> {
  const accessContext = await getValidAccessContext();
  const content: Array<Record<string, string>> = [{ type: 'input_text', text: prompt }];
  if (imageDataUrl) {
    content.push({ type: 'input_image', image_url: imageDataUrl });
  }

  const response = await fetch(CHATGPT_RESPONSES_URL, {
    method: 'POST',
    headers: createChatGptRequestHeaders(accessContext, 'text/event-stream'),
    body: JSON.stringify({
      model,
      input: [{ type: 'message', role: 'user', content }],
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      text: { verbosity: responseStyle },
      reasoning: { effort: reasoningEffort, summary: 'auto' },
      instructions: instructions || '.'
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ChatGPT request failed with status ${response.status}.${body ? ` ${body.slice(0, 240)}` : ''}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') && response.body) {
    return finalizeChatGptResponse(readResponseStream(response), accessContext);
  }

  const bodyText = await response.text();
  if (bodyText.trimStart().startsWith('event:') || bodyText.trimStart().startsWith('data:')) {
    return finalizeChatGptResponse(parseSseText(bodyText), accessContext);
  }

  return finalizeChatGptResponse(extractCompletedText(JSON.parse(bodyText) as AccessTokenClaimsResponse), accessContext);
}

/** Refreshes stored limit data while falling back to the previous cached snapshot on failure. */
export async function refreshStoredLimitInfo(accessContext: AccessContext): Promise<StoredLimitInfo> {
  try {
    return await fetchLimitInfo(accessContext);
  } catch (error) {
    console.warn('Unable to refresh ChatGPT limit info.', error);
    return (await getStorage(['limitInfo'] as const)).limitInfo || null;
  }
}

/** Calls the ChatGPT usage endpoint and converts the response into popup-friendly limit info. */
export async function fetchLimitInfo(accessContext: AccessContext): Promise<LimitInfo> {
  const response = await fetch(CHATGPT_USAGE_URL, {
    method: 'GET',
    headers: createChatGptRequestHeaders(accessContext, 'application/json', false)
  });

  if (!response.ok) {
    throw new Error(`ChatGPT limit check failed with status ${response.status}.`);
  }

  return createLimitInfoPayload(await response.json());
}

/** Calls the ChatGPT models endpoint and normalizes it into popup-friendly model options. */
export async function fetchAvailableModels(accessContext: AccessContext, clientVersion: string): Promise<AvailableModel[]> {
  const response = await fetch(`${CHATGPT_MODELS_URL}?${new URLSearchParams({ client_version: clientVersion }).toString()}`, {
    method: 'GET',
    headers: createChatGptRequestHeaders(accessContext, 'application/json', false)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ChatGPT models check failed with status ${response.status}.${body ? ` ${body.slice(0, 240)}` : ''}`);
  }

  return normalizeAvailableModelsPayload(await response.json());
}

/** Reads the latest published Codex package version from npm for use as the models client_version. */
export async function fetchCodexClientVersion(): Promise<string> {
  const response = await fetch(CODEX_NPM_LATEST_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Codex version lookup failed with status ${response.status}.`);
  }

  const payload = asRecord(await response.json());
  const version = normalizeOptionalString(payload.version);
  if (!version) {
    throw new Error('Codex version lookup returned no version field.');
  }
  return version;
}

/** Returns the hard fallback Codex client version used when the npm registry lookup fails. */
export function getDefaultCodexClientVersion(): string {
  return DEFAULT_CODEX_CLIENT_VERSION;
}

/** Normalizes any stored limit payload into the latest popup-ready structure. */
export function normalizeLimitInfo(limitInfo: StoredLimitInfo): LimitInfo | null {
  if (!limitInfo || typeof limitInfo !== 'object') {
    return null;
  }

  const data = asRecord(limitInfo);
  const planName = normalizePlanName(
    data.planName
    || data.plan
    || data.planType
    || data.subscriptionPlan
  );
  const items = Array.isArray(data.items)
    ? data.items.map(normalizeLimitInfoItem).filter((item): item is LimitInfoItem => item !== null)
    : [];

  if (items.length > 0 || planName) {
    return {
      planName,
      items
    };
  }

  return normalizeLegacyLimitInfo(data);
}

/** Checks whether normalized limit info contains any value worth rendering in the popup. */
export function hasRenderableLimitInfo(limitInfo: LimitInfo | null): boolean {
  return Boolean(limitInfo?.planName) || (Array.isArray(limitInfo?.items) && limitInfo.items.length > 0);
}

/** Exchanges a refresh token for a new access token when the current one is near expiry. */
async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  const response = await fetch(CHATGPT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CHATGPT_CLIENT_ID
    })
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed with status ${response.status}.`);
  }

  return parseTokenResponse(await response.json());
}

/** Validates and normalizes the token payload returned by ChatGPT auth endpoints. */
function parseTokenResponse(data: unknown): TokenResult {
  const payload = asRecord(data);
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : '';
  const expiresIn = typeof payload.expires_in === 'number' || typeof payload.expires_in === 'string'
    ? Number(payload.expires_in)
    : NaN;

  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn)) {
    throw new Error('ChatGPT returned an invalid token response.');
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000
  };
}

/** Creates common headers expected by ChatGPT backend endpoints. */
function createChatGptRequestHeaders(
  accessContext: AccessContext,
  accept: string,
  includeJsonContentType = true
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    Authorization: `Bearer ${accessContext.accessToken}`,
    originator: 'codex_cli_rs'
  };

  if (includeJsonContentType) {
    headers['Content-Type'] = 'application/json';
    headers['OpenAI-Beta'] = 'responses=experimental';
  }

  if (accessContext.chatgptAccountId) {
    headers['chatgpt-account-id'] = accessContext.chatgptAccountId;
  }

  return headers;
}

/** Finalizes a ChatGPT response and updates rate-limit tracking before returning the text. */
async function finalizeChatGptResponse(textOrPromise: Promise<string> | string, accessContext: AccessContext): Promise<string> {
  const text = await Promise.resolve(textOrPromise);
  await maybeRefreshLimitInfo(accessContext);
  return text;
}

/** Increments request counters and periodically refreshes stored rate-limit info. */
async function maybeRefreshLimitInfo(accessContext: AccessContext): Promise<void> {
  const { requestCount = 0 } = await getStorage(['requestCount'] as const);
  const nextCount = Number.isInteger(requestCount) ? requestCount + 1 : 1;
  const shouldRefresh = nextCount === 1 || nextCount % LIMIT_REFRESH_INTERVAL === 0;
  const values: Partial<ExtensionStorage> = { requestCount: nextCount };

  if (shouldRefresh) {
    values.limitInfo = await refreshStoredLimitInfo(accessContext);
  }

  await setStorage(values);
  if (shouldRefresh) {
    broadcastRuntimeMessage({ action: 'responseUpdated' });
  }
}

/** Reads a streamed SSE response body and accumulates the emitted text deltas. */
async function readResponseStream(response: Response): Promise<string> {
  if (!response.body) {
    return extractCompletedText(await response.json() as AccessTokenClaimsResponse);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const accumulator = createResponseAccumulator();

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      appendSseLine(accumulator, line);
    }
  }

  return finalizeResponseAccumulator(accumulator);
}

/** Parses an already-buffered SSE payload body into the final assistant text. */
function parseSseText(bodyText: string): string {
  const accumulator = createResponseAccumulator();

  for (const line of bodyText.split(/\r?\n/)) {
    appendSseLine(accumulator, line);
  }

  return finalizeResponseAccumulator(accumulator);
}

/** Creates the mutable accumulator used while parsing streamed response events. */
function createResponseAccumulator(): ResponseAccumulator {
  return {
    text: '',
    completedText: ''
  };
}

/** Consumes a single SSE line and merges any delta or completion payload into the accumulator. */
function appendSseLine(accumulator: ResponseAccumulator, line: string): void {
  if (!line.startsWith('data:')) {
    return;
  }

  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') {
    return;
  }

  const parsed = parseSsePayload(payload);
  accumulator.text += parsed.delta;
  accumulator.completedText = parsed.completedText || accumulator.completedText;
}

/** Chooses the best available text from the response accumulator. */
function finalizeResponseAccumulator(accumulator: ResponseAccumulator): string {
  return (accumulator.text || accumulator.completedText || 'No response text was returned.').trim();
}

/** Parses one SSE JSON event emitted by the responses endpoint. */
function parseSsePayload(payload: string): ParsedSsePayload {
  try {
    const event = asRecord(JSON.parse(payload));
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      return { delta: event.delta, completedText: '' };
    }

    if (event.type === 'response.completed') {
      return { delta: '', completedText: extractCompletedText(event.response || event) };
    }
  } catch (error) {
    console.warn('Unable to parse ChatGPT stream event.', error);
  }

  return { delta: '', completedText: '' };
}

/** Extracts the final output text from a responses API payload. */
function extractCompletedText(root: unknown): string {
  const response = asRecord(root).response ? asRecord(asRecord(root).response) : asRecord(root);
  const output = Array.isArray(response.output) ? response.output : [];
  const parts: string[] = [];

  for (const item of output) {
    const message = asRecord(item);
    if (message.type !== 'message' || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      const content = asRecord(part);
      if (content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }

  return parts.join('').trim();
}

/** Extracts the primary, additional, and code-review rate-limit snapshots from the usage payload. */
function parseUsageRateLimitPayload(payload: unknown): UsageRateLimitSnapshot[] {
  const data = asRecord(payload);
  const snapshots: UsageRateLimitSnapshot[] = [
    createUsageRateLimitSnapshot({
      limitId: DEFAULT_LIMIT_ID,
      limitName: '',
      rateLimit: asRecord(data.rate_limit)
    })
  ];

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  for (const item of additional) {
    const entry = asRecord(item);
    snapshots.push(createUsageRateLimitSnapshot({
      limitId: typeof entry.metered_feature === 'string' ? entry.metered_feature : typeof entry.limit_name === 'string' ? entry.limit_name : '',
      limitName: typeof entry.limit_name === 'string' ? entry.limit_name : '',
      rateLimit: asRecord(entry.rate_limit)
    }));
  }

  const codeReviewSnapshot = createUsageRateLimitSnapshot({
    limitId: 'code_review',
    limitName: 'Code Review',
    rateLimit: asRecord(data.code_review_rate_limit)
  });
  if (hasRateLimitSnapshotData(codeReviewSnapshot)) {
    snapshots.push(codeReviewSnapshot);
  }

  return snapshots;
}

/** Builds a normalized rate-limit snapshot from one usage entry. */
function createUsageRateLimitSnapshot({
  limitId,
  limitName,
  rateLimit
}: {
  limitId: string;
  limitName: string;
  rateLimit: Record<string, unknown>;
}): UsageRateLimitSnapshot {
  return {
    limitId: normalizeLimitId(limitId || DEFAULT_LIMIT_ID),
    limitName: normalizeOptionalString(limitName),
    primary: parseUsageRateLimitWindow(asRecord(rateLimit.primary_window)),
    secondary: parseUsageRateLimitWindow(asRecord(rateLimit.secondary_window))
  };
}

/** Normalizes one usage window into the compact structure used by the popup. */
function parseUsageRateLimitWindow(window: Record<string, unknown>): UsageRateLimitWindow | null {
  const usedPercent = tryGetNumber(window.used_percent);
  const windowDurationMins = tryGetWindowDurationMins(window);
  const resetsAt = tryGetInt(window.reset_at);
  const hasData = usedPercent != null || windowDurationMins != null || resetsAt != null;

  if (!hasData || resetsAt == null) {
    return null;
  }

  return {
    usedPercent: roundLimitPercent(Math.max(0, usedPercent ?? 0)),
    windowDurationMins,
    resetsAt
  };
}

/** Checks whether a snapshot contains at least one usable rate-limit window. */
function hasRateLimitSnapshotData(snapshot: UsageRateLimitSnapshot): boolean {
  return Boolean(snapshot.primary || snapshot.secondary);
}

/** Converts the raw usage payload into the normalized limit info shown in the popup. */
function createLimitInfoPayload(payload: unknown): LimitInfo {
  return {
    planName: extractPlanName(payload),
    items: createLimitInfoItems(parseUsageRateLimitPayload(payload))
  };
}

/** Flattens multiple usage snapshots into the list rendered in the popup. */
function createLimitInfoItems(snapshots: UsageRateLimitSnapshot[]): LimitInfoItem[] {
  const items: LimitInfoItem[] = [];
  for (const snapshot of snapshots) {
    if (!hasRateLimitSnapshotData(snapshot)) {
      continue;
    }

    if (snapshot.primary) {
      items.push(createLimitInfoItem(snapshot, snapshot.primary, 'primary'));
    }

    if (snapshot.secondary) {
      items.push(createLimitInfoItem(snapshot, snapshot.secondary, 'secondary'));
    }
  }

  return items;
}

/** Builds one popup-friendly rate-limit row from a snapshot window. */
function createLimitInfoItem(
  snapshot: UsageRateLimitSnapshot,
  window: UsageRateLimitWindow,
  windowType: 'primary' | 'secondary'
): LimitInfoItem {
  const usedPercent = roundLimitPercent(Math.max(0, window.usedPercent));
  const leftPercent = roundLimitPercent(Math.max(0, 100 - usedPercent));
  return {
    id: `${snapshot.limitId || DEFAULT_LIMIT_ID}:${window.windowDurationMins ?? 0}:${windowType}`,
    featureLabel: getLimitDisplayName(snapshot),
    windowLabel: getLimitWindowLabel(window.windowDurationMins),
    leftPercent,
    usedPercent,
    resetsAt: window.resetsAt,
    windowDurationMins: window.windowDurationMins ?? 0,
    limitId: snapshot.limitId || DEFAULT_LIMIT_ID
  };
}

/** Formats a usage-window duration into a short popup label such as `1h` or `30m`. */
function getLimitWindowLabel(windowDurationMins: number | null): string {
  if (windowDurationMins && windowDurationMins > 0) {
    if (windowDurationMins % 1440 === 0) {
      return `${windowDurationMins / 1440}d`;
    }

    if (windowDurationMins % 60 === 0) {
      return `${windowDurationMins / 60}h`;
    }

    return `${windowDurationMins}m`;
  }

  return '';
}

/** Resolves the human-readable feature label for a usage snapshot. */
function getLimitDisplayName(snapshot: UsageRateLimitSnapshot): string {
  if (snapshot.limitName) {
    return snapshot.limitName;
  }

  if (!snapshot.limitId || snapshot.limitId === DEFAULT_LIMIT_ID) {
    return '';
  }

  return prettifyLimitId(snapshot.limitId);
}

/** Converts an internal limit id into title-cased display text. */
function prettifyLimitId(value: string): string {
  return String(value || DEFAULT_LIMIT_ID)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Limit';
}

/** Normalizes a limit identifier into the lowercase underscore format used internally. */
function normalizeLimitId(value: unknown): string {
  return String(value || DEFAULT_LIMIT_ID).trim().toLowerCase().replace(/-/g, '_') || DEFAULT_LIMIT_ID;
}

/** Converts unknown values to trimmed strings for popup-facing normalization. */
function normalizeOptionalString(value: unknown): string {
  return String(value || '').trim();
}

/** Extracts the visible model catalog from the ChatGPT `/codex/models` payload. */
function normalizeAvailableModelsPayload(payload: unknown): AvailableModel[] {
  const root = asRecord(payload);
  const items = Array.isArray(root.models) ? root.models : [];
  const normalized = items
    .map(normalizeAvailableModel)
    .filter((model): model is AvailableModelWithPriority => model !== null)
    .sort((a, b) => a.priority - b.priority || a.displayName.localeCompare(b.displayName))
    .map(({ priority: _priority, ...model }) => model);

  if (normalized.length === 0) {
    throw new Error('ChatGPT returned an empty models catalog.');
  }

  if (!normalized.some((model) => model.isDefault)) {
    const firstVisibleIndex = normalized.findIndex((model) => !model.hidden);
    const fallbackIndex = firstVisibleIndex >= 0 ? firstVisibleIndex : 0;
    if (normalized[fallbackIndex]) {
      normalized[fallbackIndex] = {
        ...normalized[fallbackIndex],
        isDefault: true
      };
    }
  }

  return normalized;
}

interface AvailableModelWithPriority extends AvailableModel {
  priority: number;
}

/** Normalizes a single model entry from the ChatGPT catalog payload. */
function normalizeAvailableModel(item: unknown): AvailableModelWithPriority | null {
  const data = asRecord(item);
  const slug = normalizeOptionalString(data.slug);
  const model = normalizeOptionalString(slug || data.model || data.id);
  if (!model) {
    return null;
  }

  const inputModalities = Array.isArray(data.input_modalities)
    ? data.input_modalities
      .map((value) => normalizeOptionalString(value).toLowerCase())
      .filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
    : ['text', 'image'] as Array<'text' | 'image'>;
  const availableInPlans = Array.isArray(data.available_in_plans)
    ? data.available_in_plans
      .map((value) => normalizeOptionalString(value).toLowerCase())
      .filter((value): value is string => Boolean(value))
    : [];
  const hidden = data.hidden === true || normalizeOptionalString(data.visibility).toLowerCase() === 'hide';

  return {
    id: normalizeOptionalString(data.id) || model,
    model,
    displayName: slug || normalizeOptionalString(data.display_name || data.displayName) || model,
    description: normalizeOptionalString(data.description),
    availableInPlans,
    hidden,
    isDefault: data.is_default === true,
    inputModalities: inputModalities.length > 0 ? inputModalities : ['text', 'image'],
    defaultThinkingVariant: normalizeThinkingValue(data.default_reasoning_level) || 'medium',
    thinkingVariants: normalizeThinkingVariants(data.supported_reasoning_levels),
    priority: tryGetInt(data.priority) ?? Number.MAX_SAFE_INTEGER
  };
}

/** Normalizes supported reasoning levels from the remote model payload. */
function normalizeThinkingVariants(value: unknown): AvailableModel['thinkingVariants'] {
  const items = Array.isArray(value) ? value : [];
  const normalized = items
    .map((item) => {
      const data = asRecord(item);
      const thinkingValue = normalizeThinkingValue(data.effort);
      if (!thinkingValue) {
        return null;
      }
      return {
        value: thinkingValue,
        description: normalizeOptionalString(data.description) || thinkingValue
      };
    })
    .filter((item): item is AvailableModel['thinkingVariants'][number] => item !== null);

  return normalized.length > 0
    ? normalized
    : [{ value: 'medium', description: 'Balanced reasoning for everyday tasks' }];
}

/** Converts a remote reasoning-effort string into the extension's local union. */
function normalizeThinkingValue(value: unknown): ThinkingVariant | null {
  const normalized = normalizeOptionalString(value).toLowerCase();
  return normalized === 'none'
    || normalized === 'minimal'
    || normalized === 'low'
    || normalized === 'medium'
    || normalized === 'high'
    || normalized === 'xhigh'
    ? normalized
    : null;
}

/** Converts a limit window duration from seconds to rounded-up minutes. */
function tryGetWindowDurationMins(window: Record<string, unknown>): number | null {
  const rawSeconds = tryGetInt(window.limit_window_seconds);
  if (rawSeconds == null || rawSeconds <= 0) {
    return null;
  }

  return Math.ceil(rawSeconds / 60);
}

/** Parses an integer from a number or numeric string field. */
function tryGetInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }

  return null;
}

/** Parses a numeric value from a number or numeric string field. */
function tryGetNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/** Rounds percentages to the precision used in popup limit displays. */
function roundLimitPercent(value: number): number {
  return Number(value.toFixed(LIMIT_PERCENT_PRECISION));
}

/** Converts the older single-limit storage format into the current normalized structure. */
function normalizeLegacyLimitInfo(limitInfo: Record<string, unknown>): LimitInfo | null {
  const leftPercent = tryGetNumber(limitInfo.leftPercent);
  const resetsAt = tryGetInt(limitInfo.resetsAt);
  const windowDurationMins = tryGetInt(limitInfo.windowDurationMins);
  if (leftPercent == null || resetsAt == null || windowDurationMins == null) {
    return null;
  }

  const item = normalizeLimitInfoItem({
    id: `${DEFAULT_LIMIT_ID}:${windowDurationMins}:legacy`,
    featureLabel: typeof limitInfo.label === 'string' ? limitInfo.label : prettifyLimitId(DEFAULT_LIMIT_ID),
    windowLabel: getLimitWindowLabel(windowDurationMins),
    leftPercent,
    usedPercent: tryGetNumber(limitInfo.usedPercent) ?? Math.max(0, 100 - leftPercent),
    resetsAt,
    windowDurationMins,
    limitId: DEFAULT_LIMIT_ID
  });

  if (!item) {
    return null;
  }

  return {
    planName: '',
    items: [item]
  };
}

/** Normalizes one stored limit item into the exact structure expected by the popup. */
function normalizeLimitInfoItem(item: unknown): LimitInfoItem | null {
  const data = asRecord(item);
  const leftPercent = tryGetNumber(data.leftPercent);
  const resetsAt = tryGetInt(data.resetsAt);
  const windowDurationMins = tryGetInt(data.windowDurationMins);
  if (leftPercent == null || resetsAt == null || windowDurationMins == null) {
    return null;
  }

  const normalizedLimitId = normalizeLimitId(data.limitId);
  let featureLabel = normalizeOptionalString(data.featureLabel);
  if (normalizedLimitId === DEFAULT_LIMIT_ID && featureLabel.toLowerCase() === prettifyLimitId(DEFAULT_LIMIT_ID).toLowerCase()) {
    featureLabel = '';
  }

  return {
    id: normalizeOptionalString(data.id) || `${DEFAULT_LIMIT_ID}:${windowDurationMins}:item`,
    featureLabel: featureLabel || (normalizedLimitId === DEFAULT_LIMIT_ID ? '' : prettifyLimitId(normalizedLimitId)),
    windowLabel: normalizeOptionalString(data.windowLabel) || getLimitWindowLabel(windowDurationMins),
    leftPercent: roundLimitPercent(leftPercent),
    usedPercent: roundLimitPercent(tryGetNumber(data.usedPercent) ?? Math.max(0, 100 - leftPercent)),
    resetsAt,
    windowDurationMins,
    limitId: normalizedLimitId
  };
}

/** Searches the usage payload for the user's plan name using known fields first. */
function extractPlanName(payload: unknown): string {
  const data = asRecord(payload);
  const directCandidates = [
    data.plan,
    data.plan_name,
    data.plan_type,
    data.planType,
    data.subscription_plan,
    data.subscriptionPlan,
    data.subscription_tier,
    data.subscriptionTier,
    data.account_plan,
    data.accountPlan,
    data.tier,
    asRecord(data.workspace).plan,
    asRecord(data.workspace).plan_name,
    asRecord(data.workspace).plan_type,
    asRecord(data.workspace).subscription_plan,
    asRecord(data.organization).plan,
    asRecord(data.organization).plan_name,
    asRecord(data.organization).plan_type,
    asRecord(data.org).plan,
    asRecord(data.org).plan_name,
    asRecord(data.org).plan_type,
    asRecord(data.account).plan,
    asRecord(data.account).plan_name,
    asRecord(data.account).plan_type,
    asRecord(data.subscription).plan,
    asRecord(data.subscription).plan_name,
    asRecord(data.subscription).plan_type,
    asRecord(data.user).plan,
    asRecord(data.user).plan_name,
    asRecord(data.user).plan_type
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizePlanName(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return findPlanNameRecursively(payload);
}

/** Recursively walks a usage payload to find a plausible plan or subscription name. */
function findPlanNameRecursively(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return normalizePlanName(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = findPlanNameRecursively(item, depth + 1);
      if (normalized) {
        return normalized;
      }
    }
    return '';
  }

  if (typeof value !== 'object') {
    return '';
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (!/(plan|tier|subscription)/i.test(key)) {
      continue;
    }

    const normalized = findPlanNameRecursively(nestedValue, depth + 1);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

/** Normalizes a raw plan name into a compact display label. */
function normalizePlanName(value: unknown): string {
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (!normalized) {
    return '';
  }

  const knownPlans = ['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu'];
  const matchedKnownPlan = knownPlans.find((plan) => normalized === plan || normalized.includes(plan));
  if (matchedKnownPlan) {
    return matchedKnownPlan.charAt(0).toUpperCase() + matchedKnownPlan.slice(1);
  }

  if (!/(plan|tier|subscription)/i.test(normalized)) {
    return '';
  }

  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

/** Reads a nested claim from a JWT payload without failing on malformed tokens. */
function readJwtClaim(token: string | undefined, path: string[]): string | null {
  if (!token || !Array.isArray(path)) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    const tokenPayloadPart = parts[1];
    if (!tokenPayloadPart) {
      return null;
    }

    const payload = JSON.parse(atob(tokenPayloadPart.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(tokenPayloadPart.length / 4) * 4, '='))) as Record<string, unknown>;
    let current: unknown = payload;
    for (const key of path) {
      current = asRecord(current)[key];
      if (current == null) {
        return null;
      }
    }
    return typeof current === 'string' ? current : null;
  } catch {
    return null;
  }
}
