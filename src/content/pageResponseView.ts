/** Renders transient response messages inside the active page. */
import type { PageResponseType } from '../common/types';

const PAGE_STYLES_ID = 'ai-chrome-helper-page-styles';
const RESPONSE_CLASS_NAME = 'ai-helper-response';
const RESPONSE_DISMISS_MS = 9000;
const RESPONSE_FADE_MS = 220;

/** Injects the content-script toast styles once per page. */
export function ensurePageResponseStyles(): void {
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
export function displayPageResponse(response: string, type: PageResponseType): void {
  ensurePageResponseStyles();
  removePageResponses();

  const container = document.createElement('div');
  container.className = `${RESPONSE_CLASS_NAME} ${type || ''}`;
  container.textContent = response || '';
  document.documentElement.appendChild(container);

  if (type !== 'status') {
    setTimeout(() => fadeAndRemove(container), RESPONSE_DISMISS_MS);
  }
}

/** Removes every response toast currently shown on the page. */
function removePageResponses(): void {
  document.querySelectorAll(`.${RESPONSE_CLASS_NAME}`).forEach((element) => element.remove());
}

/** Fades a toast out before removing it from the DOM. */
function fadeAndRemove(element: HTMLElement): void {
  if (!element.parentNode) {
    return;
  }

  element.style.transition = 'opacity 180ms ease';
  element.style.opacity = '0';
  setTimeout(() => element.remove(), RESPONSE_FADE_MS);
}
