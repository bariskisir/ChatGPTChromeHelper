const {
  DEFAULT_MODEL,
  SCAN_KINDS,
  getScanSettings,
  normalizeStoredModel,
  normalizeSystemPromptPreset,
  getNormalizedHistory,
  getNormalizedHistoryIndex
} = globalThis.ChatGptChromeHelperShared;

const EXTERNAL_LINKS = {
  developer: 'https://www.bariskisir.com',
  source: 'https://github.com/bariskisir/ChatGPTChromeHelper'
};

const elements = getElements();
const popupState = {
  history: [],
  historyIndex: 0
};
const SCAN_CONTROLS = createScanControls();

document.addEventListener('DOMContentLoaded', initializePopup);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === 'authChanged' || message?.action === 'responseUpdated') {
    void refreshStatus();
  }
});

function initializePopup() {
  bindEvents();
  void refreshStatus();
}

function createScanControls() {
  return {
    text: createScanControl('text', {
      button: elements.textScanButton,
      modelSelect: elements.textModelSelect,
      customModelInput: elements.textCustomModel,
      systemPromptSelect: elements.textSystemPromptSelect,
      customSystemPromptInput: elements.textCustomSystemPrompt
    }),
    image: createScanControl('image', {
      button: elements.imageScanButton,
      modelSelect: elements.imageModelSelect,
      customModelInput: elements.imageCustomModel,
      systemPromptSelect: elements.imageSystemPromptSelect,
      customSystemPromptInput: elements.imageCustomSystemPrompt
    })
  };
}

function createScanControl(kind, controls) {
  const settings = getScanSettings(kind);
  controls.customModelInput.placeholder = settings.customModelPlaceholder;
  controls.customSystemPromptInput.placeholder = settings.customSystemPromptPlaceholder;
  return {
    ...controls,
    settings
  };
}

function bindEvents() {
  elements.loginButton.addEventListener('click', handleLoginClick);
  elements.signOutButton.addEventListener('click', handleSignOutClick);
  elements.developerLink.addEventListener('click', () => openExternalTab(EXTERNAL_LINKS.developer));
  elements.sourceLink.addEventListener('click', () => openExternalTab(EXTERNAL_LINKS.source));
  elements.historyPrev.addEventListener('click', () => moveHistory(-1));
  elements.historyNext.addEventListener('click', () => moveHistory(1));
  elements.deleteHistoryButton.addEventListener('click', handleDeleteHistoryClick);
  elements.copyInputButton.addEventListener('click', () => copyHistoryField('input', elements.copyInputButton));
  elements.copyOutputButton.addEventListener('click', () => copyHistoryField('output', elements.copyOutputButton));

  for (const kind of SCAN_KINDS) {
    const controls = getScanControls(kind);
    controls.button.addEventListener('click', () => triggerScan(kind));
    bindScanControlEvents(kind);
  }
}

function bindScanControlEvents(kind) {
  const controls = getScanControls(kind);
  controls.modelSelect.addEventListener('change', () => saveModelChoice(kind));
  controls.customModelInput.addEventListener('input', () => saveModelChoice(kind));
  controls.systemPromptSelect.addEventListener('change', () => saveSystemPromptChoice(kind));
  controls.customSystemPromptInput.addEventListener('input', () => saveSystemPromptChoice(kind));
}

async function handleLoginClick() {
  setBusy(elements.loginButton, true, 'Opening...');

  try {
    const result = await sendRuntimeMessage('startLogin');
    if (!result?.ok) {
      showError(result?.error || 'Could not start ChatGPT login.');
      return;
    }

    showError('');
    window.close();
  } finally {
    setBusy(elements.loginButton, false, 'Sign in with ChatGPT');
  }
}

async function handleSignOutClick() {
  const result = await sendRuntimeMessage('signOut');
  if (!result?.ok) {
    showError(result?.error || 'Could not sign out.');
    return;
  }

  showError('');
  await refreshStatus();
}

async function handleDeleteHistoryClick() {
  const result = await sendRuntimeMessage('deleteHistory');
  if (!result?.ok) {
    showError(result?.error || 'Could not delete history.');
    return;
  }

  popupState.history = [];
  popupState.historyIndex = 0;
  showError('');
  renderHistory();
}

