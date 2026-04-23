/** Runs inside web pages to show responses, handle shortcuts, and perform local image work. */
import { AREA_OVERLAY_ID, SCAN_KINDS, getScanSettings } from './lib/shared';
import { isTabMessage, sendRuntimeMessage } from './lib/messages';
import { cropImage, ocrImage } from './lib/ocr';
import type {
  CropImagePayload,
  CropImageResult,
  OcrImagePayload,
  OcrImageResult,
  PageResponseType,
  Result,
  TabMessage
} from './lib/types';

type ShortcutAction = 'triggerTextScan' | 'triggerImageScan' | 'repeatTextScan' | 'repeatImageScan';
type TabHandlerPayload = Record<never, never> | CropImagePayload | OcrImagePayload;

const IMAGE_SHORTCUT_VARIANTS = new Set(['i', 'I', '\u0130', '\u0131']);
const PAGE_STYLES_ID = 'ai-chrome-helper-page-styles';
const RESPONSE_CLASS_NAME = 'ai-helper-response';

chrome.runtime.onMessage.addListener(handleTabRuntimeMessage);
document.addEventListener('keydown', handleShortcutKeydown, true);

/** Dispatches supported tab messages and always answers with a typed result payload. */
function handleTabRuntimeMessage(
  incoming: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: Result | CropImageResult | OcrImageResult) => void
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
      ensurePageStyles();
      displayNormalResponse(message.response, message.type);
      return {};
    case 'cropImage':
      return cropImage(message.imageUri, message.coordinates);
    case 'ocrImage':
      return ocrImage(message.imageUri, message.coordinates);
    default:
      throw new Error('Unsupported tab action.');
  }
}

/** Handles keyboard shortcuts for starting or repeating scans on the active page. */
function handleShortcutKeydown(event: KeyboardEvent): void {
  if (event.repeat || isEditableTarget(event.target)) {
    return;
  }

  const repeatAction = getRepeatShortcutAction(event);
  if (repeatAction) {
    if (isAreaOverlayVisible()) {
      return;
    }

    event.preventDefault();
    void triggerShortcutAction(repeatAction);
    return;
  }

  const triggerAction = getTriggerShortcutAction(event);
  if (!triggerAction) {
    return;
  }

  event.preventDefault();
  void triggerShortcutAction(triggerAction);
}

/** Resolves the repeat-scan shortcut that matches the current key event. */
function getRepeatShortcutAction(event: KeyboardEvent): ShortcutAction | '' {
  for (const kind of SCAN_KINDS) {
    const settings = getScanSettings(kind);
    if (matchesDigitShortcut(event, settings.repeatShortcutLabel)) {
      return settings.repeatAction;
    }
  }

  return '';
}

/** Checks whether a key event matches one of the digit-based repeat shortcuts. */
function matchesDigitShortcut(event: KeyboardEvent, digit: string): boolean {
  return !event.shiftKey
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey
    && (event.key === digit || event.code === `Digit${digit}` || event.code === `Numpad${digit}`);
}

/** Resolves the scan-start shortcut that matches the current key event. */
function getTriggerShortcutAction(event: KeyboardEvent): ShortcutAction | '' {
  if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
    return '';
  }

  const key = normalizeShortcutKey(event.key);
  for (const kind of SCAN_KINDS) {
    const settings = getScanSettings(kind);
    if (key === settings.shortcutKey) {
      return settings.triggerAction;
    }
  }

  return '';
}

/** Reports whether the drag-selection overlay is currently visible on the page. */
function isAreaOverlayVisible(): boolean {
  return Boolean(document.getElementById(AREA_OVERLAY_ID));
}

/** Sends a shortcut action to the background script and displays any resulting error inline. */
async function triggerShortcutAction(action: ShortcutAction): Promise<void> {
  try {
    const result = await sendRuntimeMessage<Result>({ action });
    if (!result.ok) {
      ensurePageStyles();
      displayNormalResponse(result.error || 'Shortcut action failed.', 'error');
    }
  } catch (error) {
    ensurePageStyles();
    displayNormalResponse(getErrorMessage(error, 'Shortcut action failed.'), 'error');
  }
}

/** Normalizes locale-sensitive key variants so shortcuts behave consistently for `i`. */
function normalizeShortcutKey(key: string): string {
  if (IMAGE_SHORTCUT_VARIANTS.has(key)) {
    return 'i';
  }

  return String(key || '').toLocaleLowerCase('tr-TR');
}

/** Injects the content-script toast styles once per page. */
function ensurePageStyles(): void {
  if (document.getElementById(PAGE_STYLES_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = PAGE_STYLES_ID;
  style.textContent = `
.${RESPONSE_CLASS_NAME} {
  position: fixed;
  right: 18px;
  top: 18px;
  z-index: 2147483647;
  width: min(360px, calc(100vw - 32px));
  padding: 14px;
  border: 1px solid rgba(24, 32, 47, 0.18);
  border-radius: 8px;
  background: #fff;
  color: #18202f;
  box-shadow: 0 18px 48px rgba(18, 24, 38, 0.18);
  font-family: Inter, Segoe UI, system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  white-space: pre-wrap;
}

.${RESPONSE_CLASS_NAME}.status {
  width: auto;
  min-width: 180px;
  color: #475569;
  font-size: 14px;
  font-weight: 500;
  text-align: center;
}

.${RESPONSE_CLASS_NAME}.error {
  border-color: #f1b6b0;
  color: #9f1f18;
}
  `;
  document.documentElement.appendChild(style);
}

/** Renders a transient page response box and schedules auto-dismiss for non-status messages. */
function displayNormalResponse(response: string, type: PageResponseType): void {
  removeResponses();
  const container = document.createElement('div');
  container.className = `${RESPONSE_CLASS_NAME} ${type || ''}`;
  container.textContent = response || '';
  document.documentElement.appendChild(container);

  if (type !== 'status') {
    setTimeout(() => fadeAndRemove(container), 9000);
  }
}

/** Removes every response toast currently shown on the page. */
function removeResponses(): void {
  document.querySelectorAll(`.${RESPONSE_CLASS_NAME}`).forEach((element) => element.remove());
}

/** Fades a toast out before removing it from the DOM. */
function fadeAndRemove(element: HTMLElement): void {
  if (!element.parentNode) {
    return;
  }

  element.style.transition = 'opacity 180ms ease';
  element.style.opacity = '0';
  setTimeout(() => element.remove(), 220);
}

/** Detects whether a keyboard event target is an editable control that should ignore shortcuts. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

/** Normalizes unknown errors into user-facing strings. */
function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
}
