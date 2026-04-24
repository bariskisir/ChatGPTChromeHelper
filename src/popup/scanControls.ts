/** Owns popup scan controls for model, thinking, prompt, and scan actions. */
import {
  DEFAULT_MODEL,
  DEFAULT_THINKING_VARIANT,
  SCAN_KINDS,
  filterAvailableModelsByKind,
  findAvailableModelForKind,
  getDefaultAvailableModel,
  getDefaultThinkingVariantForModel,
  getScanSettings,
  getSupportedThinkingVariants,
  normalizeStoredModel,
  normalizeSystemPromptPreset,
  normalizeThinkingVariant
} from '../common/scanSettings';
import { sendRuntimeMessage } from '../common/messages';
import { setStorage } from '../common/storage';
import { setBusy } from './errors';
import type {
  AvailableModel,
  ModelSelection,
  PopupElements,
  ScanControl,
  ScanControlElements,
  ScanKind,
  StatusPayload,
  SystemPromptPreset,
  ThinkingVariant
} from '../common/types';

const REFRESH_ICON = '\u21BB';

interface ScanStatusValues {
  model: ModelSelection;
  customModel: string;
  thinkingVariant: ThinkingVariant;
  systemPromptPreset: SystemPromptPreset;
  customSystemPrompt: string;
}

type ErrorHandler = (message: string) => void;
type RefreshStatus = () => Promise<void>;

/** Builds the scan-control map for text and image scan sections. */
export function createScanControls(elements: PopupElements): Record<ScanKind, ScanControl> {
  return {
    text: createScanControl('text', {
      button: elements.textScanButton,
      modelSelect: elements.textModelSelect,
      thinkingSelect: elements.textThinkingSelect,
      refreshButton: elements.textModelRefreshButton,
      customModelInput: elements.textCustomModel,
      systemPromptSelect: elements.textSystemPromptSelect,
      customSystemPromptInput: elements.textCustomSystemPrompt
    }),
    image: createScanControl('image', {
      button: elements.imageScanButton,
      modelSelect: elements.imageModelSelect,
      thinkingSelect: elements.imageThinkingSelect,
      refreshButton: elements.imageModelRefreshButton,
      customModelInput: elements.imageCustomModel,
      systemPromptSelect: elements.imageSystemPromptSelect,
      customSystemPromptInput: elements.imageCustomSystemPrompt
    })
  };
}

/** Wires all scan-setting controls and scan trigger buttons. */
export function bindScanControls(
  scanControls: Record<ScanKind, ScanControl>,
  showError: ErrorHandler,
  refreshStatus: RefreshStatus
): void {
  forEachScanControl(scanControls, (kind, controls) => {
    controls.button.addEventListener('click', () => {
      void triggerScan(scanControls, kind, showError);
    });
    controls.refreshButton.addEventListener('click', () => {
      void handleRefreshModelsClick(controls.refreshButton, showError, refreshStatus);
    });
    bindScanControlEvents(scanControls, kind);
  });
}

/** Renders model and system-prompt controls from the latest status payload. */
export function renderScanControls(scanControls: Record<ScanKind, ScanControl>, status: StatusPayload): void {
  forEachScanControl(scanControls, (kind, controls) => {
    renderModelOptions(controls, status.availableModels);
    const values = getScanStatusValues(scanControls, kind, status);
    setModelControls(controls, values.model, values.customModel);
    renderThinkingOptions(controls, status.availableModels, values.model, values.thinkingVariant);
    setSystemPromptControls(controls, values.systemPromptPreset, values.customSystemPrompt);
  });
}

/** Applies scan-specific placeholders and metadata to a popup control group. */
function createScanControl(kind: ScanKind, controls: ScanControlElements): ScanControl {
  const settings = getScanSettings(kind);
  controls.customModelInput.placeholder = settings.customModelPlaceholder;
  controls.customSystemPromptInput.placeholder = settings.customSystemPromptPlaceholder;
  return {
    ...controls,
    settings
  };
}

/** Wires model and system-prompt persistence for one scan control group. */
function bindScanControlEvents(scanControls: Record<ScanKind, ScanControl>, kind: ScanKind): void {
  const controls = getScanControls(scanControls, kind);
  controls.modelSelect.addEventListener('change', () => {
    void saveModelChoice(scanControls, kind);
  });
  controls.thinkingSelect.addEventListener('change', () => {
    void saveThinkingVariantChoice(scanControls, kind);
  });
  controls.systemPromptSelect.addEventListener('change', () => {
    void saveSystemPromptChoice(scanControls, kind);
  });
  controls.customSystemPromptInput.addEventListener('input', () => {
    void saveSystemPromptChoice(scanControls, kind);
  });
}

