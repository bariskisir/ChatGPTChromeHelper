# ChatGPT Chrome Helper

ChatGPT Chrome Helper is a Chrome extension for working with ChatGPT directly from your browser. It can answer selected text, scan page text with local OCR, and analyze selected image areas.

<img src="images/interface.png" alt="ChatGPT Chrome Helper interface" width="60%">

---

## See it in action
<img src="images/action.gif">

## Install

1. Download the latest version. https://github.com/bariskisir/ChatGPTChromeHelper/releases/latest/download/dist.zip and unzip
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `dist` folder.

## Login

Open the extension popup and click **Sign in with ChatGPT**. 
You can use it with free subscription.

## Features

- **Ask**: Select text on a page, right-click, and choose **Ask** to send the selected text directly to ChatGPT.
- **Scan Text**: Click **Scan Text** or press **Shift+T** to select a page area, run local OCR with Tesseract, and send only the extracted text to ChatGPT.
- **Scan Image**: Click **Scan Image** or press **Shift+I** to select a page area and send only the selected image to ChatGPT.
- **Area reuse**: The last text and image scan areas are remembered separately. Press **1** to instantly repeat the last text scan, **2** to repeat the last image scan, or use **1** / **Enter** for text and **2** / **Enter** for image inside the overlay to reuse the previous area.
- **History**: Recent inputs and outputs are saved locally with previous/next navigation, copy buttons, and delete history.
- **Models**: On first sign-in, the extension reads the latest Codex client version from npm, fetches the models available to the logged-in ChatGPT account, and fills separate text/image model selectors. If the live fetch fails, it falls back to `gpt-5.4` and `gpt-5.4-mini`.
- **Thinking variants**: Each text/image model selector includes the supported thinking variants from the live model catalog, with `gpt-5.4-mini` + `medium` as the default fallback.
- **System prompts**: Choose separate system prompts for text and image scans: **Solver**, **None**, or **Other**.
- **Local storage**: Login tokens, history, scan areas, model choices, and system prompt choices are stored in `chrome.storage.local`.

## Playground

- https://www.oxfordonlineenglish.com/english-level-test/vocabulary

## Development

0. Clone the repository `git clone https://github.com/bariskisir/ChatGPTChromeHelper`
1. Install dependencies with `npm install`.
2. Run the extension with `npm run dev`.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the `dist` folder.

## LICENSE
- MIT
