export interface PreparedDrawing {
  dataUrl: string;
  width: number;
  height: number;
  crop: [number, number, number, number];
  correction: DrawingCorrection;
  quality: DrawingQuality;
}

export type DrawingQualityWarning =
  | "page_edge_uncertain"
  | "low_contrast"
  | "content_near_edge"
  | "blurry"
  | "uneven_lighting"
  | "page_skewed";

export interface DrawingAdjustment {
  /** Clockwise, transform-only rotation. Deliberately bounded by the UI. */
  rotationDegrees?: number;
  /** Insets into the rotated source, expressed from zero to one. */
  cropInsets?: { left: number; top: number; right: number; bottom: number };
}

export interface DrawingCorrection {
  rotationDegrees: number;
  cropInsets: { left: number; top: number; right: number; bottom: number };
  manuallyAdjusted: boolean;
}

export interface DrawingQuality {
  paperDetected: boolean;
  contrast: number;
  sharpness: number;
  lightingRange: number;
  estimatedSkewDegrees: number;
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

function pixelLuminance(image: { data: ArrayLike<number> }, pixel: number): number {
  const offset = pixel * 4;
  return (
    (image.data[offset] ?? 255) * 0.2126 +
    (image.data[offset + 1] ?? 255) * 0.7152 +
    (image.data[offset + 2] ?? 255) * 0.0722
  ) / 255;
}

function imageSharpness(image: { width: number; height: number; data: ArrayLike<number> }): number {
  if (image.width < 3 || image.height < 3) return 0;
  let sum = 0;
  let sumSquared = 0;
  let samples = 0;
  const stride = Math.max(1, Math.floor(Math.max(image.width, image.height) / 800));
  for (let y = 1; y < image.height - 1; y += stride) {
    for (let x = 1; x < image.width - 1; x += stride) {
      const center = y * image.width + x;
      const laplacian =
        pixelLuminance(image, center - image.width) +
        pixelLuminance(image, center + image.width) +
        pixelLuminance(image, center - 1) +
        pixelLuminance(image, center + 1) -
        4 * pixelLuminance(image, center);
      sum += laplacian;
      sumSquared += laplacian * laplacian;
      samples += 1;
    }
  }
  if (!samples) return 0;
  const mean = sum / samples;
  return Math.max(0, sumSquared / samples - mean * mean);
}

function imageLightingRange(image: { width: number; height: number; data: ArrayLike<number> }): number {
  const grid = 4;
  const tileSums = new Float64Array(grid * grid);
  const tileCounts = new Uint32Array(grid * grid);
  const stride = Math.max(1, Math.floor(Math.max(image.width, image.height) / 600));
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
      const pixel = y * image.width + x;
      const offset = pixel * 4;
      const red = (image.data[offset] ?? 255) / 255;
      const green = (image.data[offset + 1] ?? 255) / 255;
      const blue = (image.data[offset + 2] ?? 255) / 255;
      const lightest = Math.max(red, green, blue);
      const darkest = Math.min(red, green, blue);
      const saturation = lightest === 0 ? 0 : (lightest - darkest) / lightest;
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      // Compare likely substrate, not the child's saturated strokes.
      if (luminance < 0.45 || saturation > 0.28) continue;
      const tileX = Math.min(grid - 1, Math.floor((x / image.width) * grid));
      const tileY = Math.min(grid - 1, Math.floor((y / image.height) * grid));
      const tile = tileY * grid + tileX;
      tileSums[tile] = (tileSums[tile] ?? 0) + luminance;
      tileCounts[tile] = (tileCounts[tile] ?? 0) + 1;
    }
  }
  const means: number[] = [];
  for (let tile = 0; tile < tileSums.length; tile += 1) {
    const count = tileCounts[tile] ?? 0;
    if (count >= 8) means.push((tileSums[tile] ?? 0) / count);
  }
  return means.length >= 4 ? Math.max(...means) - Math.min(...means) : 0;
}

