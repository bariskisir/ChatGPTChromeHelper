/** Content-script entrypoint for page responses, shortcuts, and local image work. */
import { isTabMessage } from '../common/messages';
import { getErrorMessage } from '../common/safe';
import { cropImage, ocrImage } from './imageProcessing';
import { displayPageResponse } from './pageResponseView';
import { bindShortcutListener } from './shortcuts';
import type {
  CropImagePayload,
  CropImageResult,
  OcrImagePayload,
  OcrImageResult,
  Result,
  TabMessage
} from '../common/types';

type TabHandlerPayload = Record<never, never> | CropImagePayload | OcrImagePayload;
type TabMessageResponse = Result | CropImageResult | OcrImageResult;

chrome.runtime.onMessage.addListener(handleTabRuntimeMessage);
bindShortcutListener();

/** Dispatches supported tab messages and always answers with a typed result payload. */
function handleTabRuntimeMessage(
  incoming: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: TabMessageResponse) => void
): boolean {
  if (!isTabMessage(incoming)) {
    return false;
  }

  Promise.resolve(handleMessage(incoming))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error: unknown) => sendResponse({ ok: false, error: getErrorMessage(error) }));
  return true;
}

/** Routes supported tab actions to page UI updates or local image-processing helpers. */
function handleMessage(message: TabMessage): Promise<TabHandlerPayload> | TabHandlerPayload {
  switch (message.action) {
    case 'displayResponse':
      displayPageResponse(message.response, message.type);
      return {};
    case 'cropImage':
      return cropImage(message.imageUri, message.coordinates);
    case 'ocrImage':
      return ocrImage(message.imageUri, message.coordinates);
    default:
      throw new Error('Unsupported tab action.');
  }
}
