/** Stores extension-wide scan defaults, storage keys, and normalization helpers. */
import type {
  AvailableModel,
  AreaOverlayOptions,
  ExtensionStorage,
  HistoryEntry,
  HistoryEntryType,
  KnownModel,
  ModelSelection,
  ScanKind,
  ScanSettings,
  SavedSelectionCoordinates,
  SystemPromptPreset,
  ThinkingVariant,
  ThinkingVariantOption
} from './types';

export const DEFAULT_MODEL: KnownModel = 'gpt-5.4-mini';
export const DEFAULT_THINKING_VARIANT: ThinkingVariant = 'medium';
export const AREA_OVERLAY_ID = 'ai-chrome-helper-area-overlay';

const DEFAULT_INPUT_MODALITIES: ScanKind[] = ['text', 'image'];
const FALLBACK_THINKING_VARIANTS = Object.freeze<ThinkingVariantOption[]>([
  { value: 'low', description: 'Fast responses with lighter reasoning' },
  { value: 'medium', description: 'Balanced reasoning for everyday tasks' },
  { value: 'high', description: 'Greater reasoning depth for complex tasks' },
  { value: 'xhigh', description: 'Extra high reasoning depth for complex tasks' }
]);

export const FALLBACK_MODELS = Object.freeze<AvailableModel[]>([
  createAvailableModel({
    id: 'gpt-5.4',
    model: 'gpt-5.4',
    isDefault: false
  }),
  createAvailableModel({
    id: 'gpt-5.4-mini',
    model: 'gpt-5.4-mini',
    isDefault: true
  })
]);

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
  'availableModels',
  'codexClientVersion',
  'lastTextScanCoordinates',
  'lastImageScanCoordinates',
  'textScanModel',
  'textScanCustomModel',
  'textScanThinkingVariant',
  'imageScanModel',
  'imageScanCustomModel',
  'imageScanThinkingVariant',
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
  'availableModels',
  'codexClientVersion',
  'textScanModel',
  'textScanCustomModel',
  'textScanThinkingVariant',
  'imageScanModel',
  'imageScanCustomModel',
  'imageScanThinkingVariant',
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
    thinkingVariantKey: 'textScanThinkingVariant',
    systemPromptPresetKey: 'textSystemPromptPreset',
    customSystemPromptKey: 'textCustomSystemPrompt',
    customSystemPromptPlaceholder: 'Enter text scan system prompt',
    overlayFile: 'selectionOverlay.js',
    overlayLabel: 'Text Scan - select an area',
    minWidth: 30,
    minHeight: 30,
    borderColor: '#0f9f8f',
    fillColor: 'rgba(15, 159, 143, 0.14)',
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
    thinkingVariantKey: 'imageScanThinkingVariant',
    systemPromptPresetKey: 'imageSystemPromptPreset',
    customSystemPromptKey: 'imageCustomSystemPrompt',
    customSystemPromptPlaceholder: 'Enter image scan system prompt',
    overlayFile: 'imageSelectionOverlay.js',
    overlayLabel: 'Image Scan - select an area',
    minWidth: 45,
    minHeight: 45,
    borderColor: '#f4c542',
    fillColor: 'rgba(244, 197, 66, 0.22)',
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

/** Normalizes a stored model selection against the currently available model catalog. */
export function normalizeStoredModel(
  selectedModel: unknown,
  customModel: unknown,
  availableModels: AvailableModel[] = getAvailableModels()
): ModelSelection {
  const normalizedModel = normalizeOptionalString(selectedModel);
  return normalizedModel && hasAvailableModel(normalizedModel, availableModels)
    ? normalizedModel as KnownModel
    : getDefaultAvailableModel(availableModels);
}

/** Resolves the final model name that should be sent to ChatGPT. */
export function resolveModelValue(
  selectedModel: unknown,
  customModel: unknown,
  availableModels: AvailableModel[] = getAvailableModels()
): string {
  return normalizeStoredModel(selectedModel, customModel, availableModels);
}

