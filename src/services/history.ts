/** Maintains local response history and popup history events. */
import { createHistoryEntry } from '../common/scanSettings';
import { broadcastRuntimeMessage } from '../common/messages';
import { getStorage, removeStorage, setStorage } from '../common/storage';
import type { HistoryEntry, Result } from '../common/types';

const HISTORY_LIMIT = 50;

/** Appends a new response to history while keeping the history list capped. */
export async function addHistoryEntry(
  input: string,
  output: string,
  type: HistoryEntry['type'],
  inputImageDataUrl = ''
): Promise<void> {
  const data = await getStorage(['history'] as const);
  const nextHistory = [
    ...(Array.isArray(data.history) ? data.history : []),
    createHistoryEntry(input, output, type, inputImageDataUrl)
  ].slice(-HISTORY_LIMIT);
  await setStorage({
    history: nextHistory,
    historyIndex: nextHistory.length - 1
  });
}

/** Clears stored response history and resets the popup view. */
export async function deleteHistory(): Promise<Result> {
  await removeStorage(['history', 'historyIndex', 'lastResponse']);
  broadcastRuntimeMessage({ action: 'responseUpdated', response: '' });
  return { ok: true };
}
