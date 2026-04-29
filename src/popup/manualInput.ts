/** Handles direct popup text/image input and submission. */
import { sendRuntimeMessage } from '../common/messages';
import { setBusy } from './errors';
import { cancelManualDraft, startManualDraft, type PopupHistoryState } from './historyView';
import type { PopupElements } from '../common/types';

type ErrorHandler = (message: string) => void;
type RefreshStatus = () => Promise<void>;

interface ManualInputState {
  imageDataUrl: string;
}

/** Wires manual text, paste-image, file-image, clear, and send controls. */
export function bindManualInput(
  elements: PopupElements,
  historyState: PopupHistoryState,
  showError: ErrorHandler,
  refreshStatus: RefreshStatus
): void {
  const state: ManualInputState = {
    imageDataUrl: ''
  };

  elements.addManualButton.addEventListener('click', () => {
    state.imageDataUrl = '';
    setManualSendMode(elements, false);
    startManualDraft(elements, historyState);
    showError('');
  });
  elements.cancelManualButton.addEventListener('click', () => {
    state.imageDataUrl = '';
    cancelManualDraft(elements, historyState);
    showError('');
  });
  elements.manualInputText.addEventListener('paste', (event) => {
    void handlePaste(event, elements, state, showError);
  });
  elements.manualActionSendButton.addEventListener('click', () => {
    void submitManualInput(elements, state, showError, refreshStatus);
  });
}

/** Reads pasted image data without blocking normal text paste behavior. */
async function handlePaste(
  event: ClipboardEvent,
  elements: PopupElements,
  state: ManualInputState,
  showError: ErrorHandler
): Promise<void> {
  const imageFile = findImageFile(event.clipboardData?.items);
  if (!imageFile) {
    return;
  }

  event.preventDefault();
  try {
    setManualImage(elements, state, await readFileAsDataUrl(imageFile));
    showError('');
  } catch {
    showError('Could not read pasted image.');
  }
}

/** Submits manual text or image input to the background ChatGPT flow. */
async function submitManualInput(
  elements: PopupElements,
  state: ManualInputState,
  showError: ErrorHandler,
  refreshStatus: RefreshStatus
): Promise<void> {
  const text = elements.manualInputText.value.trim();
  if (!text && !state.imageDataUrl) {
    showError('Enter text or add an image first.');
    return;
  }

  const previousLabel = state.imageDataUrl ? 'Scan Image' : 'Send Text';
  setBusy(elements.manualActionSendButton, true, 'Sending...');
  try {
    const message = state.imageDataUrl
      ? {
        action: 'submitManualInput' as const,
        text,
        imageDataUrl: state.imageDataUrl
      }
      : {
        action: 'submitManualInput' as const,
        text
      };
    const result = await sendRuntimeMessage(message);

    if (!result.ok) {
      showError(result.error || 'Could not send input.');
      return;
    }

    state.imageDataUrl = '';
    showError('');
    await refreshStatus();
  } finally {
    setBusy(elements.manualActionSendButton, false, previousLabel);
  }
}

/** Finds the first image file in a clipboard item list. */
function findImageFile(items: DataTransferItemList | undefined): File | null {
  if (!items) {
    return null;
  }

  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      return item.getAsFile();
    }
  }

  return null;
}

/** Stores and renders the selected manual image. */
function setManualImage(elements: PopupElements, state: ManualInputState, imageDataUrl: string): void {
  state.imageDataUrl = imageDataUrl;
  elements.historyInputImage.src = imageDataUrl;
  elements.historyInputImage.hidden = false;
  elements.historyInput.classList.add('history-box-manual-image');
  elements.manualInputText.placeholder = '';
  setManualSendMode(elements, true);
}

/** Updates the large manual action button for text or image submission. */
function setManualSendMode(elements: PopupElements, isImage: boolean): void {
  elements.manualActionSendButton.classList.toggle('image-mode', isImage);
  elements.manualActionSendButton.textContent = isImage ? 'Scan Image' : 'Send Text';
}

/** Reads a file into a data URL. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (result.startsWith('data:image/')) {
        resolve(result);
        return;
      }

      reject(new Error('Unsupported image data.'));
    };
    reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}
