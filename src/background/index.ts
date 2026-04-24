/** Background service worker entrypoint. */
import { createContextMenus, handleContextMenuClick } from './menus';
import { handleRuntimeMessage } from './router';
import { runBackgroundTask } from './tasks';
import { handleOAuthCallback, isOAuthCallbackUrl } from '../services/auth';

chrome.runtime.onInstalled.addListener(() => {
  runBackgroundTask(createContextMenus(), 'Context menu installation');
});

chrome.runtime.onStartup.addListener(() => {
  runBackgroundTask(createContextMenus(), 'Context menu startup');
});

chrome.contextMenus.onClicked.addListener(handleContextMenuClick);
chrome.tabs.onUpdated.addListener(handleTabUpdated);
chrome.runtime.onMessage.addListener(handleRuntimeMessage);

/** Watches for the local OAuth redirect so the extension can finish sign-in. */
function handleTabUpdated(tabId: number, changeInfo: { url?: string }): void {
  if (!isOAuthCallbackUrl(changeInfo.url)) {
    return;
  }

  runBackgroundTask(handleOAuthCallback(changeInfo.url || '', tabId, createContextMenus), 'OAuth callback');
}
