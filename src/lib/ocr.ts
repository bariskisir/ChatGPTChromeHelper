/** Handles image cropping and OCR work inside the content-script context. */
import { createWorker, type Worker } from 'tesseract.js';
import type { OcrImagePayload, SelectionCoordinates } from './types';

const WORKER_PATH = chrome.runtime.getURL('assets/tesseract/worker.min.js');
const CORE_PATH = chrome.runtime.getURL('assets/tesseract-core');
const OCR_LANGUAGE = 'eng';
const OCR_DPI = '300';

interface TesseractWorkerConfig {
  languages: string;
  oem: 0 | 1;
}

let workerPromise: Promise<Worker> | null = null;

/** Crops the selected rectangle from a captured page image and returns the result as a data URL. */
export async function cropImage(imageUri: string, coordinates: SelectionCoordinates): Promise<{ croppedImageUri: string }> {
  const imageData = await cropImageData(imageUri, coordinates);
  return {
    croppedImageUri: imageData.croppedImageUri
  };
}

/** Crops the selected rectangle and runs OCR on the cropped image. */
export async function ocrImage(imageUri: string, coordinates: SelectionCoordinates): Promise<OcrImagePayload> {
  const imageData = await cropImageData(imageUri, coordinates);
  const worker = await getOcrWorker();
  const result = await worker.recognize(imageData.croppedImageUri);
  return {
    croppedImageUri: imageData.croppedImageUri,
    extractedText: result.data.text.trim()
  };
}

/** Converts screen-space coordinates into a cropped image extracted from the captured tab bitmap. */
async function cropImageData(
  imageUri: string,
  coordinates: SelectionCoordinates
): Promise<{ croppedImageUri: string; width: number; height: number }> {
  if (coordinates.width < 2 || coordinates.height < 2) {
    throw new Error('The selected area is too small.');
  }

  const image = await loadImage(imageUri);
  const pixelRatio = window.devicePixelRatio || 1;
  const startX = Math.max(0, Math.round(coordinates.startX * pixelRatio));
  const startY = Math.max(0, Math.round(coordinates.startY * pixelRatio));
  const width = Math.min(image.width - startX, Math.round(coordinates.width * pixelRatio));
  const height = Math.min(image.height - startY, Math.round(coordinates.height * pixelRatio));

  if (width < 4 || height < 4) {
    throw new Error('The selected area is outside the captured page.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not prepare an image canvas.');
  }

  context.drawImage(image, startX, startY, width, height, 0, 0, width, height);
  return {
    croppedImageUri: canvas.toDataURL('image/png'),
    width,
    height
  };
}

/** Lazily creates and reuses the OCR worker across multiple scan requests. */
async function getOcrWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createTesseractWorker({
      languages: OCR_LANGUAGE,
      oem: 1
    }).catch((error) => {
      workerPromise = null;
      throw error;
    });
  }

  return workerPromise;
}

/** Builds a Tesseract worker with the extension's bundled assets and OCR defaults. */
async function createTesseractWorker({
  languages,
  oem
}: TesseractWorkerConfig): Promise<Worker> {
  const workerOptions = {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    cacheMethod: 'none'
  } as const;

  const worker = await createWorker(languages, oem, workerOptions);
  await worker.setParameters({
    user_defined_dpi: OCR_DPI,
    preserve_interword_spaces: '1'
  });

  const singleBlockMode = '6' as unknown as NonNullable<Parameters<Worker['setParameters']>[0]['tessedit_pageseg_mode']>;
  await worker.setParameters({
    tessedit_pageseg_mode: singleBlockMode
  });
  return worker;
}

/** Loads a bitmap into an image element so canvas can crop it. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load the captured image.'));
    image.src = src;
  });
}
