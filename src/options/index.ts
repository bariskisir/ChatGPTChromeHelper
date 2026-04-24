/** Options-page entrypoint. Settings still live in the popup for this release. */

const message = document.getElementById('optionsMessage');
if (message) {
  message.textContent = 'Settings are currently managed from the extension popup.';
}
