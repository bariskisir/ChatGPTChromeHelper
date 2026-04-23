/** Stores extension-wide scan defaults, storage keys, and normalization helpers. */
import type {
  AreaOverlayOptions,
  ExtensionStorage,
  HistoryEntry,
  HistoryEntryType,
  KnownModel,
  ModelSelection,
  ScanKind,
  ScanSettings,
  SavedSelectionCoordinates,
  SystemPromptPreset
} from './types';

export const DEFAULT_MODEL: KnownModel = 'gpt-5.4-mini';
export const AREA_OVERLAY_ID = 'ai-chrome-helper-area-overlay';
export const MODEL_OPTIONS = new Set<KnownModel>(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2']);
export const TEXT_SOLVER_PROMPT = 'You are a careful problem solver. Read the selected content, solve accurately, and give the final answer clearly.';
export const IMAGE_SOLVER_PROMPT = 'You are a careful image problem solver. Analyze the selected image area, solve math accurately, interpret charts, diagrams, UI, or other image content when present, and give the key answer concisely and clearly.';
export const SYSTEM_PROMPTS = Object.freeze({
  solver: Object.freeze({
    text: TEXT_SOLVER_PROMPT,
    image: IMAGE_SOLVER_PROMPT
  })
});

export const STORAGE_KEYS = Object.freeze([
  'accessToken',
  'refreshToken',
  'expiresAt',
  'accountEmail',
  'chatgptAccountId',
  'lastResponse',
  'history',
  'historyIndex',
  'requestCount',
  'limitInfo',
  'lastTextScanCoordinates',
  'lastImageScanCoordinates',
  'textScanModel',
  'textScanCustomModel',
  'imageScanModel',
  'imageScanCustomModel',
  'textSystemPromptPreset',
  'textCustomSystemPrompt',
  'imageSystemPromptPreset',
  'imageCustomSystemPrompt',
  'pendingOAuth',
  'authError'
] satisfies readonly (keyof ExtensionStorage)[]);

export const STATUS_STORAGE_KEYS = Object.freeze([
  'accessToken',
  'refreshToken',
  'expiresAt',
  'accountEmail',
  'lastResponse',
  'history',
  'historyIndex',
  'requestCount',
  'limitInfo',
  'textScanModel',
  'textScanCustomModel',
  'imageScanModel',
  'imageScanCustomModel',
  'textSystemPromptPreset',
  'textCustomSystemPrompt',
  'imageSystemPromptPreset',
  'imageCustomSystemPrompt',
  'authError'
] satisfies readonly (keyof ExtensionStorage)[]);

export const SCAN_SETTINGS: Record<ScanKind, ScanSettings> = Object.freeze({
  text: Object.freeze({
    kind: 'text',
    buttonLabel: 'Scan Text',
    triggerAction: 'triggerTextScan',
    repeatAction: 'repeatTextScan',
    shortcutKey: 't',
    repeatShortcutLabel: '1',
    coordinateKey: 'lastTextScanCoordinates',
    modelKey: 'textScanModel',
    customModelKey: 'textScanCustomModel',
    customModelPlaceholder: 'Enter text scan model',
    systemPromptPresetKey: 'textSystemPromptPreset',
    customSystemPromptKey: 'textCustomSystemPrompt',
    customSystemPromptPlaceholder: 'Enter text scan system prompt',
    overlayFile: 'selectionOverlay.js',
    overlayLabel: 'Text Scan - select an area',
    minWidth: 30,
    minHeight: 30,
    borderColor: '#2563eb',
    fillColor: 'rgba(37, 99, 235, 0.12)',
    captureAction: 'ocrImage',
    historyType: 'text',
    progressMessage: 'Reading text with OCR...',
    responseStyle: 'medium',
    solverPrompt: TEXT_SOLVER_PROMPT
  }),
  image: Object.freeze({
    kind: 'image',
    buttonLabel: 'Scan Image',
    triggerAction: 'triggerImageScan',
    repeatAction: 'repeatImageScan',
    shortcutKey: 'i',
    repeatShortcutLabel: '2',
    coordinateKey: 'lastImageScanCoordinates',
    modelKey: 'imageScanModel',
    customModelKey: 'imageScanCustomModel',
    customModelPlaceholder: 'Enter image scan model',
    systemPromptPresetKey: 'imageSystemPromptPreset',
    customSystemPromptKey: 'imageCustomSystemPrompt',
    customSystemPromptPlaceholder: 'Enter image scan system prompt',
    overlayFile: 'imageSelectionOverlay.js',
    overlayLabel: 'Image Scan - select an area',
    minWidth: 45,
    minHeight: 45,
    borderColor: '#0f9f8f',
    fillColor: 'rgba(15, 159, 143, 0.12)',
    captureAction: 'cropImage',
    historyType: 'image',
    progressMessage: '',
    responseStyle: 'medium',
    solverPrompt: IMAGE_SOLVER_PROMPT
  })
});

export const SCAN_KINDS = Object.freeze(Object.keys(SCAN_SETTINGS) as ScanKind[]);

/** Normalizes unknown scan mode values to one of the supported modes. */
export function normalizeScanKind(kind: unknown): ScanKind {
  return kind === 'image' ? 'image' : 'text';
}

/** Returns the frozen scan settings for a requested mode. */
export function getScanSettings(kind: unknown): ScanSettings {
  return SCAN_SETTINGS[normalizeScanKind(kind)];
}

/** Maps scan settings into the smaller overlay configuration object used in page scripts. */
export function getAreaOverlayOptions(kind: unknown): AreaOverlayOptions {
  const settings = getScanSettings(kind);
  return {
    mode: settings.kind,
    label: settings.overlayLabel,
    minWidth: settings.minWidth,
    minHeight: settings.minHeight,
    borderColor: settings.borderColor,
    fillColor: settings.fillColor
  };
}

/** Normalizes a stored model selection while preserving the custom-model fallback. */
export function normalizeStoredModel(selectedModel: unknown, customModel: unknown): ModelSelection {
  if (selectedModel === 'other') {
    return 'other';
  }

  if (typeof selectedModel === 'string' && MODEL_OPTIONS.has(selectedModel as KnownModel)) {
    return selectedModel as KnownModel;
  }

  if (normalizeOptionalString(customModel)) {
    return 'other';
  }

  return DEFAULT_MODEL;
}

/** Resolves the final model name that should be sent to ChatGPT. */
export function resolveModelValue(selectedModel: unknown, customModel: unknown): string {
  if (selectedModel === 'other') {
    return normalizeOptionalString(customModel) || DEFAULT_MODEL;
  }

  return typeof selectedModel === 'string' && MODEL_OPTIONS.has(selectedModel as KnownModel)
    ? selectedModel
    : DEFAULT_MODEL;
}

/** Normalizes the system-prompt preset while inferring custom prompts when needed. */
export function normalizeSystemPromptPreset(preset: unknown, customPrompt: unknown): SystemPromptPreset {
  if (preset === 'other') {
    return 'other';
  }

  if (preset === 'none') {
    return 'none';
  }

  if (preset === 'solver') {
    return 'solver';
  }

  if (normalizeOptionalString(customPrompt)) {
    return 'other';
  }

  return 'solver';
}

/** Resolves the effective system prompt string for a given scan mode. */
export function resolveSystemPrompt(preset: unknown, customPrompt: unknown, kind: ScanKind): string {
  if (preset === 'other') {
    return normalizeOptionalString(customPrompt) || getSolverPrompt(kind);
  }

  if (preset === 'none') {
    return '';
  }

  return getSolverPrompt(kind);
}

/** Returns the built-in solver prompt for a scan mode. */
export function getSolverPrompt(kind: ScanKind): string {
  return getScanSettings(kind).solverPrompt;
}

/** Creates a consistently shaped history entry for storage. */
export function createHistoryEntry(
  input: string,
  output: string,
  type: HistoryEntryType,
  inputImageDataUrl: string
): HistoryEntry {
  return {
    input: input || '',
    inputImageDataUrl: inputImageDataUrl || '',
    output: output || '',
    type,
    createdAt: Date.now()
  };
}

/** Normalizes history storage while preserving legacy single-response data. */
export function getNormalizedHistory(history: unknown, lastResponse: unknown): HistoryEntry[] {
  if (Array.isArray(history)) {
    return history.filter(isHistoryEntry);
  }

  if (!normalizeOptionalString(lastResponse)) {
    return [];
  }

  return [{
    input: 'Legacy response',
    inputImageDataUrl: '',
    output: normalizeOptionalString(lastResponse),
    type: 'ask',
    createdAt: Date.now()
  }];
}

/** Clamps a stored history cursor to a safe index for the current history length. */
export function getNormalizedHistoryIndex(historyIndex: unknown, historyLength: number): number {
  if (historyLength <= 0) {
    return 0;
  }

  if (!Number.isInteger(historyIndex)) {
    return historyLength - 1;
  }

  return Math.min(Math.max(Number(historyIndex), 0), historyLength - 1);
}

/** Validates that saved coordinates look complete and positive. */
export function isSavedCoordinatesUsable(coordinates: unknown): coordinates is SavedSelectionCoordinates {
  if (!coordinates || typeof coordinates !== 'object') {
    return false;
  }

  const value = coordinates as Partial<SavedSelectionCoordinates>;
  return Number.isFinite(value.startX)
    && Number.isFinite(value.startY)
    && Number.isFinite(value.width)
    && Number.isFinite(value.height)
    && Number(value.width) > 0
    && Number(value.height) > 0;
}

/** Returns the user-facing error message for missing saved scan coordinates. */
export function getMissingSavedCoordinatesMessage(kind: ScanKind): string {
  return normalizeScanKind(kind) === 'image'
    ? 'No previous image scan area was saved yet.'
    : 'No previous text scan area was saved yet.';
}

/** Converts unknown values to trimmed strings for storage and UI normalization. */
export function normalizeOptionalString(value: unknown): string {
  return String(value || '').trim();
}

/** Validates that an unknown object matches the stored history entry shape. */
function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Partial<HistoryEntry>;
  return typeof entry.input === 'string'
    && typeof entry.output === 'string'
    && typeof entry.inputImageDataUrl === 'string'
    && (entry.type === 'text' || entry.type === 'image' || entry.type === 'ask')
    && Number.isFinite(entry.createdAt);
}
