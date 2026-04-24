/** Boots the reusable page-area overlay for image scans. */
import { getAreaOverlayOptions } from '../../common/scanSettings';
import { createAreaOverlay } from './areaOverlay';

/** Starts the image scan overlay with the shared scan configuration. */
function initializeImageSelectionOverlay(): void {
  createAreaOverlay(getAreaOverlayOptions('image'));
}

initializeImageSelectionOverlay();
