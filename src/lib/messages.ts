/** Centralizes runtime and tab message typing plus small transport helpers. */
import type {
  CropImageResult,
  OcrImageResult,
  Result,
  RuntimeEventMessage,
  RuntimeRequest,
  StatusPayload,
  TabMessage
} from './types';

export type RuntimeResponse = Result | StatusPayload;
export type TabResponse = Result | CropImageResult | OcrImageResult;

/** Checks whether an unknown payload matches the supported runtime request actions. */
export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  return hasAction(value, [
    'startLogin',
    'signOut',
    'getStatus',
    'deleteHistory',
    'refreshModels',
    'triggerTextScan',
    'triggerImageScan',
    'repeatTextScan',
    'repeatImageScan',
    'captureArea'
  ]);
}

/** Checks whether an unknown payload matches the supported runtime event actions. */
export function isRuntimeEventMessage(value: unknown): value is RuntimeEventMessage {
  return hasAction(value, ['authChanged', 'responseUpdated']);
}

/** Checks whether an unknown payload matches the supported tab message actions. */
export function isTabMessage(value: unknown): value is TabMessage {
  return hasAction(value, ['displayResponse', 'cropImage', 'ocrImage']);
}

/** Sends a typed message to the extension runtime. */
export async function sendRuntimeMessage<TResponse extends RuntimeResponse = RuntimeResponse>(
  message: RuntimeRequest
): Promise<TResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
}

/** Sends a typed message to a content script running in a tab. */
export async function sendTabMessage<TResponse extends TabResponse = TabResponse>(
  tabId: number,
  message: TabMessage
): Promise<TResponse> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<TResponse>;
}

/** Broadcasts lightweight runtime events without failing the caller on delivery errors. */
export function broadcastRuntimeMessage(message: RuntimeEventMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

/** Validates that a message object exposes one of the expected action names. */
function hasAction(value: unknown, actions: readonly string[]): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { action?: unknown };
  return typeof candidate.action === 'string' && actions.includes(candidate.action);
}