/** Extracts one scan mode's model and prompt values from the full status payload. */
function getScanStatusValues(
  scanControls: Record<ScanKind, ScanControl>,
  kind: ScanKind,
  status: StatusPayload
): ScanStatusValues {
  const { settings } = getScanControls(scanControls, kind);
  const selectableModels = filterAvailableModelsByKind(status.availableModels, kind);
  const selectedModel = normalizeStoredModel(status[settings.modelKey], status[settings.customModelKey], selectableModels);
  return {
    model: selectedModel,
    customModel: status[settings.customModelKey] || '',
    thinkingVariant: normalizeThinkingVariant(
      status[settings.thinkingVariantKey],
      selectedModel,
      selectableModels
    ),
    systemPromptPreset: normalizeSystemPromptPreset(
      status[settings.systemPromptPresetKey],
      status[settings.customSystemPromptKey]
    ),
    customSystemPrompt: status[settings.customSystemPromptKey] || ''
  };
}

/** Updates the model select and custom-model input for one scan mode. */
function setModelControls(
  controls: ScanControl,
  selectedModel: ModelSelection,
  customModel: string
): void {
  const optionValues = new Set(Array.from(controls.modelSelect.options).map((option) => option.value));
  const fallbackValue = controls.modelSelect.dataset.defaultModel || DEFAULT_MODEL;
  controls.modelSelect.value = optionValues.has(selectedModel) ? selectedModel : fallbackValue;
  controls.customModelInput.value = customModel;
  controls.customModelInput.hidden = true;
}

/** Persists the popup's current model selection for a scan mode. */
async function saveModelChoice(scanControls: Record<ScanKind, ScanControl>, kind: ScanKind): Promise<void> {
  const controls = getScanControls(scanControls, kind);
  const { settings } = controls;
  const selectedModel = controls.modelSelect.value as ModelSelection;
  controls.customModelInput.hidden = true;
  controls.customModelInput.value = '';
  const status = await sendRuntimeMessage({ action: 'getStatus' });
  if (status.ok) {
    const selectableModels = filterAvailableModelsByKind(status.availableModels, kind);
    const normalizedModel = normalizeStoredModel(selectedModel, '', selectableModels);
    const defaultThinkingVariant = getDefaultThinkingVariantForModel(normalizedModel, selectableModels);

    await setStorage({
      [settings.modelKey]: normalizedModel,
      [settings.customModelKey]: '',
      [settings.thinkingVariantKey]: defaultThinkingVariant
    });

    renderThinkingOptions(
      controls,
      status.availableModels,
      normalizedModel,
      defaultThinkingVariant
    );
  }
}

/** Renders the runtime model catalog for a scan mode. */
function renderModelOptions(controls: ScanControl, availableModels: AvailableModel[]): void {
  const filteredModels = filterAvailableModelsByKind(availableModels, controls.settings.kind);
  const defaultModel = getDefaultAvailableModel(filteredModels);
  controls.modelSelect.dataset.defaultModel = defaultModel;
  controls.modelSelect.replaceChildren(
    ...filteredModels.map((model) => {
      const option = document.createElement('option');
      option.value = model.model;
      option.textContent = model.model;
      return option;
    })
  );
}

/** Renders the supported thinking variants for the currently selected model. */
function renderThinkingOptions(
  controls: ScanControl,
  availableModels: AvailableModel[],
  selectedModel: string,
  selectedThinkingVariant: ThinkingVariant
): void {
  const filteredModels = filterAvailableModelsByKind(availableModels, controls.settings.kind);
  const model = findAvailableModelForKind(availableModels, controls.settings.kind, selectedModel);
  const thinkingVariants = getSupportedThinkingVariants(selectedModel, filteredModels);
  controls.thinkingSelect.replaceChildren(
    ...thinkingVariants.map((item) => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.value;
      option.title = item.description;
      return option;
    })
  );
  controls.thinkingSelect.value = thinkingVariants.some((item) => item.value === selectedThinkingVariant)
    ? selectedThinkingVariant
    : model?.defaultThinkingVariant || DEFAULT_THINKING_VARIANT;
}

/** Persists the popup's current thinking variant for a scan mode. */
async function saveThinkingVariantChoice(scanControls: Record<ScanKind, ScanControl>, kind: ScanKind): Promise<void> {
  const controls = getScanControls(scanControls, kind);
  const { settings } = controls;
  await setStorage({
    [settings.thinkingVariantKey]: controls.thinkingSelect.value as ThinkingVariant
  });
}

