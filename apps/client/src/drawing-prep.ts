export interface PreparedDrawing {
  dataUrl: string;
  width: number;
  height: number;
  crop: [number, number, number, number];
  quality: DrawingQuality;
}

export type DrawingQualityWarning = "page_edge_uncertain" | "low_contrast" | "content_near_edge";

export interface DrawingQuality {
  paperDetected: boolean;
  contrast: number;
  warnings: DrawingQualityWarning[];
}

const ALLOWED_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_EDGE = 1_600;

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The drawing could not be read."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("The drawing could not be read."));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That file is not a usable drawing image."));
    image.src = dataUrl;
  });
}

function drawingBounds(image: ImageData): [number, number, number, number] | undefined {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4;
      const red = image.data[index] ?? 255;
      const green = image.data[index + 1] ?? 255;
      const blue = image.data[index + 2] ?? 255;
      const alpha = image.data[index + 3] ?? 255;
      const brightest = Math.max(red, green, blue);
      const darkest = Math.min(red, green, blue);
      const luminance = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
      const saturation = brightest === 0 ? 0 : (brightest - darkest) / brightest;
      // Preserve dark pencil/crayon strokes and colourful crayon marks. This
      // changes only the crop boundary; pixels are never beautified or redrawn.
      if (alpha < 16 || (luminance > 0.82 && saturation < 0.16)) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) return undefined;
  const padding = Math.max(12, Math.round(Math.max(right - left + 1, bottom - top + 1) * 0.08));
  return [
    Math.max(0, left - padding),
    Math.max(0, top - padding),
    Math.min(image.width, right + padding + 1),
    Math.min(image.height, bottom + padding + 1),
  ];
}

function longestRun(values: number[], predicate: (value: number) => boolean): [number, number] | undefined {
  let bestStart = 0;
  let bestEnd = 0;
  let start = 0;
  for (let index = 0; index <= values.length; index += 1) {
    if (index < values.length && predicate(values[index] ?? 0)) continue;
    if (index - start > bestEnd - bestStart) {
      bestStart = start;
      bestEnd = index;
    }
    start = index + 1;
  }
  return bestEnd > bestStart ? [bestStart, bestEnd] : undefined;
}

/**
 * Finds a photographed sheet before looking for its ink. This prevents a
 * wooden table, carpet, or bedroom floor from becoming part of a child's
 * playable artwork. If a clear paper region is not present, callers retain
 * the conservative ink-bound fallback below.
 */
function paperBounds(image: ImageData): [number, number, number, number] | undefined {
  const columns = Array.from({ length: image.width }, () => 0);
  const rows = Array.from({ length: image.height }, () => 0);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4;
      const red = image.data[index] ?? 255;
      const green = image.data[index + 1] ?? 255;
      const blue = image.data[index + 2] ?? 255;
      const lightest = Math.max(red, green, blue);
      const darkest = Math.min(red, green, blue);
      const luminance = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
      const saturation = lightest === 0 ? 0 : (lightest - darkest) / lightest;
      // Phone photos often shade a white sheet toward warm grey. Keep that
      // paper region while excluding a saturated tabletop or carpet.
      if (luminance < 0.56 || saturation > 0.25) continue;
      columns[x] = (columns[x] ?? 0) + 1;
      rows[y] = (rows[y] ?? 0) + 1;
    }
  }
  const horizontal = longestRun(columns, (count) => count >= image.height * 0.2);
  const vertical = longestRun(rows, (count) => count >= image.width * 0.2);
  if (!horizontal || !vertical) return undefined;
  const [left, right] = horizontal;
  const [top, bottom] = vertical;
  const area = (right - left) * (bottom - top);
  if (area < image.width * image.height * 0.3) return undefined;
  // The detected region is the sheet itself, so do not add a content-style
  // margin here: even a few pixels would reintroduce the tabletop.
  const padding = 0;
  return [
    Math.max(0, left - padding),
    Math.max(0, top - padding),
    Math.min(image.width, right + padding),
    Math.min(image.height, bottom + padding),
  ];
}

function percentileFromHistogram(histogram: Uint32Array, total: number, percentile: number): number {
  const threshold = total * percentile;
  let count = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    count += histogram[index] ?? 0;
    if (count >= threshold) return index / 255;
  }
  return 1;
}

