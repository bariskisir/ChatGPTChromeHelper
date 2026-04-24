/** Coordinates ChatGPT OAuth state and extension authentication storage. */
import { STORAGE_KEYS } from '../common/scanSettings';
import { broadcastRuntimeMessage } from '../common/messages';
import { getStorage, removeStorage, setStorage } from '../common/storage';
import { getErrorMessage } from '../common/safe';
import {
  CHATGPT_REDIRECT_URI,
  buildAuthorizationUrl,
  createAccessContextFromAccessToken,
  exchangeAuthorizationCode,
  persistTokenResult,
  refreshStoredLimitInfo
} from './chatgpt';
import { base64UrlRandom, createCodeChallenge } from './pkce';
import { fetchLatestModelsData } from './status';
import { closeTab, createTab } from '../background/tabs';
import type { ExtensionStorage, PendingOAuth, Result } from '../common/types';

/** Starts the OAuth PKCE flow and stores the verifier plus state for the callback step. */
export async function startLogin(): Promise<Result> {
  const verifier = base64UrlRandom(32);
  const state = base64UrlRandom(16);
  const challenge = await createCodeChallenge(verifier);
  const authorizationUrl = buildAuthorizationUrl(state, challenge);

  const tab = await createTab(authorizationUrl);
  const pendingOAuthBase: PendingOAuth = {
    state,
    verifier,
    startedAt: Date.now()
  };
  const pendingOAuth: PendingOAuth = tab.id == null
    ? pendingOAuthBase
    : { ...pendingOAuthBase, tabId: tab.id };

  await setStorage({ pendingOAuth });
  return { ok: true };
}

/** Checks whether a tab update URL is the extension's OAuth callback URL. */
export function isOAuthCallbackUrl(url = ''): boolean {
  return url.startsWith(CHATGPT_REDIRECT_URI);
}

/** Completes the OAuth flow, stores tokens, refreshes menus, and closes the callback tab. */
export async function handleOAuthCallback(
  callbackUrl: string,
  tabId: number,
  onAuthChanged: () => Promise<void>
): Promise<void> {
  const { pendingOAuth } = await getStorage(['pendingOAuth'] as const);
  if (!pendingOAuth) {
    return;
  }

  const parsed = parseCallbackUrl(callbackUrl);
  if (!parsed.code) {
    await finishOAuthError('The ChatGPT callback did not include an authorization code.');
    return;
  }

  if (parsed.state && parsed.state !== pendingOAuth.state) {
    await finishOAuthError('OAuth state mismatch. Please try signing in again.');
    return;
  }

  try {
    const tokenResult = await exchangeAuthorizationCode(parsed.code, pendingOAuth.verifier);
    await persistTokenResult(tokenResult);
    const accessContext = createAccessContextFromAccessToken(tokenResult.accessToken);
    const valuesToStore: Partial<ExtensionStorage> = {
      limitInfo: await refreshStoredLimitInfo(accessContext)
    };
    try {
      const refreshedModels = await fetchLatestModelsData(accessContext);
      valuesToStore.availableModels = refreshedModels.availableModels;
      valuesToStore.codexClientVersion = refreshedModels.clientVersion;
    } catch (error) {
      console.warn('Unable to load ChatGPT models after login.', error);
    }
    await setStorage(valuesToStore);
    await removeStorage('pendingOAuth');
    await onAuthChanged();
    await closeTab(tabId);
    broadcastRuntimeMessage({ action: 'authChanged' });
  } catch (error) {
    await finishOAuthError(getErrorMessage(error, 'ChatGPT login failed.'));
  }
}

/** Throws if the extension is not currently signed in to ChatGPT. */
export async function ensureAuthenticated(): Promise<void> {
  if (!(await isLoggedIn())) {
    throw new Error('Please sign in with ChatGPT first.');
  }
}

/** Reports whether the extension has any stored auth credentials. */
export async function isLoggedIn(): Promise<boolean> {
  const { accessToken, refreshToken } = await getStorage(['accessToken', 'refreshToken'] as const);
  return Boolean(accessToken || refreshToken);
}

/** Clears all stored auth and UI state, then refreshes menus and popup listeners. */
export async function signOut(onAuthChanged: () => Promise<void>): Promise<Result> {
  await removeStorage(STORAGE_KEYS);
  await onAuthChanged();
  broadcastRuntimeMessage({ action: 'authChanged' });
  return { ok: true };
}

/** Clears pending OAuth state and publishes an authentication error to the popup. */
async function finishOAuthError(message: string): Promise<void> {
  await removeStorage('pendingOAuth');
  await setStorage({ authError: message });
  broadcastRuntimeMessage({ action: 'authChanged', error: message });
}

/** Extracts the OAuth authorization code and state from the callback URL. */
function parseCallbackUrl(url: string): { code: string; state: string } {
  const parsed = new URL(url);
  return {
    code: parsed.searchParams.get('code') || '',
    state: parsed.searchParams.get('state') || ''
  };
}
