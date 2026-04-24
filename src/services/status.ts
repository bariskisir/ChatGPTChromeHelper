/** Builds popup status payloads and resolves user-configured scan settings. */
import {
  STATUS_STORAGE_KEYS,
  getNormalizedHistory,
  getNormalizedHistoryIndex,
  getScanSettings,
  normalizeAvailableModelsCatalog,
  normalizeStoredModel,
  normalizeSystemPromptPreset,
  normalizeThinkingVariant,
  resolveModelValue,
  resolveSystemPrompt
} from '../common/scanSettings';
import { broadcastRuntimeMessage } from '../common/messages';
import { getStorage, setStorage } from '../common/storage';
import {
  fetchAvailableModels,
  fetchCodexClientVersion,
  fetchLimitInfo,
  getDefaultCodexClientVersion,
  getValidAccessContext,
  hasRenderableLimitInfo,
  normalizeLimitInfo
} from './chatgpt';
import type {
  AccessContext,
  AvailableModel,
  ExtensionStorage,
  Result,
  ScanKind,
  StatusPayload,
  ThinkingVariant
} from '../common/types';

interface StoredScanSettingsState {
  availableModels: AvailableModel[];
  storedModel: unknown;
  storedCustomModel: unknown;
  storedThinkingVariant: unknown;
}

/** Builds the popup status payload, refreshing rate-limit info when needed. */
export async function getStatus(): Promise<StatusPayload> {
  let data = await getStorage(STATUS_STORAGE_KEYS);
  let normalizedLimitInfo = normalizeLimitInfo(data.limitInfo ?? null);
  let availableModels = normalizeAvailableModelsCatalog(data.availableModels);
  let codexClientVersion = typeof data.codexClientVersion === 'string' && data.codexClientVersion.trim()
    ? data.codexClientVersion
    : getDefaultCodexClientVersion();

  if ((data.accessToken || data.refreshToken) && !hasRenderableLimitInfo(normalizedLimitInfo)) {
    try {
      const refreshedLimitInfo = await fetchLimitInfo(await getValidAccessContext());
      await setStorage({ limitInfo: refreshedLimitInfo });
      data = {
        ...data,
        limitInfo: refreshedLimitInfo
      };
      normalizedLimitInfo = normalizeLimitInfo(refreshedLimitInfo);
    } catch (error) {
      console.warn('Unable to load ChatGPT limit info for status.', error);
    }
  }

  if ((data.accessToken || data.refreshToken) && availableModels.length === 0) {
    try {
      const refreshedModels = await fetchLatestModelsData(await getValidAccessContext());
      await setStorage({
        availableModels: refreshedModels.availableModels,
        codexClientVersion: refreshedModels.clientVersion
      });
      availableModels = refreshedModels.availableModels;
      codexClientVersion = refreshedModels.clientVersion;
    } catch (error) {
      console.warn('Unable to load ChatGPT models for status.', error);
    }
  }

  const history = getNormalizedHistory(data.history, data.lastResponse);
  return {
    ok: true,
    loggedIn: Boolean(data.accessToken || data.refreshToken),
    accountEmail: data.accountEmail || '',
    requestCount: typeof data.requestCount === 'number' && Number.isInteger(data.requestCount) ? data.requestCount : 0,
    limitInfo: normalizedLimitInfo,
    availableModels,
    codexClientVersion,
    expiresAt: data.expiresAt || null,
    lastResponse: data.lastResponse || '',
    history,
    historyIndex: getNormalizedHistoryIndex(data.historyIndex, history.length),
    textScanModel: normalizeStoredModel(data.textScanModel, data.textScanCustomModel, availableModels),
    textScanCustomModel: data.textScanCustomModel || '',
    textScanThinkingVariant: getStatusThinkingVariant('text', data, availableModels),
    imageScanModel: normalizeStoredModel(data.imageScanModel, data.imageScanCustomModel, availableModels),
    imageScanCustomModel: data.imageScanCustomModel || '',
    imageScanThinkingVariant: getStatusThinkingVariant('image', data, availableModels),
    textSystemPromptPreset: normalizeSystemPromptPreset(data.textSystemPromptPreset, data.textCustomSystemPrompt),
    textCustomSystemPrompt: data.textCustomSystemPrompt || '',
    imageSystemPromptPreset: normalizeSystemPromptPreset(data.imageSystemPromptPreset, data.imageCustomSystemPrompt),
    imageCustomSystemPrompt: data.imageCustomSystemPrompt || '',
    authError: data.authError || ''
  };
}