async function refreshStatus() {
  const status = await sendRuntimeMessage('getStatus');
  if (!status?.ok) {
    showError(status?.error || 'Could not load extension status.');
    return;
  }

  renderSession(status);
  syncHistoryState(status);
  renderHistory();
  renderScanControls(status);
  showError(status?.authError || '');
}

function renderSession(status) {
  const loggedIn = Boolean(status?.loggedIn);
  elements.signedOutView.hidden = loggedIn;
  elements.signedInView.hidden = !loggedIn;
  elements.accountLabel.textContent = loggedIn
    ? status.accountEmail || 'Signed in to ChatGPT'
    : 'Not signed in';
  renderPlanLabel(loggedIn ? status?.limitInfo?.planName : '');
  renderLimitInfo(loggedIn ? status?.limitInfo : null);
}

function syncHistoryState(status) {
  popupState.history = getNormalizedHistory(status?.history, status?.lastResponse);
  popupState.historyIndex = getNormalizedHistoryIndex(status?.historyIndex, popupState.history.length);
}

function moveHistory(delta) {
  if (popupState.history.length === 0) {
    return;
  }

  popupState.historyIndex = getNormalizedHistoryIndex(
    popupState.historyIndex + delta,
    popupState.history.length
  );
  chrome.storage.local.set({ historyIndex: popupState.historyIndex });
  renderHistory();
}

function renderHistory() {
  if (popupState.history.length === 0) {
    applyEmptyHistoryState();
    return;
  }

  const entry = popupState.history[popupState.historyIndex];
  renderHistoryInput(entry);
  elements.historyOutput.textContent = entry.output || 'No output recorded.';
  elements.historyCounter.textContent = `${popupState.historyIndex + 1} / ${popupState.history.length}`;
  elements.historyPrev.disabled = popupState.historyIndex <= 0;
  elements.historyNext.disabled = popupState.historyIndex >= popupState.history.length - 1;
  elements.deleteHistoryButton.disabled = false;
  elements.copyInputButton.disabled = !hasVisibleText(entry.input);
  elements.copyOutputButton.disabled = !hasVisibleText(entry.output);
}

function renderHistoryInput(entry) {
  if (entry.type === 'image' && entry.inputImageDataUrl) {
    elements.historyInputImage.src = entry.inputImageDataUrl;
    elements.historyInputImage.hidden = false;
    elements.historyInputText.hidden = true;
    elements.historyInputText.textContent = '';
    return;
  }

  setHistoryInputText(entry.input || 'No input recorded.');
}

function applyEmptyHistoryState() {
  setHistoryInputText('none');
  elements.historyOutput.textContent = 'none';
  elements.historyCounter.textContent = '0 / 0';
  elements.historyPrev.disabled = true;
  elements.historyNext.disabled = true;
  elements.deleteHistoryButton.disabled = true;
  elements.copyInputButton.disabled = true;
  elements.copyOutputButton.disabled = true;
}

function setHistoryInputText(text) {
  elements.historyInputImage.hidden = true;
  elements.historyInputImage.removeAttribute('src');
  elements.historyInputText.hidden = false;
  elements.historyInputText.textContent = String(text || '').trim();
}

function renderScanControls(status) {
  for (const kind of SCAN_KINDS) {
    const controls = getScanControls(kind);
    const values = getScanStatusValues(kind, status);
    setModelControls(controls, values.model, values.customModel);
    setSystemPromptControls(controls, values.systemPromptPreset, values.customSystemPrompt);
  }
}

function getScanStatusValues(kind, status) {
  const { settings } = getScanControls(kind);
  return {
    model: normalizeStoredModel(status?.[settings.modelKey], status?.[settings.customModelKey]),
    customModel: status?.[settings.customModelKey] || '',
    systemPromptPreset: normalizeSystemPromptPreset(
      status?.[settings.systemPromptPresetKey],
      status?.[settings.customSystemPromptKey]
    ),
    customSystemPrompt: status?.[settings.customSystemPromptKey] || ''
  };
}

function setModelControls(controls, selectedModel, customModel) {
  controls.modelSelect.value = selectedModel || DEFAULT_MODEL;
  controls.customModelInput.value = customModel;
  controls.customModelInput.hidden = selectedModel !== 'other';
}