function regressionSlope(points: ReadonlyArray<readonly [number, number]>): number | undefined {
  if (points.length < 8) return undefined;
  let meanX = 0;
  let meanY = 0;
  for (const [x, y] of points) {
    meanX += x;
    meanY += y;
  }
  meanX /= points.length;
  meanY /= points.length;
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
  }
  return denominator > 0 ? numerator / denominator : undefined;
}

/** Conservative skew evidence from light, low-saturation page edges. */
export function estimatePaperSkewDegrees(
  image: { width: number; height: number; data: ArrayLike<number> },
): number {
  const left: Array<readonly [number, number]> = [];
  const right: Array<readonly [number, number]> = [];
  const step = Math.max(1, Math.floor(image.height / 160));
  const topCutoff = image.height * 0.12;
  const bottomCutoff = image.height * 0.88;
  for (let y = Math.ceil(topCutoff); y < bottomCutoff; y += step) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const red = (image.data[offset] ?? 255) / 255;
      const green = (image.data[offset + 1] ?? 255) / 255;
      const blue = (image.data[offset + 2] ?? 255) / 255;
      const lightest = Math.max(red, green, blue);
      const darkest = Math.min(red, green, blue);
      const saturation = lightest === 0 ? 0 : (lightest - darkest) / lightest;
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      if (luminance < 0.56 || saturation > 0.25) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first < 0 || last - first < image.width * 0.25) continue;
    left.push([y, first]);
    right.push([y, last]);
  }
  const slopes = [regressionSlope(left), regressionSlope(right)].filter(
    (value): value is number => value !== undefined && Number.isFinite(value),
  );
  if (slopes.length < 2 || Math.abs((slopes[0] ?? 0) - (slopes[1] ?? 0)) > 0.14) return 0;
  const slope = slopes.reduce((sum, value) => sum + value, 0) / slopes.length;
  const degrees = Math.atan(slope) * 180 / Math.PI;
  return Math.abs(degrees) <= 15 ? degrees : 0;
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
  const sharpness = imageSharpness(image);
  const lightingRange = imageLightingRange(image);
  const estimatedSkewDegrees = paperDetected ? estimatePaperSkewDegrees(image) : 0;
  const warnings: DrawingQualityWarning[] = [];
  if (!paperDetected) warnings.push("page_edge_uncertain");
  if (contrast < 0.16) warnings.push("low_contrast");
  if (contrast >= 0.16 && sharpness < 0.0008) warnings.push("blurry");
  if (lightingRange > 0.28) warnings.push("uneven_lighting");
  if (Math.abs(estimatedSkewDegrees) > 2.5) warnings.push("page_skewed");
  if (contentBounds) {
    const [left, top, right, bottom] = contentBounds;
    const marginX = image.width * 0.012;
    const marginY = image.height * 0.012;
    if (left <= marginX || top <= marginY || right >= image.width - marginX || bottom >= image.height - marginY) {
      warnings.push("content_near_edge");
    }
  }
  return { paperDetected, contrast, sharpness, lightingRange, estimatedSkewDegrees, warnings };
}

function normalizedAdjustment(adjustment: DrawingAdjustment): Required<DrawingAdjustment> {
  const rotationDegrees = Number.isFinite(adjustment.rotationDegrees)
    ? Math.max(-180, Math.min(180, adjustment.rotationDegrees ?? 0))
    : 0;
  const raw = adjustment.cropInsets ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const cropInsets = {
    left: Math.max(0, Math.min(0.45, raw.left)),
    top: Math.max(0, Math.min(0.45, raw.top)),
    right: Math.max(0, Math.min(0.45, raw.right)),
    bottom: Math.max(0, Math.min(0.45, raw.bottom)),
  };
  if (cropInsets.left + cropInsets.right > 0.82) cropInsets.right = 0.82 - cropInsets.left;
  if (cropInsets.top + cropInsets.bottom > 0.82) cropInsets.bottom = 0.82 - cropInsets.top;
  return { rotationDegrees, cropInsets };
}

