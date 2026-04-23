/** Coordinates authentication, capture flows, ChatGPT requests, and extension-wide state updates. */
import {
  DEFAULT_MODEL,
  STATUS_STORAGE_KEYS,
  STORAGE_KEYS,
  TEXT_SOLVER_PROMPT,
  createHistoryEntry,
  getMissingSavedCoordinatesMessage,
  getNormalizedHistory,
  getNormalizedHistoryIndex,
  getScanSettings,
  isSavedCoordinatesUsable,
  normalizeScanKind,
  normalizeStoredModel,
  normalizeSystemPromptPreset,
  resolveModelValue,
  resolveSystemPrompt
} from './lib/shared';
import { broadcastRuntimeMessage, isRuntimeRequest, sendTabMessage, type RuntimeResponse } from './lib/messages';
import { getStorage, removeStorage, setStorage } from './lib/storage';
import type {
  AccessContext,
  CaptureAreaRequest,
  CropImagePayload,
  ErrorResult,
  ExtensionStorage,
  HistoryEntry,
  LimitInfo,
  LimitInfoItem,
  OcrImagePayload,
  PageResponseType,
  PendingOAuth,
  Result,
  RuntimeRequest,
  SavedSelectionCoordinates,
  ScanKind,
  SelectionCoordinates,
  StatusPayload,
  StoredLimitInfo,
  TokenResult
} from './lib/types';

const CHATGPT_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CHATGPT_SCOPE = 'openid profile email offline_access';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const HISTORY_LIMIT = 50;
const RESPONSE_BADGE_COLOR = '#2563eb';
const RESPONSE_BADGE_TEXT = '1';
const RESPONSE_BADGE_DURATION_MS = 8000;
const ASK_RESPONSE_STYLE = 'low';
const LIMIT_REFRESH_INTERVAL = 5;
const LIMIT_PERCENT_PRECISION = 1;
const DEFAULT_LIMIT_ID = 'codex';

const CONTEXT_MENU_ITEMS = {
  loggedOut: [
    {
      id: 'login',
      title: 'Log in to ChatGPT',
      contexts: ['page', 'selection']
    }
  ],
  loggedIn: [
    {
      id: 'ask',
      title: 'Ask',
      contexts: ['selection']
    },
    {
      id: 'textScanArea',
      title: 'Text Scan Area',
      contexts: ['page', 'selection']
    },
    {
      id: 'imageScanArea',
      title: 'Image Scan Area',
      contexts: ['page', 'selection']
    }
  ]
} satisfies Record<'loggedOut' | 'loggedIn', chrome.contextMenus.CreateProperties[]>;

interface RequestAndPublishOptions {
  tabId: number;
  prompt: string;
  imageDataUrl?: string | null;
  kind?: ScanKind;
  historyType?: HistoryEntry['type'];
  historyInput?: string;
  historyImageDataUrl?: string;
  statusMessage?: string;
  responseStyle?: 'low' | 'medium' | 'high';
}

interface ScanRequestData {
  prompt: string;
  imageDataUrl: string | null;
  historyInput: string;
  historyImageDataUrl: string;
}

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

chrome.runtime.onInstalled.addListener(() => {
  runBackgroundTask(createContextMenus(), 'Context menu installation');
});

chrome.runtime.onStartup.addListener(() => {
  runBackgroundTask(createContextMenus(), 'Context menu startup');
});

chrome.contextMenus.onClicked.addListener(handleContextMenuClick);
chrome.tabs.onUpdated.addListener(handleTabUpdated);
chrome.runtime.onMessage.addListener(handleRuntimeMessage);

/** Rebuilds context menus to match the current authentication state. */
async function createContextMenus(): Promise<void> {
  const loggedIn = await isLoggedIn();
  await removeAllMenus();

  for (const item of getContextMenuItems(loggedIn)) {
    chrome.contextMenus.create(item);
  }
}

/** Returns the context-menu set appropriate for the current session state. */
function getContextMenuItems(loggedIn: boolean): chrome.contextMenus.CreateProperties[] {
  return loggedIn ? CONTEXT_MENU_ITEMS.loggedIn : CONTEXT_MENU_ITEMS.loggedOut;
}

