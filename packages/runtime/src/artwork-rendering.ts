export interface PixelSurface {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface BackdropIsolationResult {
  isolated: boolean;
  removedPixels: number;
  backdropColor: number | undefined;
}

interface ColorCluster {
  count: number;
  red: number;
  green: number;
  blue: number;
  redSquared: number;
  greenSquared: number;
  blueSquared: number;
}

function colorKey(red: number, green: number, blue: number, bucketSize: number): number {
  const redBucket = Math.floor(red / bucketSize);
  const greenBucket = Math.floor(green / bucketSize);
  const blueBucket = Math.floor(blue / bucketSize);
  return (redBucket << 10) | (greenBucket << 5) | blueBucket;
}

function addSample(
  clusters: Map<number, ColorCluster>,
  red: number,
  green: number,
  blue: number,
  bucketSize: number,
): void {
  const key = colorKey(red, green, blue, bucketSize);
  const cluster = clusters.get(key) ?? {
    count: 0,
    red: 0,
    green: 0,
    blue: 0,
    redSquared: 0,
    greenSquared: 0,
    blueSquared: 0,
  };
  cluster.count += 1;
  cluster.red += red;
  cluster.green += green;
  cluster.blue += blue;
  cluster.redSquared += red * red;
  cluster.greenSquared += green * green;
  cluster.blueSquared += blue * blue;
  clusters.set(key, cluster);
}

function dominantCluster(clusters: Map<number, ColorCluster>): ColorCluster | undefined {
  return [...clusters.values()].sort((left, right) => right.count - left.count)[0];
}

function clusterColor(cluster: ColorCluster): [number, number, number] {
  return [
    Math.round(cluster.red / cluster.count),
    Math.round(cluster.green / cluster.count),
    Math.round(cluster.blue / cluster.count),
  ];
}

function packedColor([red, green, blue]: [number, number, number]): number {
  return (red << 16) | (green << 8) | blue;
}

/**
 * Finds the most common visual field in an image without assigning semantic
 * meaning to palette order, filenames, object names, or drawing subjects.
 */
export function dominantSurfaceColor(surface: PixelSurface): number | undefined {
  const { data, width, height } = surface;
  if (width < 1 || height < 1 || data.length < width * height * 4) return undefined;
  const clusters = new Map<number, ColorCluster>();
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 4_096)));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      if ((data[offset + 3] ?? 0) < 192) continue;
      addSample(
        clusters,
        data[offset] ?? 0,
        data[offset + 1] ?? 0,
        data[offset + 2] ?? 0,
        24,
      );
    }
  }
  const dominant = dominantCluster(clusters);
  return dominant ? packedColor(clusterColor(dominant)) : undefined;
}

/**
 * Removes a locally uniform substrate only when it dominates a crop border.
 * The flood fill is deliberately border-connected: an enclosed mark matching
 * the paper color remains intact. This works for white, dark, or colored paper
 * and declines to guess when a crop does not expose a reliable background.
 */
