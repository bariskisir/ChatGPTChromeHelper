/** Powers the extension popup UI, including auth state, scan settings, and history browsing. */
import {
  DEFAULT_MODEL,
  DEFAULT_THINKING_VARIANT,
  filterAvailableModelsByKind,
  getDefaultAvailableModel,
  getDefaultThinkingVariantForModel,
  SCAN_KINDS,
  getNormalizedHistory,
  getNormalizedHistoryIndex,
  getScanSettings,
  getSupportedThinkingVariants,
  findAvailableModelForKind,
  normalizeThinkingVariant,
  normalizeStoredModel,
  normalizeSystemPromptPreset
} from './lib/shared';
import { isRuntimeEventMessage, sendRuntimeMessage } from './lib/messages';
import { setStorage } from './lib/storage';
import type {
  AvailableModel,
  ErrorResult,
  HistoryEntry,
  LimitInfo,
  LimitInfoItem,
  ModelSelection,
  PopupElements,
  Result,
  RuntimeEventMessage,
  ScanControl,
  ScanControlElements,
  ScanKind,
  StatusPayload,
  ThinkingVariant,
  SystemPromptPreset
} from './lib/types';

const EXTERNAL_LINKS = {
  developer: 'https://www.bariskisir.com',
  source: 'https://github.com/bariskisir/ChatGPTChromeHelper'
} as const;
const REFRESH_ICON = '\u21BB';

const elements = getElements();
const popupState: {
  history: HistoryEntry[];
  historyIndex: number;
} = {
  history: [],
  historyIndex: 0
};
const scanControls = createScanControls();

interface ScanStatusValues {
  model: ModelSelection;
  customModel: string;
  thinkingVariant: ThinkingVariant;
  systemPromptPreset: SystemPromptPreset;
  customSystemPrompt: string;
}

document.addEventListener('DOMContentLoaded', handlePopupDomReady);
chrome.runtime.onMessage.addListener(handlePopupRuntimeMessage);

/** Starts popup initialization once the DOM is ready. */
function handlePopupDomReady(): void {
  initializePopup();
}

/** Refreshes popup state when the background script broadcasts relevant events. */
function handlePopupRuntimeMessage(incoming: unknown): boolean {
  if (!isRuntimeEventMessage(incoming)) {
    return false;
  }

  handleRuntimeEvent(incoming);
  return false;
}

/** Binds popup events and loads the initial extension status. */
function initializePopup(): void {
  bindEvents();
  void refreshStatus();
}

/** Responds to runtime events that should refresh popup state. */
function handleRuntimeEvent(message: RuntimeEventMessage): void {
  if (message.action === 'authChanged' || message.action === 'responseUpdated') {
    void refreshStatus();
  }
}

