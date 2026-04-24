/** Boots the reusable page-area overlay for text scans. */
import { getAreaOverlayOptions } from '../../common/scanSettings';
import { createAreaOverlay } from './areaOverlay';

/** Starts the text scan overlay with the shared scan configuration. */
function initializeTextSelectionOverlay(): void {
  createAreaOverlay(getAreaOverlayOptions('text'));
}

initializeTextSelectionOverlay();