export function isolateBorderConnectedBackdrop(surface: PixelSurface): BackdropIsolationResult {
  const { data, width, height } = surface;
  const pixelCount = width * height;
  if (width < 2 || height < 2 || data.length < pixelCount * 4) {
    return { isolated: false, removedPixels: 0, backdropColor: undefined };
  }

  const clusters = new Map<number, ColorCluster>();
  let borderSamples = 0;
  const sample = (x: number, y: number): void => {
    const offset = (y * width + x) * 4;
    if ((data[offset + 3] ?? 0) < 192) return;
    addSample(
      clusters,
      data[offset] ?? 0,
      data[offset + 1] ?? 0,
      data[offset + 2] ?? 0,
      20,
    );
    borderSamples += 1;
  };
  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(0, y);
    sample(width - 1, y);
  }

  const orderedClusters = [...clusters.values()].sort((left, right) => right.count - left.count);
  const dominant = orderedClusters[0];
  if (!dominant || borderSamples === 0 || dominant.count / borderSamples < 0.28) {
    return { isolated: false, removedPixels: 0, backdropColor: undefined };
  }
  const [backdropRed, backdropGreen, backdropBlue] = clusterColor(dominant);
  const candidates: Array<{ color: [number, number, number]; toleranceSquared: number }> = [];
  for (const cluster of orderedClusters) {
    const share = cluster.count / borderSamples;
    const candidateColor = clusterColor(cluster);
    if (candidates.length > 0) {
      if (share < 0.04 || dominant.count / borderSamples >= 0.75) continue;
      const distanceFromDominant = Math.hypot(
        candidateColor[0] - backdropRed,
        candidateColor[1] - backdropGreen,
        candidateColor[2] - backdropBlue,
      );
      // Nearby clusters represent paper shade/lighting variation. A distant
      // cluster is much more likely to be a child's fill or stroke.
      if (distanceFromDominant > 68) continue;
    }
    const variance = (
      cluster.redSquared + cluster.greenSquared + cluster.blueSquared
    ) / cluster.count - (
      candidateColor[0] * candidateColor[0] +
      candidateColor[1] * candidateColor[1] +
      candidateColor[2] * candidateColor[2]
    );
    const tolerance = Math.max(22, Math.min(58, 20 + Math.sqrt(Math.max(0, variance)) * 2.5));
    candidates.push({ color: candidateColor, toleranceSquared: tolerance * tolerance });
    if (candidates.length >= 4) break;
  }
  const matchesBackdrop = (pixelIndex: number): boolean => {
    const offset = pixelIndex * 4;
    return candidates.some(({ color: [red, green, blue], toleranceSquared }) => {
      const redDistance = (data[offset] ?? 0) - red;
      const greenDistance = (data[offset + 1] ?? 0) - green;
      const blueDistance = (data[offset + 2] ?? 0) - blue;
      return redDistance * redDistance + greenDistance * greenDistance + blueDistance * blueDistance <= toleranceSquared;
    });
  };

  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let queueLength = 0;
  let cursor = 0;
  const enqueue = (x: number, y: number): void => {
    const pixelIndex = y * width + x;
    if (visited[pixelIndex] || !matchesBackdrop(pixelIndex)) return;
    visited[pixelIndex] = 1;
    queue[queueLength] = pixelIndex;
    queueLength += 1;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }
  while (cursor < queueLength) {
    const pixelIndex = queue[cursor] ?? 0;
    cursor += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    data[pixelIndex * 4 + 3] = 0;
    if (x > 0) enqueue(x - 1, y);
    if (x + 1 < width) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y + 1 < height) enqueue(x, y + 1);
  }

  // A tiny cleared edge is not useful isolation and can create a visible seam.
  const isolated = queueLength / pixelCount >= 0.08 && queueLength < pixelCount * 0.995;
  return {
    isolated,
    removedPixels: queueLength,
    backdropColor: packedColor([backdropRed, backdropGreen, backdropBlue]),
  };
}

export function fallbackWorldColor(palette: readonly string[]): number {
  const colors = palette
    .filter((value) => /^#[0-9a-f]{6}$/i.test(value))
    .map((value) => Number.parseInt(value.slice(1), 16));
  const neutralLight = colors
    .map((value) => ({
      value,
      red: (value >> 16) & 0xff,
      green: (value >> 8) & 0xff,
      blue: value & 0xff,
    }))
    .filter(({ red, green, blue }) => (
      Math.max(red, green, blue) - Math.min(red, green, blue) < 32 &&
      red + green + blue > 600
    ))
    .sort((left, right) => (
      right.red + right.green + right.blue - left.red - left.green - left.blue
    ))[0];
  return neutralLight?.value ?? 0xf7f4ff;
}

export function softenWorldColor(value: number): number {
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  const mix = chroma < 34 ? 0.62 : 0.18;
  const soften = (channel: number): number => Math.round(channel + (255 - channel) * mix);
  return packedColor([soften(red), soften(green), soften(blue)]);
}

/**
 * Softens only the outside edge of an otherwise unusable local crop. This is
 * a last-resort hero treatment: every interior source pixel stays untouched,
 * while the photographed crop boundary stops reading as the hero's shape.
 */
export function featherSurfaceEdges(surface: PixelSurface): void {
  const { data, width, height } = surface;
  if (width < 2 || height < 2 || data.length < width * height * 4) return;
  const feather = Math.max(2, Math.min(width, height) * 0.14);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const edgeDistance = Math.min(x, y, width - 1 - x, height - 1 - y);
      if (edgeDistance >= feather) continue;
      const normalized = Math.max(0, edgeDistance / feather);
      const eased = normalized * normalized * (3 - 2 * normalized);
      const alphaOffset = (y * width + x) * 4 + 3;
      data[alphaOffset] = Math.round((data[alphaOffset] ?? 0) * eased);
    }
  }
}
