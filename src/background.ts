/** Coordinates authentication, capture flows, ChatGPT requests, and extension-wide state updates. */
import {
  STATUS_STORAGE_KEYS,
  STORAGE_KEYS,
  createHistoryEntry,
  getMissingSavedCoordinatesMessage,
  getNormalizedHistory,
  getNormalizedHistoryIndex,
  getScanSettings,
  isSavedCoordinatesUsable,
  normalizeAvailableModelsCatalog,
  normalizeThinkingVariant,
  normalizeScanKind,
  normalizeStoredModel,
  normalizeSystemPromptPreset,
  resolveModelValue,
  resolveSystemPrompt
} from './lib/shared';
import { broadcastRuntimeMessage, isRuntimeRequest, sendTabMessage, type RuntimeResponse } from './lib/messages';
import { getStorage, removeStorage, setStorage } from './lib/storage';
import {
  CHATGPT_REDIRECT_URI,
  buildAuthorizationUrl,
  callChatGpt,
  createAccessContextFromAccessToken,
  exchangeAuthorizationCode,
  fetchAvailableModels,
  fetchCodexClientVersion,
  fetchLimitInfo,
  getDefaultCodexClientVersion,
  getValidAccessContext,
  hasRenderableLimitInfo,
  normalizeLimitInfo,
  persistTokenResult,
  refreshStoredLimitInfo
} from './background/chatgptClient';
import { base64UrlRandom, createCodeChallenge } from './background/pkce';
import { getErrorMessage, toErrorResult, unwrapResult } from './lib/safe';
import type {
  AvailableModel,
  CaptureAreaRequest,
  CropImagePayload,
  ExtensionStorage,
  HistoryEntry,
  OcrImagePayload,
  PageResponseType,
  PendingOAuth,
  Result,
  RuntimeRequest,
  SavedSelectionCoordinates,
  ScanKind,
  SelectionCoordinates,
  StatusPayload,
  ThinkingVariant
} from './lib/types';

