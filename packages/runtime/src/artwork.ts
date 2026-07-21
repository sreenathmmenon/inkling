import type { GameSpec, JsonObject, PlaytestReport } from "../../../runner/types.js";
import {
  createPlayContract,
  type PlayContract,
  type PlayContractOutcome,
} from "./play-contract.js";
import type { RuntimeTraceReport } from "./runtime-events.js";
import {
  parseBehaviorTracks,
  type BehaviorMotionTrack,
} from "./behavior-track.js";
import {
  parseBackdropPlan,
  type BackdropPlan,
} from "./backdrop-contract.js";

export type NormalizedBounds = [number, number, number, number];

export interface ArtworkManifest {
  format: "inkling-artwork-v1";
  /**
   * An inline source image is deliberately used for local saved games. Lane A
   * never dereferences a remote URL, so opening a saved game has no network
   * dependency. A production asset-store reference belongs at the service
   * boundary, not in the deterministic player.
   */
  sourceDataUrl: string;
  entityCrops: Record<string, NormalizedBounds>;
  /** P3's validated hero motion plan; absent plans use a deterministic puppet fallback. */
  heroRig?: HeroRigPlan;
}

export interface HeroRigPlan {
  topology: "humanoid" | "quadruped" | "blob" | "vehicle" | "unknown";
  tier: "arap_mesh" | "squash_stretch_puppet";
  joints: Array<{ name: string; point: [number, number] }>;
  animations: Array<"idle" | "walk" | "jump" | "blink" | "bounce" | "lean">;
  styleRef: string | null;
}

export interface PlayableGameDocument {
  format: "inkling-playable-game-v1";
  gameSpec: GameSpec;
  artwork: ArtworkManifest | null;
  readinessEvidence: ReadinessEvidence | null;
  /** Certified sandbox motion per entity; data only, never module source. */
  behaviorTracks?: Record<string, BehaviorMotionTrack> | null;
  /** P4's parallax plan; colors always come from the child's page. */
  backdrop?: BackdropPlan | null;
  /** P5's selected packs; unknown ids degrade to the base pack. */
  soundPack?: { musicPackId: string; sfxPackId: string } | null;
}

export interface ReadinessEvidence {
  playtestReport: PlaytestReport;
  solvability: JsonObject;
  playContract: PlayContract;
  runtimeTraceReport: RuntimeTraceReport | null;
}

export type PipelineReadinessEvidence = Omit<
  ReadinessEvidence,
  "playContract" | "runtimeTraceReport"
>;

export interface ResolvedPlayableGame {
  gameSpec: unknown;
  artwork: ArtworkManifest | undefined;
  readinessOutcome: PlayContractOutcome | undefined;
  playContract: PlayContract | undefined;
  behaviorTracks: Record<string, BehaviorMotionTrack>;
  backdrop: BackdropPlan | undefined;
  sfxPackId: string | undefined;
}

const TOPOLOGIES = new Set<HeroRigPlan["topology"]>([
  "humanoid", "quadruped", "blob", "vehicle", "unknown",
]);
const TIERS = new Set<HeroRigPlan["tier"]>(["arap_mesh", "squash_stretch_puppet"]);
const ANIMATIONS = new Set<HeroRigPlan["animations"][number]>([
  "idle", "walk", "jump", "blink", "bounce", "lean",
]);

const INLINE_IMAGE = /^data:image\/(?:gif|jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedBounds(value: unknown): NormalizedBounds | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    return undefined;
  }
  const [firstX, firstY, secondX, secondY] = value;
  if (
    firstX === undefined ||
    firstY === undefined ||
    secondX === undefined ||
    secondY === undefined
  ) {
    return undefined;
  }
  const left = Math.max(0, Math.min(1, Math.min(firstX, secondX)));
  const top = Math.max(0, Math.min(1, Math.min(firstY, secondY)));
  const right = Math.max(0, Math.min(1, Math.max(firstX, secondX)));
  const bottom = Math.max(0, Math.min(1, Math.max(firstY, secondY)));
  if (right - left < 0.01 || bottom - top < 0.01) return undefined;
  return [left, top, right, bottom];
}

function paddedSourceBounds(bounds: NormalizedBounds): NormalizedBounds {
  const [left, top, right, bottom] = bounds;
  const horizontalPadding = Math.max(0.005, (right - left) * 0.06);
  const verticalPadding = Math.max(0.005, (bottom - top) * 0.06);
  return [
    Math.max(0, left - horizontalPadding),
    Math.max(0, top - verticalPadding),
    Math.min(1, right + horizontalPadding),
    Math.min(1, bottom + verticalPadding),
  ];
}

