import Phaser from "phaser";

import {
  createPlatformerPlan,
  type PlannedEntity,
  type PlatformerPlan,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./platformer-layout.js";
import {
  fitArtworkWithin,
  resolvePlayableGame,
  type ArtworkManifest,
  type NormalizedBounds,
} from "./artwork.js";
import {
  ONE_WAY_PLATFORM_COLLISION,
  PLATFORMER_PHYSICS,
} from "./platformer-physics.js";
import {
  surfaceJumpVelocity,
  surfaceVelocityX,
} from "./platformer-materials.js";
import {
  createTouchControlLayout,
  type TouchControlLayout,
} from "./platformer-controls.js";
import { createObjectiveContract } from "./objective-contract.js";
import {
  trackOffsetAt,
  type BehaviorMotionTrack,
} from "./behavior-track.js";
import {
  planBackdropLayers,
  type BackdropPlan,
} from "./backdrop-contract.js";
import {
  CELEBRATION_POINTS,
  feedbackCueFor,
  type GameplayFeedbackEvent,
  type GameplayFeedbackKind,
} from "./feedback-contract.js";
import {
  createCoachingContract,
  createRecoveryCue,
  type CoachingContract,
} from "./coaching-contract.js";
import type { RuntimeEvent, RuntimeEventKind } from "./runtime-events.js";
import {
  createLaunchState,
  resetLaunchShot,
  stepLaunchFrame,
  type LaunchState,
  type LaunchWorld,
} from "./launch-contract.js";
import type { InputFrame } from "./input-frame.js";
import { findMazeRoute, type MazePoint } from "./maze-topology.js";
import { carriedCollectibleIds } from "./progress-preservation.js";
import {
  dominantSurfaceColor,
  dominantSurfaceShare,
  fallbackWorldColor,
  featherSurfaceEdges,
  isolateBorderConnectedBackdrop,
  softlyIsolateLocalBackdrop,
  softlyRemoveKnownBackdrop,
  type BackdropIsolationResult,
} from "./artwork-rendering.js";
import {
  artworkHaloForWorldColor,
  boundedCueAnchor,
  friendlyObjectiveLabel,
  INKLING_CUE,
  INKLING_FONT_FAMILY,
  readableHeroArtworkFit,
} from "./presentation-contract.js";

export type PlatformerStatus = "playing" | "won" | "lost";

export interface PlatformerState {
  status: PlatformerStatus;
  lives: number;
  collected: number;
  collectibleTotal: number;
  assistAvailable: boolean;
  assistActive: boolean;
}

export interface PlatformerOptions {
  parent: string | HTMLElement;
  gameSpec: unknown;
  artwork?: ArtworkManifest;
  onStateChange?: (state: PlatformerState) => void;
  onFeedback?: (event: GameplayFeedbackEvent) => void;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  /** Fixed control trace used by the production-browser replay harness. */
  inputFrames?: readonly InputFrame[];
  showTouchControls?: boolean;
  /** Standalone keeps all runtime chrome; embedded lets the host own headings. */
  presentation?: "standalone" | "embedded";
  /**
   * Bonus collectibles carried forward from a rescan of the same world. Only
   * ids the deterministic carry rule admits (still present, never required,
   * never a collect_all objective) are marked collected at create; the
   * certification replay never passes this, so solvability is unaffected.
   */
  initiallyCollected?: readonly string[];
}

export type PlatformerControl = "left" | "right" | "jump" | "down" | "action";

interface Controls {
  cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  left?: Phaser.Input.Keyboard.Key;
  right?: Phaser.Input.Keyboard.Key;
  jump?: Phaser.Input.Keyboard.Key;
  down?: Phaser.Input.Keyboard.Key;
  space?: Phaser.Input.Keyboard.Key;
}

const ENVIRONMENTAL_SURFACE_ROLES = new Set(["platform", "ice", "cloud", "launchpad", "water"]);

function color(value: string | undefined, fallback: number): number {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return fallback;
  return Number.parseInt(value.slice(1), 16);
}

function colorLuminance(value: number): number {
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

class PlatformerScene extends Phaser.Scene {
  private readonly artworkTextureKey = "inkling-original-art";
  private hero!: Phaser.GameObjects.Rectangle;
  private heroArtwork: Phaser.GameObjects.Image | undefined;
  private readonly artworkByEntity = new Map<string, Phaser.GameObjects.Image>();
  private readonly artworkHaloByEntity = new Map<string, Phaser.GameObjects.Ellipse>();
  private readonly artworkIsolationByEntity = new Map<string, boolean>();
  private sceneWorldColor = 0xf7f4ff;
  private sceneSurfaceShare = 1;
  private readonly doorObjects = new Map<string, Phaser.GameObjects.Rectangle>();
  private platforms!: Phaser.Physics.Arcade.StaticGroup;
  private doors!: Phaser.Physics.Arcade.StaticGroup;
  private hazards!: Phaser.Physics.Arcade.StaticGroup;
  private trackedHazards: Array<{
    track: BehaviorMotionTrack;
    body: Phaser.Physics.Arcade.StaticBody;
    bodyWidth: number;
    bodyHeight: number;
    parts: Array<{
      object: { setPosition(x: number, y: number): unknown };
      baseX: number;
      baseY: number;
    }>;
  }> = [];
  private collectibles!: Phaser.Physics.Arcade.StaticGroup;
  private goalTrigger!: Phaser.Physics.Arcade.StaticGroup;
  private target!: Phaser.Physics.Arcade.StaticGroup;
  private projectiles!: Phaser.Physics.Arcade.Group;
  private hud!: Phaser.GameObjects.Text;
  private goalGuide: Phaser.GameObjects.Text | undefined;
  private goalPointer: Phaser.GameObjects.Triangle | undefined;
  private message!: Phaser.GameObjects.Text;
  private recoveryGuide: Phaser.GameObjects.Text | undefined;
  private controls: Controls = {};
  private touch = { left: false, right: false, jump: false, down: false, action: false };
  private touchButtons: Phaser.GameObjects.Container[] = [];
  private touchResizeObserver: ResizeObserver | undefined;
  private jumpWasDown = false;
  private lives = 3;
  private collected = 0;
  private readonly collectedIds = new Set<string>();
  private elapsedMs = 0;
  private invulnerableUntil = 0;
  private lastGroundedAt = 0;
  private lastJumpPressedAt = -Infinity;
  private jumpsRemaining: number = PLATFORMER_PHYSICS.maxJumps;
  private surviveRemainingMs = PLATFORMER_PHYSICS.surviveDurationMs;
  private lastProjectileAt = -Infinity;
  private projectileFeedbackShown = false;
  private lastGoalBlockedAt = -Infinity;
  private lastSurfaceId: string | undefined;
  private wasInsideWater = false;
  private meaningfulInputSeen = false;
  private runnerStarted = false;
  private lastProgressAt = 0;
  private bestObjectiveDistance = Infinity;
  private stuckCueShown = false;
  private assistAvailable = false;
  private assistActiveUntil = -Infinity;
  private assistTargetGuide: Phaser.GameObjects.Ellipse | undefined;
  private launchState: LaunchState | undefined;
  private launchWorld: LaunchWorld | undefined;
  private aimIndicator: Phaser.GameObjects.Graphics | undefined;
  private lastAimIndicatorKey = "";
  private status: PlatformerStatus = "playing";
  private frame = 0;
  private physicsStepsElapsed = 0;
  private runtimeSequence = 0;
  private readonly replayFrames: ReadonlyMap<number, InputFrame>;
  private readonly coaching: CoachingContract;
  private coachingCompleted = false;
  private readonly coachingObjects: Phaser.GameObjects.GameObject[] = [];
  private readonly controlCoachingObjects: Phaser.GameObjects.GameObject[] = [];
  private readonly reducedMotion = typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  setExternalControl(control: PlatformerControl, pressed: boolean): void {
    this.touch[control] = pressed;
    if (pressed) this.acceptCoachedControl(control);
  }

  requestAssist(): void {
    if (this.status !== "playing" || !this.assistAvailable) return;
    this.assistAvailable = false;
    this.assistActiveUntil = this.elapsedMs + PLATFORMER_PHYSICS.assistDurationMs;
    const target = this.recoveryTarget();
    if (target) this.showAssistTarget(target);
    this.recoveryGuide?.destroy();
    this.recoveryGuide = undefined;
    this.emitFeedback("assist_activated", null, false);
    this.publishState();
  }

  private get usesFreeMovement(): boolean {
    return this.plan.contract.movement === "free" || this.plan.contract.movement === "launch";
  }

  private get usesLaunchMovement(): boolean {
    return this.plan.contract.movement === "launch";
  }

  constructor(
    private readonly plan: PlatformerPlan,
    private readonly artwork: ArtworkManifest | undefined,
    private readonly onStateChange?: (state: PlatformerState) => void,
    private readonly onFeedback?: (event: GameplayFeedbackEvent) => void,
    private readonly onRuntimeEvent?: (event: RuntimeEvent) => void,
    inputFrames: readonly InputFrame[] = [],
    private readonly showTouchControls = true,
    private readonly presentation: "standalone" | "embedded" = "standalone",
    private readonly backdrop?: BackdropPlan,
    private readonly initiallyCollected: readonly string[] = [],
  ) {
    super("lane-a-platformer");
    this.coaching = createCoachingContract(plan);
    this.replayFrames = new Map(inputFrames.map((input) => [input.frame, input]));
  }

  preload(): void {
    if (this.artwork) this.load.image(this.artworkTextureKey, this.artwork.sourceDataUrl);
  }

  create(): void {
    this.physics.resume();
    this.status = "playing";
    this.lives = this.plan.lives;
    this.collected = 0;
    this.collectedIds.clear();
    this.doorObjects.clear();
    this.elapsedMs = 0;
    this.invulnerableUntil = 0;
    this.lastGroundedAt = 0;
    this.lastJumpPressedAt = -Infinity;
    this.jumpsRemaining = PLATFORMER_PHYSICS.maxJumps;
    this.surviveRemainingMs = PLATFORMER_PHYSICS.surviveDurationMs;
    this.touch = { left: false, right: false, jump: false, down: false, action: false };
    this.jumpWasDown = false;
    this.projectileFeedbackShown = false;
    this.lastGoalBlockedAt = -Infinity;
    this.lastSurfaceId = undefined;
    this.wasInsideWater = false;
    this.meaningfulInputSeen = false;
    this.runnerStarted = false;
    this.lastProgressAt = 0;
    this.bestObjectiveDistance = Infinity;
    this.stuckCueShown = false;
    this.assistAvailable = false;
    this.assistActiveUntil = -Infinity;
    this.assistTargetGuide?.destroy();
    this.assistTargetGuide = undefined;
    this.recoveryGuide?.destroy();
    this.recoveryGuide = undefined;
    this.frame = 0;
    this.physicsStepsElapsed = 0;
    // Frame identity advances with the fixed 60 Hz physics step, never the
    // render tick: high-refresh displays call update() faster than the
    // simulation, and every frame-indexed contract (certified replay input,
    // tracked hazard motion, launch stepping, runtime-event frames) must stay
    // in exact agreement with the analytic playtester.
    this.physics.world.off(Phaser.Physics.Arcade.Events.WORLD_STEP, this.countPhysicsStep, this);
    this.physics.world.on(Phaser.Physics.Arcade.Events.WORLD_STEP, this.countPhysicsStep, this);
    this.runtimeSequence = 0;
    this.trackedHazards = [];
    this.launchState = undefined;
    this.launchWorld = undefined;
    this.aimIndicator = undefined;
    this.lastAimIndicatorKey = "";

    const orderedPalette = [...this.plan.palette].sort((left, right) => (
      colorLuminance(color(left, 0xffffff)) - colorLuminance(color(right, 0xffffff))
    ));
    const worldColor = this.artworkWorldColor();
    this.sceneWorldColor = worldColor;
    const paletteInk = color(orderedPalette[0], 0x263238);
    const ink = colorLuminance(worldColor) < 105 ? 0xf7f4ff : paletteInk;
    // Palette entries carry no role semantics. Original crops supply the
    // child's colors; missing or unusable crops use stable, accessible Lane A
    // tokens rather than guessing that palette position means hero/platform.
    const heroColor = INKLING_CUE.sun;
    const platformColor = INKLING_CUE.violet;
    const dangerColor = INKLING_CUE.coral;
    const collectibleColor = INKLING_CUE.sky;

    this.cameras.main.setBackgroundColor(worldColor);
    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    // P4's parallax plan renders as soft bands of the child's own palette,
    // behind everything and capped at low alpha so the backdrop can never
    // compete with the drawn art. No plan means no backdrop — play is
    // unaffected either way.
    for (const layer of planBackdropLayers(this.backdrop, this.plan.palette)) {
      this.add
        .rectangle(
          WORLD_WIDTH / 2,
          (layer.heightFraction * WORLD_HEIGHT) / 2,
          WORLD_WIDTH,
          layer.heightFraction * WORLD_HEIGHT,
          color(layer.color, worldColor),
          layer.alpha,
        )
        .setDepth(-5)
        .setScrollFactor(layer.scrollFactor, 1);
    }
    // The child's whole page is the world's scenery: rendered once, aligned
    // to world coordinates, with every self-rendering entity's region erased
    // (feathered, alpha-only) so no stroke ever exists twice and a collected
    // item leaves no ghost. Page-scale context drawings — skylines, seas —
    // finally stay visible instead of leaving a gray void.
    this.addPageBackdrop();
    if (this.presentation === "standalone") {
      this.add
        .text(24, 18, this.plan.title, {
          color: "#292343",
          fontFamily: INKLING_FONT_FAMILY,
          fontSize: "22px",
          fontStyle: "bold",
          backgroundColor: "rgba(255,251,244,0.86)",
          padding: { x: 8, y: 4 },
        })
        .setScrollFactor(0)
        .setDepth(20);
      if (this.usesFreeMovement) {
        this.add
          .text(this.scale.width - 24, 22, this.plan.contract.instruction, {
            color: `#${ink.toString(16).padStart(6, "0")}`,
            fontFamily: INKLING_FONT_FAMILY,
            fontSize: "16px",
            fontStyle: "bold",
          })
          .setOrigin(1, 0)
          .setScrollFactor(0)
          .setAlpha(0.78)
          .setDepth(20);
      }
    }

    // Decorations are the untraced remainder of the child's page. They render
    // at their drawn positions (which are their play positions) at full
    // opacity — a ghosted page reads as a rendering mistake, not as the world.
    for (const decoration of this.plan.decorations) this.addArtwork(decoration, 0, 1);

    this.platforms = this.physics.add.staticGroup();
    for (const platform of this.plan.platforms) {
      if (this.usesFreeMovement && platform.id === "lane_a_safety_floor") continue;
      const alpha = platform.id === "lane_a_safety_floor" ? 0.5 : 1;
      const materialColor = platform.role === "ice" ? 0x9ee7ff
        : platform.role === "cloud" ? 0xffffff
        : platform.role === "launchpad" ? 0xff7bbd
        : platformColor;
      const shape = this.rectangle(platform, materialColor, ink, alpha);
      // The child's strokes are the platform's primary visual. The template
      // fill only survives as the synthetic safety floor, as a subtle
      // affordance beneath rendered strokes, or as the organic fallback when
      // no usable crop exists — never as an opaque slab over drawn art.
      if (platform.id !== "lane_a_safety_floor") {
        const artwork = this.addArtwork(platform, 2, alpha);
        if (artwork) {
          this.addSurfaceAffordance(platform, materialColor);
        } else {
          shape.setAlpha(0);
          this.addOrganicSurface(platform, materialColor, 0.34, 2);
        }
      }
      this.physics.add.existing(shape, true);
      const body = shape.body as Phaser.Physics.Arcade.StaticBody;
      if (this.plan.contract.id === "maze") {
        // In a maze the drawn strips are visible art only; the collision
        // bodies are added below from the plan's merged wall geometry so the
        // scene, the topology check, and the analytic solver share one
        // clearance truth. If topology validation failed, the strips remain
        // visible but non-colliding in the explicitly related fallback.
      } else {
        // Drawn platforms are landing surfaces. Let the hero pass through their
        // underside and sides, then collide with the top while descending. This
        // is the same one-way contract used by the deterministic P8 simulation.
        Object.assign(body.checkCollision, ONE_WAY_PLATFORM_COLLISION);
        this.platforms.add(shape);
      }
    }
    // Merged maze walls (sub-clearance seams sealed at plan level) become the
    // collision bodies. They are invisible: the child's strips above stay the
    // only visible wall art, exactly as drawn.
    for (const wall of this.plan.mazeCollisionWalls) {
      const collider = this.add
        .rectangle(wall.x, wall.y, wall.width, wall.height, 0x000000, 0)
        .setVisible(false)
        .setData("entityId", wall.id)
        .setData("role", wall.role);
      this.physics.add.existing(collider, true);
      this.platforms.add(collider);
    }

    this.hero = this.rectangle(this.plan.hero, heroColor, ink, 1);
    this.heroArtwork = this.addArtwork(this.plan.hero, 5, 1);
    this.physics.add.existing(this.hero, false);
    const heroBody = this.hero.body as Phaser.Physics.Arcade.Body;
    heroBody.setAllowGravity(!this.usesFreeMovement);
    heroBody.setCollideWorldBounds(true);
    if (this.usesFreeMovement) {
      const width = this.plan.hero.width * PLATFORMER_PHYSICS.freeMovementColliderScale;
      const height = this.plan.hero.height * PLATFORMER_PHYSICS.freeMovementColliderScale;
      heroBody.setSize(width, height);
      heroBody.setOffset(
        (this.plan.hero.width - width) / 2,
        (this.plan.hero.height - height) / 2,
      );
    }
    heroBody.setMaxVelocity(PLATFORMER_PHYSICS.maxVelocityX, PLATFORMER_PHYSICS.maxVelocityY);
    if (this.scale.width < WORLD_WIDTH) {
      this.cameras.main.startFollow(this.hero, true, 0.16, 0.16);
    }
    if (!this.usesFreeMovement || this.plan.contract.id === "maze") {
      this.physics.add.collider(this.hero, this.platforms, (_hero, surface) => {
        if (this.plan.contract.id !== "maze") return;
        const entityId = (surface as Phaser.GameObjects.GameObject).getData("entityId");
        this.emitRuntimeEvent(
          "maze_wall_contact",
          typeof entityId === "string" ? entityId : null,
          false,
        );
      });
    }

    this.doors = this.physics.add.staticGroup();
    for (const door of this.plan.doors) {
      const shape = this.rectangle(door, INKLING_CUE.violetDeep, ink, 0.88);
      this.physics.add.existing(shape, true);
      this.doors.add(shape);
      this.doorObjects.set(door.id, shape);
      this.restoreTemplateVisual(shape, this.addArtwork(door, 6, 1), INKLING_CUE.violetDeep, ink, 0.88);
    }
    // A launched hero is positioned by the shared launch state machine, so a
    // Phaser separation collider cannot block it. Doors therefore never gate a
    // launch flight — the same rule the analytic solver uses — and the play
    // contract honestly does not claim key_door_unlock for slingshot.
    if (!this.usesLaunchMovement) this.physics.add.collider(this.hero, this.doors);
    if (this.usesLaunchMovement) {
      this.launchState = createLaunchState(this.plan.hero.x, this.plan.hero.y);
      this.launchWorld = {
        heroWidth: this.plan.hero.width * PLATFORMER_PHYSICS.freeMovementColliderScale,
        heroHeight: this.plan.hero.height * PLATFORMER_PHYSICS.freeMovementColliderScale,
        platforms: this.plan.platforms,
      };
      this.aimIndicator = this.add
        .graphics()
        .setDepth(7)
        .setData("inklingPresentation", "mechanic-cue");
      this.drawAimIndicator();
    }

    for (const water of this.plan.waterVolumes) {
      // Water strokes render at full opacity over a faint volume tint; only
      // a missing/unusable crop falls back to the deterministic organic band.
      if (this.addArtwork(water, 1, 1)) {
        this.add
          .rectangle(water.x, water.y, water.width, water.height, 0x58bde8, 0.14)
          .setDepth(0.5)
          .setData("entityId", water.id)
          .setData("role", water.role)
          .setData("inklingPresentation", "surface-affordance");
      } else {
        this.addOrganicSurface(water, 0x58bde8, 0.28, 1);
      }
    }

    this.hazards = this.physics.add.staticGroup();
    for (const hazard of this.plan.hazards) {
      const shape = this.rectangle(hazard, dangerColor, ink, 1);
      this.physics.add.existing(shape, true);
      const body = shape.body as Phaser.Physics.Arcade.StaticBody;
      body.setSize(hazard.width * 0.72, hazard.height * 0.72);
      this.hazards.add(shape);
      const artwork = this.addArtwork(hazard, 3, 1);
      let placeholder: Phaser.GameObjects.Graphics | undefined;
      if (!artwork) {
        shape.setAlpha(0);
        placeholder = this.addHazardPlaceholder(hazard, dangerColor, ink);
      }
      // Certified track motion moves the collision body, the child's art
      // crop, its legibility halo, and any placeholder in lockstep, one
      // deterministic offset per fixed frame — the same offsets the analytic
      // playtest consumed. Nothing may stay behind at the base position.
      if (hazard.track) {
        const parts: Array<{ object: { setPosition(x: number, y: number): unknown }; baseX: number; baseY: number }> = [
          { object: shape, baseX: shape.x, baseY: shape.y },
        ];
        if (artwork) parts.push({ object: artwork, baseX: artwork.x, baseY: artwork.y });
        const halo = this.artworkHaloByEntity.get(hazard.id);
        if (halo) parts.push({ object: halo, baseX: halo.x, baseY: halo.y });
        if (placeholder) parts.push({ object: placeholder, baseX: placeholder.x, baseY: placeholder.y });
        this.trackedHazards.push({
          track: hazard.track,
          body,
          bodyWidth: hazard.width * 0.72,
          bodyHeight: hazard.height * 0.72,
          parts,
        });
      }
    }
    this.physics.add.overlap(this.hero, this.hazards, () => this.hitHazard());

    this.collectibles = this.physics.add.staticGroup();
    for (const collectible of this.plan.collectibles) {
      const shape = this.rectangle(collectible, collectibleColor, ink, 1);
      this.physics.add.existing(shape, true);
      this.collectibles.add(shape);
      this.restoreTemplateVisual(shape, this.addArtwork(collectible, 4, 1), collectibleColor, ink, 1);
    }
    this.physics.add.overlap(this.hero, this.collectibles, (_hero, collected) => {
      this.collect(collected as Phaser.GameObjects.GameObject);
    });
    // Rescan continuity: bonuses the deterministic carry rule admits start
    // collected, quietly — no pickup feedback, no win evaluation. The rule
    // guarantees none of these ids is required or part of a collect_all
    // objective, so doors, goals, and certification stay untouched.
    for (const entityId of carriedCollectibleIds(this.plan, this.initiallyCollected)) {
      const gameObject = this.collectibles.getChildren().find((candidate) => (
        candidate.getData("entityId") === entityId
      ));
      const body = gameObject?.body as Phaser.Physics.Arcade.StaticBody | null | undefined;
      if (!gameObject || !body?.enable) continue;
      body.enable = false;
      (gameObject as Phaser.GameObjects.Rectangle).setVisible(false);
      this.artworkByEntity.get(entityId)?.setVisible(false);
      this.artworkHaloByEntity.get(entityId)?.setVisible(false);
      this.collected += 1;
      this.collectedIds.add(entityId);
    }

    this.goalTrigger = this.physics.add.staticGroup();
    // Every objective cue comes from the same contract as the win predicate.
    // In particular, collect-all worlds must never display a contradictory
    // FINISH marker when collecting the final required item ends the game.
    const hasVisibleGoal = createObjectiveContract(this.plan).finishRequired;
    if (hasVisibleGoal) {
      const goalShape = this.rectangle(this.plan.goal, INKLING_CUE.violet, ink, 0.72);
      this.restoreTemplateVisual(goalShape, this.addArtwork(this.plan.goal, 4, 1), INKLING_CUE.violet, ink, 0.72);
      const goalCue = this.add
        .ellipse(
          this.plan.goal.x,
          this.plan.goal.y,
          this.plan.goal.width + 22,
          this.plan.goal.height + 22,
          INKLING_CUE.violet,
          0.065,
        )
        .setStrokeStyle(3, INKLING_CUE.violet, 0.52)
        .setDepth(8)
        .setData("inklingPresentation", "mechanic-cue");
      if (!this.reducedMotion) {
        this.tweens.add({ targets: goalCue, alpha: 0.5, duration: 900, yoyo: true, repeat: -1 });
      }
      // A child should never wonder where to go: a small chevron floats above
      // the hero pointing at the goal, and retires once the goal is near.
      this.goalPointer = this.add
        .triangle(this.hero.x, this.hero.y - 40, 0, 0, 0, 14, 18, 7, INKLING_CUE.violet, 0.85)
        .setOrigin(0.5, 0.5)
        .setDepth(30)
        .setData("inklingPresentation", "mechanic-cue");
      const goalLabel = boundedCueAnchor(
        this.plan.goal.x,
        this.plan.goal.y - this.plan.goal.height / 2,
        this.plan.goal.y + this.plan.goal.height / 2,
        WORLD_WIDTH,
        WORLD_HEIGHT,
      );
      this.addCuePill(
        goalLabel.x,
        goalLabel.y + (goalLabel.originY === 1 ? -13 : 13),
        "Goal",
        INKLING_CUE.violetDeep,
        INKLING_CUE.paper,
        9,
      );
      if (this.scale.width < WORLD_WIDTH) {
        this.goalGuide = this.add
          .text(this.scale.width - 24, 66, "Goal  →", {
            color: "#292343",
            fontFamily: INKLING_FONT_FAMILY,
            fontSize: "16px",
            fontStyle: "bold",
            backgroundColor: "rgba(255,251,244,0.92)",
            padding: { x: 8, y: 5 },
          })
          .setOrigin(1, 0)
          .setScrollFactor(0)
          .setDepth(121);
      }
      const trigger = this.add
        .rectangle(
          this.plan.goalTrigger.x,
          this.plan.goalTrigger.y,
          this.plan.goalTrigger.width,
          this.plan.goalTrigger.height,
          0xffffff,
          0,
        )
        .setData("entityId", this.plan.goal.id)
        .setData("style_ref", this.plan.goal.styleRef);
      this.physics.add.existing(trigger, true);
      this.goalTrigger.add(trigger);
      this.physics.add.overlap(this.hero, this.goalTrigger, () => this.touchGoal());
    } else if (
      this.plan.goalKind === "collect_all" &&
      this.plan.goal.id !== "lane_a_goal" &&
      !this.plan.collectibles.some((entity) => entity.id === this.plan.goal.id)
    ) {
      // A collect-all contract ends on the final required item, so this art is
      // not a finish. Keep the child's non-required goal crop in the world as
      // decoration without adding a contradictory label or win trigger.
      this.addArtwork(this.plan.goal, 1, 0.82);
    }

    this.target = this.physics.add.staticGroup();
    this.projectiles = this.physics.add.group({ allowGravity: false });
    if (this.plan.goalKind === "defeat_boss") {
      const target = this.rectangle(this.plan.goal, dangerColor, ink, 0.9);
      this.physics.add.existing(target, true);
      this.target.add(target);
      this.restoreTemplateVisual(target, this.addArtwork(this.plan.goal, 4, 1), dangerColor, ink, 0.9);
      this.physics.add.overlap(this.projectiles, this.target, (projectile, targetObject) => {
        (projectile as Phaser.GameObjects.GameObject).destroy();
        (targetObject as Phaser.GameObjects.GameObject).destroy();
        this.artworkByEntity.get(this.plan.goal.id)?.setVisible(false);
        this.artworkHaloByEntity.get(this.plan.goal.id)?.setVisible(false);
        this.win();
      });
      if (this.plan.contract.action !== "projectile") {
        this.physics.add.overlap(this.hero, this.target, () => this.win());
      }
    }

    this.hud = this.add.text(24, 62, "", {
      color: "#fffbf4",
      fontFamily: INKLING_FONT_FAMILY,
      fontSize: "17px",
      fontStyle: "bold",
      backgroundColor: "rgba(41,35,67,0.82)",
      padding: { x: 10, y: 6 },
    }).setScrollFactor(0).setDepth(120).setVisible(this.presentation === "standalone");
    this.message = this.add
      .text(this.scale.width / 2, this.scale.height / 2, "", {
        align: "center",
        color: "#ffffff",
        fontFamily: INKLING_FONT_FAMILY,
        fontSize: "32px",
        fontStyle: "bold",
        backgroundColor: "rgba(79,63,194,0.92)",
        padding: { x: 22, y: 14 },
      })
      .setOrigin(0.5)
      .setPosition(this.scale.width / 2, 112)
      .setScrollFactor(0)
      .setDepth(200)
      .setVisible(false)
      .setInteractive()
      .on("pointerdown", () => this.scene.restart());

    const keyboard = this.input.keyboard;
    if (keyboard) {
      this.controls = {
        cursors: keyboard.createCursorKeys(),
        left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
        right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
        jump: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
        down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
        space: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      };
    }
    if (this.showTouchControls) this.createTouchControls();
    if (!this.coachingCompleted) this.createCoaching();
    this.input.on(Phaser.Input.Events.GAME_OUT, this.resetTouchControls, this);
    if (this.showTouchControls && typeof ResizeObserver !== "undefined") {
      this.touchResizeObserver?.disconnect();
      this.touchResizeObserver = new ResizeObserver(([entry]) => {
        if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
        // Observations can be delivered after a synchronously destroyed game
        // (e.g. the certification replay); a dead scene must never rebuild
        // controls. Scene destroy nulls the factories this rebuild needs.
        if (!this.add || !this.sys) return;
        this.createTouchControls(entry.contentRect.width, entry.contentRect.height);
      });
      this.touchResizeObserver.observe(this.game.canvas);
    }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.off(Phaser.Input.Events.GAME_OUT, this.resetTouchControls, this);
      this.touchResizeObserver?.disconnect();
      this.touchResizeObserver = undefined;
      this.assistTargetGuide?.destroy();
      this.assistTargetGuide = undefined;
      this.clearCoachingObjects(this.coachingObjects);
      this.clearCoachingObjects(this.controlCoachingObjects);
    });
    // Game.destroy() tears scenes down without SHUTDOWN; the observer must
    // still stop watching the removed canvas or its pending notifications
    // target a dead scene.
    this.events.once(Phaser.Scenes.Events.DESTROY, () => {
      this.touchResizeObserver?.disconnect();
      this.touchResizeObserver = undefined;
    });
    this.publishState();
  }

  /** One fixed physics step happened; scene UPDATE fires it before update(). */
  private countPhysicsStep(): void {
    this.physicsStepsElapsed += 1;
  }

  update(_time: number, delta: number): void {
    if (this.status !== "playing") return;
    // Consume exactly the fixed physics steps that have happened, not one
    // frame per render tick (see the WORLD_STEP subscription in create).
    const stepsElapsed = this.physicsStepsElapsed;
    const framesAdvanced = stepsElapsed - this.frame;
    let replayConsumedThisUpdate = false;
    while (this.frame < stepsElapsed) {
      this.frame += 1;
      for (const tracked of this.trackedHazards) {
        const [offsetX, offsetY] = trackOffsetAt(tracked.track, this.frame);
        for (const part of tracked.parts) {
          part.object.setPosition(part.baseX + offsetX, part.baseY + offsetY);
        }
        tracked.body.updateFromGameObject();
        // updateFromGameObject resets the body to the full shape; restore the
        // reduced collision size so browser contact matches the solver exactly.
        tracked.body.setSize(tracked.bodyWidth, tracked.bodyHeight);
      }
      if (this.replayFrames.size > 0) {
        const replay = this.replayFrames.get(this.frame);
        // When one late tick catches up several steps, press-like inputs
        // survive the whole batch; held directions take the newest frame.
        const batch = replayConsumedThisUpdate ? this.touch : undefined;
        this.touch = {
          left: replay?.left ?? false,
          right: replay?.right ?? false,
          jump: (replay?.jump ?? false) || (batch?.jump ?? false),
          down: replay?.down ?? false,
          action: (replay?.action ?? false) || (batch?.action ?? false),
        };
        if (replay?.assist) this.requestAssist();
        replayConsumedThisUpdate = true;
      }
    }
    this.elapsedMs += delta;
    if (this.goalGuide) {
      const view = this.cameras.main.worldView;
      const visible = this.plan.goal.x >= view.left + 24 && this.plan.goal.x <= view.right - 24;
      this.goalGuide
        .setVisible(!visible)
        .setText(this.plan.goal.x < this.hero.x ? "←  Goal" : "Goal  →");
    }
    if (this.goalPointer) {
      const goalDistance = Phaser.Math.Distance.Between(
        this.hero.x, this.hero.y, this.plan.goal.x, this.plan.goal.y,
      );
      const pointing = this.status === "playing" && goalDistance > 170;
      this.goalPointer.setVisible(pointing);
      if (pointing) {
        this.goalPointer
          .setPosition(this.hero.x, this.hero.y - this.plan.hero.height / 2 - 26)
          .setRotation(Phaser.Math.Angle.Between(
            this.hero.x, this.hero.y, this.plan.goal.x, this.plan.goal.y,
          ));
      }
    }
    if (this.elapsedMs >= this.invulnerableUntil) this.hero.setAlpha(1);

    const body = this.hero.body as Phaser.Physics.Arcade.Body;
    this.animateHeroArtwork(body);
    this.collectAssistedNearbyTarget();
    if (this.status !== "playing") return;
    if (this.usesLaunchMovement) {
      // The launch state machine is frame-indexed like the analytic solver's:
      // advance it once per fixed physics step, never per render tick.
      for (let step = 0; step < framesAdvanced; step += 1) this.updateLaunchMovement(body);
      if (this.plan.goalKind === "survive") {
        this.surviveRemainingMs -= delta;
        if (this.surviveRemainingMs <= 0) this.win();
      }
      this.trackRecovery();
      this.updateHud();
      return;
    }
    if (this.usesFreeMovement) {
      this.updateFreeMovementControls(body);
      this.tryProjectileAction();
      if (this.plan.goalKind === "survive") {
        this.surviveRemainingMs -= delta;
        if (this.surviveRemainingMs <= 0) this.win();
      }
      this.trackRecovery();
      this.updateHud();
      return;
    }
    if (body.blocked.down || body.touching.down) {
      this.lastGroundedAt = this.elapsedMs;
      this.jumpsRemaining = PLATFORMER_PHYSICS.maxJumps;
    }
    const movingLeft = Boolean(this.controls.cursors?.left.isDown || this.controls.left?.isDown || this.touch.left);
    const movingRight = Boolean(this.controls.cursors?.right.isDown || this.controls.right?.isDown || this.touch.right);
    if (movingLeft) this.acceptCoachedControl("left");
    if (movingRight) this.acceptCoachedControl("right");
    const surface = this.surfaceUnderHero();
    const surfaceRole = surface?.role;
    const inWater = this.isInsideWater();
    if (inWater && !this.wasInsideWater) this.emitRuntimeEvent("water_entered", null, false);
    this.wasInsideWater = inWater;
    if ((body.blocked.down || body.touching.down) && surface) {
      if (surface.id !== this.lastSurfaceId) {
        this.emitRuntimeEvent("surface_landed", surface.id, surface.id !== "lane_a_safety_floor");
        if (surface.role === "ice" || surface.role === "cloud" || surface.role === "launchpad") {
          this.emitRuntimeEvent("material_effect", surface.id, false);
        }
      }
      this.lastSurfaceId = surface.id;
    } else if (!inWater) {
      this.lastSurfaceId = undefined;
    }
    body.setGravityY(inWater ? PLATFORMER_PHYSICS.waterGravityY - PLATFORMER_PHYSICS.gravityY : 0);
    const direction: -1 | 0 | 1 = movingLeft === movingRight ? 0 : movingLeft ? -1 : 1;
    const assistActive = this.elapsedMs < this.assistActiveUntil;
    if (inWater) {
      body.setVelocityX(direction * PLATFORMER_PHYSICS.waterMoveVelocityX * (assistActive ? 1.16 : 1));
    } else if (this.plan.contract.movement === "auto_ground") {
      // A runner begins only after a real child input, so doing nothing can
      // never finish the game. Once begun, deterministic forward motion is the
      // genre contract; steering left still permits recovery for required art.
      const jumpRequested = Boolean(
        this.controls.cursors?.up.isDown || this.controls.jump?.isDown ||
        this.controls.space?.isDown || this.touch.jump
      );
      if (movingLeft || movingRight || jumpRequested) this.runnerStarted = true;
      body.setVelocityX(this.runnerStarted
        ? (movingLeft ? -PLATFORMER_PHYSICS.moveVelocityX : PLATFORMER_PHYSICS.moveVelocityX) * this.plan.heroSpeedFactor
        : 0);
    } else {
      body.setVelocityX(surfaceVelocityX(body.velocity.x, direction, surfaceRole, assistActive));
    }

    const jumpDown = Boolean(
      this.controls.cursors?.up.isDown ||
        this.controls.jump?.isDown ||
        this.controls.space?.isDown ||
        this.touch.jump,
    );
    if (inWater && !jumpDown) this.jumpsRemaining = PLATFORMER_PHYSICS.maxJumps;
    if (jumpDown) this.acceptCoachedControl("jump");
    if (jumpDown && !this.jumpWasDown) this.lastJumpPressedAt = this.elapsedMs;
    if (
      this.elapsedMs - this.lastJumpPressedAt <= PLATFORMER_PHYSICS.jumpBufferMs &&
      (
        this.elapsedMs - this.lastGroundedAt <= PLATFORMER_PHYSICS.coyoteTimeMs ||
        this.jumpsRemaining > 0
      )
    ) {
      body.setVelocityY(inWater
        ? PLATFORMER_PHYSICS.waterJumpVelocityY * (assistActive ? 1.12 : 1)
        : surfaceJumpVelocity(surfaceRole, assistActive));
      this.jumpsRemaining = Math.max(0, this.jumpsRemaining - 1);
      this.lastJumpPressedAt = -Infinity;
      this.lastGroundedAt = -Infinity;
    }
    this.jumpWasDown = jumpDown;
    this.tryProjectileAction();

    if (this.plan.goalKind === "survive") {
      this.surviveRemainingMs -= delta;
      if (this.surviveRemainingMs <= 0) this.win();
    }
    this.trackRecovery();
    this.updateHud();
  }

  private recoveryTarget(): PlannedEntity | undefined {
    const required = this.plan.collectibles.filter((entity) => (
      this.plan.requiredCollectibleIds.includes(entity.id) && !this.collectedIds.has(entity.id)
    ));
    const outstanding = this.plan.goalKind === "collect_all"
      ? this.plan.collectibles.filter((entity) => !this.collectedIds.has(entity.id))
      : required;
    return outstanding
      .sort((left, right) => (
        Math.hypot(left.x - this.hero.x, left.y - this.hero.y) -
          Math.hypot(right.x - this.hero.x, right.y - this.hero.y) ||
        left.id.localeCompare(right.id)
      ))[0] ?? this.plan.goal;
  }

  private mazeRecoveryRoute(target: PlannedEntity): MazePoint[] | undefined {
    if (this.plan.contract.id !== "maze" || this.plan.mazeTopologyFallback) return undefined;
    const unlockedDoorIds = new Set(this.plan.relationships
      .filter((relationship) => this.collectedIds.has(relationship.keyId))
      .map((relationship) => relationship.doorId));
    return findMazeRoute(
      { x: this.hero.x, y: this.hero.y },
      target,
      this.plan.hero.width * this.plan.contract.colliderScale,
      this.plan.hero.height * this.plan.contract.colliderScale,
      [
        ...this.plan.mazeCollisionWalls,
        ...this.plan.doors.filter((door) => !unlockedDoorIds.has(door.id)),
        ...this.plan.hazards,
      ],
    );
  }

  private trackRecovery(): void {
    if (this.status !== "playing" || this.plan.goalKind === "survive") return;
    const attempted = this.touch.left || this.touch.right || this.touch.jump || this.touch.down || this.touch.action ||
      Boolean(this.controls.cursors?.left.isDown || this.controls.cursors?.right.isDown || this.controls.cursors?.up.isDown ||
        this.controls.cursors?.down.isDown || this.controls.left?.isDown || this.controls.right?.isDown ||
        this.controls.jump?.isDown || this.controls.down?.isDown || this.controls.space?.isDown);
    if (attempted && !this.meaningfulInputSeen) {
      this.meaningfulInputSeen = true;
      this.lastProgressAt = this.elapsedMs;
    }
    const target = this.recoveryTarget();
    if (!target) return;
    const mazeRoute = this.mazeRecoveryRoute(target);
    const distance = mazeRoute
      ? mazeRoute.reduce((total, point, index) => {
        const previous = index === 0 ? this.hero : mazeRoute[index - 1]!;
        return total + Math.hypot(point.x - previous.x, point.y - previous.y);
      }, 0)
      : Math.hypot(target.x - this.hero.x, target.y - this.hero.y);
    if (distance <= this.bestObjectiveDistance - PLATFORMER_PHYSICS.progressDistance) {
      this.bestObjectiveDistance = distance;
      this.lastProgressAt = this.elapsedMs;
      this.stuckCueShown = false;
      if (this.assistAvailable) {
        this.assistAvailable = false;
        this.publishState();
      }
      this.recoveryGuide?.destroy();
      this.recoveryGuide = undefined;
      return;
    }
    if (!this.meaningfulInputSeen) return;
    const stuckFor = this.elapsedMs - this.lastProgressAt;
    if (!this.stuckCueShown && stuckFor >= PLATFORMER_PHYSICS.stuckCueAfterMs) {
      this.stuckCueShown = true;
      const cueTarget = mazeRoute?.find((point) => Math.hypot(point.x - this.hero.x, point.y - this.hero.y) > 12) ?? target;
      this.showAssistTarget(target);
      const deltaX = cueTarget.x - this.hero.x;
      const deltaY = cueTarget.y - this.hero.y;
      this.recoveryGuide = this.add
        .text(this.scale.width / 2, 112, createRecoveryCue(this.plan.contract.touchControls, deltaX, deltaY), {
          color: "#292343",
          fontFamily: INKLING_FONT_FAMILY,
          fontSize: "17px",
          fontStyle: "bold",
          backgroundColor: "rgba(255,251,244,0.94)",
          padding: { x: 10, y: 6 },
        })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(150);
      this.emitFeedback("stuck_cue", target.id, false);
    }
    if (!this.assistAvailable && stuckFor >= PLATFORMER_PHYSICS.assistOfferAfterMs) {
      this.assistAvailable = true;
      this.emitFeedback("assist_available", target.id, false);
      this.publishState();
    }
  }

  private surfaceUnderHero(): PlannedEntity | undefined {
    const heroBottom = this.hero.y + this.plan.hero.height / 2;
    return this.plan.platforms
      .filter((platform) => (
        this.hero.x + this.plan.hero.width * 0.35 >= platform.x - platform.width / 2 &&
        this.hero.x - this.plan.hero.width * 0.35 <= platform.x + platform.width / 2 &&
        Math.abs(heroBottom - (platform.y - platform.height / 2)) <= 12
      ))
      .sort((left, right) => left.y - right.y)[0];
  }

  private isInsideWater(): boolean {
    return this.plan.waterVolumes.some((water) => (
      Math.abs(this.hero.x - water.x) * 2 < this.plan.hero.width * 0.7 + water.width &&
      Math.abs(this.hero.y - water.y) * 2 < this.plan.hero.height * 0.7 + water.height
    ));
  }

  private updateFreeMovementControls(body: Phaser.Physics.Arcade.Body): void {
    const left = Boolean(this.controls.cursors?.left.isDown || this.controls.left?.isDown || this.touch.left);
    const right = Boolean(this.controls.cursors?.right.isDown || this.controls.right?.isDown || this.touch.right);
    const up = Boolean(this.controls.cursors?.up.isDown || this.controls.jump?.isDown || this.touch.jump);
    const down = Boolean(this.controls.cursors?.down.isDown || this.controls.down?.isDown || this.touch.down);
    if (left) this.acceptCoachedControl("left");
    if (right) this.acceptCoachedControl("right");
    if (up) this.acceptCoachedControl("jump");
    if (down) this.acceptCoachedControl("down");
    const velocity = PLATFORMER_PHYSICS.moveVelocityX * this.plan.heroSpeedFactor;
    body.setVelocityX(left === right ? 0 : left ? -velocity : velocity);
    body.setVelocityY(up === down ? 0 : up ? -velocity : velocity);
  }

  /**
   * Slingshot control: the hero stays anchored while left/right taps step the
   * shared quantized aim and jump (or action) fires a fixed-power ballistic
   * shot. Every frame advances the exact state machine the analytic solver
   * simulates, so the certified route and the played game cannot diverge.
   */
  private updateLaunchMovement(body: Phaser.Physics.Arcade.Body): void {
    const state = this.launchState;
    const world = this.launchWorld;
    if (!state || !world) return;
    const left = Boolean(this.controls.cursors?.left.isDown || this.controls.left?.isDown || this.touch.left);
    const right = Boolean(this.controls.cursors?.right.isDown || this.controls.right?.isDown || this.touch.right);
    const fire = Boolean(
      this.controls.cursors?.up.isDown ||
        this.controls.jump?.isDown ||
        this.controls.space?.isDown ||
        this.touch.jump ||
        this.touch.action,
    );
    if (left) this.acceptCoachedControl("left");
    if (right) this.acceptCoachedControl("right");
    if (fire) this.acceptCoachedControl("jump");
    const result = stepLaunchFrame(state, { left, right, jump: fire, action: false }, world);
    if (result.fired) this.emitRuntimeEvent("launch_fired", null, false);
    body.reset(state.x, state.y);
    this.drawAimIndicator();
  }

  /**
   * A small dotted aim ray in the product cue palette. It labels the launch
   * mechanic near the hero and never covers or recolors the child's art.
   */
  private drawAimIndicator(): void {
    const state = this.launchState;
    const indicator = this.aimIndicator;
    if (!state || !indicator) return;
    const key = `${state.phase}:${state.aimDeg}:${Math.round(state.x)}:${Math.round(state.y)}`;
    if (key === this.lastAimIndicatorKey) return;
    this.lastAimIndicatorKey = key;
    indicator.clear();
    if (state.phase !== "aiming") return;
    const radians = (state.aimDeg * Math.PI) / 180;
    const directionX = Math.cos(radians);
    const directionY = -Math.sin(radians);
    const start = Math.max(this.plan.hero.width, this.plan.hero.height) * 0.62;
    for (let dot = 0; dot < 3; dot += 1) {
      const reach = start + dot * 16;
      indicator.fillStyle(INKLING_CUE.violetDeep, 0.78);
      indicator.fillCircle(state.x + directionX * reach, state.y + directionY * reach, 4 - dot * 0.5);
    }
    const tipReach = start + 52;
    indicator.fillStyle(INKLING_CUE.sun, 0.95);
    indicator.fillCircle(state.x + directionX * tipReach, state.y + directionY * tipReach, 6);
    indicator.lineStyle(2, INKLING_CUE.ink, 0.85);
    indicator.strokeCircle(state.x + directionX * tipReach, state.y + directionY * tipReach, 6);
  }

  private showAssistTarget(target: PlannedEntity): void {
    this.assistTargetGuide?.destroy();
    this.assistTargetGuide = this.add
      .ellipse(
        target.x,
        target.y,
        target.width + PLATFORMER_PHYSICS.assistPickupReach,
        target.height + PLATFORMER_PHYSICS.assistPickupReach,
        INKLING_CUE.sky,
        0.1,
      )
      .setStrokeStyle(4, INKLING_CUE.violet, 0.78)
      .setData("inklingPresentation", "mechanic-cue")
      .setDepth(148);
  }

  /**
   * Help mode forgives near misses around the next required pickup. The
   * target still comes entirely from the current GameSpec and the child must
   * steer close to it; this never recognizes or branches on drawing nouns.
   */
  private collectAssistedNearbyTarget(): void {
    if (this.elapsedMs >= this.assistActiveUntil) return;
    const target = this.recoveryTarget();
    if (!target || !this.plan.collectibles.some((candidate) => candidate.id === target.id)) return;
    const colliderScale = this.usesFreeMovement ? PLATFORMER_PHYSICS.freeMovementColliderScale : 1;
    const colliderWidth = this.plan.hero.width * colliderScale;
    const colliderHeight = this.plan.hero.height * colliderScale;
    const gapX = Math.max(
      0,
      Math.abs(target.x - this.hero.x) - (colliderWidth + target.width) / 2,
    );
    const gapY = Math.max(
      0,
      Math.abs(target.y - this.hero.y) - (colliderHeight + target.height) / 2,
    );
    if (Math.hypot(gapX, gapY) > PLATFORMER_PHYSICS.assistPickupReach) return;
    if (this.plan.contract.id === "maze" && !this.plan.mazeTopologyFallback) {
      const route = this.mazeRecoveryRoute(target);
      if (!route) return;
      const routeDistance = route.reduce((total, point, index) => {
        const previous = index === 0 ? this.hero : route[index - 1]!;
        return total + Math.hypot(point.x - previous.x, point.y - previous.y);
      }, 0);
      const contactDistance = Math.hypot(
        (colliderWidth + target.width) / 2,
        (colliderHeight + target.height) / 2,
      );
      if (routeDistance > contactDistance + PLATFORMER_PHYSICS.assistPickupReach) return;
    }
    const gameObject = this.collectibles.getChildren().find((candidate) => (
      candidate.getData("entityId") === target.id
    ));
    if (gameObject) this.collect(gameObject);
  }

  /**
   * Shooter worlds use this deterministic, local projectile contract; the
   * slingshot template launches the hero itself instead. It is selected by
   * GameSpec genre/goal, never by a drawing name or model-written code. The
   * target direction is intentional: it keeps the touch control usable for
   * young players while P8 can simulate the same rule.
   */
  private tryProjectileAction(): void {
    if (this.plan.contract.action !== "projectile" || this.plan.goalKind !== "defeat_boss") return;
    const actionDown = Boolean(this.controls.space?.isDown || this.touch.action);
    if (!actionDown || this.elapsedMs - this.lastProjectileAt < PLATFORMER_PHYSICS.projectileCooldownMs) return;
    this.lastProjectileAt = this.elapsedMs;
    const deltaX = this.plan.goal.x - this.hero.x;
    const deltaY = this.plan.goal.y - this.hero.y;
    const magnitude = Math.max(1, Math.hypot(deltaX, deltaY));
    const projectile = this.add.circle(this.hero.x, this.hero.y, 7, 0xffffff, 0.96);
    this.physics.add.existing(projectile, false);
    // Adding an existing body to an Arcade group applies the group's defaults.
    // Add first, then set the shot's final physics so velocity and gravity
    // cannot be overwritten by group membership.
    this.projectiles.add(projectile);
    const body = projectile.body as Phaser.Physics.Arcade.Body;
    body.setAllowGravity(false);
    body.setVelocity(
      (deltaX / magnitude) * PLATFORMER_PHYSICS.projectileVelocity,
      (deltaY / magnitude) * PLATFORMER_PHYSICS.projectileVelocity,
    );
    body.setCollideWorldBounds(true);
    body.onWorldBounds = true;
    this.acceptCoachedControl("action");
    if (!this.projectileFeedbackShown) {
      this.projectileFeedbackShown = true;
      this.emitFeedback("projectile", null, false, this.hero.x, this.hero.y - this.plan.hero.height / 2);
    }
    this.time.delayedCall(PLATFORMER_PHYSICS.projectileLifetimeMs, () => projectile.destroy());
  }

  private emitFeedback(
    kind: GameplayFeedbackKind,
    entityId: string | null,
    required: boolean,
    x = this.hero.x,
    y = this.hero.y,
  ): void {
    const event: GameplayFeedbackEvent = { kind, elapsedMs: this.elapsedMs, entityId, required };
    this.onFeedback?.(event);
    this.emitRuntimeEvent(kind, entityId, required);
    const cue = feedbackCueFor(event, this.reducedMotion);
    if (kind === "win") {
      this.createCelebration(cue.color, cue.durationMs);
      return;
    }
    if (!cue.label || kind === "lose") return;
    const cueAnchor = boundedCueAnchor(x, y - 36, y + 36, WORLD_WIDTH, WORLD_HEIGHT, 58);
    const label = this.add
      .text(cueAnchor.x, cueAnchor.y + (cueAnchor.originY === 1 ? -8 : 8), cue.label, {
        color: `#${cue.color.toString(16).padStart(6, "0")}`,
        fontFamily: INKLING_FONT_FAMILY,
        fontSize: "19px",
        fontStyle: "bold",
        backgroundColor: "rgba(41,35,67,0.9)",
        padding: { x: 9, y: 5 },
      })
      .setOrigin(0.5)
      .setDepth(180);
    const ring = this.add
      .circle(x, y, Math.max(24, this.plan.hero.width * 0.42), cue.color, 0.08)
      .setStrokeStyle(4, cue.color, 0.9)
      .setDepth(179);
    if (cue.motion === "none") {
      this.time.delayedCall(cue.durationMs, () => {
        label.destroy();
        ring.destroy();
      });
      return;
    }
    this.tweens.add({
      targets: label,
      y: label.y - 34,
      alpha: 0,
      duration: cue.durationMs,
      ease: "Cubic.easeOut",
      onComplete: () => label.destroy(),
    });
    this.tweens.add({
      targets: ring,
      scale: 1.55,
      alpha: 0,
      duration: cue.durationMs,
      ease: "Cubic.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  private createCelebration(colorValue: number, durationMs: number): void {
    const centerX = this.scale.width / 2;
    const centerY = this.scale.height / 2;
    const colors = [colorValue, 0x8fe8ff, 0xff7bbd, 0x8fe388];
    CELEBRATION_POINTS.forEach(([x, y], index) => {
      const sparkle = this.add
        .circle(centerX, centerY, index % 3 === 0 ? 8 : 6, colors[index % colors.length], 0.96)
        .setScrollFactor(0)
        .setDepth(199);
      const destinationX = centerX + x * this.scale.width;
      const destinationY = centerY + y * this.scale.height;
      if (this.reducedMotion) {
        sparkle.setPosition(destinationX, destinationY);
        this.time.delayedCall(durationMs, () => sparkle.destroy());
        return;
      }
      this.tweens.add({
        targets: sparkle,
        x: destinationX,
        y: destinationY,
        scale: 0.55,
        alpha: 0,
        delay: index * 25,
        duration: durationMs,
        ease: "Cubic.easeOut",
        onComplete: () => sparkle.destroy(),
      });
    });
  }

  private createCoaching(): void {
    this.clearCoachingObjects(this.coachingObjects);
    const heroRing = this.add
      .ellipse(
        this.plan.hero.x,
        this.plan.hero.y,
        this.plan.hero.width + 22,
        this.plan.hero.height + 22,
        INKLING_CUE.violet,
        0.045,
      )
      .setStrokeStyle(3, INKLING_CUE.violet, 0.62)
      .setData("inklingPresentation", "mechanic-cue")
      .setDepth(132);
    this.coachingObjects.push(heroRing);
    const target = this.coaching.objectiveTarget;
    // Reach-goal scenes already draw a permanent FINISH marker. Onboarding
    // should not stack a second ring and label over it; collect/boss targets
    // do not have that marker and still benefit from a brief highlight.
    if (
      target &&
      target.id !== this.plan.hero.id &&
      this.plan.goalKind !== "reach_goal"
    ) {
      const targetRing = this.add
        .ellipse(target.x, target.y, target.width + 24, target.height + 24, 0xffffff, 0)
        .setStrokeStyle(3, INKLING_CUE.sky, 0.7)
        .setData("inklingPresentation", "mechanic-cue")
        .setDepth(131);
      const targetAnchor = boundedCueAnchor(
        target.x,
        target.y - target.height / 2,
        target.y + target.height / 2,
        WORLD_WIDTH,
        WORLD_HEIGHT,
      );
      const targetLabel = this.addCuePill(
        targetAnchor.x,
        targetAnchor.y + (targetAnchor.originY === 1 ? -13 : 13),
        friendlyObjectiveLabel(this.coaching.objectiveLabel),
        INKLING_CUE.paper,
        INKLING_CUE.ink,
        133,
      );
      this.coachingObjects.push(targetRing, targetLabel);
    }
    if (!this.reducedMotion) {
      this.tweens.add({ targets: heroRing, alpha: 0.48, duration: 620, yoyo: true, repeat: -1 });
    }
  }

  private acceptCoachedControl(control: PlatformerControl): void {
    if (this.coachingCompleted || control !== this.coaching.firstControl) return;
    this.coachingCompleted = true;
    this.emitFeedback("input_accepted", null, false);
    this.clearCoachingObjects(this.coachingObjects);
    this.clearCoachingObjects(this.controlCoachingObjects);
  }

  private clearCoachingObjects(objects: Phaser.GameObjects.GameObject[]): void {
    for (const object of objects) object.destroy();
    objects.length = 0;
  }

  /** Rounded, product-owned mechanic chrome; never presented as source art. */
  private addCuePill(
    x: number,
    y: number,
    label: string,
    fill: number,
    textColor: number,
    depth: number,
  ): Phaser.GameObjects.Container {
    const text = this.add.text(0, 0, label, {
      color: `#${textColor.toString(16).padStart(6, "0")}`,
      fontFamily: INKLING_FONT_FAMILY,
      fontSize: "14px",
      fontStyle: "bold",
    }).setOrigin(0.5);
    const width = Math.max(52, text.width + 22);
    const height = 30;
    const chrome = this.add.graphics();
    chrome.fillStyle(INKLING_CUE.ink, 0.12).fillRoundedRect(-width / 2 + 1, -height / 2 + 2, width, height, 15);
    chrome.fillStyle(fill, 0.94).fillRoundedRect(-width / 2, -height / 2, width, height, 15);
    chrome.lineStyle(2, INKLING_CUE.paper, 0.6).strokeRoundedRect(-width / 2, -height / 2, width, height, 15);
    return this.add.container(x, y, [chrome, text])
      .setDepth(depth)
      .setData("inklingPresentation", "mechanic-cue");
  }

  private rectangle(
    entity: PlannedEntity,
    fill: number,
    stroke: number,
    alpha: number,
  ): Phaser.GameObjects.Rectangle {
    const usesOriginalArtwork = this.canRenderEntityArtwork(entity);
    return this.add
      .rectangle(entity.x, entity.y, entity.width, entity.height, fill, usesOriginalArtwork ? 0 : alpha)
      .setStrokeStyle(usesOriginalArtwork ? 0 : 4, stroke, usesOriginalArtwork ? 0 : Math.min(1, alpha + 0.25))
      .setData("entityId", entity.id)
      .setData("role", entity.role)
      .setData("style_ref", entity.styleRef);
  }

  /**
   * Renders the child's own strokes over the deterministic collision
   * primitive. Foreground sprites contain-fit their isolated crop at the
   * entity's play position; environmental surfaces render exactly the page
   * region their play rectangle occupies, so what you stand on IS what was
   * drawn there. The primitive remains the physics contract; a
   * malformed/missing artwork document simply leaves it visible.
   */
  private addArtwork(
    entity: PlannedEntity,
    depth: number,
    alpha: number,
  ): Phaser.GameObjects.Image | undefined {
    if (!this.canRenderEntityArtwork(entity)) return undefined;
    const crop = this.artwork?.entityCrops[entity.id];
    if (!crop || !this.textures.exists(this.artworkTextureKey)) return undefined;
    const texture = this.textures.get(this.artworkTextureKey);
    const source = texture.source[0];
    if (!source?.width || !source.height) return undefined;
    const [left, top, right, bottom] = crop;
    if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
      return undefined;
    }
    const isSurface = ENVIRONMENTAL_SURFACE_ROLES.has(entity.role);
    // A surface's play rectangle maps straight back onto the page (the plan
    // only clamps its drawn box, never relocates it), so sampling exactly
    // that region shows the true strokes at the collision strip — a winding
    // page-sized road keeps its real marks under the hero's wheels instead
    // of a squashed photograph or strokes at stale positions.
    let sampleLeft = left;
    let sampleTop = top;
    let sampleRight = right;
    let sampleBottom = bottom;
    if (isSurface) {
      const worldLeft = Math.max(0, Math.min(1, (entity.x - entity.width / 2) / WORLD_WIDTH));
      const worldRight = Math.max(0, Math.min(1, (entity.x + entity.width / 2) / WORLD_WIDTH));
      const worldTop = Math.max(0, Math.min(1, (entity.y - entity.height / 2) / WORLD_HEIGHT));
      const worldBottom = Math.max(0, Math.min(1, (entity.y + entity.height / 2) / WORLD_HEIGHT));
      const clippedLeft = Math.max(left, worldLeft);
      const clippedRight = Math.min(right, worldRight);
      const clippedTop = Math.max(top, worldTop);
      const clippedBottom = Math.min(bottom, worldBottom);
      if (clippedRight - clippedLeft >= 0.01 && clippedBottom - clippedTop >= 0.01) {
        sampleLeft = clippedLeft;
        sampleRight = clippedRight;
        sampleTop = clippedTop;
        sampleBottom = clippedBottom;
      }
    }
    const cropX = Math.floor(sampleLeft * source.width);
    const cropY = Math.floor(sampleTop * source.height);
    const cropWidth = Math.max(1, Math.ceil((sampleRight - sampleLeft) * source.width));
    const cropHeight = Math.max(1, Math.ceil((sampleBottom - sampleTop) * source.height));
    const cropTextureKey = `inkling-art-crop-${entity.id}`;
    let isolatedArtwork = false;
    if (!this.textures.exists(cropTextureKey) && source.image) {
      // A tight crop can be bordered almost entirely by the drawn marks
      // themselves, which starves border-connected isolation of paper samples
      // and leaves a visible paper box behind the art. Sampling a surrounding
      // context margin exposes the real paper; the texture is cropped back to
      // the exact entity rectangle afterwards, so neighbouring strokes never
      // join this entity's art. Purely geometric — no drawing specifics.
      const contextPad = Math.round(Math.min(cropWidth, cropHeight) * 0.2) + 4;
      const paddedX = Math.max(0, cropX - contextPad);
      const paddedY = Math.max(0, cropY - contextPad);
      const paddedWidth = Math.min(source.width, cropX + cropWidth + contextPad) - paddedX;
      const paddedHeight = Math.min(source.height, cropY + cropHeight + contextPad) - paddedY;
      const innerX = cropX - paddedX;
      const innerY = cropY - paddedY;
      const cropTexture = this.textures.createCanvas(cropTextureKey, paddedWidth, paddedHeight);
      if (cropTexture) {
        cropTexture.context.drawImage(
          source.image as CanvasImageSource,
          paddedX,
          paddedY,
          paddedWidth,
          paddedHeight,
          0,
          0,
          paddedWidth,
          paddedHeight,
        );
        // A surface band can contain other entities drawn on it (the truck on
        // its road, gems on a ledge). Those strokes render at their own play
        // positions, so the copy inside the surface is erased — alpha only —
        // or the world would show the same drawing twice at disagreeing spots.
        if (isSurface) {
          this.eraseForeignSpriteRegions(
            cropTexture,
            entity.id,
            paddedX,
            paddedY,
            paddedWidth,
            paddedHeight,
            source.width,
            source.height,
          );
        }
        const isolation = this.removePaperBackground(cropTexture.context, paddedWidth, paddedHeight);
        isolatedArtwork = isolation.isolated;
        if (isolatedArtwork) {
          if (isolation.backdropColor !== undefined) {
            const pixels = cropTexture.context.getImageData(0, 0, paddedWidth, paddedHeight);
            if (softlyRemoveKnownBackdrop(
              { data: pixels.data, width: paddedWidth, height: paddedHeight },
              isolation.backdropColor,
            )) {
              cropTexture.context.putImageData(pixels, 0, 0);
            }
          }
          this.cropTextureToRect(cropTexture, innerX, innerY, cropWidth, cropHeight);
          // A surface texture must keep its exact sampled rectangle: it is
          // stretched onto the play rectangle, so trimming would shift the
          // strokes off the geometry they belong to.
          if (!isSurface) this.trimTransparentBounds(cropTexture, cropWidth, cropHeight);
        } else {
          const padded = cropTexture.context.getImageData(0, 0, paddedWidth, paddedHeight);
          isolatedArtwork = softlyIsolateLocalBackdrop({
            data: padded.data,
            width: paddedWidth,
            height: paddedHeight,
          });
          cropTexture.context.putImageData(padded, 0, 0);
          this.cropTextureToRect(cropTexture, innerX, innerY, cropWidth, cropHeight);
          if (isolatedArtwork) {
            if (!isSurface) this.trimTransparentBounds(cropTexture, cropWidth, cropHeight);
          } else {
            const pixels = cropTexture.context.getImageData(0, 0, cropWidth, cropHeight);
            featherSurfaceEdges({ data: pixels.data, width: cropWidth, height: cropHeight });
            cropTexture.context.putImageData(pixels, 0, 0);
          }
        }
        this.artworkIsolationByEntity.set(entity.id, isolatedArtwork);
        cropTexture.refresh();
      }
    } else if (this.textures.exists(cropTextureKey)) {
      isolatedArtwork = this.artworkIsolationByEntity.get(entity.id) ?? false;
    }

    const hasCropTexture = this.textures.exists(cropTextureKey);
    // Without a local canvas texture the only remaining fallback repaints the
    // full source photograph; a surface must fall back to its deterministic
    // template affordance instead of lying about geometry.
    if (!hasCropTexture && isSurface) return undefined;
    const fitted = isSurface
      ? { width: entity.width, height: entity.height }
      : entity.id === this.plan.hero.id
        ? readableHeroArtworkFit(fitArtworkWithin(cropWidth, cropHeight, entity.width, entity.height))
        : fitArtworkWithin(cropWidth, cropHeight, entity.width, entity.height);
    if (!isSurface) {
      // The halo is a legibility backing that hugs the rendered art — never a
      // washed-out disc dominating it. Collectibles instead get a warm ring
      // that reads as an invitation while their strokes stay at full opacity.
      const halo = artworkHaloForWorldColor(this.sceneWorldColor);
      const isCollectible = entity.role === "collectible" || entity.role === "key";
      const haloEllipse = this.add
        .ellipse(
          entity.x,
          entity.y,
          fitted.width + 14,
          fitted.height + 14,
          isCollectible ? INKLING_CUE.sun : halo.color,
          isCollectible ? 0.05 : halo.alpha * 0.7,
        )
        .setStrokeStyle(
          isCollectible ? 2.5 : 2,
          isCollectible ? INKLING_CUE.sun : halo.color,
          isCollectible ? 0.62 : halo.alpha * 1.35,
        )
        .setDepth(depth - 0.1)
        .setData("entityId", entity.id)
        .setData("inklingPresentation", "artwork-legibility-halo");
      this.artworkHaloByEntity.set(entity.id, haloEllipse);
    }
    let image: Phaser.GameObjects.Image;
    if (hasCropTexture) {
      image = this.add.image(entity.x, entity.y, cropTextureKey).setDisplaySize(fitted.width, fitted.height);
    } else {
      // The full-photo fallback texture keeps the crop at its source offset;
      // re-anchor the image so the visible strokes sit at the play position
      // rather than wherever they happened to be on the page.
      const scale = fitted.width / cropWidth;
      const offsetX = (cropX + cropWidth / 2 - source.width / 2) * scale;
      const offsetY = (cropY + cropHeight / 2 - source.height / 2) * scale;
      image = this.add
        .image(entity.x - offsetX, entity.y - offsetY, this.artworkTextureKey)
        .setCrop(cropX, cropY, cropWidth, cropHeight)
        .setScale(scale);
    }
    const baseScaleX = image.scaleX;
    const baseScaleY = image.scaleY;
    image
      .setAlpha(isolatedArtwork ? alpha : alpha * 0.96)
      .setBlendMode(Phaser.BlendModes.NORMAL)
      .setDepth(depth)
      .setData("entityId", entity.id)
      .setData("style_ref", entity.styleRef)
      .setData("inklingBaseScaleX", baseScaleX)
      .setData("inklingBaseScaleY", baseScaleY);
    this.artworkByEntity.set(entity.id, image);
    return image;
  }

  private canRenderEntityArtwork(entity: PlannedEntity): boolean {
    if (entity.artworkSource === "synthetic") return false;
    const crop = this.artwork?.entityCrops[entity.id];
    if (!crop || !this.textures.exists(this.artworkTextureKey)) return false;
    const [left, top, right, bottom] = crop;
    const area = (right - left) * (bottom - top);
    const difficultDarkSurface = colorLuminance(this.sceneWorldColor) < 150 && this.sceneSurfaceShare < 0.24;
    if (ENVIRONMENTAL_SURFACE_ROLES.has(entity.role)) {
      // Surfaces render only the page band their play rectangle occupies and
      // erase foreign sprites from it (see addArtwork), so even a page-wide
      // drawn road shows its own strokes without reconstructing the photo.
      // Only a dark, highly textured photographed substrate lacks the local
      // separation for that band to stop reading as a photo tile.
      return !difficultDarkSurface;
    }
    // A non-hero crop spanning a large fraction of the page is scene context,
    // not a usable sprite. Treating it as an entity reconstructs the source
    // photograph as a conspicuous nested rectangle.
    if (entity.id !== this.plan.hero.id && area >= 0.16) return false;
    if (difficultDarkSurface && (entity.role === "decoration" || entity.role === "hazard")) return false;
    return true;
  }

  /**
   * A crop-bearing entity whose artwork could not actually be built (missing
   * canvas support, malformed texture) must not end up invisible: restore the
   * deterministic template visual its rectangle suppressed.
   */
  private restoreTemplateVisual(
    shape: Phaser.GameObjects.Rectangle,
    artwork: Phaser.GameObjects.Image | undefined,
    fill: number,
    stroke: number,
    alpha: number,
  ): void {
    if (artwork || shape.fillAlpha > 0) return;
    shape.setFillStyle(fill, alpha);
    shape.setStrokeStyle(4, stroke, Math.min(1, alpha + 0.25));
  }

  /**
   * A subtle standable-surface cue beneath a drawn surface's own strokes:
   * a faint fill plus a thin top edge along the landing contract. The child's
   * marks stay the primary visual above it.
   */
  private addSurfaceAffordance(entity: PlannedEntity, fill: number): void {
    const leftEdge = entity.x - entity.width / 2;
    const topEdge = entity.y - entity.height / 2;
    const graphics = this.add.graphics().setDepth(1.5);
    graphics.fillStyle(fill, 0.1);
    graphics.fillRect(leftEdge, topEdge, entity.width, entity.height);
    if (this.plan.contract.id !== "maze") {
      graphics.lineStyle(2, fill, 0.3);
      graphics.lineBetween(leftEdge + 1, topEdge, leftEdge + entity.width - 1, topEdge);
    }
    graphics
      .setData("entityId", entity.id)
      .setData("role", entity.role)
      .setData("inklingPresentation", "surface-affordance");
  }

  /**
   * Source-page regions of every non-surface entity that renders its own crop
   * at a play position. A surface sample erases these so no stroke exists
   * twice — once moving with its entity and once fossilized in the surface.
   */
  private foreignSpriteSourceRects(excludeId: string): NormalizedBounds[] {
    const sprites = [
      this.plan.hero,
      ...this.plan.hazards,
      ...this.plan.collectibles,
      ...this.plan.doors,
      ...this.plan.decorations,
      this.plan.goal,
    ];
    const rects: NormalizedBounds[] = [];
    const seen = new Set<string>();
    for (const sprite of sprites) {
      if (sprite.id === excludeId || seen.has(sprite.id)) continue;
      seen.add(sprite.id);
      if (!this.canRenderEntityArtwork(sprite)) continue;
      const crop = this.artwork?.entityCrops[sprite.id];
      if (crop) rects.push(crop);
    }
    return rects;
  }

  /**
   * Alpha-only erasure of foreign sprite regions from a surface's sampled
   * strokes, feathered so the cut never reads as a hard box. RGB is never
   * touched (child-art invariant: isolation modifies alpha only).
   */
  private eraseForeignSpriteRegions(
    texture: Phaser.Textures.CanvasTexture,
    entityId: string,
    canvasSourceX: number,
    canvasSourceY: number,
    width: number,
    height: number,
    sourceWidth: number,
    sourceHeight: number,
  ): void {
    const rects = this.foreignSpriteSourceRects(entityId)
      .map(([rectLeft, rectTop, rectRight, rectBottom]) => ({
        left: rectLeft * sourceWidth - canvasSourceX,
        top: rectTop * sourceHeight - canvasSourceY,
        right: rectRight * sourceWidth - canvasSourceX,
        bottom: rectBottom * sourceHeight - canvasSourceY,
      }))
      .filter((rect) => (
        Math.min(rect.right, width) - Math.max(rect.left, 0) >= 2 &&
        Math.min(rect.bottom, height) - Math.max(rect.top, 0) >= 2
      ));
    if (rects.length === 0) return;
    const pixels = texture.context.getImageData(0, 0, width, height);
    const feather = 5;
    for (const rect of rects) {
      const spanLeft = Math.max(0, Math.floor(rect.left));
      const spanTop = Math.max(0, Math.floor(rect.top));
      const spanRight = Math.min(width, Math.ceil(rect.right));
      const spanBottom = Math.min(height, Math.ceil(rect.bottom));
      for (let y = spanTop; y < spanBottom; y += 1) {
        for (let x = spanLeft; x < spanRight; x += 1) {
          const inset = Math.min(x - rect.left, rect.right - 1 - x, y - rect.top, rect.bottom - 1 - y);
          if (inset < 0) continue;
          const eased = Math.min(1, inset / feather);
          const keep = 1 - eased * eased * (3 - 2 * eased);
          const alphaOffset = (y * width + x) * 4 + 3;
          pixels.data[alphaOffset] = Math.round((pixels.data[alphaOffset] ?? 0) * keep);
        }
      }
    }
    texture.context.putImageData(pixels, 0, 0);
  }

  /**
   * The child's page as the world's scenery. Every crop small enough to be a
   * self-rendering entity (below the page-context threshold) is feather-erased
   * so its strokes appear only on the moving entity; what remains — skies,
   * skylines, seas, scenery — is the drawing the child expects to see behind
   * their game. Alignment is exact because the world is the page's coordinate
   * space scaled to 960x540.
   */
  private addPageBackdrop(): void {
    if (!this.artwork || !this.textures.exists(this.artworkTextureKey)) return;
    const source = this.textures.get(this.artworkTextureKey).getSourceImage() as
      | HTMLImageElement
      | HTMLCanvasElement;
    if (!source.width || !source.height) return;
    const key = `${this.artworkTextureKey}--page-backdrop`;
    if (this.textures.exists(key)) this.textures.remove(key);
    const texture = this.textures.createCanvas(key, source.width, source.height);
    if (!texture) return;
    texture.context.drawImage(source, 0, 0);
    // Only pure scenery survives in the backdrop: a page-scale DECORATION
    // (skyline, sea) is context, but the hero and every gameplay entity are
    // erased at ANY size — a drawn rocket the child pilots must never also
    // stand frozen in the background beside its moving self.
    const PAGE_CONTEXT_AREA = 0.16;
    const sceneryIds = new Set(
      this.plan.decorations
        .filter((decoration) => {
          const crop = this.artwork?.entityCrops[decoration.id];
          if (!crop) return false;
          const area = Math.max(0, crop[2] - crop[0]) * Math.max(0, crop[3] - crop[1]);
          return area >= PAGE_CONTEXT_AREA;
        })
        .map((decoration) => decoration.id),
    );
    const entityRects: NormalizedBounds[] = [];
    for (const [entityId, crop] of Object.entries(this.artwork.entityCrops)) {
      if (!sceneryIds.has(entityId)) entityRects.push(crop);
    }
    this.eraseSourceRects(texture, entityRects, source.width, source.height);
    texture.refresh();
    this.add
      .image(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, key)
      .setDisplaySize(WORLD_WIDTH, WORLD_HEIGHT)
      .setDepth(-4)
      .setAlpha(0.88)
      .setData("inklingPresentation", "page-backdrop");
  }

  /** Feathered alpha-only erasure of normalized source rects from a canvas texture. */
  private eraseSourceRects(
    texture: Phaser.Textures.CanvasTexture,
    sourceRects: NormalizedBounds[],
    width: number,
    height: number,
  ): void {
    const rects = sourceRects
      .map(([rectLeft, rectTop, rectRight, rectBottom]) => ({
        left: rectLeft * width,
        top: rectTop * height,
        right: rectRight * width,
        bottom: rectBottom * height,
      }))
      .filter((rect) => rect.right - rect.left >= 2 && rect.bottom - rect.top >= 2);
    if (rects.length === 0) return;
    const pixels = texture.context.getImageData(0, 0, width, height);
    const feather = 5;
    for (const rect of rects) {
      const spanLeft = Math.max(0, Math.floor(rect.left));
      const spanTop = Math.max(0, Math.floor(rect.top));
      const spanRight = Math.min(width, Math.ceil(rect.right));
      const spanBottom = Math.min(height, Math.ceil(rect.bottom));
      for (let y = spanTop; y < spanBottom; y += 1) {
        for (let x = spanLeft; x < spanRight; x += 1) {
          const inset = Math.min(x - rect.left, rect.right - 1 - x, y - rect.top, rect.bottom - 1 - y);
          if (inset < 0) continue;
          const eased = Math.min(1, inset / feather);
          const keep = 1 - eased * eased * (3 - 2 * eased);
          const alphaOffset = (y * width + x) * 4 + 3;
          pixels.data[alphaOffset] = Math.round((pixels.data[alphaOffset] ?? 0) * keep);
        }
      }
    }
    texture.context.putImageData(pixels, 0, 0);
  }

  /** A deterministic scene layer for geometry too broad to be a sprite crop. */
  private addOrganicSurface(
    entity: PlannedEntity,
    fill: number,
    alpha: number,
    depth: number,
  ): void {
    const left = entity.x - entity.width / 2;
    const right = entity.x + entity.width / 2;
    const top = entity.y - entity.height / 2;
    const bottom = entity.y + entity.height / 2;
    const hash = [...entity.id].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 17);
    const segments = Math.max(4, Math.min(12, Math.round(entity.width / 80)));
    const amplitude = Math.min(7, Math.max(2, entity.height * 0.12));
    const graphics = this.add.graphics().setDepth(depth);
    const traceTop = (): void => {
      graphics.beginPath();
      graphics.moveTo(left, top);
      for (let segment = 1; segment <= segments; segment += 1) {
        const x = left + entity.width * segment / segments;
        const direction = ((segment + hash) % 2 === 0 ? 1 : -1);
        const y = segment === segments ? top : top + direction * amplitude;
        graphics.lineTo(x, y);
      }
    };
    if (entity.role === "water") {
      graphics.lineStyle(18, fill, 0.11);
      traceTop();
      graphics.strokePath();
      graphics.lineStyle(5, fill, 0.82);
      traceTop();
      graphics.strokePath();
    } else {
      graphics.fillStyle(fill, alpha);
      graphics.lineStyle(4, fill, Math.min(0.9, alpha + 0.48));
      traceTop();
      graphics.lineTo(right, bottom);
      graphics.lineTo(left, bottom);
      graphics.closePath();
      graphics.fillPath();
      graphics.strokePath();
    }
    graphics.setData("entityId", entity.id).setData("role", entity.role);
  }

  /** A readable deterministic danger silhouette when no clean art crop exists. */
  private addHazardPlaceholder(
    entity: PlannedEntity,
    fill: number,
    stroke: number,
  ): Phaser.GameObjects.Graphics {
    const left = entity.x - entity.width / 2;
    const right = entity.x + entity.width / 2;
    const top = entity.y - entity.height / 2;
    const bottom = entity.y + entity.height / 2;
    const graphics = this.add.graphics().setDepth(3);
    graphics.fillStyle(fill, 0.72).lineStyle(3, stroke, 0.88).beginPath();
    if (entity.width >= entity.height * 1.35) {
      const teeth = Math.max(2, Math.min(8, Math.round(entity.width / Math.max(18, entity.height * 0.65))));
      graphics.moveTo(left, bottom);
      for (let tooth = 0; tooth < teeth; tooth += 1) {
        const toothLeft = left + entity.width * tooth / teeth;
        const toothRight = left + entity.width * (tooth + 1) / teeth;
        graphics.lineTo((toothLeft + toothRight) / 2, top);
        graphics.lineTo(toothRight, bottom);
      }
    } else {
      graphics.moveTo(entity.x, top);
      graphics.lineTo(right, entity.y);
      graphics.lineTo(entity.x, bottom);
      graphics.lineTo(left, entity.y);
    }
    graphics.closePath().fillPath().strokePath();
    graphics.setData("entityId", entity.id).setData("role", entity.role);
    return graphics;
  }

  /**
   * Removes only light, neutral paper from a local crop. Crayon/marker
   * pixels remain byte-for-byte untouched; this is isolation, not a style
   * filter or a redraw. It keeps each original drawing piece readable against
   * the deterministic world and lets collected pieces genuinely disappear.
   */
  private removePaperBackground(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): BackdropIsolationResult {
    const pixels = context.getImageData(0, 0, width, height);
    const result = isolateBorderConnectedBackdrop({ data: pixels.data, width, height });
    if (result.isolated) context.putImageData(pixels, 0, 0);
    return result;
  }

  private artworkWorldColor(): number {
    const fallback = fallbackWorldColor(this.plan.palette);
    if (!this.artwork || !this.textures.exists(this.artworkTextureKey) || typeof document === "undefined") {
      return fallback;
    }
    const source = this.textures.get(this.artworkTextureKey).source[0];
    if (!source?.image || !source.width || !source.height) return fallback;
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return fallback;
    context.drawImage(source.image as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    this.sceneSurfaceShare = dominantSurfaceShare({
      data: pixels.data,
      width: canvas.width,
      height: canvas.height,
    });
    const sampled = dominantSurfaceColor({ data: pixels.data, width: canvas.width, height: canvas.height });
    // Match the real drawing surface instead of lightening it: even a small
    // shift makes any unavoidable anti-aliased edge read as a rectangular tile.
    return sampled === undefined ? fallback : sampled;
  }

  /** Restores a context-padded crop texture to the entity's exact rectangle. */
  private cropTextureToRect(
    texture: Phaser.Textures.CanvasTexture,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    if (x === 0 && y === 0 && texture.width === width && texture.height === height) return;
    const inner = texture.context.getImageData(x, y, width, height);
    texture.setSize(width, height);
    texture.context.putImageData(inner, 0, 0);
  }

  /** Shrinks an already-isolated local texture to its surviving child strokes. */
  private trimTransparentBounds(
    texture: Phaser.Textures.CanvasTexture,
    width: number,
    height: number,
  ): void {
    const pixels = texture.context.getImageData(0, 0, width, height);
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if ((pixels.data[(y * width + x) * 4 + 3] ?? 0) === 0) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    if (right < left || bottom < top) return;
    const padding = 3;
    left = Math.max(0, left - padding);
    top = Math.max(0, top - padding);
    right = Math.min(width - 1, right + padding);
    bottom = Math.min(height - 1, bottom + padding);
    const trimmedWidth = right - left + 1;
    const trimmedHeight = bottom - top + 1;
    if (trimmedWidth === width && trimmedHeight === height) return;
    const trimmed = texture.context.getImageData(left, top, trimmedWidth, trimmedHeight);
    texture.setSize(trimmedWidth, trimmedHeight);
    texture.context.putImageData(trimmed, 0, 0);
  }

  /**
   * A transform-only puppet keeps the original crop intact. It reads P3's
   * declared animations when available and falls back to a gentle deterministic
   * idle/walk/jump motion; no child stroke is regenerated or replaced.
   */
  private animateHeroArtwork(body: Phaser.Physics.Arcade.Body): void {
    const artwork = this.heroArtwork;
    if (!artwork) return;
    const animations = this.artwork?.heroRig?.animations ?? ["idle", "walk", "jump"];
    const phase = this.elapsedMs / 1_000;
    const moving = Math.abs(body.velocity.x) > 1;
    const airborne = !body.blocked.down && !body.touching.down;
    let scaleX = 1;
    let scaleY = 1;
    let angle = 0;
    if (this.usesFreeMovement) {
      // A launched hero is positioned kinematically, so its true velocity
      // lives in the shared launch state rather than the Phaser body.
      const velocityX = this.launchState?.velocityX ?? body.velocity.x;
      const velocityY = this.launchState?.velocityY ?? body.velocity.y;
      scaleX = 1 + Math.sin(phase * 5) * 0.025;
      scaleY = 1 - Math.sin(phase * 5) * 0.025;
      angle = Phaser.Math.Clamp(velocityY / PLATFORMER_PHYSICS.moveVelocityX, -1, 1) * 12;
      if (Math.abs(velocityX) > 1) angle += Math.sign(velocityX) * 4;
    } else if (airborne && animations.includes("jump")) {
      scaleX = 0.9;
      scaleY = 1.1;
      angle = body.velocity.y < 0 ? -5 : 5;
    } else if (moving && animations.includes("walk")) {
      scaleX = 1 + Math.sin(phase * 12) * 0.045;
      scaleY = 1 - Math.sin(phase * 12) * 0.045;
      if (animations.includes("lean")) angle = Math.sign(body.velocity.x) * 3;
    } else if (animations.includes("idle") || animations.includes("bounce")) {
      scaleX = 1 - Math.sin(phase * 3) * 0.018;
      scaleY = 1 + Math.sin(phase * 3) * 0.018;
    }
    const baseScaleX = artwork.getData("inklingBaseScaleX") as number | undefined;
    const baseScaleY = artwork.getData("inklingBaseScaleY") as number | undefined;
    artwork
      .setPosition(this.hero.x, this.hero.y)
      .setScale((baseScaleX ?? 1) * scaleX, (baseScaleY ?? 1) * scaleY)
      .setAngle(angle);
  }

  private resetTouchControls(): void {
    this.touch = { left: false, right: false, jump: false, down: false, action: false };
  }

  private createTouchControls(displayWidth?: number, displayHeight?: number): void {
    const bounds = this.game.canvas.getBoundingClientRect();
    const layout = createTouchControlLayout(
      displayWidth || bounds.width || WORLD_WIDTH,
      displayHeight || bounds.height || WORLD_HEIGHT,
      this.scale.width,
      this.scale.height,
    );
    for (const button of this.touchButtons) button.destroy(true);
    this.touchButtons = [];
    this.resetTouchControls();
    const makeButton = (
      x: number,
      direction: "left" | "right" | "up" | "down" | "action",
      property: keyof typeof this.touch,
    ): void => {
      const size = layout.size;
      const button = this.add.container(x, layout.y).setDepth(100).setScrollFactor(0);
      const chrome = this.add.graphics();
      chrome.fillStyle(INKLING_CUE.ink, 0.18);
      chrome.fillRoundedRect(
        -size / 2 + 2,
        -size / 2 + 3,
        size,
        size,
        layout.cornerRadius,
      );
      chrome.fillStyle(INKLING_CUE.violetDeep, 0.76);
      chrome.fillRoundedRect(
        -size / 2,
        -size / 2,
        size,
        size,
        layout.cornerRadius,
      );
      chrome.lineStyle(Math.max(2, size * 0.035), INKLING_CUE.paper, 0.7);
      chrome.strokeRoundedRect(
        -size / 2,
        -size / 2,
        size,
        size,
        layout.cornerRadius,
      );

      const icon = this.add.graphics();
      icon.lineStyle(Math.max(4, size * 0.075), INKLING_CUE.paper, 0.98);
      const reach = size * 0.16;
      if (direction === "action") {
        icon.strokeCircle(0, 0, size * 0.15);
        icon.fillStyle(INKLING_CUE.paper, 0.98);
        icon.fillCircle(0, 0, size * 0.065);
      } else {
        icon.beginPath();
        if (direction === "left") {
          icon.moveTo(reach * 0.55, -reach);
          icon.lineTo(-reach * 0.55, 0);
          icon.lineTo(reach * 0.55, reach);
        } else if (direction === "right") {
          icon.moveTo(-reach * 0.55, -reach);
          icon.lineTo(reach * 0.55, 0);
          icon.lineTo(-reach * 0.55, reach);
        } else if (direction === "up") {
          icon.moveTo(-reach, reach * 0.55);
          icon.lineTo(0, -reach * 0.55);
          icon.lineTo(reach, reach * 0.55);
        } else {
          icon.moveTo(-reach, -reach * 0.55);
          icon.lineTo(0, reach * 0.55);
          icon.lineTo(reach, -reach * 0.55);
        }
        icon.strokePath();
      }
      button.add([chrome, icon]);
      button.setData("inklingPresentation", "touch-control");
      button
        .setSize(size, size)
        .setInteractive(
          new Phaser.Geom.Rectangle(-size / 2, -size / 2, size, size),
          Phaser.Geom.Rectangle.Contains,
        )
        .setAlpha(0.94);
      button.on("pointerdown", () => {
        this.touch[property] = true;
        button.setScale(0.94).setAlpha(1);
      });
      button.on("pointerup", () => {
        this.touch[property] = false;
        button.setScale(1).setAlpha(0.94);
      });
      button.on("pointerout", () => {
        this.touch[property] = false;
        button.setScale(1).setAlpha(0.94);
      });
      this.touchButtons.push(button);
    };
    makeButton(layout.left[0], "left", "left");
    makeButton(layout.left[1], "right", "right");
    makeButton(layout.right[0], "up", "jump");
    if (this.plan.contract.touchControls === "four_way") makeButton(layout.right[1], "down", "down");
    if (this.plan.contract.action === "projectile" && this.plan.goalKind === "defeat_boss") {
      makeButton(layout.right[2], "action", "action");
    }
    if (!this.coachingCompleted) this.renderControlCoaching(layout);
    else this.clearCoachingObjects(this.controlCoachingObjects);
  }

  private renderControlCoaching(layout: TouchControlLayout): void {
    this.clearCoachingObjects(this.controlCoachingObjects);
    const control = this.coaching.firstControl;
    const x = control === "left" ? layout.left[0]
      : control === "right" ? layout.left[1]
      : control === "jump" ? layout.right[0]
      : control === "down" ? layout.right[1]
      : layout.right[2];
    if (x === undefined) return;
    const ring = this.add
      .circle(x, layout.y, layout.size * 0.58, INKLING_CUE.sky, 0.055)
      .setStrokeStyle(Math.max(3, layout.size * 0.035), INKLING_CUE.sun, 0.82)
      .setScrollFactor(0)
      .setData("inklingPresentation", "mechanic-cue")
      .setDepth(106);
    this.controlCoachingObjects.push(ring);
    if (!this.reducedMotion) {
      this.tweens.add({ targets: ring, scale: 1.1, alpha: 0.55, duration: 620, yoyo: true, repeat: -1 });
    }
  }

  private collect(gameObject: Phaser.GameObjects.GameObject): void {
    const body = gameObject.body as Phaser.Physics.Arcade.StaticBody | null;
    if (!body?.enable) return;
    body.enable = false;
    const pickupX = (gameObject as Phaser.GameObjects.Rectangle).x;
    const pickupY = (gameObject as Phaser.GameObjects.Rectangle).y;
    (gameObject as Phaser.GameObjects.Rectangle).setVisible(false);
    const entityId = gameObject.getData("entityId");
    if (typeof entityId === "string") {
      this.artworkByEntity.get(entityId)?.setVisible(false);
      this.artworkHaloByEntity.get(entityId)?.setVisible(false);
    }
    this.collected += 1;
    if (typeof entityId === "string") {
      this.collectedIds.add(entityId);
      this.unlockLinkedDoors(entityId);
    }
    this.markObjectiveProgress();
    this.emitFeedback(
      "pickup",
      typeof entityId === "string" ? entityId : null,
      this.plan.goalKind === "collect_all" || (
        typeof entityId === "string" && this.plan.requiredCollectibleIds.includes(entityId)
      ),
      pickupX,
      pickupY,
    );
    if (
      this.plan.goalKind === "collect_all" &&
      this.collected >= this.plan.collectibles.length
    ) {
      this.win();
      return;
    }
    this.publishState();
  }

  private unlockLinkedDoors(keyId: string): void {
    for (const relationship of this.plan.relationships) {
      if (relationship.keyId !== keyId) continue;
      const door = this.doorObjects.get(relationship.doorId);
      const body = door?.body as Phaser.Physics.Arcade.StaticBody | null | undefined;
      if (!door || !body?.enable) continue;
      body.enable = false;
      door.setVisible(false);
      this.artworkByEntity.get(relationship.doorId)?.setVisible(false);
      this.artworkHaloByEntity.get(relationship.doorId)?.setVisible(false);
      this.emitFeedback("unlock", relationship.doorId, true, door.x, door.y);
    }
  }

  private markObjectiveProgress(): void {
    this.bestObjectiveDistance = Infinity;
    this.lastProgressAt = this.elapsedMs;
    this.stuckCueShown = false;
    this.assistAvailable = false;
    this.recoveryGuide?.destroy();
    this.recoveryGuide = undefined;
    this.assistTargetGuide?.destroy();
    this.assistTargetGuide = undefined;
    if (this.elapsedMs < this.assistActiveUntil) {
      const target = this.recoveryTarget();
      if (target) this.showAssistTarget(target);
    }
  }

  private touchGoal(): void {
    if (this.plan.goalKind === "survive") return;
    if (
      this.plan.goalKind === "collect_all" &&
      this.collected < this.plan.collectibles.length
    ) {
      if (this.elapsedMs - this.lastGoalBlockedAt >= 1_000) {
        this.lastGoalBlockedAt = this.elapsedMs;
        this.emitFeedback("goal_blocked", this.plan.goal.id, true, this.hero.x, this.hero.y - 22);
      }
      return;
    }
    if (this.plan.requiredCollectibleIds.some((id) => !this.collectedIds.has(id))) {
      if (this.elapsedMs - this.lastGoalBlockedAt >= 1_000) {
        this.lastGoalBlockedAt = this.elapsedMs;
        this.emitFeedback("goal_blocked", this.plan.goal.id, true, this.hero.x, this.hero.y - 22);
      }
      return;
    }
    this.win();
  }

  private hitHazard(): void {
    if (this.status !== "playing" || this.elapsedMs < this.invulnerableUntil) return;
    this.lives -= 1;
    if (this.lives <= 0) {
      this.lose();
      return;
    }
    this.emitFeedback("damage", null, false, this.hero.x, this.hero.y - this.plan.hero.height / 2);
    this.invulnerableUntil = this.elapsedMs + PLATFORMER_PHYSICS.invulnerabilityMs;
    this.hero.setAlpha(0.45);
    this.respawn();
    this.publishState();
  }

  private respawn(): void {
    const body = this.hero.body as Phaser.Physics.Arcade.Body;
    body.reset(this.plan.hero.x, this.plan.hero.y);
    body.setVelocity(0, 0);
    this.jumpsRemaining = PLATFORMER_PHYSICS.maxJumps;
    this.lastJumpPressedAt = -Infinity;
    // A hazard hit ends the current shot: the hero returns to the anchor to
    // aim again — the same rule the analytic solver applies on respawn.
    if (this.launchState) {
      resetLaunchShot(this.launchState);
      this.drawAimIndicator();
    }
    this.markObjectiveProgress();
  }

  private win(): void {
    if (this.status !== "playing") return;
    this.status = "won";
    this.assistTargetGuide?.destroy();
    this.assistTargetGuide = undefined;
    this.recoveryGuide?.destroy();
    this.recoveryGuide = undefined;
    this.physics.pause();
    if (this.presentation === "standalone") {
      this.message.setText("You brought it to life!\nTap to play again").setVisible(true);
    }
    this.emitFeedback("win", this.plan.goal.id, true);
    this.publishState();
  }

  private lose(): void {
    this.status = "lost";
    this.assistTargetGuide?.destroy();
    this.assistTargetGuide = undefined;
    this.recoveryGuide?.destroy();
    this.recoveryGuide = undefined;
    this.physics.pause();
    if (this.presentation === "standalone") {
      this.message.setText("Try again\nTap to restart").setVisible(true);
    }
    this.emitFeedback("lose", null, false);
    this.publishState();
  }

  private updateHud(): void {
    const objective = createObjectiveContract(this.plan);
    const objectiveCollected = objective.requiredTotal > 0
      ? this.plan.requiredCollectibleIds.filter((id) => this.collectedIds.has(id)).length
      : this.collected;
    const collectibleText = objective.counterLabel
      ? `  ${objective.counterLabel} ${objectiveCollected}/${objective.requiredTotal || this.plan.collectibles.length}`
      : "";
    const surviveText = this.plan.goalKind === "survive"
      ? `  Time ${Math.max(0, Math.ceil(this.surviveRemainingMs / 1000))}`
      : "";
    this.hud.setText(`Lives ${this.lives}${collectibleText}${surviveText}`);
  }

  private publishState(): void {
    this.updateHud();
    const state = this.currentState();
    this.onStateChange?.(state);
    this.emitRuntimeEvent("state_changed", null, false, state);
  }

  private currentState(): PlatformerState {
    const objective = createObjectiveContract(this.plan);
    const objectiveCollected = objective.requiredTotal > 0
      ? this.plan.requiredCollectibleIds.filter((id) => this.collectedIds.has(id)).length
      : this.collected;
    return {
      status: this.status,
      lives: this.lives,
      collected: objectiveCollected,
      collectibleTotal: objective.requiredTotal || this.plan.collectibles.length,
      assistAvailable: this.assistAvailable,
      assistActive: this.elapsedMs < this.assistActiveUntil,
    };
  }

  private emitRuntimeEvent(
    kind: RuntimeEventKind,
    entityId: string | null,
    required: boolean,
    state = this.currentState(),
  ): void {
    this.onRuntimeEvent?.({
      format: "inkling-runtime-event-v1",
      sequence: this.runtimeSequence,
      frame: this.frame,
      kind,
      entityId,
      required,
      state,
    });
    this.runtimeSequence += 1;
  }
}

/** Launches deterministic Lane A. It never loads prompts, models, or Lane B code. */
export function launchPlatformer(options: PlatformerOptions): Phaser.Game {
  const playableGame = resolvePlayableGame(options.gameSpec);
  const plan = createPlatformerPlan(playableGame.gameSpec, playableGame.behaviorTracks);
  const artwork = options.artwork ?? playableGame.artwork;
  const narrowPortrait = typeof window !== "undefined" &&
    window.innerWidth <= 680 && window.innerHeight > window.innerWidth;
  const viewportWidth = narrowPortrait ? 432 : WORLD_WIDTH;
  return new Phaser.Game({
    // Inkling repeatedly creates and retires small 2D games in one browser
    // session. Canvas avoids the low WebGL-context ceiling on mobile WebKit
    // while keeping the Phaser scene, physics, art, and deterministic replay
    // contracts identical.
    type: Phaser.CANVAS,
    parent: options.parent,
    width: viewportWidth,
    height: WORLD_HEIGHT,
    backgroundColor: "#f7f4ff",
    // P5 currently supplies a sound plan, not playable audio assets. Do not
    // create an unused WebAudio context until that deterministic audio layer
    // exists; this also keeps silent browser environments error-free.
    audio: { noAudio: true },
    physics: {
      default: "arcade",
      arcade: {
        gravity: { x: 0, y: PLATFORMER_PHYSICS.gravityY },
        fixedStep: true,
        fps: 1 / PLATFORMER_PHYSICS.fixedStepSeconds,
      },
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    input: {
      activePointers: 3,
    },
    scene: new PlatformerScene(
      plan,
      artwork,
      options.onStateChange,
      options.onFeedback,
      options.onRuntimeEvent,
      options.inputFrames ?? [],
      options.showTouchControls ?? true,
      options.presentation ?? "standalone",
      playableGame.backdrop,
      options.initiallyCollected ?? [],
    ),
  });
}

/** Feeds accessible DOM controls into the same deterministic input state. */
export function setPlatformerControl(
  game: Phaser.Game | undefined,
  control: PlatformerControl,
  pressed: boolean,
): void {
  if (!game) return;
  const scene = game.scene.getScene("lane-a-platformer");
  if (scene instanceof PlatformerScene) scene.setExternalControl(control, pressed);
}

/** Activates only an already-offered deterministic assist; it never auto-plays. */
export function requestPlatformerAssist(game: Phaser.Game | undefined): void {
  if (!game) return;
  const scene = game.scene.getScene("lane-a-platformer");
  if (scene instanceof PlatformerScene) scene.requestAssist();
}
