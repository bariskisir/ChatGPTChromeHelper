/** Boots the reusable page-area overlay for image scans. */
import { createAreaOverlay } from './lib/areaOverlay';
import { getAreaOverlayOptions } from './lib/shared';

/** Starts the image scan overlay with the shared scan configuration. */
function initializeImageSelectionOverlay(): void {
  createAreaOverlay(getAreaOverlayOptions('image'));
}

initializeImageSelectionOverlay();