export function fitArtworkWithin(
  sourceWidth: number,
  sourceHeight: number,
  maximumWidth: number,
  maximumHeight: number,
): { width: number; height: number } {
  if (
    ![sourceWidth, sourceHeight, maximumWidth, maximumHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    return { width: Math.max(1, maximumWidth), height: Math.max(1, maximumHeight) };
  }
  const scale = Math.min(maximumWidth / sourceWidth, maximumHeight / sourceHeight);
  return { width: sourceWidth * scale, height: sourceHeight * scale };
}

export function isInlineArtworkDataUrl(value: unknown): value is string {
  return typeof value === "string" && INLINE_IMAGE.test(value);
}

export function createArtworkManifest(
  gameSpec: GameSpec,
  sourceDataUrl: string,
  heroRig?: unknown,
): ArtworkManifest {
  if (!isInlineArtworkDataUrl(sourceDataUrl)) {
    throw new Error("Artwork source must be an inline GIF, JPEG, PNG, or WebP data URL");
  }
  const entityCrops: Record<string, NormalizedBounds> = {};
  const heroBounds = normalizedBounds(gameSpec.hero.bbox);
  if (heroBounds) entityCrops[gameSpec.hero.id] = paddedSourceBounds(heroBounds);
  for (const entity of gameSpec.entities) {
    const bounds = normalizedBounds(entity.bbox);
    if (bounds) entityCrops[entity.id] = paddedSourceBounds(bounds);
  }
  const manifest: ArtworkManifest = {
    format: "inkling-artwork-v1",
    sourceDataUrl,
    entityCrops,
  };
  const parsedRig = parseHeroRigPlan(heroRig);
  if (parsedRig) manifest.heroRig = parsedRig;
  return manifest;
}

export function createPlayableGameDocument(
  gameSpec: GameSpec,
  sourceDataUrl?: string,
  heroRig?: unknown,
  readinessEvidence?: PipelineReadinessEvidence,
  behaviorTracks?: Record<string, BehaviorMotionTrack>,
  assetPlans?: { backdrop?: unknown; soundPack?: unknown },
): PlayableGameDocument {
  const tracks = parseBehaviorTracks(behaviorTracks);
  const backdrop = parseBackdropPlan(assetPlans?.backdrop) ?? null;
  const soundPack = parseSoundPack(assetPlans?.soundPack);
  return {
    format: "inkling-playable-game-v1",
    gameSpec,
    artwork: sourceDataUrl ? createArtworkManifest(gameSpec, sourceDataUrl, heroRig) : null,
    readinessEvidence: readinessEvidence
      ? {
        ...readinessEvidence,
        // The solver route's visited set is the server-side drawn-support
        // evidence; the client trace audit applies the same shared rule to
        // real surface_landed events, so the two claims can never drift.
        playContract: createPlayContract(gameSpec, {
          certifiedDynamicEntityIds: Object.keys(tracks),
          solverVisitedEntityIds: Array.isArray(readinessEvidence.playtestReport?.visited)
            ? readinessEvidence.playtestReport.visited
            : [],
        }),
        runtimeTraceReport: null,
      }
      : null,
    behaviorTracks: Object.keys(tracks).length > 0 ? tracks : null,
    backdrop,
    soundPack,
  };
}

const MAX_PACK_ID_LENGTH = 40;

function parseSoundPack(value: unknown): { musicPackId: string; sfxPackId: string } | null {
  if (!isRecord(value)) return null;
  const music = value.musicPackId ?? value.music_pack_id;
  const sfx = value.sfxPackId ?? value.sfx_pack_id;
  if (
    typeof music !== "string" || music.length === 0 || music.length > MAX_PACK_ID_LENGTH ||
    typeof sfx !== "string" || sfx.length === 0 || sfx.length > MAX_PACK_ID_LENGTH
  ) {
    return null;
  }
  return { musicPackId: music, sfxPackId: sfx };
}

export function parseHeroRigPlan(value: unknown): HeroRigPlan | undefined {
  if (!isRecord(value) || !TOPOLOGIES.has(value.topology as HeroRigPlan["topology"])) {
    return undefined;
  }
  if (!TIERS.has(value.tier as HeroRigPlan["tier"]) || !Array.isArray(value.joints)) {
    return undefined;
  }
  if (!Array.isArray(value.animations) || (typeof value.style_ref !== "string" && value.style_ref !== null)) {
    return undefined;
  }
  const joints: HeroRigPlan["joints"] = [];
  for (const joint of value.joints) {
    if (!isRecord(joint) || typeof joint.name !== "string" || !Array.isArray(joint.point) || joint.point.length !== 2) {
      return undefined;
    }
    const [x, y] = joint.point;
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
      return undefined;
    }
    joints.push({ name: joint.name, point: [x, y] });
  }
  const animations: HeroRigPlan["animations"] = [];
  for (const animation of value.animations) {
    if (typeof animation !== "string" || !ANIMATIONS.has(animation as HeroRigPlan["animations"][number])) {
      return undefined;
    }
    animations.push(animation as HeroRigPlan["animations"][number]);
  }
  return {
    topology: value.topology as HeroRigPlan["topology"],
    tier: value.tier as HeroRigPlan["tier"],
    joints,
    animations,
    styleRef: value.style_ref,
  };
}

