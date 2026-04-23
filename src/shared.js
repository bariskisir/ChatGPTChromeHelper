(function attachSharedHelpers(global) {
  const DEFAULT_MODEL = 'gpt-5.4-mini';
  const AREA_OVERLAY_ID = 'ai-chrome-helper-area-overlay';
  const MODEL_OPTIONS = new Set(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2']);
  const TEXT_SOLVER_PROMPT = 'You are a careful problem solver. Read the selected content, solve accurately, and give the final answer clearly.';
  const IMAGE_SOLVER_PROMPT = 'You are a careful image problem solver. Analyze the selected image area, solve math accurately, interpret charts, diagrams, UI, or other image content when present, and give the key answer concisely and clearly.';
  const SYSTEM_PROMPTS = Object.freeze({
    solver: Object.freeze({
      text: TEXT_SOLVER_PROMPT,
      image: IMAGE_SOLVER_PROMPT
    })
  });
  const STORAGE_KEYS = Object.freeze([
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
  ]);
  const STATUS_STORAGE_KEYS = Object.freeze([
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
  ]);
  const SCAN_SETTINGS = Object.freeze({
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
  const SCAN_KINDS = Object.freeze(Object.keys(SCAN_SETTINGS));

  function normalizeScanKind(kind) {
    return Object.hasOwn(SCAN_SETTINGS, kind) ? kind : 'text';
  }

  function getScanSettings(kind) {
    return SCAN_SETTINGS[normalizeScanKind(kind)];
  }

  function getAreaOverlayOptions(kind) {
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

  function normalizeStoredModel(selectedModel, customModel) {
    if (selectedModel === 'other') {
      return 'other';
    }

    if (MODEL_OPTIONS.has(selectedModel)) {
      return selectedModel;
    }

    if (customModel) {
      return 'other';
    }

    return DEFAULT_MODEL;
  }

  function resolveModelValue(selectedModel, customModel) {
    if (selectedModel === 'other') {
      return normalizeOptionalString(customModel) || DEFAULT_MODEL;
    }

    return MODEL_OPTIONS.has(selectedModel) ? selectedModel : DEFAULT_MODEL;
  }

  function normalizeSystemPromptPreset(preset, customPrompt) {
    if (preset === 'other') {
      return 'other';
    }

    if (preset === 'none') {
      return 'none';
    }

    if (Object.hasOwn(SYSTEM_PROMPTS, preset)) {
      return preset;
    }

    if (customPrompt) {
      return 'other';
    }

    return 'solver';
  }

  function resolveSystemPrompt(preset, customPrompt, kind) {
    if (preset === 'other') {
      return normalizeOptionalString(customPrompt) || getSolverPrompt(kind);
    }

    if (preset === 'none') {
      return '';
    }

    return getSolverPrompt(kind);
  }

  function getSolverPrompt(kind) {
    return getScanSettings(kind).solverPrompt;
  }

  function createHistoryEntry(input, output, type, inputImageDataUrl) {
    return {
      input: input || '',
      inputImageDataUrl: inputImageDataUrl || '',
      output: output || '',
      type: type || '',
      createdAt: Date.now()
    };
  }

  function getNormalizedHistory(history, lastResponse) {
    if (Array.isArray(history)) {
      return history;
    }

    if (!lastResponse) {
      return [];
    }

    return [{
      input: 'Legacy response',
      output: lastResponse
    }];
  }

  function getNormalizedHistoryIndex(historyIndex, historyLength) {
    if (historyLength <= 0) {
      return 0;
    }

    if (!Number.isInteger(historyIndex)) {
      return historyLength - 1;
    }

    return Math.min(Math.max(historyIndex, 0), historyLength - 1);
  }

  function isSavedCoordinatesUsable(coordinates) {
    return Boolean(coordinates)
      && Number.isFinite(coordinates.startX)
      && Number.isFinite(coordinates.startY)
      && Number.isFinite(coordinates.width)
      && Number.isFinite(coordinates.height)
      && coordinates.width > 0
      && coordinates.height > 0;
  }

  function getMissingSavedCoordinatesMessage(kind) {
    return normalizeScanKind(kind) === 'image'
      ? 'No previous image scan area was saved yet.'
      : 'No previous text scan area was saved yet.';
  }

  function normalizeOptionalString(value) {
    return String(value || '').trim();
  }

  global.ChatGptChromeHelperShared = Object.freeze({
    DEFAULT_MODEL,
    AREA_OVERLAY_ID,
    MODEL_OPTIONS,
    TEXT_SOLVER_PROMPT,
    IMAGE_SOLVER_PROMPT,
    SYSTEM_PROMPTS,
    STORAGE_KEYS,
    STATUS_STORAGE_KEYS,
    SCAN_SETTINGS,
    SCAN_KINDS,
    normalizeScanKind,
    getScanSettings,
    getAreaOverlayOptions,
    normalizeStoredModel,
    resolveModelValue,
    normalizeSystemPromptPreset,
    resolveSystemPrompt,
    getSolverPrompt,
    createHistoryEntry,
    getNormalizedHistory,
    getNormalizedHistoryIndex,
    isSavedCoordinatesUsable,
    getMissingSavedCoordinatesMessage,
    normalizeOptionalString
  });
})(globalThis);
