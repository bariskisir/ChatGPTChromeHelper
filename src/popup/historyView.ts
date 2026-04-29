/** Renders and persists popup response history navigation. */
import { getNormalizedHistory, getNormalizedHistoryIndex } from '../common/scanSettings';
import { setStorage } from '../common/storage';
import { flashButtonText } from './errors';
import type { HistoryEntry, PopupElements, StatusPayload } from '../common/types';

export interface PopupHistoryState {
  history: HistoryEntry[];
  historyIndex: number;
  manualDraftActive: boolean;
}

/** Creates the mutable history state used by the popup view. */
export function createHistoryState(): PopupHistoryState {
  return {
    history: [],
    historyIndex: 0,
    manualDraftActive: false
  };
}

/** Copies normalized history data from the background status into popup state. */
export function syncHistoryState(state: PopupHistoryState, status: StatusPayload): void {
  state.history = getNormalizedHistory(status.history, status.lastResponse);
  state.historyIndex = getNormalizedHistoryIndex(status.historyIndex, state.history.length);
  state.manualDraftActive = false;
}

/** Moves the active history pointer and persists the new index. */
export function moveHistory(elements: PopupElements, state: PopupHistoryState, delta: number): void {
  if (state.manualDraftActive) {
    return;
  }

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
  state.manualDraftActive = false;
  renderHistory(elements, state);
}

/** Opens a local editable draft in the history input/output area. */
export function startManualDraft(elements: PopupElements, state: PopupHistoryState): void {
  state.manualDraftActive = true;
  renderHistory(elements, state);
  elements.manualInputText.focus();
}

/** Cancels the local editable draft and restores the normal history view. */
export function cancelManualDraft(elements: PopupElements, state: PopupHistoryState): void {
  state.manualDraftActive = false;
  state.historyIndex = getNormalizedHistoryIndex(state.historyIndex, state.history.length);
  renderHistory(elements, state);
}

/** Renders the currently selected history entry or an empty state. */
export function renderHistory(elements: PopupElements, state: PopupHistoryState): void {
  if (state.manualDraftActive) {
    renderManualDraft(elements, state);
    return;
  }

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
  setHistoryEmptyStyle(elements, false);
  elements.historyCounter.textContent = `${state.historyIndex + 1} / ${state.history.length}`;
  elements.historyPrev.disabled = state.historyIndex <= 0;
  elements.historyNext.disabled = state.historyIndex >= state.history.length - 1;
  elements.addManualButton.disabled = false;
  elements.cancelManualButton.disabled = true;
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
  setManualDraftControls(elements, false);
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
  setManualDraftControls(elements, false);
  setHistoryInputText(elements, '');
  elements.historyOutput.textContent = '';
  setHistoryEmptyStyle(elements, true);
  elements.historyCounter.textContent = '0 / 0';
  elements.historyPrev.disabled = true;
  elements.historyNext.disabled = true;
  elements.cancelManualButton.disabled = true;
  elements.deleteHistoryButton.disabled = true;
  elements.addManualButton.disabled = false;
  elements.copyInputButton.disabled = true;
  elements.copyOutputButton.disabled = true;
}

/** Renders the editable history draft opened by the plus button. */
function renderManualDraft(elements: PopupElements, state: PopupHistoryState): void {
  setManualDraftControls(elements, true);
  elements.historyCounter.textContent = state.history.length > 0
    ? `${state.historyIndex + 1} / ${state.history.length}`
    : '0 / 0';
  elements.historyOutput.textContent = '';
  setHistoryEmptyStyle(elements, false);
  elements.historyOutput.classList.add('history-box-empty');
  elements.historyPrev.disabled = true;
  elements.historyNext.disabled = true;
  elements.addManualButton.disabled = true;
  elements.cancelManualButton.disabled = false;
  elements.deleteHistoryButton.disabled = true;
  elements.copyInputButton.disabled = true;
  elements.copyOutputButton.disabled = true;
}

/** Switches the history input area to a plain-text view. */
function setHistoryInputText(elements: PopupElements, text: string): void {
  setManualDraftControls(elements, false);
  elements.historyInputImage.hidden = true;
  elements.historyInputImage.removeAttribute('src');
  elements.historyInputText.hidden = false;
  elements.historyInputText.textContent = String(text || '').trim();
}

/** Applies the subdued empty-state styling to both history boxes. */
function setHistoryEmptyStyle(elements: PopupElements, isEmpty: boolean): void {
  elements.historyInput.classList.toggle('history-box-empty', isEmpty);
  elements.historyOutput.classList.toggle('history-box-empty', isEmpty);
}

/** Shows or hides the editable draft controls inside the input history box. */
function setManualDraftControls(elements: PopupElements, isManual: boolean): void {
  elements.historyInput.classList.toggle('history-box-manual', isManual);
  elements.historyInput.classList.toggle('history-box-manual-image', isManual && !elements.historyInputImage.hidden);
  elements.manualInputText.hidden = !isManual;
  elements.manualActionRow.hidden = !isManual;
  elements.textScanButtonWrap.hidden = isManual;
  elements.imageScanButtonWrap.hidden = isManual;

  if (!isManual) {
    elements.addManualButton.disabled = false;
    elements.manualInputText.value = '';
    elements.manualInputText.placeholder = 'Enter text or paste image';
    elements.manualActionSendButton.classList.remove('image-mode');
    elements.manualActionSendButton.textContent = 'Send Text';
    elements.historyInput.classList.remove('history-box-manual-image');
    elements.manualActionRow.hidden = true;
    elements.textScanButtonWrap.hidden = false;
    elements.imageScanButtonWrap.hidden = false;
    return;
  }

  elements.historyInput.classList.remove('history-box-empty');
  elements.historyInputText.hidden = true;
  elements.historyInputText.textContent = '';
  elements.historyInputImage.hidden = true;
  elements.historyInputImage.removeAttribute('src');
}

/** Checks whether a string contains user-visible content. */
function hasVisibleText(text: string): boolean {
  return Boolean(String(text || '').trim());
}