function saveModelChoice(kind) {
  const controls = getScanControls(kind);
  const { settings } = controls;
  const selectedModel = controls.modelSelect.value;
  controls.customModelInput.hidden = selectedModel !== 'other';

  chrome.storage.local.set({
    [settings.modelKey]: selectedModel,
    [settings.customModelKey]: controls.customModelInput.value.trim()
  });
}

function setSystemPromptControls(controls, selectedPreset, customPrompt) {
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

function saveSystemPromptChoice(kind) {
  const controls = getScanControls(kind);
  const { settings } = controls;
  const selectedPreset = controls.systemPromptSelect.value;
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

  chrome.storage.local.set({
    [settings.systemPromptPresetKey]: selectedPreset,
    [settings.customSystemPromptKey]: selectedPreset === 'other' ? customPrompt : ''
  });
}

function setReadOnlyPromptInput(controls, value) {
  controls.customSystemPromptInput.hidden = false;
  controls.customSystemPromptInput.readOnly = true;
  controls.customSystemPromptInput.placeholder = '';
  controls.customSystemPromptInput.value = value;
}

function setEditablePromptInput(controls, value) {
  controls.customSystemPromptInput.hidden = false;
  controls.customSystemPromptInput.readOnly = false;
  controls.customSystemPromptInput.placeholder = controls.settings.customSystemPromptPlaceholder;
  controls.customSystemPromptInput.value = value;
}

function getScanControls(kind) {
  return SCAN_CONTROLS[kind] || SCAN_CONTROLS.text;
}

async function triggerScan(kind) {
  const controls = getScanControls(kind);
  setBusy(controls.button, true, 'Select area...');

  try {
    const result = await sendRuntimeMessage(controls.settings.triggerAction);
    if (!result?.ok) {
      showError(result?.error || 'Could not start scan.');
      return;
    }

    showError('');
    window.close();
  } finally {
    setBusy(controls.button, false, controls.settings.buttonLabel);
  }
}

function showError(message) {
  elements.authError.hidden = !message;
  elements.authError.textContent = message || '';
}

function renderPlanLabel(planName) {
  const normalizedPlan = String(planName || '').trim();
  elements.planLabel.hidden = !normalizedPlan;
  elements.planLabel.textContent = normalizedPlan || '';
}

function renderLimitInfo(limitInfo) {
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

function formatLimitItem(item) {
  const featureLabel = String(item?.featureLabel || '').trim();
  const windowLabel = String(item?.windowLabel || '').trim();
  const label = [featureLabel, windowLabel].filter(Boolean).join(' ').trim() || windowLabel || 'Limit';
  return `${label}: ${formatLimitPercent(item?.leftPercent)}% left, resets ${formatResetTime(item?.resetsAt)}`;
}

function formatLimitPercent(value) {
  const rounded = Number(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatResetTime(unixSeconds) {
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

function setBusy(button, busy, label) {
  button.disabled = busy;
  const labelElement = button.querySelector('.button-label');
  if (labelElement) {
    labelElement.textContent = label;
    return;
  }

  button.textContent = label;
}

async function copyHistoryField(field, button) {
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

function flashButtonText(button, text) {
  const originalText = button.dataset.originalText || button.textContent;
  button.dataset.originalText = originalText;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = originalText;
    delete button.dataset.originalText;
  }, 900);
}

function hasVisibleText(text) {
  return Boolean(String(text || '').trim());
}

function openExternalTab(url) {
  chrome.tabs.create({ url });
}

async function sendRuntimeMessage(action, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({
      action,
      ...payload
    });
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'The extension background is unavailable.'
    };
  }
}

function getElements() {
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
    textCustomModel: getElement('textCustomModel'),
    imageCustomModel: getElement('imageCustomModel'),
    textSystemPromptSelect: getElement('textSystemPromptSelect'),
    imageSystemPromptSelect: getElement('imageSystemPromptSelect'),
    textCustomSystemPrompt: getElement('textCustomSystemPrompt'),
    imageCustomSystemPrompt: getElement('imageCustomSystemPrompt')
  };
}

function getElement(id) {
  return document.getElementById(id);
}
