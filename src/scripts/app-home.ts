/* Home-spezifisches Verhalten: Einmal pro Mount initialisieren und Cleanup zurueckgeben. */

import { initHomeGallery } from './home/gallery';
import { initHomeQuickNav } from './home/quick-nav';
import { initHomeWorldAge } from './home/world-age';

export function initHomeApp(): () => void {
  const stopGallery = initHomeGallery();
  const stopQuickNav = initHomeQuickNav();
  initHomeWorldAge();

  return () => {
    stopGallery();
    stopQuickNav();
  };
}