/** Normalizes a stored thinking variant against the selected model's supported variants. */
export function normalizeThinkingVariant(
  selectedVariant: unknown,
  selectedModel: string,
  availableModels: AvailableModel[] = getAvailableModels()
): ThinkingVariant {
  const supportedVariants = getSupportedThinkingVariants(selectedModel, availableModels);
  const normalizedVariant = normalizeOptionalString(selectedVariant) as ThinkingVariant;
  return supportedVariants.some((variant) => variant.value === normalizedVariant)
    ? normalizedVariant
    : getDefaultThinkingVariantForModel(selectedModel, availableModels);
}

/** Normalizes an unknown model catalog payload into a safe runtime-ready list. */
export function normalizeAvailableModelsCatalog(
  models: unknown,
  fallbackModels: AvailableModel[] = getAvailableModels()
): AvailableModel[] {
  if (!Array.isArray(models)) {
    return cloneAvailableModels(fallbackModels);
  }

  const normalizedModels = models
    .map((model) => normalizeAvailableModelEntry(model, fallbackModels))
    .filter((model): model is AvailableModel => model !== null);

  return normalizedModels.length > 0 ? normalizedModels : cloneAvailableModels(fallbackModels);
}

/** Validates one available-model entry read from storage or runtime payloads. */
export function normalizeAvailableModelEntry(
  value: unknown,
  fallbackModels: AvailableModel[] = getAvailableModels()
): AvailableModel | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<AvailableModel>;
  const normalizedModel = normalizeOptionalString(candidate.model);
  if (!normalizedModel) {
    return null;
  }

  const inputModalities = normalizeInputModalities(candidate.inputModalities);
  const thinkingVariants = normalizeThinkingOptions(candidate.thinkingVariants);

  return {
    id: normalizeOptionalString(candidate.id) || normalizedModel,
    model: normalizedModel,
    displayName: normalizeOptionalString(candidate.displayName) || normalizedModel,
    description: normalizeOptionalString(candidate.description),
    availableInPlans: normalizePlanNames(candidate.availableInPlans),
    hidden: candidate.hidden === true,
    isDefault: candidate.isDefault === true,
    inputModalities,
    defaultThinkingVariant: normalizeThinkingVariant(candidate.defaultThinkingVariant, normalizedModel, fallbackModels),
    thinkingVariants
  };
}

/** Returns the visible models for a given scan kind, with a non-empty fallback. */
export function filterAvailableModelsByKind(models: AvailableModel[], kind: ScanKind): AvailableModel[] {
  const visibleModels = models.filter((model) => !model.hidden && model.inputModalities.includes(kind));
  return visibleModels.length > 0 ? visibleModels : models.filter((model) => !model.hidden);
}

/** Finds a model within the current scan-kind subset, falling back to the default visible model. */
export function findAvailableModelForKind(
  models: AvailableModel[],
  kind: ScanKind,
  selectedModel: string
): AvailableModel | undefined {
  const availableModels = filterAvailableModelsByKind(models, kind);
  return findAvailableModel(selectedModel, availableModels)
    || availableModels.find((model) => model.isDefault)
    || availableModels[0];
}

/** Returns the supported thinking variants for a selected model, with a fallback entry. */
export function getSupportedThinkingVariants(
  selectedModel: string,
  availableModels: AvailableModel[] = getAvailableModels()
): ThinkingVariantOption[] {
  const matchedModel = findAvailableModel(selectedModel, availableModels)
    || availableModels.find((model) => model.isDefault)
    || availableModels[0];
  const thinkingVariants = matchedModel?.thinkingVariants ?? [];
  return thinkingVariants.length > 0
    ? thinkingVariants.map((variant) => ({ ...variant }))
    : getFallbackThinkingVariants();
}

