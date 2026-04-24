/** Chrome tab helpers used by background services. */

/** Captures the visible tab bitmap for a given window. */
export function captureVisibleTab(windowId: number): Promise<string> {
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

/** Opens a new active tab for the requested URL. */
export function createTab(url: string): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create({ url, active: true });
}

/** Closes a tab while tolerating the user having already dismissed it. */
export async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The user may have already closed the tab.
  }
}

/** Checks whether a tab URL points at a normal web page that can receive injected scripts. */
export function isSupportedPageUrl(url = ''): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}
