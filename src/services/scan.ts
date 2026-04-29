/** Coordinates scan capture flows, ChatGPT requests, and page response publication. */
import {
  getMissingSavedCoordinatesMessage,
  getScanSettings,
  isSavedCoordinatesUsable,
  normalizeScanKind
} from '../common/scanSettings';
import { broadcastRuntimeMessage, sendTabMessage } from '../common/messages';
import { getStorage, setStorage } from '../common/storage';
import { getErrorMessage, toErrorResult, unwrapResult } from '../common/safe';
import { callChatGpt } from './chatgpt';
import { ensureAuthenticated } from './auth';
import { addHistoryEntry } from './history';
import { getScanModel, getScanThinkingVariant, getSystemPrompt } from './status';
import { captureVisibleTab, isSupportedPageUrl } from '../background/tabs';
import type {
  CaptureAreaRequest,
  CropImagePayload,
  ExtensionStorage,
  HistoryEntry,
  OcrImagePayload,
  PageResponseType,
  Result,
  SavedSelectionCoordinates,
  ScanKind,
  SelectionCoordinates,
  SubmitManualInputRequest
} from '../common/types';

const RESPONSE_BADGE_COLOR = '#2563eb';
const RESPONSE_BADGE_TEXT = '1';
const RESPONSE_BADGE_DURATION_MS = 8000;
const ASK_RESPONSE_STYLE = 'low';

interface RequestAndPublishOptions {
  tabId?: number | null;
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

/** Sends selected page text to ChatGPT using the lightweight ask flow. */
export async function processSelectedText(selectionText: string | undefined, tabId: number): Promise<void> {
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

/** Captures a user-selected page area, extracts the request payload, and publishes the answer. */
export async function captureArea(message: CaptureAreaRequest, sender: chrome.runtime.MessageSender): Promise<Result> {
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

/** Starts the overlay flow on the active tab after validating the page and auth state. */
export async function triggerActiveOverlay(kind: ScanKind): Promise<Result> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isSupportedPageUrl(tab.url)) {
    throw new Error('Open a regular web page first.');
  }

  await ensureAuthenticated();
  await injectOverlay(tab.id, kind);
  return { ok: true };
}

/** Sends text or pasted image input from the popup to ChatGPT without requiring an active tab. */
export async function submitManualInput(message: SubmitManualInputRequest): Promise<Result> {
  await ensureAuthenticated();
  const text = String(message.text || '').trim();
  const imageDataUrl = String(message.imageDataUrl || '').trim();
  const kind: ScanKind = imageDataUrl ? 'image' : 'text';

  if (!text && !imageDataUrl) {
    throw new Error('Enter text or add an image first.');
  }

  await requestAndPublishResponse({
    tabId: null,
    prompt: imageDataUrl ? text || '.' : text,
    imageDataUrl: imageDataUrl || null,
    kind,
    historyType: kind,
    historyInput: text,
    historyImageDataUrl: imageDataUrl,
    responseStyle: getScanSettings(kind).responseStyle,
    statusMessage: ''
  });

  return { ok: true };
}

/** Repeats the last saved scan coordinates for the requested mode. */
export async function repeatSavedScan(kind: ScanKind, sender: chrome.runtime.MessageSender): Promise<Result> {
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

/** Injects the correct overlay script into a tab. */
export async function injectOverlay(tabId: number, kind: ScanKind): Promise<void> {
  const settings = getScanSettings(kind);
  await ensureAuthenticated();
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [settings.overlayFile]
  });
}

/** Builds the direct-answer prompt used for context-menu text questions. */
function buildAskPrompt(text: string): string {
  return `Answer this as directly and briefly as possible. For math, solve it. For multiple choice, give the correct option and a short reason.\n\n${text}`;
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
    const result = await sendTabMessage(tabId, {
      action: 'ocrImage',
      imageUri,
      coordinates
    });
    return buildScanRequestData(kind, unwrapResult(result));
  }

  const result = await sendTabMessage(tabId, {
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
  if (statusMessage && tabId != null) {
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
  tabId: number | null | undefined,
  response: string,
  type: PageResponseType,
  input = '',
  inputImageDataUrl = ''
): Promise<void> {
  await setStorage({ lastResponse: response });
  await addHistoryEntry(input, response, type === 'error' || type === 'status' ? 'ask' : type, inputImageDataUrl);
  broadcastRuntimeMessage({ action: 'responseUpdated', response });
  if (tabId != null) {
    await sendPageResponse(tabId, response, type);
  }
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