/** Refreshes the remote model catalog from the popup refresh button. */
async function handleRefreshModelsClick(
  button: HTMLButtonElement,
  showError: ErrorHandler,
  refreshStatus: RefreshStatus
): Promise<void> {
  setBusy(button, true, REFRESH_ICON);
  try {
    const result = await sendRuntimeMessage({ action: 'refreshModels' });
    if (!result.ok) {
      showError(result.error || 'Could not refresh models.');
      return;
    }
    await refreshStatus();
  } finally {
    setBusy(button, false, REFRESH_ICON);
  }
}

/** Updates the prompt preset UI and input behavior for one scan mode. */
function setSystemPromptControls(controls: ScanControl, selectedPreset: SystemPromptPreset, customPrompt: string): void {
  const { settings } = controls;
  controls.systemPromptSelect.value = selectedPreset;
  controls.customSystemPromptInput.dataset.customPrompt = customPrompt || '';

  if (selectedPreset === 'solver') {
    setReadOnlyPromptInput(controls, settings.solverPrompt);
    return;
  }

  if (selectedPreset === 'other') {
    setEditablePromptInput(controls, customPrompt || '');
    return;
  }

  setReadOnlyPromptInput(controls, '');
}

/** Persists the popup's current system-prompt preset for a scan mode. */
async function saveSystemPromptChoice(scanControls: Record<ScanKind, ScanControl>, kind: ScanKind): Promise<void> {
  const controls = getScanControls(scanControls, kind);
  const { settings } = controls;
  const selectedPreset = controls.systemPromptSelect.value as SystemPromptPreset;
  let customPrompt = '';

  if (selectedPreset === 'solver') {
    setReadOnlyPromptInput(controls, settings.solverPrompt);
  } else if (selectedPreset === 'other') {
    if (controls.customSystemPromptInput.value === settings.solverPrompt) {
      controls.customSystemPromptInput.value = controls.customSystemPromptInput.dataset.customPrompt || '';
    }

    customPrompt = controls.customSystemPromptInput.value.trim();
    controls.customSystemPromptInput.dataset.customPrompt = customPrompt;
    controls.customSystemPromptInput.hidden = false;
    controls.customSystemPromptInput.readOnly = false;
    controls.customSystemPromptInput.placeholder = settings.customSystemPromptPlaceholder;
  } else {
    setReadOnlyPromptInput(controls, '');
  }

  await setStorage({
    [settings.systemPromptPresetKey]: selectedPreset,
    [settings.customSystemPromptKey]: selectedPreset === 'other' ? customPrompt : ''
  });
}

/** Locks the system-prompt input and shows a fixed value. */
function setReadOnlyPromptInput(controls: ScanControl, value: string): void {
  controls.customSystemPromptInput.hidden = false;
  controls.customSystemPromptInput.readOnly = true;
  controls.customSystemPromptInput.placeholder = '';
  controls.customSystemPromptInput.value = value;
}

/** Unlocks the system-prompt input for custom editing. */
function setEditablePromptInput(controls: ScanControl, value: string): void {
  controls.customSystemPromptInput.hidden = false;
  controls.customSystemPromptInput.readOnly = false;
  controls.customSystemPromptInput.placeholder = controls.settings.customSystemPromptPlaceholder;
  controls.customSystemPromptInput.value = value;
}

/** Starts the selected scan flow from the popup. */
async function triggerScan(
  scanControls: Record<ScanKind, ScanControl>,
  kind: ScanKind,
  showError: ErrorHandler
): Promise<void> {
  const controls = getScanControls(scanControls, kind);
  setBusy(controls.button, true, 'Select area...');

  try {
    const result = await sendRuntimeMessage({ action: controls.settings.triggerAction });
    if (!result.ok) {
      showError(result.error || 'Could not start scan.');
      return;
    }

    showError('');
    window.close();
  } finally {
    setBusy(controls.button, false, controls.settings.buttonLabel);
  }
}

/** Returns the scan-control bundle for a requested mode. */
function getScanControls(scanControls: Record<ScanKind, ScanControl>, kind: ScanKind): ScanControl {
  return scanControls[kind] || scanControls.text;
}

/** Runs shared text/image control logic through one callback. */
function forEachScanControl(
  scanControls: Record<ScanKind, ScanControl>,
  callback: (kind: ScanKind, controls: ScanControl) => void
): void {
  for (const kind of SCAN_KINDS) {
    callback(kind, getScanControls(scanControls, kind));
  }
}
