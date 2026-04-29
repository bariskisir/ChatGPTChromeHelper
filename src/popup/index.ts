/** Popup entrypoint for auth state, scan settings, and history browsing. */
import { EXTERNAL_LINKS } from '../common/constants';
import { isRuntimeEventMessage, sendRuntimeMessage } from '../common/messages';
import { getElements } from './dom';
import { openExternalTab, setBusy, showError as renderError } from './errors';
import {
  clearHistoryState,
  copyHistoryField,
  createHistoryState,
  moveHistory,
  renderHistory,
  syncHistoryState
} from './historyView';
import { bindManualInput } from './manualInput';
import { bindScanControls, createScanControls, renderScanControls } from './scanControls';
import { renderSession } from './sessionView';
import type { RuntimeEventMessage } from '../common/types';

const REFRESH_ICON = '\u21BB';
const elements = getElements();
const historyState = createHistoryState();
const scanControls = createScanControls(elements);

document.addEventListener('DOMContentLoaded', handlePopupDomReady);
chrome.runtime.onMessage.addListener(handlePopupRuntimeMessage);

/** Starts popup initialization once the DOM is ready. */
function handlePopupDomReady(): void {
  initializePopup();
}

/** Refreshes popup state when the background script broadcasts relevant events. */
function handlePopupRuntimeMessage(incoming: unknown): boolean {
  if (!isRuntimeEventMessage(incoming)) {
    return false;
  }

  handleRuntimeEvent(incoming);
  return false;
}

/** Binds popup events and loads the initial extension status. */
function initializePopup(): void {
  renderAppVersion();
  bindEvents();
  void refreshStatus();
}

/** Shows the installed extension version next to the popup title. */
function renderAppVersion(): void {
  const version = chrome.runtime.getManifest().version;
  elements.appVersion.textContent = version ? `v${version}` : '';
}

/** Responds to runtime events that should refresh popup state. */
function handleRuntimeEvent(message: RuntimeEventMessage): void {
  if (message.action === 'authChanged' || message.action === 'responseUpdated') {
    void refreshStatus();
  }
}

/** Wires popup-level buttons, links, history controls, and scan controls. */
function bindEvents(): void {
  elements.loginButton.addEventListener('click', handleLoginClick);
  elements.signOutButton.addEventListener('click', handleSignOutClick);
  elements.developerLink.addEventListener('click', () => openExternalTab(EXTERNAL_LINKS.developer));
  elements.sourceLink.addEventListener('click', () => openExternalTab(EXTERNAL_LINKS.source));
  elements.historyPrev.addEventListener('click', () => moveHistory(elements, historyState, -1));
  elements.historyNext.addEventListener('click', () => moveHistory(elements, historyState, 1));
  elements.deleteHistoryButton.addEventListener('click', handleDeleteHistoryClick);
  elements.limitRefreshButton.addEventListener('click', () => {
    void handleRefreshLimitsClick();
  });
  elements.copyInputButton.addEventListener('click', () => {
    void copyHistoryField(historyState, 'input', elements.copyInputButton, showError);
  });
  elements.copyOutputButton.addEventListener('click', () => {
    void copyHistoryField(historyState, 'output', elements.copyOutputButton, showError);
  });
  bindManualInput(elements, historyState, showError, refreshStatus);
  bindScanControls(scanControls, showError, refreshStatus);
}

/** Starts the ChatGPT OAuth flow from the popup. */
async function handleLoginClick(): Promise<void> {
  setBusy(elements.loginButton, true, 'Opening...');

  try {
    const result = await sendRuntimeMessage({ action: 'startLogin' });
    if (!result.ok) {
      showError(result.error || 'Could not start ChatGPT login.');
      return;
    }

    showError('');
    window.close();
  } finally {
    setBusy(elements.loginButton, false, 'Sign in with ChatGPT');
  }
}

/** Signs the current user out and refreshes the popup state. */
async function handleSignOutClick(): Promise<void> {
  const result = await sendRuntimeMessage({ action: 'signOut' });
  if (!result.ok) {
    showError(result.error || 'Could not sign out.');
    return;
  }

  showError('');
  await refreshStatus();
}

/** Refreshes usage limits from the popup header refresh button. */
async function handleRefreshLimitsClick(): Promise<void> {
  setBusy(elements.limitRefreshButton, true, REFRESH_ICON);
  try {
    const result = await sendRuntimeMessage({ action: 'refreshLimits' });
    if (!result.ok) {
      showError(result.error || 'Could not refresh limits.');
      return;
    }

    await refreshStatus();
  } finally {
    setBusy(elements.limitRefreshButton, false, REFRESH_ICON);
  }
}

/** Clears stored history and resets the popup history viewer. */
async function handleDeleteHistoryClick(): Promise<void> {
  const result = await sendRuntimeMessage({ action: 'deleteHistory' });
  if (!result.ok) {
    showError(result.error || 'Could not delete history.');
    return;
  }

  clearHistoryState(elements, historyState);
  showError('');
}

/** Fetches the latest extension status and rerenders popup sections. */
async function refreshStatus(): Promise<void> {
  const status = await sendRuntimeMessage({ action: 'getStatus' });
  if (!status.ok) {
    showError(status.error || 'Could not load extension status.');
    return;
  }

  renderSession(elements, status);
  syncHistoryState(historyState, status);
  renderHistory(elements, historyState);
  renderScanControls(scanControls, status);
  showError(status.authError || '');
}

/** Renders or hides the popup error block. */
function showError(message: string): void {
  renderError(elements.authError, message);
}