/** Clears all existing context menus before recreating them. */
function removeAllMenus(): Promise<void> {
  return new Promise((resolve) => chrome.contextMenus.removeAll(() => resolve()));
}

/** Routes context-menu clicks to login, ask, or scan actions. */
function handleContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): void {
  switch (info.menuItemId) {
    case 'login':
      runBackgroundTask(startLogin(), 'Context menu "login"');
      return;
    case 'ask':
      if (tab?.id != null) {
        runBackgroundTask(processSelectedText(info.selectionText, tab.id), 'Context menu "ask"');
      }
      return;
    case 'textScanArea':
      if (tab?.id != null) {
        runBackgroundTask(injectOverlay(tab.id, 'text'), 'Context menu "textScanArea"');
      }
      return;
    case 'imageScanArea':
      if (tab?.id != null) {
        runBackgroundTask(injectOverlay(tab.id, 'image'), 'Context menu "imageScanArea"');
      }
      return;
    default:
      return;
  }
}

/** Watches for the local OAuth redirect so the extension can finish sign-in. */
function handleTabUpdated(tabId: number, changeInfo: { url?: string }): void {
  if (!changeInfo.url || !changeInfo.url.startsWith(CHATGPT_REDIRECT_URI)) {
    return;
  }

  runBackgroundTask(handleOAuthCallback(changeInfo.url, tabId), 'OAuth callback');
}

/** Validates incoming runtime messages and replies asynchronously with typed results. */
function handleRuntimeMessage(
  incoming: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: RuntimeResponse) => void
): boolean {
  if (!isRuntimeRequest(incoming)) {
    return false;
  }

  respondWithResult(sendResponse, dispatchRuntimeMessage(incoming, sender));
  return true;
}

/** Routes supported runtime messages to their background handlers. */
function dispatchRuntimeMessage(message: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> | RuntimeResponse {
  switch (message.action) {
    case 'startLogin':
      return startLogin();
    case 'signOut':
      return signOut();
    case 'getStatus':
      return getStatus();
    case 'deleteHistory':
      return deleteHistory();
    case 'triggerTextScan':
      return triggerActiveOverlay('text');
    case 'triggerImageScan':
      return triggerActiveOverlay('image');
    case 'repeatTextScan':
      return repeatSavedScan('text', sender);
    case 'repeatImageScan':
      return repeatSavedScan('image', sender);
    case 'captureArea':
      return captureArea(message, sender);
    default:
      return { ok: false, error: 'Unsupported runtime action.' };
  }
}

/** Runs a background task and logs failures without breaking Chrome event handlers. */
function runBackgroundTask(task: Promise<unknown> | unknown, label: string): void {
  Promise.resolve(task).catch((error: unknown) => {
    console.error(`${label} failed.`, error);
  });
}

/** Resolves a background task into a `sendResponse` callback with consistent error handling. */
function respondWithResult(
  sendResponse: (response: RuntimeResponse) => void,
  task: Promise<RuntimeResponse> | RuntimeResponse
): void {
  Promise.resolve(task)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse(toErrorResult(error)));
}

/** Starts the OAuth PKCE flow and stores the verifier plus state for the callback step. */
async function startLogin(): Promise<Result> {
  const verifier = base64UrlRandom(32);
  const state = base64UrlRandom(16);
  const challenge = await createCodeChallenge(verifier);
  const authorizationUrl = buildAuthorizationUrl(state, challenge);

  const tab = await createTab(authorizationUrl);
  const pendingOAuthBase: PendingOAuth = {
    state,
    verifier,
    startedAt: Date.now()
  };
  const pendingOAuth: PendingOAuth = tab.id == null
    ? pendingOAuthBase
    : { ...pendingOAuthBase, tabId: tab.id };

  await setStorage({ pendingOAuth });
  return { ok: true };
}

