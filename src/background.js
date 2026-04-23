importScripts('shared.js');

const {
  DEFAULT_MODEL,
  STORAGE_KEYS,
  STATUS_STORAGE_KEYS,
  TEXT_SOLVER_PROMPT,
  getScanSettings,
  normalizeScanKind,
  normalizeStoredModel,
  resolveModelValue,
  normalizeSystemPromptPreset,
  resolveSystemPrompt,
  createHistoryEntry,
  getNormalizedHistory,
  getNormalizedHistoryIndex,
  isSavedCoordinatesUsable,
  getMissingSavedCoordinatesMessage
} = globalThis.ChatGptChromeHelperShared;

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
};
const CONTEXT_MENU_ACTIONS = {
  login: () => startLogin(),
  ask: (info, tab) => {
    if (!tab?.id) {
      return null;
    }

    return processSelectedText(info.selectionText, tab.id);
  },
  textScanArea: (_, tab) => {
    if (!tab?.id) {
      return null;
    }

    return injectOverlay(tab.id, 'text');
  },
  imageScanArea: (_, tab) => {
    if (!tab?.id) {
      return null;
    }

    return injectOverlay(tab.id, 'image');
  }
};
const RUNTIME_MESSAGE_ACTIONS = {
  startLogin: () => startLogin(),
  signOut: () => signOut(),
  getStatus: () => getStatus(),
  deleteHistory: () => deleteHistory(),
  triggerTextScan: () => triggerActiveOverlay('text'),
  triggerImageScan: () => triggerActiveOverlay('image'),
  repeatTextScan: (_, sender) => repeatSavedScan('text', sender),
  repeatImageScan: (_, sender) => repeatSavedScan('image', sender),
  captureArea: (message, sender) => captureArea(message, sender)
};

chrome.runtime.onInstalled.addListener(() => {
  runBackgroundTask(createContextMenus(), 'Context menu installation');
});

chrome.runtime.onStartup.addListener(() => {
  runBackgroundTask(createContextMenus(), 'Context menu startup');
});

chrome.contextMenus.onClicked.addListener(handleContextMenuClick);
chrome.tabs.onUpdated.addListener(handleTabUpdated);
chrome.runtime.onMessage.addListener(handleRuntimeMessage);

async function createContextMenus() {
  const loggedIn = await isLoggedIn();
  await removeAllMenus();

  for (const item of getContextMenuItems(loggedIn)) {
    chrome.contextMenus.create(item);
  }
}

function getContextMenuItems(loggedIn) {
  return loggedIn ? CONTEXT_MENU_ITEMS.loggedIn : CONTEXT_MENU_ITEMS.loggedOut;
}

function removeAllMenus() {
  return new Promise((resolve) => chrome.contextMenus.removeAll(resolve));
}

function handleContextMenuClick(info, tab) {
  const handler = CONTEXT_MENU_ACTIONS[info.menuItemId];
  if (!handler) {
    return;
  }

  runBackgroundTask(handler(info, tab), `Context menu "${info.menuItemId}"`);
}

function handleTabUpdated(tabId, changeInfo) {
  if (!changeInfo.url || !changeInfo.url.startsWith(CHATGPT_REDIRECT_URI)) {
    return;
  }

  runBackgroundTask(handleOAuthCallback(changeInfo.url, tabId), 'OAuth callback');
}

function handleRuntimeMessage(message, sender, sendResponse) {
  const handler = RUNTIME_MESSAGE_ACTIONS[message?.action];
  if (!handler) {
    return false;
  }

  respondWithResult(sendResponse, handler(message, sender));
  return true;
}

function runBackgroundTask(task, label) {
  Promise.resolve(task).catch((error) => {
    console.error(`${label} failed.`, error);
  });
}

function respondWithResult(sendResponse, task) {
  Promise.resolve(task)
    .then(sendResponse)
    .catch((error) => sendResponse(toErrorResult(error)));
}

async function startLogin() {
  const verifier = base64UrlRandom(32);
  const state = base64UrlRandom(16);
  const challenge = await createCodeChallenge(verifier);
  const authorizationUrl = buildAuthorizationUrl(state, challenge);

  const tab = await createTab(authorizationUrl);
  await setStorage({
    pendingOAuth: {
      state,
      verifier,
      tabId: tab.id,
      startedAt: Date.now()
    }
  });

  return { ok: true };
}

async function handleOAuthCallback(callbackUrl, tabId) {
  const { pendingOAuth } = await getStorage(['pendingOAuth']);
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
    await chrome.storage.local.remove('pendingOAuth');
    await createContextMenus();
    await closeTab(tabId);
    broadcast({ action: 'authChanged' });
  } catch (error) {
    await finishOAuthError(error.message || 'ChatGPT login failed.');
  }
}

