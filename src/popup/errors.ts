/** Small popup UI helpers for error and button feedback. */

/** Renders or hides the popup error block. */
export function showError(element: HTMLElement, message: string): void {
  element.hidden = !message;
  element.textContent = message || '';
}

/** Updates a button's disabled state and visible label together. */
export function setBusy(button: HTMLButtonElement, busy: boolean, label: string): void {
  button.disabled = busy;
  const labelElement = button.querySelector<HTMLElement>('.button-label');
  if (labelElement) {
    labelElement.textContent = label;
    return;
  }

  button.textContent = label;
}

/** Temporarily swaps a button label to provide quick feedback. */
export function flashButtonText(button: HTMLButtonElement, text: string): void {
  const originalText = button.dataset.originalText || button.textContent || '';
  button.dataset.originalText = originalText;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = originalText;
    delete button.dataset.originalText;
  }, 900);
}

/** Opens a URL in a new Chrome tab. */
export function openExternalTab(url: string): void {
  void chrome.tabs.create({ url });
}