/** Completes the OAuth flow, stores tokens, refreshes menus, and closes the callback tab. */
async function handleOAuthCallback(callbackUrl: string, tabId: number): Promise<void> {
  const { pendingOAuth } = await getStorage(['pendingOAuth'] as const);
  if (!pendingOAuth) {
    return;
  }

  const parsed = parseCallbackUrl(callbackUrl);
  if (!parsed.code) {
    await finishOAuthError('The ChatGPT callback did not include an authorization code.');
    return;
  }

  if (parsed.state && parsed.state !== pendingOAuth.state) {
    await finishOAuthError('OAuth state mismatch. Please try signing in again.');
    return;
  }

  try {
    const tokenResult = await exchangeAuthorizationCode(parsed.code, pendingOAuth.verifier);
    await persistTokenResult(tokenResult);
    await setStorage({
      limitInfo: await refreshStoredLimitInfo(createAccessContextFromAccessToken(tokenResult.accessToken))
    });
    await removeStorage('pendingOAuth');
    await createContextMenus();
    await closeTab(tabId);
    broadcastRuntimeMessage({ action: 'authChanged' });
  } catch (error) {
    await finishOAuthError(getErrorMessage(error, 'ChatGPT login failed.'));
  }
}

/** Clears pending OAuth state and publishes an authentication error to the popup. */
async function finishOAuthError(message: string): Promise<void> {
  await removeStorage('pendingOAuth');
  await setStorage({ authError: message });
  broadcastRuntimeMessage({ action: 'authChanged', error: message });
}

