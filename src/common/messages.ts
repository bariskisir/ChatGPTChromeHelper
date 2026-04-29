/** Centralizes runtime and tab message typing plus small transport helpers. */
import type {
  CaptureAreaRequest,
  CropImageMessage,
  CropImageResult,
  DisplayResponseMessage,
  ErrorResult,
  OcrImageResult,
  OcrImageMessage,
  Result,
  RuntimeEventMessage,
  RuntimeRequest,
  StatusPayload,
  SubmitManualInputRequest,
  TabMessage
} from './types';

export type RuntimeResponse = Result | StatusPayload;
export type TabResponse = Result | CropImageResult | OcrImageResult;

export interface RuntimeResponseByAction {
  startLogin: Result;
  signOut: Result;
  getStatus: StatusPayload | ErrorResult;
  deleteHistory: Result;
  refreshModels: Result;
  refreshLimits: Result;
  triggerTextScan: Result;
  triggerImageScan: Result;
  repeatTextScan: Result;
  repeatImageScan: Result;
  captureArea: Result;
  submitManualInput: Result;
}

export interface TabResponseByAction {
  displayResponse: Result;
  cropImage: CropImageResult;
  ocrImage: OcrImageResult;
}

type RuntimeResponseFor<TRequest extends RuntimeRequest> = RuntimeResponseByAction[TRequest['action']];
type TabResponseFor<TMessage extends TabMessage> = TabResponseByAction[TMessage['action']];

/** Checks whether an unknown payload matches the supported runtime request actions. */
export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  const candidate = getActionRecord(value);
  if (!candidate) {
    return false;
  }

  switch (candidate.action) {
    case 'startLogin':
    case 'signOut':
    case 'getStatus':
    case 'deleteHistory':
    case 'refreshModels':
    case 'refreshLimits':
    case 'triggerTextScan':
    case 'triggerImageScan':
    case 'repeatTextScan':
    case 'repeatImageScan':
      return true;
    case 'captureArea':
      return isCaptureAreaRequest(candidate);
    case 'submitManualInput':
      return isSubmitManualInputRequest(candidate);
    default:
      return false;
  }
}

/** Checks whether an unknown payload matches the supported runtime event actions. */
export function isRuntimeEventMessage(value: unknown): value is RuntimeEventMessage {
  return hasAction(value, ['authChanged', 'responseUpdated']);
}

/** Checks whether an unknown payload matches the supported tab message actions. */
export function isTabMessage(value: unknown): value is TabMessage {
  const candidate = getActionRecord(value);
  if (!candidate) {
    return false;
  }

  switch (candidate.action) {
    case 'displayResponse':
      return isDisplayResponseMessage(candidate);
    case 'cropImage':
      return isImageWorkMessage(candidate);
    case 'ocrImage':
      return isImageWorkMessage(candidate);
    default:
      return false;
  }
}

/** Sends a typed message to the extension runtime. */
export async function sendRuntimeMessage<TRequest extends RuntimeRequest>(
  message: TRequest
): Promise<RuntimeResponseFor<TRequest>> {
  return chrome.runtime.sendMessage(message) as Promise<RuntimeResponseFor<TRequest>>;
}

/** Sends a typed message to a content script running in a tab. */
export async function sendTabMessage<TMessage extends TabMessage>(
  tabId: number,
  message: TMessage
): Promise<TabResponseFor<TMessage>> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<TabResponseFor<TMessage>>;
}

/** Broadcasts lightweight runtime events without failing the caller on delivery errors. */
export function broadcastRuntimeMessage(message: RuntimeEventMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

/** Validates that a message object exposes one of the expected action names. */
function hasAction(value: unknown, actions: readonly string[]): boolean {
  const candidate = getActionRecord(value);
  return Boolean(candidate && actions.includes(candidate.action));
}

/** Returns an object with a string action when the payload has the expected base shape. */
function getActionRecord(value: unknown): (Record<string, unknown> & { action: string }) | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as { action?: unknown };
  return typeof candidate.action === 'string'
    ? value as Record<string, unknown> & { action: string }
    : null;
}

/** Validates the capture-area payload sent by selection overlays. */
function isCaptureAreaRequest(value: unknown): value is CaptureAreaRequest {
  const candidate = toLooseRecord(value);
  return (candidate.mode === 'text' || candidate.mode === 'image')
    && isSelectionCoordinates(candidate.coordinates);
}

/** Validates manual text/image input submitted from the popup. */
function isSubmitManualInputRequest(value: unknown): value is SubmitManualInputRequest {
  const candidate = toLooseRecord(value);
  return typeof candidate.text === 'string'
    && (candidate.imageDataUrl == null || isImageDataUrl(candidate.imageDataUrl));
}

/** Validates a display response message sent from the background script. */
function isDisplayResponseMessage(value: unknown): value is DisplayResponseMessage {
  const candidate = toLooseRecord(value);
  return typeof candidate.response === 'string'
    && (
      candidate.type === 'text'
      || candidate.type === 'image'
      || candidate.type === 'ask'
      || candidate.type === 'status'
      || candidate.type === 'error'
    );
}

/** Validates crop and OCR messages sent to the content script. */
function isImageWorkMessage(value: unknown): value is CropImageMessage | OcrImageMessage {
  const candidate = toLooseRecord(value);
  return typeof candidate.imageUri === 'string' && isSelectionCoordinates(candidate.coordinates);
}

/** Checks for image data URLs generated from pasted or selected files. */
function isImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:image/');
}

/** Validates page selection coordinates used by capture and image-processing flows. */
function isSelectionCoordinates(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const coordinates = value as Record<string, unknown>;
  return Number.isFinite(coordinates.startX)
    && Number.isFinite(coordinates.startY)
    && Number.isFinite(coordinates.width)
    && Number.isFinite(coordinates.height);
}

/** Converts object-like payloads into a loose record for runtime validation. */
function toLooseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
