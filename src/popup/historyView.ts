/** Renders and persists popup response history navigation. */
import { getNormalizedHistory, getNormalizedHistoryIndex } from '../common/scanSettings';
import { setStorage } from '../common/storage';
import { flashButtonText } from './errors';
import type { HistoryEntry, PopupElements, StatusPayload } from '../common/types';

export interface PopupHistoryState {
  history: HistoryEntry[];
  historyIndex: number;
}

/** Creates the mutable history state used by the popup view. */
export function createHistoryState(): PopupHistoryState {
  return {
    history: [],
    historyIndex: 0
  };
}

/** Copies normalized history data from the background status into popup state. */
export function syncHistoryState(state: PopupHistoryState, status: StatusPayload): void {
  state.history = getNormalizedHistory(status.history, status.lastResponse);
  state.historyIndex = getNormalizedHistoryIndex(status.historyIndex, state.history.length);
}

/** Moves the active history pointer and persists the new index. */
export function moveHistory(elements: PopupElements, state: PopupHistoryState, delta: number): void {
  if (state.history.length === 0) {
    return;
  }

  state.historyIndex = getNormalizedHistoryIndex(
    state.historyIndex + delta,
    state.history.length
  );
  void setStorage({ historyIndex: state.historyIndex });
  renderHistory(elements, state);
}

/** Resets local history state after background deletion succeeds. */
export function clearHistoryState(elements: PopupElements, state: PopupHistoryState): void {
  state.history = [];
  state.historyIndex = 0;
  renderHistory(elements, state);
}

/** Renders the currently selected history entry or an empty state. */
export function renderHistory(elements: PopupElements, state: PopupHistoryState): void {
  if (state.history.length === 0) {
    applyEmptyHistoryState(elements);
    return;
  }

  const entry = state.history[state.historyIndex];
  if (!entry) {
    applyEmptyHistoryState(elements);
    return;
  }

  renderHistoryInput(elements, entry);
  elements.historyOutput.textContent = entry.output || 'No output recorded.';
  elements.historyCounter.textContent = `${state.historyIndex + 1} / ${state.history.length}`;
  elements.historyPrev.disabled = state.historyIndex <= 0;
  elements.historyNext.disabled = state.historyIndex >= state.history.length - 1;
  elements.deleteHistoryButton.disabled = false;
  elements.copyInputButton.disabled = !hasVisibleText(entry.input);
  elements.copyOutputButton.disabled = !hasVisibleText(entry.output);
}

/** Copies the active history field to the clipboard and briefly updates the button label. */
export async function copyHistoryField(
  state: PopupHistoryState,
  field: 'input' | 'output',
  button: HTMLButtonElement,
  onError: (message: string) => void
): Promise<void> {
  const entry = state.history[state.historyIndex];
  const text = field === 'input' ? entry?.input : entry?.output;
  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    flashButtonText(button, 'Done');
  } catch {
    onError('Could not copy to clipboard.');
  }
}

/** Renders either the input image preview or the input text for a history entry. */
function renderHistoryInput(elements: PopupElements, entry: HistoryEntry): void {
  if (entry.type === 'image' && entry.inputImageDataUrl) {
    elements.historyInputImage.src = entry.inputImageDataUrl;
    elements.historyInputImage.hidden = false;
    elements.historyInputText.hidden = true;
    elements.historyInputText.textContent = '';
    return;
  }

  setHistoryInputText(elements, entry.input || 'No input recorded.');
}

/** Applies the placeholder state shown when no history entries exist. */
function applyEmptyHistoryState(elements: PopupElements): void {
  setHistoryInputText(elements, 'none');
  elements.historyOutput.textContent = 'none';
  elements.historyCounter.textContent = '0 / 0';
  elements.historyPrev.disabled = true;
  elements.historyNext.disabled = true;
  elements.deleteHistoryButton.disabled = true;
  elements.copyInputButton.disabled = true;
  elements.copyOutputButton.disabled = true;
}

/** Switches the history input area to a plain-text view. */
function setHistoryInputText(elements: PopupElements, text: string): void {
  elements.historyInputImage.hidden = true;
  elements.historyInputImage.removeAttribute('src');
  elements.historyInputText.hidden = false;
  elements.historyInputText.textContent = String(text || '').trim();
}

/** Checks whether a string contains user-visible content. */
function hasVisibleText(text: string): boolean {
  return Boolean(String(text || '').trim());
}
