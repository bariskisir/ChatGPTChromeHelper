/** Routes typed runtime messages to background services. */
import { isRuntimeRequest, type RuntimeResponse } from '../common/messages';
import { toErrorResult } from '../common/safe';
import type { RuntimeRequest } from '../common/types';
import { createContextMenus } from './menus';
import { startLogin, signOut } from '../services/auth';
import { captureArea, repeatSavedScan, triggerActiveOverlay } from '../services/scan';
import { deleteHistory } from '../services/history';
import { getStatus, refreshModels } from '../services/status';

/** Validates incoming runtime messages and replies asynchronously with typed results. */
export function handleRuntimeMessage(
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
      return signOut(createContextMenus);
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

/** Resolves a background task into a `sendResponse` callback with consistent error handling. */
function respondWithResult(
  sendResponse: (response: RuntimeResponse) => void,
  task: Promise<RuntimeResponse> | RuntimeResponse
): void {
  Promise.resolve(task)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse(toErrorResult(error)));
}
