import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { defineConfig } from 'vite';

const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = path.resolve(ROOT_DIR, 'dist');
const TESSERACT_DIST_DIR = path.resolve(ROOT_DIR, 'node_modules', 'tesseract.js', 'dist');
const TESSERACT_CORE_DIR = path.resolve(ROOT_DIR, 'node_modules', 'tesseract.js-core');

export const EXTENSION_ENTRIES = [
  { name: 'background', entry: 'src/background/index.ts', fileName: 'background.js', globalName: 'ChatGptChromeHelperBackground' },
  { name: 'content', entry: 'src/content/index.ts', fileName: 'content.js', globalName: 'ChatGptChromeHelperContent' },
  { name: 'popup', entry: 'src/popup/index.ts', fileName: 'popup.js', globalName: 'ChatGptChromeHelperPopup' },
  { name: 'options', entry: 'src/options/index.ts', fileName: 'options.js', globalName: 'ChatGptChromeHelperOptions' },
  { name: 'selectionOverlay', entry: 'src/content/overlays/textSelectionEntry.ts', fileName: 'selectionOverlay.js', globalName: 'ChatGptChromeHelperSelectionOverlay' },
  { name: 'imageSelectionOverlay', entry: 'src/content/overlays/imageSelectionEntry.ts', fileName: 'imageSelectionOverlay.js', globalName: 'ChatGptChromeHelperImageSelectionOverlay' }
];

async function copyFileTask(from, to, options = {}) {
  const source = path.resolve(ROOT_DIR, from);
  const target = path.resolve(DIST_DIR, to);
  await fs.mkdir(path.dirname(target), { recursive: true });

  if (options.stripSourceMapComment) {
    const content = await fs.readFile(source, 'utf8');
    const normalizedContent = content.replace(/\r?\n\/\/# sourceMappingURL=.*$/g, '');
    await fs.writeFile(target, normalizedContent, 'utf8');
    return;
  }

  await fs.copyFile(source, target);
}

async function copyMatchingFiles(fromDir, toDir, predicate) {
  const names = await fs.readdir(fromDir);
  await fs.mkdir(path.resolve(DIST_DIR, toDir), { recursive: true });

  for (const name of names) {
    if (!predicate(name)) {
      continue;
    }

    await fs.copyFile(
      path.resolve(fromDir, name),
      path.resolve(DIST_DIR, toDir, name)
    );
  }
}

async function copyStaticAssets() {
  await Promise.all([
    copyFileTask('public/manifest.json', 'manifest.json'),
    copyFileTask('public/popup.html', 'popup.html'),
    copyFileTask('public/options.html', 'options.html'),
    copyFileTask('public/styles.css', 'styles.css'),
    copyFileTask('public/icons/chatgpt-icon.png', 'icons/chatgpt-icon.png'),
    copyFileTask(
      path.join('node_modules', 'tesseract.js', 'dist', 'worker.min.js'),
      path.join('assets', 'tesseract', 'worker.min.js'),
      { stripSourceMapComment: true }
    ),
    copyMatchingFiles(TESSERACT_CORE_DIR, path.join('assets', 'tesseract-core'), (name) => name.startsWith('tesseract-core'))
  ]);
}

function copyStaticAssetsPlugin() {
  return {
    name: 'copy-static-assets',
    async buildStart() {
      await copyStaticAssets();
    }
  };
}

export function createExtensionBuildConfig({ entry, fileName, globalName, watch = false }) {
  return defineConfig({
    build: {
      outDir: DIST_DIR,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      watch: watch ? {} : undefined,
      target: 'chrome120',
      lib: {
        entry: path.resolve(ROOT_DIR, entry),
        name: globalName,
        formats: ['iife'],
        fileName: () => fileName
      }
    },
    plugins: [copyStaticAssetsPlugin()]
  });
}

export default createExtensionBuildConfig(EXTENSION_ENTRIES[0]);