function adjustedBounds(
  width: number,
  height: number,
  insets: Required<DrawingAdjustment>["cropInsets"],
): [number, number, number, number] | undefined {
  if (!Object.values(insets).some((value) => value > 0)) return undefined;
  return [
    Math.round(width * insets.left),
    Math.round(height * insets.top),
    Math.round(width * (1 - insets.right)),
    Math.round(height * (1 - insets.bottom)),
  ];
}

/**
 * Runs entirely in the browser. It validates the captured file, finds the
 * ink/content bounds, and emits a bounded PNG crop. The original pixels inside
 * that crop are retained unchanged; no art-restyling filters are applied.
 */
export async function prepareDrawing(
  file: File,
  requestedAdjustment: DrawingAdjustment = {},
): Promise<PreparedDrawing> {
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
  const adjustment = normalizedAdjustment(requestedAdjustment);
  const radians = adjustment.rotationDegrees * Math.PI / 180;
  const rotatedWidth = Math.abs(image.naturalWidth * Math.cos(radians)) +
    Math.abs(image.naturalHeight * Math.sin(radians));
  const rotatedHeight = Math.abs(image.naturalWidth * Math.sin(radians)) +
    Math.abs(image.naturalHeight * Math.cos(radians));
  const analysisScale = Math.min(1, MAX_OUTPUT_EDGE / Math.max(rotatedWidth, rotatedHeight));
  const analysisWidth = Math.max(1, Math.round(rotatedWidth * analysisScale));
  const analysisHeight = Math.max(1, Math.round(rotatedHeight * analysisScale));
  const analysis = document.createElement("canvas");
  analysis.width = analysisWidth;
  analysis.height = analysisHeight;
  const analysisContext = analysis.getContext("2d", { willReadFrequently: true });
  if (!analysisContext) throw new Error("This browser cannot prepare drawing images.");
  analysisContext.fillStyle = "#ffffff";
  analysisContext.fillRect(0, 0, analysisWidth, analysisHeight);
  analysisContext.translate(analysisWidth / 2, analysisHeight / 2);
  analysisContext.rotate(radians);
  analysisContext.drawImage(
    image,
    -image.naturalWidth * analysisScale / 2,
    -image.naturalHeight * analysisScale / 2,
    image.naturalWidth * analysisScale,
    image.naturalHeight * analysisScale,
  );
  analysisContext.setTransform(1, 0, 0, 1, 0, 0);

  const pixels = analysisContext.getImageData(0, 0, analysisWidth, analysisHeight);
  const paper = paperBounds(pixels);
  const ink = drawingBounds(pixels);
  const manual = adjustedBounds(analysisWidth, analysisHeight, adjustment.cropInsets);
  const detected = manual ?? paper ?? ink;
  const quality = assessDrawingQuality(pixels, ink, paper !== undefined);
  const bounds = detected ?? [0, 0, analysisWidth, analysisHeight] as const;
  const [left, top, right, bottom] = bounds;
  const sourceWidth = Math.max(1, right - left);
  const sourceHeight = Math.max(1, bottom - top);
  const width = sourceWidth;
  const height = sourceHeight;
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const outputContext = output.getContext("2d");
  if (!outputContext) throw new Error("This browser cannot prepare drawing images.");
  outputContext.imageSmoothingEnabled = true;
  outputContext.drawImage(
    analysis,
    left,
    top,
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
      left / analysisWidth,
      top / analysisHeight,
      Math.min(1, right / analysisWidth),
      Math.min(1, bottom / analysisHeight),
    ],
    correction: {
      rotationDegrees: adjustment.rotationDegrees,
      cropInsets: adjustment.cropInsets,
      manuallyAdjusted: adjustment.rotationDegrees !== 0 || manual !== undefined,
    },
    quality,
  };
}
