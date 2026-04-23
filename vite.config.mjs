import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { defineConfig } from 'vite';

const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DIST_DIR = path.resolve(ROOT_DIR, 'dist');
const TESSERACT_DIST_DIR = path.resolve(ROOT_DIR, 'node_modules', 'tesseract.js', 'dist');
const TESSERACT_CORE_DIR = path.resolve(ROOT_DIR, 'node_modules', 'tesseract.js-core');

export const EXTENSION_ENTRIES = [
  { name: 'background', entry: 'src/background.ts', fileName: 'background.js', globalName: 'ChatGptChromeHelperBackground' },
  { name: 'content', entry: 'src/content.ts', fileName: 'content.js', globalName: 'ChatGptChromeHelperContent' },
  { name: 'popup', entry: 'src/popup.ts', fileName: 'popup.js', globalName: 'ChatGptChromeHelperPopup' },
  { name: 'selectionOverlay', entry: 'src/selectionOverlay.ts', fileName: 'selectionOverlay.js', globalName: 'ChatGptChromeHelperSelectionOverlay' },
  { name: 'imageSelectionOverlay', entry: 'src/imageSelectionOverlay.ts', fileName: 'imageSelectionOverlay.js', globalName: 'ChatGptChromeHelperImageSelectionOverlay' }
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
    copyFileTask('src/manifest.json', 'manifest.json'),
    copyFileTask('src/popup.html', 'popup.html'),
    copyFileTask('src/styles.css', 'styles.css'),
    copyFileTask('src/chatgpt-icon.png', 'chatgpt-icon.png'),
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