export function assessDrawingQuality(
  image: { width: number; height: number; data: ArrayLike<number> },
  contentBounds: readonly [number, number, number, number] | undefined,
  paperDetected: boolean,
): DrawingQuality {
  const histogram = new Uint32Array(256);
  const pixels = image.width * image.height;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const red = image.data[offset] ?? 255;
    const green = image.data[offset + 1] ?? 255;
    const blue = image.data[offset + 2] ?? 255;
    const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
    histogram[luminance] = (histogram[luminance] ?? 0) + 1;
  }
  const contrast = percentileFromHistogram(histogram, pixels, 0.95) -
    percentileFromHistogram(histogram, pixels, 0.05);
  const warnings: DrawingQualityWarning[] = [];
  if (!paperDetected) warnings.push("page_edge_uncertain");
  if (contrast < 0.16) warnings.push("low_contrast");
  if (contentBounds) {
    const [left, top, right, bottom] = contentBounds;
    const marginX = image.width * 0.012;
    const marginY = image.height * 0.012;
    if (left <= marginX || top <= marginY || right >= image.width - marginX || bottom >= image.height - marginY) {
      warnings.push("content_near_edge");
    }
  }
  return { paperDetected, contrast, warnings };
}

/**
 * Runs entirely in the browser. It validates the captured file, finds the
 * ink/content bounds, and emits a bounded PNG crop. The original pixels inside
 * that crop are retained unchanged; no art-restyling filters are applied.
 */
export async function prepareDrawing(file: File): Promise<PreparedDrawing> {
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new Error("Choose a GIF, JPEG, PNG, or WebP drawing.");
  }
  if (file.size < 1 || file.size > MAX_INPUT_BYTES) {
    throw new Error("Choose a drawing smaller than 8 MB.");
  }

  const dataUrl = await fileDataUrl(file);
  const image = await loadImage(dataUrl);
  if (image.naturalWidth < 16 || image.naturalHeight < 16) {
    throw new Error("Choose a larger photo of your drawing.");
  }
  const analysisScale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const analysisWidth = Math.max(1, Math.round(image.naturalWidth * analysisScale));
  const analysisHeight = Math.max(1, Math.round(image.naturalHeight * analysisScale));
  const analysis = document.createElement("canvas");
  analysis.width = analysisWidth;
  analysis.height = analysisHeight;
  const analysisContext = analysis.getContext("2d", { willReadFrequently: true });
  if (!analysisContext) throw new Error("This browser cannot prepare drawing images.");
  analysisContext.drawImage(image, 0, 0, analysisWidth, analysisHeight);

  const pixels = analysisContext.getImageData(0, 0, analysisWidth, analysisHeight);
  const paper = paperBounds(pixels);
  const ink = drawingBounds(pixels);
  const detected = paper ?? ink;
  const quality = assessDrawingQuality(pixels, ink, paper !== undefined);
  const bounds = detected ?? [0, 0, analysisWidth, analysisHeight] as const;
  const [left, top, right, bottom] = bounds;
  const sourceLeft = Math.round(left / analysisScale);
  const sourceTop = Math.round(top / analysisScale);
  const sourceWidth = Math.max(1, Math.round((right - left) / analysisScale));
  const sourceHeight = Math.max(1, Math.round((bottom - top) / analysisScale));
  const outputScale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * outputScale));
  const height = Math.max(1, Math.round(sourceHeight * outputScale));
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const outputContext = output.getContext("2d");
  if (!outputContext) throw new Error("This browser cannot prepare drawing images.");
  outputContext.imageSmoothingEnabled = true;
  outputContext.drawImage(
    image,
    sourceLeft,
    sourceTop,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height,
  );
  return {
    dataUrl: output.toDataURL("image/png"),
    width,
    height,
    crop: [
      sourceLeft / image.naturalWidth,
      sourceTop / image.naturalHeight,
      Math.min(1, (sourceLeft + sourceWidth) / image.naturalWidth),
      Math.min(1, (sourceTop + sourceHeight) / image.naturalHeight),
    ],
    quality,
  };
}