/** Builds the scan-control map for text and image scan sections. */
function createScanControls(): Record<ScanKind, ScanControl> {
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

/** Wires every popup button, link, and scan-setting control to its handler. */
function bindEvents(): void {
  elements.loginButton.addEventListener('click', handleLoginClick);
  elements.signOutButton.addEventListener('click', handleSignOutClick);
  elements.developerLink.addEventListener('click', handleDeveloperLinkClick);
  elements.sourceLink.addEventListener('click', handleSourceLinkClick);
  elements.historyPrev.addEventListener('click', handleHistoryPrevClick);
  elements.historyNext.addEventListener('click', handleHistoryNextClick);
  elements.deleteHistoryButton.addEventListener('click', handleDeleteHistoryClick);
  elements.copyInputButton.addEventListener('click', handleCopyInputClick);
  elements.copyOutputButton.addEventListener('click', handleCopyOutputClick);

  forEachScanControl((kind, controls) => {
    controls.button.addEventListener('click', () => {
      void triggerScan(kind);
    });
    controls.refreshButton.addEventListener('click', () => {
      void handleRefreshModelsClick(controls.refreshButton);
    });
    bindScanControlEvents(kind);
  });
}

/** Opens the developer website in a new tab. */
function handleDeveloperLinkClick(): void {
  openExternalTab(EXTERNAL_LINKS.developer);
}

/** Opens the source repository in a new tab. */
function handleSourceLinkClick(): void {
  openExternalTab(EXTERNAL_LINKS.source);
}

/** Moves popup history one entry backward. */
function handleHistoryPrevClick(): void {
  moveHistory(-1);
}

/** Moves popup history one entry forward. */
function handleHistoryNextClick(): void {
  moveHistory(1);
}

/** Copies the current history input text to the clipboard. */
function handleCopyInputClick(): void {
  void copyHistoryField('input', elements.copyInputButton);
}

/** Copies the current history output text to the clipboard. */
function handleCopyOutputClick(): void {
  void copyHistoryField('output', elements.copyOutputButton);
}

/** Wires model and system-prompt persistence for one scan control group. */
function bindScanControlEvents(kind: ScanKind): void {
  const controls = getScanControls(kind);
  controls.modelSelect.addEventListener('change', () => {
    void saveModelChoice(kind);
  });
  controls.thinkingSelect.addEventListener('change', () => {
    void saveThinkingVariantChoice(kind);
  });
  controls.systemPromptSelect.addEventListener('change', () => {
    void saveSystemPromptChoice(kind);
  });
  controls.customSystemPromptInput.addEventListener('input', () => {
    void saveSystemPromptChoice(kind);
  });
}

/** Starts the ChatGPT OAuth flow from the popup. */
async function handleLoginClick(): Promise<void> {
  setBusy(elements.loginButton, true, 'Opening...');

  try {
    const result = await sendRuntimeMessage<Result>({ action: 'startLogin' });
    if (!result.ok) {
      showError(result.error || 'Could not start ChatGPT login.');
      return;
    }

    showError('');
    window.close();
  } finally {
    setBusy(elements.loginButton, false, 'Sign in with ChatGPT');
  }
}

/** Signs the current user out and refreshes the popup state. */
async function handleSignOutClick(): Promise<void> {
  const result = await sendRuntimeMessage<Result>({ action: 'signOut' });
  if (!result.ok) {
    showError(result.error || 'Could not sign out.');
    return;
  }

  showError('');
  await refreshStatus();
}

/** Clears stored history and resets the popup history viewer. */
async function handleDeleteHistoryClick(): Promise<void> {
  const result = await sendRuntimeMessage<Result>({ action: 'deleteHistory' });
  if (!result.ok) {
    showError(result.error || 'Could not delete history.');
    return;
  }

  popupState.history = [];
  popupState.historyIndex = 0;
  showError('');
  renderHistory();
}

/** Fetches the latest extension status and rerenders popup sections. */
async function refreshStatus(): Promise<void> {
  const status = await sendRuntimeMessage<StatusPayload | ErrorResult>({ action: 'getStatus' });
  if (!status.ok) {
    showError(status.error || 'Could not load extension status.');
    return;
  }

  renderSession(status);
  syncHistoryState(status);
  renderHistory();
  renderScanControls(status);
  showError(status.authError || '');
}

/** Renders the signed-in or signed-out session state. */
function renderSession(status: StatusPayload): void {
  const loggedIn = Boolean(status.loggedIn);
  elements.signedOutView.hidden = loggedIn;
  elements.signedInView.hidden = !loggedIn;
  elements.accountLabel.textContent = loggedIn
    ? status.accountEmail || 'Signed in to ChatGPT'
    : 'Not signed in';
  renderPlanLabel(loggedIn ? status.limitInfo?.planName || '' : '');
  renderLimitInfo(loggedIn ? status.limitInfo : null);
}

/** Copies normalized history data from the background status into popup state. */
function syncHistoryState(status: StatusPayload): void {
  popupState.history = getNormalizedHistory(status.history, status.lastResponse);
  popupState.historyIndex = getNormalizedHistoryIndex(status.historyIndex, popupState.history.length);
}

/** Moves the active history pointer and persists the new index. */
function moveHistory(delta: number): void {
  if (popupState.history.length === 0) {
    return;
  }

  popupState.historyIndex = getNormalizedHistoryIndex(
    popupState.historyIndex + delta,
    popupState.history.length
  );
  void setStorage({ historyIndex: popupState.historyIndex });
  renderHistory();
}

/** Renders the currently selected history entry or an empty state. */
function renderHistory(): void {
  if (popupState.history.length === 0) {
    applyEmptyHistoryState();
    return;
  }

  const entry = popupState.history[popupState.historyIndex];
  if (!entry) {
    applyEmptyHistoryState();
    return;
  }

  renderHistoryInput(entry);
  elements.historyOutput.textContent = entry.output || 'No output recorded.';
  elements.historyCounter.textContent = `${popupState.historyIndex + 1} / ${popupState.history.length}`;
  elements.historyPrev.disabled = popupState.historyIndex <= 0;
  elements.historyNext.disabled = popupState.historyIndex >= popupState.history.length - 1;
  elements.deleteHistoryButton.disabled = false;
  elements.copyInputButton.disabled = !hasVisibleText(entry.input);
  elements.copyOutputButton.disabled = !hasVisibleText(entry.output);
}

/** Renders either the input image preview or the input text for a history entry. */
function renderHistoryInput(entry: HistoryEntry): void {
  if (entry.type === 'image' && entry.inputImageDataUrl) {
    elements.historyInputImage.src = entry.inputImageDataUrl;
    elements.historyInputImage.hidden = false;
    elements.historyInputText.hidden = true;
    elements.historyInputText.textContent = '';
    return;
  }

  setHistoryInputText(entry.input || 'No input recorded.');
}

/** Applies the placeholder state shown when no history entries exist. */
function applyEmptyHistoryState(): void {
  setHistoryInputText('none');
  elements.historyOutput.textContent = 'none';
  elements.historyCounter.textContent = '0 / 0';
  elements.historyPrev.disabled = true;
  elements.historyNext.disabled = true;
  elements.deleteHistoryButton.disabled = true;
  elements.copyInputButton.disabled = true;
  elements.copyOutputButton.disabled = true;
}

/** Switches the history input area to a plain-text view. */
function setHistoryInputText(text: string): void {
  elements.historyInputImage.hidden = true;
  elements.historyInputImage.removeAttribute('src');
  elements.historyInputText.hidden = false;
  elements.historyInputText.textContent = String(text || '').trim();
}

/** Renders model and system-prompt controls from the latest status payload. */
function renderScanControls(status: StatusPayload): void {
  forEachScanControl((kind, controls) => {
    renderModelOptions(controls, status.availableModels);
    const values = getScanStatusValues(kind, status);
    setModelControls(controls, values.model, values.customModel);
    renderThinkingOptions(controls, status.availableModels, values.model, values.thinkingVariant);
    setSystemPromptControls(controls, values.systemPromptPreset, values.customSystemPrompt);
  });
}

/** Extracts one scan mode's model and prompt values from the full status payload. */
function getScanStatusValues(kind: ScanKind, status: StatusPayload): ScanStatusValues {
  const { settings } = getScanControls(kind);
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
async function saveModelChoice(kind: ScanKind): Promise<void> {
  const controls = getScanControls(kind);
  const { settings } = controls;
  const selectedModel = controls.modelSelect.value as ModelSelection;
  controls.customModelInput.hidden = true;
  controls.customModelInput.value = '';
  const status = await sendRuntimeMessage<StatusPayload | ErrorResult>({ action: 'getStatus' });
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

/** Renders the runtime model catalog for a scan mode and preserves the Other fallback. */
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
async function saveThinkingVariantChoice(kind: ScanKind): Promise<void> {
  const controls = getScanControls(kind);
  const { settings } = controls;
  await setStorage({
    [settings.thinkingVariantKey]: controls.thinkingSelect.value as ThinkingVariant
  });
}

/** Refreshes the remote model catalog from the popup refresh button. */
async function handleRefreshModelsClick(button: HTMLButtonElement): Promise<void> {
  setBusy(button, true, REFRESH_ICON);
  try {
    const result = await sendRuntimeMessage<Result>({ action: 'refreshModels' });
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
async function saveSystemPromptChoice(kind: ScanKind): Promise<void> {
  const controls = getScanControls(kind);
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

/** Returns the scan-control bundle for a requested mode. */
function getScanControls(kind: ScanKind): ScanControl {
  return scanControls[kind] || scanControls.text;
}

/** Runs shared text/image control logic through one callback. */
function forEachScanControl(callback: (kind: ScanKind, controls: ScanControl) => void): void {
  for (const kind of SCAN_KINDS) {
    callback(kind, getScanControls(kind));
  }
}

/** Starts the selected scan flow from the popup. */
async function triggerScan(kind: ScanKind): Promise<void> {
  const controls = getScanControls(kind);
  setBusy(controls.button, true, 'Select area...');

  try {
    const result = await sendRuntimeMessage<Result>({ action: controls.settings.triggerAction });
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

/** Renders or hides the popup error block. */
function showError(message: string): void {
  elements.authError.hidden = !message;
  elements.authError.textContent = message || '';
}

/** Shows the current subscription plan label when available. */
function renderPlanLabel(planName: string): void {
  const normalizedPlan = String(planName || '').trim();
  elements.planLabel.hidden = !normalizedPlan;
  elements.planLabel.textContent = normalizedPlan || '';
}

/** Renders the list of rate-limit items in the popup. */
function renderLimitInfo(limitInfo: LimitInfo | null): void {
  const items = Array.isArray(limitInfo?.items) ? limitInfo.items : [];
  elements.limitList.replaceChildren();

  if (items.length === 0) {
    elements.limitList.hidden = true;
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'limit-item';
    row.textContent = formatLimitItem(item);
    elements.limitList.appendChild(row);
  }

  elements.limitList.hidden = false;
}

/** Formats one rate-limit row for popup display. */
function formatLimitItem(item: LimitInfoItem): string {
  const featureLabel = String(item.featureLabel || '').trim();
  const windowLabel = String(item.windowLabel || '').trim();
  const label = [featureLabel, windowLabel].filter(Boolean).join(' ').trim() || windowLabel || 'Limit';
  return `${label}: ${formatLimitPercent(item.leftPercent)}% left, resets ${formatResetTime(item.resetsAt)}`;
}

/** Formats a percentage while keeping whole numbers compact. */
function formatLimitPercent(value: number): string {
  const rounded = Number(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Formats a Unix timestamp as a compact local reset time string. */
function formatResetTime(unixSeconds: number): string {
  try {
    const date = new Date(Number(unixSeconds) * 1000);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    if (sameDay) {
      return `${hours}:${minutes}`;
    }

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}.${month} ${hours}:${minutes}`;
  } catch {
    return '--:--';
  }
}

/** Updates a button's disabled state and visible label together. */
function setBusy(button: HTMLButtonElement, busy: boolean, label: string): void {
  button.disabled = busy;
  const labelElement = button.querySelector<HTMLElement>('.button-label');
  if (labelElement) {
    labelElement.textContent = label;
    return;
  }

  button.textContent = label;
}

/** Copies the active history field to the clipboard and briefly updates the button label. */
async function copyHistoryField(field: 'input' | 'output', button: HTMLButtonElement): Promise<void> {
  const entry = popupState.history[popupState.historyIndex];
  const text = field === 'input' ? entry?.input : entry?.output;
  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    flashButtonText(button, 'Done');
  } catch {
    showError('Could not copy to clipboard.');
  }
}

/** Temporarily swaps a button label to provide quick feedback. */
function flashButtonText(button: HTMLButtonElement, text: string): void {
  const originalText = button.dataset.originalText || button.textContent || '';
  button.dataset.originalText = originalText;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = originalText;
    delete button.dataset.originalText;
  }, 900);
}

/** Checks whether a string contains user-visible content. */
function hasVisibleText(text: string): boolean {
  return Boolean(String(text || '').trim());
}

/** Opens a URL in a new Chrome tab. */
function openExternalTab(url: string): void {
  void chrome.tabs.create({ url });
}

/** Collects and type-checks all required popup DOM elements. */
function getElements(): PopupElements {
  return {
    signedOutView: getElement('signedOutView'),
    signedInView: getElement('signedInView'),
    accountLabel: getElement('accountLabel'),
    planLabel: getElement('planLabel'),
    limitList: getElement('limitList'),
    authError: getElement('authError'),
    historyOutput: getElement('historyOutput'),
    historyInputImage: getElement('historyInputImage'),
    historyInputText: getElement('historyInputText'),
    historyCounter: getElement('historyCounter'),
    historyPrev: getElement('historyPrev'),
    historyNext: getElement('historyNext'),
    deleteHistoryButton: getElement('deleteHistoryButton'),
    copyInputButton: getElement('copyInputButton'),
    copyOutputButton: getElement('copyOutputButton'),
    loginButton: getElement('loginButton'),
    signOutButton: getElement('signOutButton'),
    developerLink: getElement('developerLink'),
    sourceLink: getElement('sourceLink'),
    textScanButton: getElement('textScanButton'),
    imageScanButton: getElement('imageScanButton'),
    textModelSelect: getElement('textModelSelect'),
    imageModelSelect: getElement('imageModelSelect'),
    textThinkingSelect: getElement('textThinkingSelect'),
    imageThinkingSelect: getElement('imageThinkingSelect'),
    textModelRefreshButton: getElement('textModelRefreshButton'),
    imageModelRefreshButton: getElement('imageModelRefreshButton'),
    textCustomModel: getElement('textCustomModel'),
    imageCustomModel: getElement('imageCustomModel'),
    textSystemPromptSelect: getElement('textSystemPromptSelect'),
    imageSystemPromptSelect: getElement('imageSystemPromptSelect'),
    textCustomSystemPrompt: getElement('textCustomSystemPrompt'),
    imageCustomSystemPrompt: getElement('imageCustomSystemPrompt')
  };
}

/** Returns a required popup element or throws if the markup is out of sync. */
function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required popup element: ${id}`);
  }

  return element as T;
}

