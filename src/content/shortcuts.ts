/** Handles page-level keyboard shortcuts for starting and repeating scans. */
import { AREA_OVERLAY_ID, SCAN_KINDS, getScanSettings } from '../common/scanSettings';
import { sendRuntimeMessage } from '../common/messages';
import { getErrorMessage } from '../common/safe';
import { displayPageResponse } from './pageResponseView';
import type { RepeatAction, TriggerAction } from '../common/types';

type ShortcutAction = TriggerAction | RepeatAction;

const IMAGE_SHORTCUT_VARIANTS = new Set(['i', 'I', '\u0130', '\u0131']);

/** Registers page shortcut handling for the content script. */
export function bindShortcutListener(): void {
  document.addEventListener('keydown', handleShortcutKeydown, true);
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
    const result = await sendRuntimeMessage({ action });
    if (!result.ok) {
      displayPageResponse(result.error || 'Shortcut action failed.', 'error');
    }
  } catch (error) {
    displayPageResponse(getErrorMessage(error, 'Shortcut action failed.'), 'error');
  }
}

/** Normalizes locale-sensitive key variants so shortcuts behave consistently for `i`. */
function normalizeShortcutKey(key: string): string {
  if (IMAGE_SHORTCUT_VARIANTS.has(key)) {
    return 'i';
  }

  return String(key || '').toLocaleLowerCase('tr-TR');
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
