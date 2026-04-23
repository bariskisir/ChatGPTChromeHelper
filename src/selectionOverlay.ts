/** Boots the reusable page-area overlay for text scans. */
import { createAreaOverlay } from './lib/areaOverlay';
import { getAreaOverlayOptions } from './lib/shared';

/** Starts the text scan overlay with the shared scan configuration. */
function initializeTextSelectionOverlay(): void {
  createAreaOverlay(getAreaOverlayOptions('text'));
}

initializeTextSelectionOverlay();