/** Builds the authorization URL for the ChatGPT OAuth PKCE flow. */
function buildAuthorizationUrl(state: string, challenge: string): string {
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
async function exchangeAuthorizationCode(code: string, verifier: string): Promise<TokenResult> {
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

/** Persists tokens plus account metadata extracted from the returned JWT. */
async function persistTokenResult(tokenResult: TokenResult): Promise<void> {
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
function createAccessContextFromAccessToken(accessToken: string): AccessContext {
  return {
    accessToken,
    chatgptAccountId: readJwtClaim(accessToken, ['https://api.openai.com/auth', 'chatgpt_account_id'])
  };
}

/** Returns a valid access context, refreshing tokens when the current token is too close to expiry. */
async function getValidAccessContext(): Promise<AccessContext> {
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
async function callChatGpt({
  prompt,
  imageDataUrl,
  model = DEFAULT_MODEL,
  instructions = TEXT_SOLVER_PROMPT,
  responseStyle = 'medium'
}: {
  prompt: string;
  imageDataUrl?: string | null;
  model?: string;
  instructions?: string;
  responseStyle?: 'low' | 'medium' | 'high';
}): Promise<string> {
  const accessContext = await getValidAccessContext();
  const content: Array<Record<string, string>> = [{ type: 'input_text', text: prompt }];
  if (imageDataUrl) {
    content.push({ type: 'input_image', image_url: imageDataUrl });
  }

  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessContext.accessToken}`,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs'
  };

  if (accessContext.chatgptAccountId) {
    headers['chatgpt-account-id'] = accessContext.chatgptAccountId;
  }

  const payload: Record<string, unknown> = {
    model,
    input: [
      {
        type: 'message',
        role: 'user',
        content
      }
    ],
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    text: { verbosity: responseStyle },
    reasoning: { effort: 'medium', summary: 'auto' },
    instructions: instructions || '.'
  };

  const response = await fetch(CHATGPT_RESPONSES_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
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

/** Sends selected page text to ChatGPT using the lightweight ask flow. */
async function processSelectedText(selectionText: string | undefined, tabId: number): Promise<void> {
  const text = (selectionText || '').trim();
  if (!text) {
    await sendPageResponse(tabId, 'Select text first.', 'error');
    return;
  }

  try {
    await requestAndPublishResponse({
      tabId,
      prompt: buildAskPrompt(text),
      kind: 'text',
      historyType: 'ask',
      historyInput: text,
      responseStyle: ASK_RESPONSE_STYLE
    });
  } catch (error) {
    await publishResponse(tabId, `Error: ${getErrorMessage(error)}`, 'error', text);
  }
}

/** Builds the direct-answer prompt used for context-menu text questions. */
function buildAskPrompt(text: string): string {
  return `Answer this as directly and briefly as possible. For math, solve it. For multiple choice, give the correct option and a short reason.\n\n${text}`;
}

/** Captures a user-selected page area, extracts the request payload, and publishes the answer. */
async function captureArea(message: CaptureAreaRequest, sender: chrome.runtime.MessageSender): Promise<Result> {
  if (sender.tab?.id == null) {
    throw new Error('No active tab was available for capture.');
  }

  if (sender.tab.windowId == null) {
    throw new Error('No active window was available for capture.');
  }

  const kind = normalizeScanKind(message.mode);
  const settings = getScanSettings(kind);
  const tabId = sender.tab.id;
  let requestData: ScanRequestData = {
    prompt: '',
    imageDataUrl: null,
    historyInput: '',
    historyImageDataUrl: ''
  };

  try {
    await ensureAuthenticated();
    await saveScanCoordinates(kind, message.coordinates);
    if (settings.progressMessage) {
      await sendPageResponse(tabId, settings.progressMessage, 'status');
    }

    requestData = await extractCapturedScanRequestData({
      tabId,
      windowId: sender.tab.windowId,
      kind,
      coordinates: message.coordinates
    });

    await requestAndPublishResponse({
      tabId,
      prompt: requestData.prompt,
      imageDataUrl: requestData.imageDataUrl,
      kind,
      historyType: settings.historyType,
      historyInput: requestData.historyInput,
      historyImageDataUrl: requestData.historyImageDataUrl,
      responseStyle: settings.responseStyle
    });
    return { ok: true };
  } catch (error) {
    await publishResponse(
      tabId,
      `Error: ${getErrorMessage(error)}`,
      'error',
      requestData.historyInput,
      requestData.historyImageDataUrl
    );
    return toErrorResult(error);
  }
}

/** Converts captured OCR or cropped image data into the request shape used by ChatGPT calls. */
function buildScanRequestData(kind: ScanKind, imageData: Partial<CropImagePayload & OcrImagePayload>): ScanRequestData {
  const croppedImageUri = imageData.croppedImageUri || '';
  if (!croppedImageUri) {
    throw new Error('Could not crop the selected area.');
  }

  if (kind === 'image') {
    return {
      prompt: '.',
      imageDataUrl: croppedImageUri,
      historyInput: '',
      historyImageDataUrl: croppedImageUri
    };
  }

  const extractedText = (imageData.extractedText || '').trim();
  if (!extractedText) {
    throw new Error('OCR did not find readable text in the selected area.');
  }

  return {
    prompt: buildTextScanPrompt(extractedText),
    imageDataUrl: null,
    historyInput: extractedText,
    historyImageDataUrl: ''
  };
}

/** Builds the short OCR-answer prompt used after text extraction. */
function buildTextScanPrompt(text: string): string {
  return `Answer the text extracted from the selected area. For math, solve it. Keep the answer concise.\n\n${text}`;
}

/** Captures the visible tab and delegates cropping or OCR work to the content script. */
async function extractCapturedScanRequestData({
  tabId,
  windowId,
  kind,
  coordinates
}: {
  tabId: number;
  windowId: number;
  kind: ScanKind;
  coordinates: SelectionCoordinates;
}): Promise<ScanRequestData> {
  const settings = getScanSettings(kind);
  const imageUri = await captureVisibleTab(windowId);

  if (settings.captureAction === 'ocrImage') {
    const result = await sendTabMessage<Result<OcrImagePayload>>(tabId, {
      action: 'ocrImage',
      imageUri,
      coordinates
    });
    return buildScanRequestData(kind, unwrapResult(result));
  }

  const result = await sendTabMessage<Result<CropImagePayload>>(tabId, {
    action: 'cropImage',
    imageUri,
    coordinates
  });
  return buildScanRequestData(kind, unwrapResult(result));
}

/** Sends a request to ChatGPT and publishes the returned answer back to the page and popup. */
async function requestAndPublishResponse({
  tabId,
  prompt,
  imageDataUrl = null,
  kind = 'text',
  historyType = kind,
  historyInput = '',
  historyImageDataUrl = '',
  statusMessage = 'Thinking...',
  responseStyle = 'medium'
}: RequestAndPublishOptions): Promise<string> {
  if (statusMessage) {
    await sendPageResponse(tabId, statusMessage, 'status');
  }

  const [model, instructions] = await Promise.all([
    getScanModel(kind),
    getSystemPrompt(kind)
  ]);
  const answer = await callChatGpt({
    prompt,
    imageDataUrl,
    model,
    instructions,
    responseStyle
  });
  await publishResponse(tabId, answer, historyType, historyInput, historyImageDataUrl);
  return answer;
}

/** Stores an answer, pushes it into history, notifies the popup, and shows it on the page. */
async function publishResponse(
  tabId: number,
  response: string,
  type: PageResponseType,
  input = '',
  inputImageDataUrl = ''
): Promise<void> {
  await setStorage({ lastResponse: response });
  await addHistoryEntry(input, response, type === 'error' || type === 'status' ? 'ask' : type, inputImageDataUrl);
  broadcastRuntimeMessage({ action: 'responseUpdated', response });
  await sendPageResponse(tabId, response, type);
  showActionBadge();
}

/** Shows a temporary action badge so the user notices a fresh response. */
function showActionBadge(): void {
  void chrome.action.setBadgeText({ text: RESPONSE_BADGE_TEXT });
  void chrome.action.setBadgeBackgroundColor({ color: RESPONSE_BADGE_COLOR });
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: '' });
  }, RESPONSE_BADGE_DURATION_MS);
}

/** Sends a response payload to the content script, ignoring delivery failures on unsupported pages. */
async function sendPageResponse(tabId: number, response: string, type: PageResponseType): Promise<void> {
  try {
    await sendTabMessage(tabId, {
      action: 'displayResponse',
      response,
      type
    });
  } catch (error) {
    console.warn('Unable to send response to content script.', error);
  }
}

/** Starts the overlay flow on the active tab after validating the page and auth state. */
async function triggerActiveOverlay(kind: ScanKind): Promise<Result> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isSupportedPageUrl(tab.url)) {
    throw new Error('Open a regular web page first.');
  }

  await ensureAuthenticated();
  await injectOverlay(tab.id, kind);
  return { ok: true };
}

/** Repeats the last saved scan coordinates for the requested mode. */
async function repeatSavedScan(kind: ScanKind, sender: chrome.runtime.MessageSender): Promise<Result> {
  if (!sender.tab?.id) {
    throw new Error('No active tab was available for repeat scan.');
  }

  const coordinates = await getSavedScanCoordinates(kind);
  return captureArea({
    action: 'captureArea',
    mode: kind,
    coordinates
  }, sender);
}

/** Loads the last saved scan coordinates and validates that they can still be reused. */
async function getSavedScanCoordinates(kind: ScanKind): Promise<SelectionCoordinates> {
  const settings = getScanSettings(kind);
  const data = await getStorage([settings.coordinateKey]);
  const coordinates = data[settings.coordinateKey];

  if (!isSavedCoordinatesUsable(coordinates)) {
    throw new Error(getMissingSavedCoordinatesMessage(kind));
  }

  return {
    startX: coordinates.startX,
    startY: coordinates.startY,
    width: coordinates.width,
    height: coordinates.height
  };
}

/** Injects the correct overlay script into a tab. */
async function injectOverlay(tabId: number, kind: ScanKind): Promise<void> {
  const settings = getScanSettings(kind);
  await ensureAuthenticated();
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [settings.overlayFile]
  });
}

/** Throws if the extension is not currently signed in to ChatGPT. */
async function ensureAuthenticated(): Promise<void> {
  if (!(await isLoggedIn())) {
    throw new Error('Please sign in with ChatGPT first.');
  }
}

/** Reports whether the extension has any stored auth credentials. */
async function isLoggedIn(): Promise<boolean> {
  const { accessToken, refreshToken } = await getStorage(['accessToken', 'refreshToken'] as const);
  return Boolean(accessToken || refreshToken);
}

/** Builds the popup status payload, refreshing rate-limit info when needed. */
async function getStatus(): Promise<StatusPayload> {
  let data = await getStorage(STATUS_STORAGE_KEYS);
  let normalizedLimitInfo = normalizeLimitInfo(data.limitInfo ?? null);

  if ((data.accessToken || data.refreshToken) && !hasRenderableLimitInfo(normalizedLimitInfo)) {
    try {
      const refreshedLimitInfo = await fetchLimitInfo(await getValidAccessContext());
      await setStorage({ limitInfo: refreshedLimitInfo });
      data = {
        ...data,
        limitInfo: refreshedLimitInfo
      };
      normalizedLimitInfo = normalizeLimitInfo(refreshedLimitInfo);
    } catch (error) {
      console.warn('Unable to load ChatGPT limit info for status.', error);
    }
  }

  const history = getNormalizedHistory(data.history, data.lastResponse);
  return {
    ok: true,
    loggedIn: Boolean(data.accessToken || data.refreshToken),
    accountEmail: data.accountEmail || '',
    requestCount: typeof data.requestCount === 'number' && Number.isInteger(data.requestCount) ? data.requestCount : 0,
    limitInfo: normalizedLimitInfo,
    expiresAt: data.expiresAt || null,
    lastResponse: data.lastResponse || '',
    history,
    historyIndex: getNormalizedHistoryIndex(data.historyIndex, history.length),
    textScanModel: normalizeStoredModel(data.textScanModel, data.textScanCustomModel),
    textScanCustomModel: data.textScanCustomModel || '',
    imageScanModel: normalizeStoredModel(data.imageScanModel, data.imageScanCustomModel),
    imageScanCustomModel: data.imageScanCustomModel || '',
    textSystemPromptPreset: normalizeSystemPromptPreset(data.textSystemPromptPreset, data.textCustomSystemPrompt),
    textCustomSystemPrompt: data.textCustomSystemPrompt || '',
    imageSystemPromptPreset: normalizeSystemPromptPreset(data.imageSystemPromptPreset, data.imageCustomSystemPrompt),
    imageCustomSystemPrompt: data.imageCustomSystemPrompt || '',
    authError: data.authError || ''
  };
}

/** Appends a new response to history while keeping the history list capped. */
async function addHistoryEntry(
  input: string,
  output: string,
  type: HistoryEntry['type'],
  inputImageDataUrl = ''
): Promise<void> {
  const data = await getStorage(['history'] as const);
  const nextHistory = [
    ...(Array.isArray(data.history) ? data.history : []),
    createHistoryEntry(input, output, type, inputImageDataUrl)
  ].slice(-HISTORY_LIMIT);
  await setStorage({
    history: nextHistory,
    historyIndex: nextHistory.length - 1
  });
}

/** Clears stored response history and resets the popup view. */
async function deleteHistory(): Promise<Result> {
  await removeStorage(['history', 'historyIndex', 'lastResponse']);
  broadcastRuntimeMessage({ action: 'responseUpdated', response: '' });
  return { ok: true };
}

/** Resolves the effective model for a scan mode from stored popup settings. */
async function getScanModel(kind: ScanKind): Promise<string> {
  const settings = getScanSettings(kind);
  const data = await getStorage([settings.modelKey, settings.customModelKey]);
  return resolveModelValue(data[settings.modelKey], data[settings.customModelKey]);
}

/** Resolves the effective system prompt for a scan mode from stored popup settings. */
async function getSystemPrompt(kind: ScanKind): Promise<string> {
  const settings = getScanSettings(kind);
  const data = await getStorage([settings.systemPromptPresetKey, settings.customSystemPromptKey]);
  return resolveSystemPrompt(data[settings.systemPromptPresetKey], data[settings.customSystemPromptKey], kind);
}

/** Persists the latest successful scan coordinates so the user can repeat them later. */
async function saveScanCoordinates(mode: ScanKind, coordinates: SelectionCoordinates): Promise<void> {
  const key = getScanSettings(mode).coordinateKey;
  const values: Partial<ExtensionStorage> = {
    [key]: {
      startX: coordinates.startX,
      startY: coordinates.startY,
      width: coordinates.width,
      height: coordinates.height,
      savedAt: Date.now()
    } satisfies SavedSelectionCoordinates
  };
  await setStorage(values);
}

/** Clears all stored auth and UI state, then refreshes menus and popup listeners. */
async function signOut(): Promise<Result> {
  await removeStorage(STORAGE_KEYS);
  await createContextMenus();
  broadcastRuntimeMessage({ action: 'authChanged' });
  return { ok: true };
}

/** Extracts the OAuth authorization code and state from the callback URL. */
function parseCallbackUrl(url: string): { code: string; state: string } {
  const parsed = new URL(url);
  return {
    code: parsed.searchParams.get('code') || '',
    state: parsed.searchParams.get('state') || ''
  };
}

/** Captures the visible tab bitmap for a given window. */
function captureVisibleTab(windowId: number): Promise<string> {
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

/** Opens a new active tab for the requested URL. */
function createTab(url: string): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create({ url, active: true });
}

/** Closes a tab while tolerating the user having already dismissed it. */
async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The user may have already closed the tab.
  }
}

/** Converts an unknown error into the standard extension error result shape. */
function toErrorResult(error: unknown): ErrorResult {
  return { ok: false, error: getErrorMessage(error) };
}

/** Checks whether a tab URL points at a normal web page that can receive the overlay. */
function isSupportedPageUrl(url = ''): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
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

/** Refreshes stored limit data while falling back to the previous cached snapshot on failure. */
async function refreshStoredLimitInfo(accessContext: AccessContext): Promise<StoredLimitInfo> {
  try {
    return await fetchLimitInfo(accessContext);
  } catch (error) {
    console.warn('Unable to refresh ChatGPT limit info.', error);
    return (await getStorage(['limitInfo'] as const)).limitInfo || null;
  }
}

/** Calls the ChatGPT usage endpoint and converts the response into popup-friendly limit info. */
async function fetchLimitInfo(accessContext: AccessContext): Promise<LimitInfo> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessContext.accessToken}`,
    originator: 'codex_cli_rs'
  };

  if (accessContext.chatgptAccountId) {
    headers['chatgpt-account-id'] = accessContext.chatgptAccountId;
  }

  const response = await fetch(CHATGPT_USAGE_URL, {
    method: 'GET',
    headers
  });

  if (!response.ok) {
    throw new Error(`ChatGPT limit check failed with status ${response.status}.`);
  }

  return createLimitInfoPayload(await response.json());
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
  if (!Array.isArray(snapshots)) {
    return [];
  }

  const items: LimitInfoItem[] = [];
  for (const snapshot of snapshots) {
    if (!hasRateLimitSnapshotData(snapshot)) {
      continue;
    }

    if (snapshot.primary) {
      const item = createLimitInfoItem(snapshot, snapshot.primary, 'primary');
      if (item) {
        items.push(item);
      }
    }

    if (snapshot.secondary) {
      const item = createLimitInfoItem(snapshot, snapshot.secondary, 'secondary');
      if (item) {
        items.push(item);
      }
    }
  }

  return items;
}

/** Builds one popup-friendly rate-limit row from a snapshot window. */
function createLimitInfoItem(
  snapshot: UsageRateLimitSnapshot,
  window: UsageRateLimitWindow,
  windowType: 'primary' | 'secondary'
): LimitInfoItem | null {
  if (window.resetsAt == null) {
    return null;
  }

  const usedPercent = roundLimitPercent(Math.max(0, window.usedPercent ?? 0));
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

/** Normalizes any stored limit payload into the latest popup-ready structure. */
function normalizeLimitInfo(limitInfo: StoredLimitInfo): LimitInfo | null {
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

/** Checks whether normalized limit info contains any value worth rendering in the popup. */
function hasRenderableLimitInfo(limitInfo: LimitInfo | null): boolean {
  return Boolean(limitInfo?.planName) || (Array.isArray(limitInfo?.items) && limitInfo.items.length > 0);
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

/** Generates a cryptographically random base64url string for PKCE values. */
function base64UrlRandom(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Creates the SHA-256 PKCE code challenge for the provided verifier. */
function createCodeChallenge(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  return crypto.subtle.digest('SHA-256', bytes).then(base64UrlEncode);
}

/** Encodes bytes into URL-safe base64 without padding. */
function base64UrlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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

/** Throws when a typed result object represents an error instead of success data. */
function unwrapResult<T extends object>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(result.error);
  }

  return result;
}

/** Converts unknown error values into readable fallback strings. */
function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
}

/** Coerces unknown values into safe record objects for defensive parsing. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