/** Refreshes the remote model catalog on demand for the popup refresh buttons. */
export async function refreshModels(): Promise<Result> {
  const refreshedModels = await fetchLatestModelsData(await getValidAccessContext());
  await setStorage({
    availableModels: refreshedModels.availableModels,
    codexClientVersion: refreshedModels.clientVersion
  });
  broadcastRuntimeMessage({ action: 'responseUpdated' });
  return { ok: true };
}

/** Resolves the effective model for a scan mode from stored popup settings. */
export async function getScanModel(kind: ScanKind): Promise<string> {
  const scanSettingsState = await getStoredScanSettings(kind);
  return resolveModelValue(
    scanSettingsState.storedModel,
    scanSettingsState.storedCustomModel,
    scanSettingsState.availableModels
  );
}

/** Resolves the effective thinking variant for a scan mode from stored popup settings. */
export async function getScanThinkingVariant(kind: ScanKind): Promise<ThinkingVariant> {
  const scanSettingsState = await getStoredScanSettings(kind);
  const selectedModel = resolveModelValue(scanSettingsState.storedModel, '', scanSettingsState.availableModels);
  return normalizeThinkingVariant(scanSettingsState.storedThinkingVariant, selectedModel, scanSettingsState.availableModels);
}

/** Resolves the effective system prompt for a scan mode from stored popup settings. */
export async function getSystemPrompt(kind: ScanKind): Promise<string> {
  const settings = getScanSettings(kind);
  const data = await getStorage([settings.systemPromptPresetKey, settings.customSystemPromptKey]);
  return resolveSystemPrompt(data[settings.systemPromptPresetKey], data[settings.customSystemPromptKey], kind);
}

/** Loads the latest npm-published Codex version, then fetches the matching model catalog. */
export async function fetchLatestModelsData(accessContext: AccessContext): Promise<{
  availableModels: AvailableModel[];
  clientVersion: string;
}> {
  let clientVersion = getDefaultCodexClientVersion();
  try {
    clientVersion = await fetchCodexClientVersion();
  } catch (error) {
    console.warn('Unable to load Codex client version from npm.', error);
  }

  return {
    availableModels: normalizeAvailableModelsCatalog(await fetchAvailableModels(accessContext, clientVersion)),
    clientVersion
  };
}

/** Resolves a valid thinking variant for status payloads. */
function getStatusThinkingVariant(kind: ScanKind, data: Partial<ExtensionStorage>, availableModels: AvailableModel[]): ThinkingVariant {
  const settings = getScanSettings(kind);
  const selectedModel = normalizeStoredModel(data[settings.modelKey], data[settings.customModelKey], availableModels);
  return normalizeThinkingVariant(data[settings.thinkingVariantKey], selectedModel, availableModels);
}

/** Reads one scan mode's stored model selection state with normalized available models. */
async function getStoredScanSettings(kind: ScanKind): Promise<StoredScanSettingsState> {
  const settings = getScanSettings(kind);
  const data = await getStorage([settings.modelKey, settings.customModelKey, settings.thinkingVariantKey, 'availableModels']);
  return {
    availableModels: normalizeAvailableModelsCatalog(data.availableModels),
    storedModel: data[settings.modelKey],
    storedCustomModel: data[settings.customModelKey],
    storedThinkingVariant: data[settings.thinkingVariantKey]
  };
}