/** Returns the default reasoning level for the selected model or the extension fallback. */
export function getDefaultThinkingVariantForModel(
  selectedModel: string,
  availableModels: AvailableModel[] = getAvailableModels()
): ThinkingVariant {
  return findAvailableModel(selectedModel, availableModels)?.defaultThinkingVariant
    || availableModels.find((model) => model.isDefault)?.defaultThinkingVariant
    || DEFAULT_THINKING_VARIANT;
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

  return normalizeOptionalString(customPrompt) ? 'other' : 'solver';
}

/** Resolves the effective system prompt string for a given scan mode. */
export function resolveSystemPrompt(preset: unknown, customPrompt: unknown, kind: ScanKind): string {
  if (preset === 'other') {
    return normalizeOptionalString(customPrompt) || getSolverPrompt(kind);
  }

  return preset === 'none' ? '' : getSolverPrompt(kind);
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

/** Returns the current fallback model catalog used before remote models are fetched. */
export function getAvailableModels(): AvailableModel[] {
  return cloneAvailableModels(FALLBACK_MODELS);
}

/** Picks the default model slug from a model catalog, falling back to the extension default. */
export function getDefaultAvailableModel(models: AvailableModel[]): string {
  return models.find((model) => model.isDefault)?.model || models[0]?.model || DEFAULT_MODEL;
}

/** Returns cloned fallback thinking variants. */
export function getFallbackThinkingVariants(): ThinkingVariantOption[] {
  return FALLBACK_THINKING_VARIANTS.map((variant) => ({ ...variant }));
}

function createAvailableModel(overrides: Pick<AvailableModel, 'id' | 'model' | 'isDefault'>): AvailableModel {
  return {
    id: overrides.id,
    model: overrides.model,
    displayName: overrides.model,
    description: '',
    availableInPlans: [],
    hidden: false,
    isDefault: overrides.isDefault,
    inputModalities: [...DEFAULT_INPUT_MODALITIES],
    defaultThinkingVariant: DEFAULT_THINKING_VARIANT,
    thinkingVariants: getFallbackThinkingVariants()
  };
}

function cloneAvailableModels(models: readonly AvailableModel[]): AvailableModel[] {
  return models.map((model) => ({
    ...model,
    availableInPlans: [...model.availableInPlans],
    inputModalities: [...model.inputModalities],
    thinkingVariants: model.thinkingVariants.map((variant) => ({ ...variant }))
  }));
}

function hasAvailableModel(modelName: string, availableModels: AvailableModel[]): boolean {
  return availableModels.some((model) => model.model === modelName);
}

function findAvailableModel(modelName: string, availableModels: AvailableModel[]): AvailableModel | undefined {
  return availableModels.find((model) => model.model === modelName);
}

function normalizeInputModalities(value: unknown): ScanKind[] {
  const inputModalities = Array.isArray(value)
    ? value.filter((item): item is ScanKind => item === 'text' || item === 'image')
    : DEFAULT_INPUT_MODALITIES;
  return inputModalities.length > 0 ? inputModalities : [...DEFAULT_INPUT_MODALITIES];
}

function normalizeThinkingOptions(value: unknown): ThinkingVariantOption[] {
  const thinkingVariants = Array.isArray(value)
    ? value
      .map((item) => normalizeThinkingOption(item))
      .filter((item): item is ThinkingVariantOption => item !== null)
    : [];

  return thinkingVariants.length > 0 ? thinkingVariants : getFallbackThinkingVariants();
}

function normalizeThinkingOption(value: unknown): ThinkingVariantOption | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<ThinkingVariantOption>;
  const normalizedValue = normalizeOptionalString(candidate.value) as ThinkingVariant;
  if (!normalizedValue) {
    return null;
  }

  return {
    value: normalizedValue,
    description: normalizeOptionalString(candidate.description) || normalizedValue
  };
}

function normalizePlanNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .map((item) => normalizeOptionalString(item).toLowerCase())
      .filter(Boolean)
    : [];
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
