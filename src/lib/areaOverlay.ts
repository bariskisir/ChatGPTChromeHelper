/** Renders the reusable drag-to-select overlay used by text and image scans. */
import { AREA_OVERLAY_ID } from './shared';
import type { AreaOverlayOptions, ScanKind, SelectionCoordinates, SavedSelectionCoordinates } from './types';

const OVERLAY_CLEANUP_KEY = '__aiChromeHelperCleanupAreaOverlay';
const OVERLAY_Z_INDEX = 2147483646;
const OVERLAY_FOREGROUND_Z_INDEX = 2147483647;
const OVERLAY_BACKDROP = 'rgba(15, 23, 42, 0.18)';
const OVERLAY_SHADOW = 'rgba(15, 23, 42, 0.22)';
const PREVIOUS_OVERLAY_SHADOW = 'rgba(15, 23, 42, 0.12)';
const AREA_MESSAGE_DURATION_MS = 1800;

interface AreaOverlayState {
  options: AreaOverlayOptions;
  overlay: HTMLDivElement | null;
  label: HTMLDivElement | null;
  onKeyDown: ((event: KeyboardEvent) => void) | null;
  startX: number;
  startY: number;
  selecting: boolean;
  selectionBox: HTMLDivElement | null;
  previousBox: HTMLDivElement | null;
  previousCoordinates: SelectionCoordinates | null;
  cleanup: (() => void) | null;
}

interface OverlayGlobal extends Window {
  [OVERLAY_CLEANUP_KEY]?: () => void;
}

/** Mounts a fresh overlay instance and wires mouse plus keyboard interactions. */
export function createAreaOverlay(options: AreaOverlayOptions): void {
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

  getOverlayWindow()[OVERLAY_CLEANUP_KEY] = state.cleanup;
  document.addEventListener('keydown', state.onKeyDown, true);
  document.documentElement.appendChild(state.overlay);
  void hydratePreviousSelection(state);
}

