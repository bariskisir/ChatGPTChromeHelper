let tesseractWorkerPromise = null;

const {
  AREA_OVERLAY_ID,
  SCAN_KINDS,
  getScanSettings
} = globalThis.ChatGptChromeHelperShared;

const IMAGE_SHORTCUT_VARIANTS = new Set(['i', 'I', '\u0130', '\u0131']);
const PAGE_STYLES_ID = 'ai-chrome-helper-page-styles';
const RESPONSE_CLASS_NAME = 'ai-helper-response';
const MESSAGE_HANDLERS = {
  displayResponse: (message) => {
    ensurePageStyles();
    displayNormalResponse(message.response, message.type);
    return { ok: true };
  },
  cropImage: (message) => cropImage(message.imageUri, message.coordinates),
  ocrImage: (message) => ocrImage(message.imageUri, message.coordinates)
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = MESSAGE_HANDLERS[message?.action];
  if (!handler) {
    return false;
  }

  Promise.resolve(handler(message, sender))
    .then((result) => sendResponse(result?.ok === false ? result : { ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

document.addEventListener('keydown', handleShortcutKeydown, true);

function handleShortcutKeydown(event) {
  if (event.repeat || isEditableTarget(event.target)) {
    return;
  }

  const repeatAction = getRepeatShortcutAction(event);
  if (repeatAction) {
    if (isAreaOverlayVisible()) {
      return;
    }

    event.preventDefault();
    void triggerShortcutAction(repeatAction);
    return;
  }

  const triggerAction = getTriggerShortcutAction(event);
  if (!triggerAction) {
    return;
  }

  event.preventDefault();
  void triggerShortcutAction(triggerAction);
}

function getRepeatShortcutAction(event) {
  for (const kind of SCAN_KINDS) {
    const settings = getScanSettings(kind);
    if (matchesDigitShortcut(event, settings.repeatShortcutLabel)) {
      return settings.repeatAction;
    }
  }

  return '';
}

function matchesDigitShortcut(event, digit) {
  return !event.shiftKey
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey
    && (event.key === digit || event.code === `Digit${digit}` || event.code === `Numpad${digit}`);
}

function getTriggerShortcutAction(event) {
  if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
    return '';
  }

  const key = normalizeShortcutKey(event.key);
  for (const kind of SCAN_KINDS) {
    const settings = getScanSettings(kind);
    if (key === settings.shortcutKey) {
      return settings.triggerAction;
    }
  }

  return '';
}

function isAreaOverlayVisible() {
  return Boolean(document.getElementById(AREA_OVERLAY_ID));
}

async function triggerShortcutAction(action) {
  try {
    const result = await chrome.runtime.sendMessage({ action });
    if (!result?.ok) {
      ensurePageStyles();
      displayNormalResponse(result?.error || 'Shortcut action failed.', 'error');
    }
  } catch (error) {
    ensurePageStyles();
    displayNormalResponse(error?.message || 'Shortcut action failed.', 'error');
  }
}

function normalizeShortcutKey(key) {
  if (IMAGE_SHORTCUT_VARIANTS.has(key)) {
    return 'i';
  }

  return String(key || '').toLocaleLowerCase('tr-TR');
}

function ensurePageStyles() {
  if (document.getElementById(PAGE_STYLES_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = PAGE_STYLES_ID;
  style.textContent = `
.${RESPONSE_CLASS_NAME} {
  position: fixed;
  right: 18px;
  top: 18px;
  z-index: 2147483647;
  width: min(360px, calc(100vw - 32px));
  padding: 14px;
  border: 1px solid rgba(24, 32, 47, 0.18);
  border-radius: 8px;
  background: #fff;
  color: #18202f;
  box-shadow: 0 18px 48px rgba(18, 24, 38, 0.18);
  font-family: Inter, Segoe UI, system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  white-space: pre-wrap;
}

.${RESPONSE_CLASS_NAME}.status {
  width: auto;
  min-width: 180px;
  color: #475569;
  font-size: 14px;
  font-weight: 500;
  text-align: center;
}

.${RESPONSE_CLASS_NAME}.error {
  border-color: #f1b6b0;
  color: #9f1f18;
}
  `;
  document.documentElement.appendChild(style);
}

function displayNormalResponse(response, type) {
  removeResponses();
  const container = document.createElement('div');
  container.className = `${RESPONSE_CLASS_NAME} ${type || ''}`;
  container.textContent = response || '';
  document.documentElement.appendChild(container);

  if (type !== 'status') {
    setTimeout(() => fadeAndRemove(container), 9000);
  }
}

function removeResponses() {
  document.querySelectorAll(`.${RESPONSE_CLASS_NAME}`).forEach((element) => element.remove());
}

function fadeAndRemove(element) {
  if (!element?.parentNode) {
    return;
  }

  element.style.transition = 'opacity 180ms ease';
  element.style.opacity = '0';
  setTimeout(() => element.remove(), 220);
}

async function cropImage(imageUri, coordinates) {
  if (!coordinates || coordinates.width < 2 || coordinates.height < 2) {
    throw new Error('The selected area is too small.');
  }

  const image = await loadImage(imageUri);
  const pixelRatio = window.devicePixelRatio || 1;
  const startX = Math.max(0, Math.round(coordinates.startX * pixelRatio));
  const startY = Math.max(0, Math.round(coordinates.startY * pixelRatio));
  const width = Math.min(image.width - startX, Math.round(coordinates.width * pixelRatio));
  const height = Math.min(image.height - startY, Math.round(coordinates.height * pixelRatio));

  if (width < 4 || height < 4) {
    throw new Error('The selected area is outside the captured page.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not prepare an image canvas.');
  }

  context.drawImage(image, startX, startY, width, height, 0, 0, width, height);
  return {
    croppedImageUri: canvas.toDataURL('image/png')
  };
}

async function ocrImage(imageUri, coordinates) {
  const imageData = await cropImage(imageUri, coordinates);
  const worker = await getTesseractWorker();
  const result = await worker.recognize(imageData.croppedImageUri);
  return {
    ...imageData,
    extractedText: result?.data?.text?.trim() || ''
  };
}

async function getTesseractWorker() {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = createTesseractWorker().catch((error) => {
      tesseractWorkerPromise = null;
      throw error;
    });
  }

  return tesseractWorkerPromise;
}

async function createTesseractWorker() {
  if (typeof Tesseract === 'undefined') {
    throw new Error('Tesseract is not available.');
  }

  const worker = await Tesseract.createWorker();
  if (typeof worker.load === 'function') {
    await worker.load();
  }
  if (typeof worker.loadLanguage === 'function') {
    await worker.loadLanguage('eng');
  }
  if (typeof worker.initialize === 'function') {
    await worker.initialize('eng');
  }
  return worker;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load the captured image.'));
    image.src = src;
  });
}

function isEditableTarget(target) {
  if (!target) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tag = (target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}
