/** Creates and routes extension context-menu actions. */
import { isLoggedIn, startLogin } from '../services/auth';
import { injectOverlay, processSelectedText } from '../services/scan';
import { runBackgroundTask } from './tasks';

const CONTEXT_MENU_ITEMS = {
  loggedOut: [
    {
      id: 'login',
      title: 'Log in to ChatGPT',
      contexts: ['page', 'selection']
    }
  ],
  loggedIn: [
    {
      id: 'ask',
      title: 'Ask',
      contexts: ['selection']
    },
    {
      id: 'textScanArea',
      title: 'Text Scan Area',
      contexts: ['page', 'selection']
    },
    {
      id: 'imageScanArea',
      title: 'Image Scan Area',
      contexts: ['page', 'selection']
    }
  ]
} satisfies Record<'loggedOut' | 'loggedIn', chrome.contextMenus.CreateProperties[]>;

/** Rebuilds context menus to match the current authentication state. */
export async function createContextMenus(): Promise<void> {
  const loggedIn = await isLoggedIn();
  await removeAllMenus();

  for (const item of getContextMenuItems(loggedIn)) {
    chrome.contextMenus.create(item);
  }
}

/** Routes context-menu clicks to login, ask, or scan actions. */
export function handleContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): void {
  switch (info.menuItemId) {
    case 'login':
      runBackgroundTask(startLogin(), 'Context menu "login"');
      return;
    case 'ask':
      if (tab?.id != null) {
        runBackgroundTask(processSelectedText(info.selectionText, tab.id), 'Context menu "ask"');
      }
      return;
    case 'textScanArea':
      if (tab?.id != null) {
        runBackgroundTask(injectOverlay(tab.id, 'text'), 'Context menu "textScanArea"');
      }
      return;
    case 'imageScanArea':
      if (tab?.id != null) {
        runBackgroundTask(injectOverlay(tab.id, 'image'), 'Context menu "imageScanArea"');
      }
      return;
    default:
      return;
  }
}

/** Returns the context-menu set appropriate for the current session state. */
function getContextMenuItems(loggedIn: boolean): chrome.contextMenus.CreateProperties[] {
  return loggedIn ? CONTEXT_MENU_ITEMS.loggedIn : CONTEXT_MENU_ITEMS.loggedOut;
}

/** Clears all existing context menus before recreating them. */
function removeAllMenus(): Promise<void> {
  return new Promise((resolve) => chrome.contextMenus.removeAll(() => resolve()));
}