/** Builds the mutable state bag shared across overlay event handlers. */
function createAreaOverlayState(options: AreaOverlayOptions): AreaOverlayState {
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

/** Removes any older overlay so only one selection UI exists at a time. */
function cleanupExistingAreaOverlay(): void {
  const existingCleanup = getOverlayWindow()[OVERLAY_CLEANUP_KEY];
  if (typeof existingCleanup === 'function') {
    existingCleanup();
    return;
  }

  document.getElementById(AREA_OVERLAY_ID)?.remove();
}

/** Creates the full-screen backdrop element that captures selection input. */
function createOverlayElement(): HTMLDivElement {
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

/** Creates the floating instruction label shown at the top of the overlay. */
function createOverlayLabel(text: string): HTMLDivElement {
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

/** Returns the default label shown before a previous area is loaded from storage. */
function getDefaultOverlayLabel(options: AreaOverlayOptions): string {
  return `${options.label} - Esc cancels`;
}

/** Returns the richer label shown when the user can reuse a previous selection. */
function getReuseOverlayLabel(options: AreaOverlayOptions): string {
  return `${options.label} - ${getReuseShortcutLabel(options.mode)} or Enter reuses previous area, drag to replace, Esc cancels`;
}

/** Loads the last saved area for the current scan mode and previews it if usable. */
async function hydratePreviousSelection(state: AreaOverlayState): Promise<void> {
  const storageKey = getOverlayStorageKey(state.options.mode);
  const result = await chrome.storage.local.get([storageKey]);
  if (!state.overlay?.isConnected || state.selecting) {
    return;
  }

  const stored = result[storageKey] as SavedSelectionCoordinates | undefined;
  if (!isUsableCoordinates(stored, state.options)) {
    return;
  }

  state.previousCoordinates = {
    startX: stored.startX,
    startY: stored.startY,
    width: stored.width,
    height: stored.height
  };
  if (state.label) {
    state.label.textContent = getReuseOverlayLabel(state.options);
  }

  state.previousBox = createSelectionBox(state.options, true);
  setBoxCoordinates(state.previousBox, state.previousCoordinates);
  state.overlay.appendChild(state.previousBox);
}

/** Maps a scan mode to the matching coordinate storage key. */
function getOverlayStorageKey(mode: ScanKind): 'lastTextScanCoordinates' | 'lastImageScanCoordinates' {
  return mode === 'image' ? 'lastImageScanCoordinates' : 'lastTextScanCoordinates';
}

/** Starts a drag selection when the user presses the primary mouse button. */
function handleOverlayMouseDown(event: MouseEvent, state: AreaOverlayState): void {
  if (event.button !== 0 || !state.overlay) {
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

/** Resizes the active drag selection as the cursor moves. */
function handleOverlayMouseMove(event: MouseEvent, state: AreaOverlayState): void {
  if (!state.selecting) {
    return;
  }

  updateSelectionBox(state, event.clientX, event.clientY);
}

/** Finishes the current selection and forwards valid coordinates to the background script. */
function handleOverlayMouseUp(event: MouseEvent, state: AreaOverlayState): void {
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

/** Recomputes the overlay box position and dimensions from the current pointer location. */
function updateSelectionBox(state: AreaOverlayState, currentX: number, currentY: number): void {
  if (!state.selectionBox) {
    return;
  }

  setBoxCoordinates(state.selectionBox, getSelectionCoordinates(state, currentX, currentY));
}

/** Normalizes the drag bounds so the box works in every drag direction. */
function getSelectionCoordinates(state: AreaOverlayState, currentX: number, currentY: number): SelectionCoordinates {
  return {
    startX: Math.min(state.startX, currentX),
    startY: Math.min(state.startY, currentY),
    width: Math.abs(currentX - state.startX),
    height: Math.abs(currentY - state.startY)
  };
}

/** Handles keyboard shortcuts for canceling or reusing the previous selection. */
function handleOverlayKeyDown(event: KeyboardEvent, state: AreaOverlayState): void {
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

/** Unmounts the overlay and removes all registered event hooks. */
function cleanupAreaOverlay(state: AreaOverlayState): void {
  state.overlay?.remove();
  state.selectionBox?.remove();
  state.previousBox?.remove();
  state.selectionBox = null;
  state.previousBox = null;

  if (state.onKeyDown) {
    document.removeEventListener('keydown', state.onKeyDown, true);
  }

  if (getOverlayWindow()[OVERLAY_CLEANUP_KEY] === state.cleanup) {
    delete getOverlayWindow()[OVERLAY_CLEANUP_KEY];
  }
}

/** Waits for the overlay to disappear before sending capture coordinates to the background script. */
function sendCoordinatesAfterCleanup(mode: ScanKind, coordinates: SelectionCoordinates): void {
  void waitForOverlayToClear().then(() => chrome.runtime.sendMessage({
    action: 'captureArea',
    mode,
    coordinates
  }));
}

/** Defers execution until the browser has painted away the overlay elements. */
function waitForOverlayToClear(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Checks whether the pressed key matches the previous-area reuse shortcut. */
function isReuseShortcut(event: KeyboardEvent, mode: ScanKind): boolean {
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }

  const shortcutLabel = getReuseShortcutLabel(mode);
  const digitCode = shortcutLabel === '2' ? 'Digit2' : 'Digit1';
  const numpadCode = shortcutLabel === '2' ? 'Numpad2' : 'Numpad1';
  return event.key === shortcutLabel || event.code === digitCode || event.code === numpadCode;
}

/** Returns the one-key shortcut used to reuse a saved area for a scan mode. */
function getReuseShortcutLabel(mode: ScanKind): '1' | '2' {
  return mode === 'image' ? '2' : '1';
}

/** Creates the visible selection rectangle used for active or previous areas. */
function createSelectionBox(options: AreaOverlayOptions, isPrevious: boolean): HTMLDivElement {
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

/** Applies normalized coordinates to a selection box element. */
function setBoxCoordinates(box: HTMLDivElement, coordinates: SelectionCoordinates): void {
  box.style.left = `${coordinates.startX}px`;
  box.style.top = `${coordinates.startY}px`;
  box.style.width = `${coordinates.width}px`;
  box.style.height = `${coordinates.height}px`;
}

/** Validates that saved coordinates are large enough to be reused. */
function isUsableCoordinates(coordinates: SavedSelectionCoordinates | undefined, options: AreaOverlayOptions): coordinates is SavedSelectionCoordinates {
  if (!coordinates) {
    return false;
  }

  return Number.isFinite(coordinates.startX)
    && Number.isFinite(coordinates.startY)
    && Number.isFinite(coordinates.width)
    && Number.isFinite(coordinates.height)
    && coordinates.width >= options.minWidth
    && coordinates.height >= options.minHeight;
}

/** Displays a short-lived message for invalid selection attempts. */
function showAreaMessage(message: string): void {
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

/** Returns the window object with the overlay cleanup hook typing applied. */
function getOverlayWindow(): OverlayGlobal {
  return window as OverlayGlobal;
}
