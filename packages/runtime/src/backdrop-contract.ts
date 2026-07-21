/**
 * P4 backdrop consumption. The plan chooses layer count and parallax; every
 * visible property comes from the child's own page — palette colors behind
 * everything at low alpha — so the backdrop can never compete with or
 * obscure the drawn art. Absent or invalid plans degrade to no backdrop.
 */

export interface BackdropPlan {
  layers: Array<{ source: string; parallax: number }>;
}

export interface BackdropLayerRender {
  color: string;
  alpha: number;
  /** Fraction of world height the band occupies, anchored to the top. */
  heightFraction: number;
  scrollFactor: number;
}

const MAX_LAYERS = 3;
const MAX_SOURCE_LENGTH = 60;
export const MAX_BACKDROP_ALPHA = 0.16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBackdropPlan(value: unknown): BackdropPlan | undefined {
  if (!isRecord(value) || !Array.isArray(value.layers)) return undefined;
  const layers: BackdropPlan["layers"] = [];
  for (const layer of value.layers.slice(0, MAX_LAYERS)) {
    if (!isRecord(layer)) return undefined;
    if (typeof layer.source !== "string" || layer.source.length === 0 || layer.source.length > MAX_SOURCE_LENGTH) {
      return undefined;
    }
    if (typeof layer.parallax !== "number" || !Number.isFinite(layer.parallax)) return undefined;
    layers.push({
      source: layer.source,
      parallax: Math.max(0, Math.min(1, layer.parallax)),
    });
  }
  return layers.length > 0 ? { layers } : undefined;
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Deterministic renderable bands: farthest (lowest parallax) layers get the
 * lightest palette colors and sit tallest, so depth reads naturally without
 * any color leaving the child's own page.
 */
export function planBackdropLayers(
  plan: BackdropPlan | undefined,
  palette: readonly string[],
): BackdropLayerRender[] {
  if (!plan) return [];
  const colors = palette.filter((color) => HEX_COLOR.test(color));
  if (colors.length === 0) return [];
  const byLightness = [...colors].sort((left, right) => luminance(right) - luminance(left));
  const ordered = [...plan.layers].sort((left, right) => left.parallax - right.parallax);
  return ordered.map((layer, index) => ({
    color: byLightness[index % byLightness.length] ?? byLightness[0] ?? "#ffffff",
    alpha: Math.min(MAX_BACKDROP_ALPHA, 0.06 + layer.parallax * 0.08),
    heightFraction: Math.max(0.2, 0.58 - index * 0.14),
    scrollFactor: layer.parallax,
  }));
}