async function finishOAuthError(message) {
  await chrome.storage.local.remove('pendingOAuth');
  await setStorage({ authError: message });
  broadcast({ action: 'authChanged', error: message });
}

function buildAuthorizationUrl(state, challenge) {
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

async function exchangeAuthorizationCode(code, verifier) {
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

async function refreshAccessToken(refreshToken) {
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

function parseTokenResponse(data) {
  if (!data?.access_token || !data?.refresh_token || !data?.expires_in) {
    throw new Error('ChatGPT returned an invalid token response.');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000
  };
}

async function persistTokenResult(tokenResult) {
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

function createAccessContextFromAccessToken(accessToken) {
  return {
    accessToken,
    chatgptAccountId: readJwtClaim(accessToken, ['https://api.openai.com/auth', 'chatgpt_account_id'])
  };
}

async function getValidAccessContext() {
  const stored = await getStorage(['accessToken', 'refreshToken', 'expiresAt', 'chatgptAccountId']);
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

async function callChatGpt({ prompt, imageDataUrl, model = DEFAULT_MODEL, instructions = TEXT_SOLVER_PROMPT, responseStyle = 'medium' }) {
  const accessContext = await getValidAccessContext();
  const content = [{ type: 'input_text', text: prompt }];
  if (imageDataUrl) {
    content.push({ type: 'input_image', image_url: imageDataUrl });
  }

  const headers = {
    'Accept': 'text/event-stream',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessContext.accessToken}`,
    'OpenAI-Beta': 'responses=experimental',
    'originator': 'codex_cli_rs'
  };

  if (accessContext.chatgptAccountId) {
    headers['chatgpt-account-id'] = accessContext.chatgptAccountId;
  }

  const payload = {
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
    reasoning: { effort: 'medium', summary: 'auto' }
  };

  payload.instructions = instructions || '.';

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

  return finalizeChatGptResponse(extractCompletedText(JSON.parse(bodyText)), accessContext);
}

async function readResponseStream(response) {
  if (!response.body) {
    return extractCompletedText(await response.json());
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

function parseSseText(bodyText) {
  const accumulator = createResponseAccumulator();

  for (const line of bodyText.split(/\r?\n/)) {
    appendSseLine(accumulator, line);
  }

  return finalizeResponseAccumulator(accumulator);
}

function createResponseAccumulator() {
  return {
    text: '',
    completedText: ''
  };
}

function appendSseLine(accumulator, line) {
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

function finalizeResponseAccumulator(accumulator) {
  return (accumulator.text || accumulator.completedText || 'No response text was returned.').trim();
}

function parseSsePayload(payload) {
  try {
    const event = JSON.parse(payload);
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

function extractCompletedText(root) {
  const response = root?.response || root;
  if (!Array.isArray(response?.output)) {
    return '';
  }

  const parts = [];
  for (const item of response.output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) {
      continue;
    }

    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }

  return parts.join('').trim();
}

async function processSelectedText(selectionText, tabId) {
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
    await publishResponse(tabId, `Error: ${error.message}`, 'error', text);
  }
}

function buildAskPrompt(text) {
  return `Answer this as directly and briefly as possible. For math, solve it. For multiple choice, give the correct option and a short reason.\n\n${text}`;
}

async function captureArea(message, sender) {
  if (!sender?.tab?.id) {
    throw new Error('No active tab was available for capture.');
  }

  const kind = normalizeScanKind(message.mode);
  const settings = getScanSettings(kind);
  const tabId = sender.tab.id;
  let requestData = {
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
      `Error: ${error.message}`,
      'error',
      requestData.historyInput,
      requestData.historyImageDataUrl
    );
    return toErrorResult(error);
  }
}

function buildScanRequestData(kind, imageData) {
  const croppedImageUri = imageData?.croppedImageUri || '';
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

  const extractedText = (imageData?.extractedText || '').trim();
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

function buildTextScanPrompt(text) {
  return `Answer the text extracted from the selected area. For math, solve it. Keep the answer concise.\n\n${text}`;
}

async function extractCapturedScanRequestData({ tabId, windowId, kind, coordinates }) {
  const settings = getScanSettings(kind);
  const imageUri = await captureVisibleTab(windowId);
  const imageData = await sendMessageToTab(tabId, {
    action: settings.captureAction,
    imageUri,
    coordinates
  });
  return buildScanRequestData(kind, imageData);
}

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
}) {
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

async function publishResponse(tabId, response, type, input = '', inputImageDataUrl = '') {
  await setStorage({ lastResponse: response });
  await addHistoryEntry(input, response, type, inputImageDataUrl);
  broadcast({ action: 'responseUpdated', response });
  await sendPageResponse(tabId, response, type);
  showActionBadge();
}

function showActionBadge() {
  chrome.action.setBadgeText({ text: RESPONSE_BADGE_TEXT });
  chrome.action.setBadgeBackgroundColor({ color: RESPONSE_BADGE_COLOR });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), RESPONSE_BADGE_DURATION_MS);
}

async function sendPageResponse(tabId, response, type) {
  try {
    await sendMessageToTab(tabId, {
      action: 'displayResponse',
      response,
      type
    });
  } catch (error) {
    console.warn('Unable to send response to content script.', error);
  }
}

async function triggerActiveOverlay(kind) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isSupportedPageUrl(tab.url)) {
    throw new Error('Open a regular web page first.');
  }

  await ensureAuthenticated();
  await injectOverlay(tab.id, kind);
  return { ok: true };
}

async function repeatSavedScan(kind, sender) {
  if (!sender?.tab?.id) {
    throw new Error('No active tab was available for repeat scan.');
  }

  const coordinates = await getSavedScanCoordinates(kind);
  return captureArea({
    mode: kind,
    coordinates
  }, sender);
}

async function getSavedScanCoordinates(kind) {
  const settings = getScanSettings(kind);
  const {
    [settings.coordinateKey]: coordinates
  } = await getStorage([settings.coordinateKey]);

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

async function injectOverlay(tabId, kind) {
  const settings = getScanSettings(kind);
  await ensureAuthenticated();
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['shared.js', 'areaOverlay.js', settings.overlayFile]
  });
}

async function ensureAuthenticated() {
  if (!(await isLoggedIn())) {
    throw new Error('Please sign in with ChatGPT first.');
  }
}

async function isLoggedIn() {
  const { accessToken, refreshToken } = await getStorage(['accessToken', 'refreshToken']);
  return Boolean(accessToken || refreshToken);
}

async function getStatus() {
  let data = await getStorage(STATUS_STORAGE_KEYS);
  let normalizedLimitInfo = normalizeLimitInfo(data.limitInfo);

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
    requestCount: Number.isInteger(data.requestCount) ? data.requestCount : 0,
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

async function addHistoryEntry(input, output, type, inputImageDataUrl = '') {
  const data = await getStorage(['history']);
  const nextHistory = [
    ...(Array.isArray(data.history) ? data.history : []),
    createHistoryEntry(input, output, type, inputImageDataUrl)
  ].slice(-HISTORY_LIMIT);
  await setStorage({
    history: nextHistory,
    historyIndex: nextHistory.length - 1
  });
}

async function deleteHistory() {
  await chrome.storage.local.remove(['history', 'historyIndex', 'lastResponse']);
  broadcast({ action: 'responseUpdated', response: '' });
  return { ok: true };
}

async function getScanModel(kind) {
  const settings = getScanSettings(kind);
  const {
    [settings.modelKey]: selectedModel,
    [settings.customModelKey]: customModel
  } = await getStorage([settings.modelKey, settings.customModelKey]);
  return resolveModelValue(selectedModel, customModel);
}

async function getSystemPrompt(kind) {
  const settings = getScanSettings(kind);
  const {
    [settings.systemPromptPresetKey]: preset,
    [settings.customSystemPromptKey]: customPrompt
  } = await getStorage([settings.systemPromptPresetKey, settings.customSystemPromptKey]);
  return resolveSystemPrompt(preset, customPrompt, kind);
}

async function saveScanCoordinates(mode, coordinates) {
  const key = getScanSettings(mode).coordinateKey;
  await setStorage({
    [key]: {
      startX: coordinates.startX,
      startY: coordinates.startY,
      width: coordinates.width,
      height: coordinates.height,
      savedAt: Date.now()
    }
  });
}

async function signOut() {
  await chrome.storage.local.remove(STORAGE_KEYS);
  await createContextMenus();
  broadcast({ action: 'authChanged' });
  return { ok: true };
}

function parseCallbackUrl(url) {
  const parsed = new URL(url);
  return {
    code: parsed.searchParams.get('code') || '',
    state: parsed.searchParams.get('state') || ''
  };
}

function captureVisibleTab(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

function createTab(url) {
  return chrome.tabs.create({ url, active: true });
}

async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The user may have already closed the tab.
  }
}

function sendMessageToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

function setStorage(values) {
  return chrome.storage.local.set(values);
}

function toErrorResult(error) {
  return { ok: false, error: error?.message || String(error) };
}

function isSupportedPageUrl(url = '') {
  return url.startsWith('http://') || url.startsWith('https://');
}

async function finalizeChatGptResponse(textOrPromise, accessContext) {
  const text = await Promise.resolve(textOrPromise);
  await maybeRefreshLimitInfo(accessContext);
  return text;
}

async function maybeRefreshLimitInfo(accessContext) {
  const { requestCount = 0 } = await getStorage(['requestCount']);
  const nextCount = Number.isInteger(requestCount) ? requestCount + 1 : 1;
  const shouldRefresh = nextCount === 1 || nextCount % LIMIT_REFRESH_INTERVAL === 0;
  const values = { requestCount: nextCount };

  if (shouldRefresh) {
    values.limitInfo = await refreshStoredLimitInfo(accessContext);
  }

  await setStorage(values);
  if (shouldRefresh) {
    broadcast({ action: 'responseUpdated' });
  }
}

async function refreshStoredLimitInfo(accessContext) {
  try {
    return await fetchLimitInfo(accessContext);
  } catch (error) {
    console.warn('Unable to refresh ChatGPT limit info.', error);
    return (await getStorage(['limitInfo'])).limitInfo || null;
  }
}

async function fetchLimitInfo(accessContext) {
  const headers = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${accessContext.accessToken}`,
    'originator': 'codex_cli_rs'
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

function parseUsageRateLimitPayload(payload) {
  const snapshots = [
    createUsageRateLimitSnapshot({
      limitId: DEFAULT_LIMIT_ID,
      limitName: '',
      rateLimit: payload?.rate_limit
    })
  ];

  const additional = Array.isArray(payload?.additional_rate_limits) ? payload.additional_rate_limits : [];
  for (const item of additional) {
    snapshots.push(createUsageRateLimitSnapshot({
      limitId: item?.metered_feature || item?.limit_name || '',
      limitName: item?.limit_name || '',
      rateLimit: item?.rate_limit
    }));
  }

  const codeReviewSnapshot = createUsageRateLimitSnapshot({
    limitId: 'code_review',
    limitName: 'Code Review',
    rateLimit: payload?.code_review_rate_limit
  });
  if (hasRateLimitSnapshotData(codeReviewSnapshot)) {
    snapshots.push(codeReviewSnapshot);
  }

  return snapshots;
}

function createUsageRateLimitSnapshot({ limitId, limitName, rateLimit }) {
  return {
    limitId: normalizeLimitId(limitId || DEFAULT_LIMIT_ID),
    limitName: normalizeOptionalString(limitName),
    primary: parseUsageRateLimitWindow(rateLimit?.primary_window),
    secondary: parseUsageRateLimitWindow(rateLimit?.secondary_window)
  };
}

function parseUsageRateLimitWindow(window) {
  const usedPercent = tryGetNumber(window?.used_percent);
  const windowDurationMins = tryGetWindowDurationMins(window);
  const resetsAt = tryGetInt(window?.reset_at);
  const hasData = usedPercent != null || windowDurationMins != null || resetsAt != null;

  if (!hasData) {
    return null;
  }

  return {
    usedPercent: roundLimitPercent(Math.max(0, usedPercent ?? 0)),
    windowDurationMins,
    resetsAt
  };
}

function hasRateLimitSnapshotData(snapshot) {
  return Boolean(snapshot?.primary || snapshot?.secondary);
}

function createLimitInfoPayload(payload) {
  return {
    planName: extractPlanName(payload),
    items: createLimitInfoItems(parseUsageRateLimitPayload(payload))
  };
}

function createLimitInfoItems(snapshots) {
  if (!Array.isArray(snapshots)) {
    return [];
  }

  const items = [];
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

  return items.filter(Boolean);
}

function createLimitInfoItem(snapshot, window, windowType) {
  if (!window || window.resetsAt == null) {
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

function getLimitWindowLabel(windowDurationMins) {
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

function getLimitDisplayName(snapshot) {
  if (snapshot?.limitName) {
    return snapshot.limitName;
  }

  if (!snapshot?.limitId || snapshot.limitId === DEFAULT_LIMIT_ID) {
    return '';
  }

  return prettifyLimitId(snapshot.limitId);
}

function prettifyLimitId(value) {
  return String(value || DEFAULT_LIMIT_ID)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Limit';
}

function normalizeLimitId(value) {
  return String(value || DEFAULT_LIMIT_ID).trim().toLowerCase().replace(/-/g, '_') || DEFAULT_LIMIT_ID;
}

function normalizeOptionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function tryGetWindowDurationMins(window) {
  const rawSeconds = tryGetInt(window?.limit_window_seconds);
  if (rawSeconds == null || rawSeconds <= 0) {
    return null;
  }

  return Math.ceil(rawSeconds / 60);
}

function tryGetInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }

  return null;
}

function tryGetNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function roundLimitPercent(value) {
  return Number(value.toFixed(LIMIT_PERCENT_PRECISION));
}

function normalizeLimitInfo(limitInfo) {
  if (!limitInfo || typeof limitInfo !== 'object') {
    return null;
  }

  const planName = normalizePlanName(
    limitInfo.planName
    || limitInfo.plan
    || limitInfo.planType
    || limitInfo.subscriptionPlan
  );
  const items = Array.isArray(limitInfo.items)
    ? limitInfo.items.map(normalizeLimitInfoItem).filter(Boolean)
    : [];

  if (items.length > 0 || planName) {
    return {
      planName,
      items
    };
  }

  return normalizeLegacyLimitInfo(limitInfo);
}

function normalizeLegacyLimitInfo(limitInfo) {
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

function normalizeLimitInfoItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const leftPercent = tryGetNumber(item.leftPercent);
  const resetsAt = tryGetInt(item.resetsAt);
  const windowDurationMins = tryGetInt(item.windowDurationMins);
  if (leftPercent == null || resetsAt == null || windowDurationMins == null) {
    return null;
  }

  const normalizedLimitId = normalizeLimitId(item.limitId);
  let featureLabel = normalizeOptionalString(item.featureLabel);
  if (normalizedLimitId === DEFAULT_LIMIT_ID && featureLabel.toLowerCase() === prettifyLimitId(DEFAULT_LIMIT_ID).toLowerCase()) {
    featureLabel = '';
  }

  return {
    id: normalizeOptionalString(item.id) || `${DEFAULT_LIMIT_ID}:${windowDurationMins}:item`,
    featureLabel: featureLabel || (normalizedLimitId === DEFAULT_LIMIT_ID ? '' : prettifyLimitId(normalizedLimitId)),
    windowLabel: normalizeOptionalString(item.windowLabel) || getLimitWindowLabel(windowDurationMins),
    leftPercent: roundLimitPercent(leftPercent),
    usedPercent: roundLimitPercent(tryGetNumber(item.usedPercent) ?? Math.max(0, 100 - leftPercent)),
    resetsAt,
    windowDurationMins,
    limitId: normalizedLimitId
  };
}

function hasRenderableLimitInfo(limitInfo) {
  return Boolean(limitInfo?.planName) || (Array.isArray(limitInfo?.items) && limitInfo.items.length > 0);
}

function extractPlanName(payload) {
  const directCandidates = [
    payload?.plan,
    payload?.plan_name,
    payload?.plan_type,
    payload?.planType,
    payload?.subscription_plan,
    payload?.subscriptionPlan,
    payload?.subscription_tier,
    payload?.subscriptionTier,
    payload?.account_plan,
    payload?.accountPlan,
    payload?.tier,
    payload?.workspace?.plan,
    payload?.workspace?.plan_name,
    payload?.workspace?.plan_type,
    payload?.workspace?.subscription_plan,
    payload?.organization?.plan,
    payload?.organization?.plan_name,
    payload?.organization?.plan_type,
    payload?.org?.plan,
    payload?.org?.plan_name,
    payload?.org?.plan_type,
    payload?.account?.plan,
    payload?.account?.plan_name,
    payload?.account?.plan_type,
    payload?.subscription?.plan,
    payload?.subscription?.plan_name,
    payload?.subscription?.plan_type,
    payload?.user?.plan,
    payload?.user?.plan_name,
    payload?.user?.plan_type
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizePlanName(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return findPlanNameRecursively(payload);
}

function findPlanNameRecursively(value, depth = 0) {
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

function normalizePlanName(value) {
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

function base64UrlRandom(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function createCodeChallenge(verifier) {
  const bytes = new TextEncoder().encode(verifier);
  return crypto.subtle.digest('SHA-256', bytes).then(base64UrlEncode);
}

function base64UrlEncode(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function readJwtClaim(token, path) {
  if (!token || !Array.isArray(path)) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=')));
    let current = payload;
    for (const key of path) {
      current = current?.[key];
      if (current == null) {
        return null;
      }
    }
    return typeof current === 'string' ? current : null;
  } catch {
    return null;
  }
}
