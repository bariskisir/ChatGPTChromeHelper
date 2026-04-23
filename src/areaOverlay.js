(function () {
const AREA_OVERLAY_ID = globalThis.ChatGptChromeHelperShared?.AREA_OVERLAY_ID || 'ai-chrome-helper-area-overlay';
const OVERLAY_CLEANUP_KEY = '__aiChromeHelperCleanupAreaOverlay';
const OVERLAY_Z_INDEX = 2147483646;
const OVERLAY_FOREGROUND_Z_INDEX = 2147483647;
const OVERLAY_BACKDROP = 'rgba(15, 23, 42, 0.18)';
const OVERLAY_SHADOW = 'rgba(15, 23, 42, 0.22)';
const PREVIOUS_OVERLAY_SHADOW = 'rgba(15, 23, 42, 0.12)';
const AREA_MESSAGE_DURATION_MS = 1800;

globalThis.createAreaOverlay = function createAreaOverlay(options) {
  cleanupExistingAreaOverlay();

  const state = createAreaOverlayState(options);
  state.overlay = createOverlayElement();
  state.label = createOverlayLabel(getDefaultOverlayLabel(options));
  state.onKeyDown = (event) => handleOverlayKeyDown(event, state);
  state.cleanup = () => cleanupAreaOverlay(state);

  state.overlay.appendChild(state.label);
  state.overlay.addEventListener('mousedown', (event) => handleOverlayMouseDown(event, state));
  state.overlay.addEventListener('mousemove', (event) => handleOverlayMouseMove(event, state));
  state.overlay.addEventListener('mouseup', (event) => handleOverlayMouseUp(event, state));

  globalThis[OVERLAY_CLEANUP_KEY] = state.cleanup;
  document.addEventListener('keydown', state.onKeyDown, true);
  document.documentElement.appendChild(state.overlay);
  hydratePreviousSelection(state);
};

function createAreaOverlayState(options) {
  return {
    options,
    overlay: null,
    label: null,
    onKeyDown: null,
    startX: 0,
    startY: 0,
    selecting: false,
    selectionBox: null,
    previousBox: null,
    previousCoordinates: null,
    cleanup: null
  };
}

function cleanupExistingAreaOverlay() {
  const existingCleanup = globalThis[OVERLAY_CLEANUP_KEY];
  if (typeof existingCleanup === 'function') {
    existingCleanup();
    return;
  }

  document.getElementById(AREA_OVERLAY_ID)?.remove();
}

function createOverlayElement() {
  const overlay = document.createElement('div');
  overlay.id = AREA_OVERLAY_ID;
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: ${OVERLAY_Z_INDEX};
    cursor: crosshair;
    background: ${OVERLAY_BACKDROP};
  `;
  return overlay;
}

function createOverlayLabel(text) {
  const label = document.createElement('div');
  label.textContent = text;
  label.style.cssText = `
    position: fixed;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    z-index: ${OVERLAY_FOREGROUND_Z_INDEX};
    padding: 8px 12px;
    border-radius: 8px;
    background: rgba(15, 23, 42, 0.92);
    color: #fff;
    font: 13px/1.3 Segoe UI, system-ui, sans-serif;
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.24);
    pointer-events: none;
  `;
  return label;
}

function getDefaultOverlayLabel(options) {
  return `${options.label} - Esc cancels`;
}

function getReuseOverlayLabel(options) {
  return `${options.label} - ${getReuseShortcutLabel(options.mode)} or Enter reuses previous area, drag to replace, Esc cancels`;
}

function hydratePreviousSelection(state) {
  const storageKey = getOverlayStorageKey(state.options.mode);

  chrome.storage.local.get([storageKey], (result) => {
    if (!state.overlay?.isConnected || state.selecting) {
      return;
    }

    const stored = result?.[storageKey];
    if (!isUsableCoordinates(stored, state.options)) {
      return;
    }

    state.previousCoordinates = {
      startX: stored.startX,
      startY: stored.startY,
      width: stored.width,
      height: stored.height
    };
    state.label.textContent = getReuseOverlayLabel(state.options);
    state.previousBox = createSelectionBox(state.options, true);
    setBoxCoordinates(state.previousBox, state.previousCoordinates);
    state.overlay.appendChild(state.previousBox);
  });
}

function getOverlayStorageKey(mode) {
  return mode === 'image' ? 'lastImageScanCoordinates' : 'lastTextScanCoordinates';
}

function handleOverlayMouseDown(event, state) {
  if (event.button !== 0) {
    return;
  }

  state.selecting = true;
  state.previousCoordinates = null;
  state.previousBox?.remove();
  state.previousBox = null;

  state.startX = event.clientX;
  state.startY = event.clientY;
  state.selectionBox = createSelectionBox(state.options, false);
  state.overlay.appendChild(state.selectionBox);
  updateSelectionBox(state, event.clientX, event.clientY);
}

function handleOverlayMouseMove(event, state) {
  if (!state.selecting) {
    return;
  }

  updateSelectionBox(state, event.clientX, event.clientY);
}

function handleOverlayMouseUp(event, state) {
  if (!state.selecting) {
    return;
  }

  state.selecting = false;
  const coordinates = getSelectionCoordinates(state, event.clientX, event.clientY);
  if (coordinates.width < state.options.minWidth || coordinates.height < state.options.minHeight) {
    cleanupAreaOverlay(state);
    showAreaMessage('Selection is too small.');
    return;
  }

  cleanupAreaOverlay(state);
  sendCoordinatesAfterCleanup(state.options.mode, coordinates);
}

function updateSelectionBox(state, currentX, currentY) {
  if (!state.selectionBox) {
    return;
  }

  setBoxCoordinates(state.selectionBox, getSelectionCoordinates(state, currentX, currentY));
}

function getSelectionCoordinates(state, currentX, currentY) {
  return {
    startX: Math.min(state.startX, currentX),
    startY: Math.min(state.startY, currentY),
    width: Math.abs(currentX - state.startX),
    height: Math.abs(currentY - state.startY)
  };
}

function handleOverlayKeyDown(event, state) {
  if (event.key === 'Escape') {
    cleanupAreaOverlay(state);
    return;
  }

  if ((event.key === 'Enter' || isReuseShortcut(event, state.options.mode)) && state.previousCoordinates && !state.selecting) {
    event.preventDefault();
    const coordinates = state.previousCoordinates;
    cleanupAreaOverlay(state);
    sendCoordinatesAfterCleanup(state.options.mode, coordinates);
  }
}

function cleanupAreaOverlay(state) {
  state.overlay?.remove();
  state.selectionBox?.remove();
  state.previousBox?.remove();
  state.selectionBox = null;
  state.previousBox = null;
  document.removeEventListener('keydown', state.onKeyDown, true);

  if (globalThis[OVERLAY_CLEANUP_KEY] === state.cleanup) {
    delete globalThis[OVERLAY_CLEANUP_KEY];
  }
}

function sendCoordinatesAfterCleanup(mode, coordinates) {
  void waitForOverlayToClear().then(() => {
    chrome.runtime.sendMessage({
      action: 'captureArea',
      mode,
      coordinates
    });
  });
}

function waitForOverlayToClear() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

function isReuseShortcut(event, mode) {
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }

  const shortcutLabel = getReuseShortcutLabel(mode);
  const digitCode = shortcutLabel === '2' ? 'Digit2' : 'Digit1';
  const numpadCode = shortcutLabel === '2' ? 'Numpad2' : 'Numpad1';
  return event.key === shortcutLabel || event.code === digitCode || event.code === numpadCode;
}

function getReuseShortcutLabel(mode) {
  return mode === 'image' ? '2' : '1';
}

function createSelectionBox(options, isPrevious) {
  const box = document.createElement('div');
  box.style.cssText = `
    position: fixed;
    z-index: ${OVERLAY_FOREGROUND_Z_INDEX};
    border: ${isPrevious ? '2px dashed' : '2px solid'} ${options.borderColor};
    background: ${options.fillColor};
    border-radius: 6px;
    pointer-events: none;
    box-shadow: 0 0 0 99999px ${isPrevious ? PREVIOUS_OVERLAY_SHADOW : OVERLAY_SHADOW};
  `;
  return box;
}

function setBoxCoordinates(box, coordinates) {
  box.style.left = `${coordinates.startX}px`;
  box.style.top = `${coordinates.startY}px`;
  box.style.width = `${coordinates.width}px`;
  box.style.height = `${coordinates.height}px`;
}

function isUsableCoordinates(coordinates, options) {
  return Boolean(coordinates)
    && Number.isFinite(coordinates.startX)
    && Number.isFinite(coordinates.startY)
    && Number.isFinite(coordinates.width)
    && Number.isFinite(coordinates.height)
    && coordinates.width >= options.minWidth
    && coordinates.height >= options.minHeight;
}

function showAreaMessage(message) {
  const element = document.createElement('div');
  element.textContent = message;
  element.style.cssText = `
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: ${OVERLAY_FOREGROUND_Z_INDEX};
    padding: 10px 14px;
    border-radius: 8px;
    background: #fff7ed;
    color: #9a3412;
    border: 1px solid #fed7aa;
    font: 14px/1.3 Segoe UI, system-ui, sans-serif;
    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.16);
  `;
  document.documentElement.appendChild(element);
  setTimeout(() => element.remove(), AREA_MESSAGE_DURATION_MS);
}
})();