export function parseArtworkManifest(value: unknown): ArtworkManifest | undefined {
  if (!isRecord(value) || value.format !== "inkling-artwork-v1") return undefined;
  if (!isInlineArtworkDataUrl(value.sourceDataUrl) || !isRecord(value.entityCrops)) {
    return undefined;
  }
  const entityCrops: Record<string, NormalizedBounds> = {};
  for (const [id, bounds] of Object.entries(value.entityCrops)) {
    const normalized = normalizedBounds(bounds);
    if (normalized) entityCrops[id] = normalized;
  }
  const manifest: ArtworkManifest = {
    format: "inkling-artwork-v1",
    sourceDataUrl: value.sourceDataUrl,
    entityCrops,
  };
  const heroRig = parseHeroRigPlan(value.heroRig);
  if (heroRig) manifest.heroRig = heroRig;
  return manifest;
}

/** Accepts a v1 playable document while retaining compatibility with raw GameSpec JSON. */
export function resolvePlayableGame(value: unknown): ResolvedPlayableGame {
  if (!isRecord(value) || value.format !== "inkling-playable-game-v1") {
    return {
      gameSpec: value,
      artwork: undefined,
      readinessOutcome: undefined,
      playContract: undefined,
      behaviorTracks: {},
      backdrop: undefined,
      sfxPackId: undefined,
    };
  }
  const evidence = isRecord(value.readinessEvidence) ? value.readinessEvidence : undefined;
  const playContract = evidence && isRecord(evidence.playContract) ? evidence.playContract : undefined;
  const parsedOutcome = playContract && (
    playContract.outcome === "faithful_ready" ||
    playContract.outcome === "related_fallback" ||
    playContract.outcome === "needs_recast"
  ) ? playContract.outcome : undefined;
  const runtimeTraceReport = evidence && isRecord(evidence.runtimeTraceReport)
    ? evidence.runtimeTraceReport
    : undefined;
  const runtimeReceiptMatches = Boolean(
    playContract &&
    runtimeTraceReport?.valid === true &&
    runtimeTraceReport.contractFormat === playContract.format &&
    runtimeTraceReport.templateId === playContract.templateId &&
    runtimeTraceReport.runtimeVersion === playContract.runtimeVersion,
  );
  const readinessOutcome = parsedOutcome === "faithful_ready" && !runtimeReceiptMatches
    ? "related_fallback"
    : parsedOutcome;
  const soundPack = parseSoundPack(value.soundPack);
  return {
    gameSpec: value.gameSpec,
    artwork: parseArtworkManifest(value.artwork),
    readinessOutcome,
    playContract: playContract as unknown as PlayContract | undefined,
    behaviorTracks: parseBehaviorTracks(value.behaviorTracks),
    backdrop: parseBackdropPlan(value.backdrop),
    sfxPackId: soundPack?.sfxPackId,
  };
}

export function attachRuntimeTraceReport(
  value: unknown,
  report: RuntimeTraceReport,
): unknown {
  if (!isRecord(value) || value.format !== "inkling-playable-game-v1") return value;
  if (!isRecord(value.readinessEvidence)) return value;
  return {
    ...value,
    readinessEvidence: { ...value.readinessEvidence, runtimeTraceReport: report },
  };
}
