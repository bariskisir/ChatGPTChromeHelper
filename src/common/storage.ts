/** Wraps Chrome local storage with typed helpers used across the extension. */
import type { ExtensionStorage } from './types';

/** Reads one or more typed values from local extension storage. */
export async function getStorage<K extends keyof ExtensionStorage>(
  keys: readonly K[] | K
): Promise<Pick<ExtensionStorage, K>> {
  const normalizedKeys = toMutableKeys(keys);
  const result = await chrome.storage.local.get(normalizedKeys);
  return result as Pick<ExtensionStorage, K>;
}

/** Writes a partial storage payload into local extension storage. */
export async function setStorage(values: Partial<ExtensionStorage>): Promise<void> {
  await chrome.storage.local.set(values);
}

/** Removes one or more typed values from local extension storage. */
export async function removeStorage(keys: readonly (keyof ExtensionStorage)[] | keyof ExtensionStorage): Promise<void> {
  const normalizedKeys = toMutableKeys(keys);
  await chrome.storage.local.remove(normalizedKeys);
}

/** Converts readonly key collections into the mutable shape Chrome expects. */
function toMutableKeys<K extends keyof ExtensionStorage>(keys: readonly K[] | K): K[] | K {
  if (!Array.isArray(keys)) {
    return keys as K;
  }

  return Array.from(keys) as K[];
}