const HISTORY_LIMIT = 50;
const RESPONSE_BADGE_COLOR = '#2563eb';
const RESPONSE_BADGE_TEXT = '1';
const RESPONSE_BADGE_DURATION_MS = 8000;
const ASK_RESPONSE_STYLE = 'low';

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
    case 'refreshModels':
      return refreshModels();
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
    const accessContext = createAccessContextFromAccessToken(tokenResult.accessToken);
    const valuesToStore: Partial<ExtensionStorage> = {
      limitInfo: await refreshStoredLimitInfo(accessContext)
    };
    try {
      const refreshedModels = await fetchLatestModelsData(accessContext);
      valuesToStore.availableModels = refreshedModels.availableModels;
      valuesToStore.codexClientVersion = refreshedModels.clientVersion;
    } catch (error) {
      console.warn('Unable to load ChatGPT models after login.', error);
    }
    await setStorage(valuesToStore);
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

  const [model, reasoningEffort, instructions] = await Promise.all([
    getScanModel(kind),
    getScanThinkingVariant(kind),
    getSystemPrompt(kind)
  ]);
  const answer = await callChatGpt({
    prompt,
    imageDataUrl,
    model,
    reasoningEffort,
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
  let availableModels = normalizeAvailableModelsCatalog(data.availableModels);
  let codexClientVersion = typeof data.codexClientVersion === 'string' && data.codexClientVersion.trim()
    ? data.codexClientVersion
    : getDefaultCodexClientVersion();

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

  if ((data.accessToken || data.refreshToken) && availableModels.length === 0) {
    try {
      const refreshedModels = await fetchLatestModelsData(await getValidAccessContext());
      await setStorage({
        availableModels: refreshedModels.availableModels,
        codexClientVersion: refreshedModels.clientVersion
      });
      availableModels = refreshedModels.availableModels;
      codexClientVersion = refreshedModels.clientVersion;
    } catch (error) {
      console.warn('Unable to load ChatGPT models for status.', error);
    }
  }

  const history = getNormalizedHistory(data.history, data.lastResponse);
  return {
    ok: true,
    loggedIn: Boolean(data.accessToken || data.refreshToken),
    accountEmail: data.accountEmail || '',
    requestCount: typeof data.requestCount === 'number' && Number.isInteger(data.requestCount) ? data.requestCount : 0,
    limitInfo: normalizedLimitInfo,
    availableModels,
    codexClientVersion,
    expiresAt: data.expiresAt || null,
    lastResponse: data.lastResponse || '',
    history,
    historyIndex: getNormalizedHistoryIndex(data.historyIndex, history.length),
    textScanModel: normalizeStoredModel(data.textScanModel, data.textScanCustomModel, availableModels),
    textScanCustomModel: data.textScanCustomModel || '',
    textScanThinkingVariant: getStatusThinkingVariant('text', data, availableModels),
    imageScanModel: normalizeStoredModel(data.imageScanModel, data.imageScanCustomModel, availableModels),
    imageScanCustomModel: data.imageScanCustomModel || '',
    imageScanThinkingVariant: getStatusThinkingVariant('image', data, availableModels),
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
  const scanSettingsState = await getStoredScanSettings(kind);
  return resolveModelValue(
    scanSettingsState.storedModel,
    scanSettingsState.storedCustomModel,
    scanSettingsState.availableModels
  );
}

/** Resolves the effective thinking variant for a scan mode from stored popup settings. */
async function getScanThinkingVariant(kind: ScanKind): Promise<ThinkingVariant> {
  const scanSettingsState = await getStoredScanSettings(kind);
  const selectedModel = resolveModelValue(scanSettingsState.storedModel, '', scanSettingsState.availableModels);
  return normalizeThinkingVariant(scanSettingsState.storedThinkingVariant, selectedModel, scanSettingsState.availableModels);
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

/** Refreshes the remote model catalog on demand for the popup refresh buttons. */
async function refreshModels(): Promise<Result> {
  const refreshedModels = await fetchLatestModelsData(await getValidAccessContext());
  await setStorage({
    availableModels: refreshedModels.availableModels,
    codexClientVersion: refreshedModels.clientVersion
  });
  broadcastRuntimeMessage({ action: 'responseUpdated' });
  return { ok: true };
}

/** Loads the latest npm-published Codex version, then fetches the matching model catalog. */
async function fetchLatestModelsData(accessContext: ReturnType<typeof createAccessContextFromAccessToken>): Promise<{
  availableModels: AvailableModel[];
  clientVersion: string;
}> {
  let clientVersion = getDefaultCodexClientVersion();
  try {
    clientVersion = await fetchCodexClientVersion();
  } catch (error) {
    console.warn('Unable to load Codex client version from npm.', error);
  }

  return {
    availableModels: normalizeAvailableModelsCatalog(await fetchAvailableModels(accessContext, clientVersion)),
    clientVersion
  };
}

/** Resolves a valid thinking variant for status payloads. */
function getStatusThinkingVariant(kind: ScanKind, data: Partial<ExtensionStorage>, availableModels: AvailableModel[]): ThinkingVariant {
  const settings = getScanSettings(kind);
  const selectedModel = normalizeStoredModel(data[settings.modelKey], data[settings.customModelKey], availableModels);
  return normalizeThinkingVariant(data[settings.thinkingVariantKey], selectedModel, availableModels);
}

interface StoredScanSettingsState {
  availableModels: AvailableModel[];
  storedModel: unknown;
  storedCustomModel: unknown;
  storedThinkingVariant: unknown;
}

/** Reads one scan mode's stored model selection state with normalized available models. */
async function getStoredScanSettings(kind: ScanKind): Promise<StoredScanSettingsState> {
  const settings = getScanSettings(kind);
  const data = await getStorage([settings.modelKey, settings.customModelKey, settings.thinkingVariantKey, 'availableModels']);
  return {
    availableModels: normalizeAvailableModelsCatalog(data.availableModels),
    storedModel: data[settings.modelKey],
    storedCustomModel: data[settings.customModelKey],
    storedThinkingVariant: data[settings.thinkingVariantKey]
  };
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

/** Checks whether a tab URL points at a normal web page that can receive the overlay. */
function isSupportedPageUrl(url = ''): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}
