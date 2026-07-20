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
  CELEBRATION_POINTS,
  feedbackCueFor,
  type GameplayFeedbackEvent,
  type GameplayFeedbackKind,
} from "./feedback-contract.js";
import {
  createCoachingContract,
  type CoachingContract,
} from "./coaching-contract.js";
import type { RuntimeEvent, RuntimeEventKind } from "./runtime-events.js";
import type { InputFrame } from "./input-frame.js";
import { findMazeRoute, type MazePoint } from "./maze-topology.js";
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

const ENVIRONMENTAL_SURFACE_ROLES = new Set(["platform", "ice", "cloud", "launchpad", "mover", "water"]);

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
  private readonly artworkIsolationByEntity = new Map<string, boolean>();
  private sceneWorldColor = 0xf7f4ff;
  private sceneSurfaceShare = 1;
  private readonly doorObjects = new Map<string, Phaser.GameObjects.Rectangle>();
  private platforms!: Phaser.Physics.Arcade.StaticGroup;
  private doors!: Phaser.Physics.Arcade.StaticGroup;
  private hazards!: Phaser.Physics.Arcade.StaticGroup;
  private collectibles!: Phaser.Physics.Arcade.StaticGroup;
  private goalTrigger!: Phaser.Physics.Arcade.StaticGroup;
  private target!: Phaser.Physics.Arcade.StaticGroup;
  private projectiles!: Phaser.Physics.Arcade.Group;
  private hud!: Phaser.GameObjects.Text;
  private goalGuide: Phaser.GameObjects.Text | undefined;
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
  private status: PlatformerStatus = "playing";
  private frame = 0;
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

  constructor(
    private readonly plan: PlatformerPlan,
    private readonly artwork: ArtworkManifest | undefined,
    private readonly onStateChange?: (state: PlatformerState) => void,
    private readonly onFeedback?: (event: GameplayFeedbackEvent) => void,
    private readonly onRuntimeEvent?: (event: RuntimeEvent) => void,
    inputFrames: readonly InputFrame[] = [],
    private readonly showTouchControls = true,
    private readonly presentation: "standalone" | "embedded" = "standalone",
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
    this.runtimeSequence = 0;

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
    const heroColor = 0xffca58;
    const platformColor = 0x65a45b;
    const dangerColor = 0xd84343;
    const collectibleColor = 0x4c9bd6;

    this.cameras.main.setBackgroundColor(worldColor);
    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    // Scenes are composed from isolated original-art crops. Repainting the
    // complete photo behind them creates ghost entities that remain after a
    // collectible disappears and makes repeated crops look like photo tiles.
    if (this.presentation === "standalone") {
      this.add
        .text(24, 18, this.plan.title, {
          color: "#211c38",
          fontFamily: "system-ui, sans-serif",
          fontSize: "22px",
          fontStyle: "bold",
          backgroundColor: "rgba(255,255,255,0.82)",
          padding: { x: 8, y: 4 },
        })
        .setScrollFactor(0)
        .setDepth(20);
      if (this.usesFreeMovement) {
        this.add
          .text(this.scale.width - 24, 22, this.plan.contract.instruction, {
            color: `#${ink.toString(16).padStart(6, "0")}`,
            fontFamily: "system-ui, sans-serif",
            fontSize: "16px",
            fontStyle: "bold",
          })
          .setOrigin(1, 0)
          .setScrollFactor(0)
          .setAlpha(0.78)
          .setDepth(20);
      }
    }

    for (const decoration of this.plan.decorations) this.addArtwork(decoration, 0, 0.82);

    this.platforms = this.physics.add.staticGroup();
    const mazeWallIds = new Set(this.plan.mazeCollisionWalls.map((wall) => wall.id));
    for (const platform of this.plan.platforms) {
      if (this.usesFreeMovement && platform.id === "lane_a_safety_floor") continue;
      const alpha = platform.id === "lane_a_safety_floor" ? 0.5 : 1;
      const materialColor = platform.role === "ice" ? 0x9ee7ff
        : platform.role === "cloud" ? 0xffffff
        : platform.role === "launchpad" ? 0xff7bbd
        : platformColor;
      const shape = this.rectangle(platform, materialColor, ink, alpha);
      if (platform.id !== "lane_a_safety_floor" && !this.canRenderEntityArtwork(platform)) {
        shape.setAlpha(0);
        this.addOrganicSurface(platform, materialColor, 0.34, 2);
      }
      this.physics.add.existing(shape, true);
      const body = shape.body as Phaser.Physics.Arcade.StaticBody;
      if (this.plan.contract.id === "maze") {
        // In a finishable maze, the child's drawn support geometry is a set of
        // full collision walls. If topology validation failed, it remains
        // visible but non-colliding in the explicitly related fallback.
        if (mazeWallIds.has(platform.id)) this.platforms.add(shape);
      } else {
        // Drawn platforms are landing surfaces. Let the hero pass through their
        // underside and sides, then collide with the top while descending. This
        // is the same one-way contract used by the deterministic P8 simulation.
        Object.assign(body.checkCollision, ONE_WAY_PLATFORM_COLLISION);
        this.platforms.add(shape);
      }
      this.addArtwork(platform, 2, alpha);
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
      const shape = this.rectangle(door, 0x8f6bd7, ink, 0.92);
      this.physics.add.existing(shape, true);
      this.doors.add(shape);
      this.doorObjects.set(door.id, shape);
      this.addArtwork(door, 6, 1);
    }
    this.physics.add.collider(this.hero, this.doors);

    for (const water of this.plan.waterVolumes) {
      if (this.canRenderEntityArtwork(water)) {
        this.rectangle(water, 0x58bde8, ink, 0.18).setDepth(1);
        this.addArtwork(water, 1, 0.68);
      } else {
        this.addOrganicSurface(water, 0x58bde8, 0.28, 1);
      }
    }

    this.hazards = this.physics.add.staticGroup();
    for (const hazard of this.plan.hazards) {
      const shape = this.rectangle(hazard, dangerColor, ink, 1);
      if (!this.canRenderEntityArtwork(hazard)) {
        shape.setAlpha(0);
        this.addHazardPlaceholder(hazard, dangerColor, ink);
      }
      this.physics.add.existing(shape, true);
      const body = shape.body as Phaser.Physics.Arcade.StaticBody;
      body.setSize(hazard.width * 0.72, hazard.height * 0.72);
      this.hazards.add(shape);
      this.addArtwork(hazard, 3, 1);
    }
    this.physics.add.overlap(this.hero, this.hazards, () => this.hitHazard());

    this.collectibles = this.physics.add.staticGroup();
    for (const collectible of this.plan.collectibles) {
      const shape = this.rectangle(collectible, collectibleColor, ink, 1);
      this.physics.add.existing(shape, true);
      this.collectibles.add(shape);
      this.addArtwork(collectible, 4, 1);
    }
    this.physics.add.overlap(this.hero, this.collectibles, (_hero, collected) => {
      this.collect(collected as Phaser.GameObjects.GameObject);
    });

    this.goalTrigger = this.physics.add.staticGroup();
    // Every objective cue comes from the same contract as the win predicate.
    // In particular, collect-all worlds must never display a contradictory
    // FINISH marker when collecting the final required item ends the game.
    const hasVisibleGoal = createObjectiveContract(this.plan).finishRequired;
    if (hasVisibleGoal) {
      this.rectangle(this.plan.goal, dangerColor, ink, 0.85);
      this.addArtwork(this.plan.goal, 4, 1);
      this.add
        .rectangle(
          this.plan.goal.x,
          this.plan.goal.y,
          this.plan.goal.width + 18,
          this.plan.goal.height + 18,
          0xffffff,
          0,
        )
        .setStrokeStyle(5, 0xffb629, 0.96)
        .setDepth(8);
      this.add
        .text(this.plan.goal.x, Math.max(18, this.plan.goal.y - this.plan.goal.height / 2 - 18), "FINISH", {
          color: "#211c38",
          fontFamily: "system-ui, sans-serif",
          fontSize: "14px",
          fontStyle: "bold",
          backgroundColor: "rgba(255,255,255,0.9)",
          padding: { x: 6, y: 3 },
        })
        .setOrigin(0.5)
        .setDepth(9);
      if (this.scale.width < WORLD_WIDTH) {
        this.goalGuide = this.add
          .text(this.scale.width - 24, 66, "FINISH →", {
            color: "#211c38",
            fontFamily: "system-ui, sans-serif",
            fontSize: "16px",
            fontStyle: "bold",
            backgroundColor: "rgba(255,213,86,0.94)",
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
      this.addArtwork(this.plan.goal, 4, 1);
      this.physics.add.overlap(this.projectiles, this.target, (projectile, targetObject) => {
        (projectile as Phaser.GameObjects.GameObject).destroy();
        (targetObject as Phaser.GameObjects.GameObject).destroy();
        this.artworkByEntity.get(this.plan.goal.id)?.setVisible(false);
        this.win();
      });
      if (this.plan.contract.action !== "projectile") {
        this.physics.add.overlap(this.hero, this.target, () => this.win());
      }
    }

    this.hud = this.add.text(24, 62, "", {
      color: "#ffffff",
      fontFamily: "Nunito Variable, system-ui, sans-serif",
      fontSize: "17px",
      fontStyle: "bold",
      backgroundColor: "rgba(32,25,54,0.78)",
      padding: { x: 10, y: 6 },
    }).setScrollFactor(0).setDepth(120).setVisible(this.presentation === "standalone");
    this.message = this.add
      .text(this.scale.width / 2, this.scale.height / 2, "", {
        align: "center",
        color: "#ffffff",
        fontFamily: "Nunito Variable, system-ui, sans-serif",
        fontSize: "32px",
        fontStyle: "bold",
        backgroundColor: "rgba(75,47,212,0.9)",
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
    this.publishState();
  }

  update(_time: number, delta: number): void {
    if (this.status !== "playing") return;
    this.frame += 1;
    const replay = this.replayFrames.get(this.frame);
    if (replay) {
      this.touch = {
        left: replay.left,
        right: replay.right,
        jump: replay.jump,
        down: replay.down,
        action: replay.action,
      };
      if (replay.assist) this.requestAssist();
    } else if (this.replayFrames.size > 0) {
      this.touch = { left: false, right: false, jump: false, down: false, action: false };
    }
    this.elapsedMs += delta;
    if (this.goalGuide) {
      const view = this.cameras.main.worldView;
      const visible = this.plan.goal.x >= view.left + 24 && this.plan.goal.x <= view.right - 24;
      this.goalGuide
        .setVisible(!visible)
        .setText(this.plan.goal.x < this.hero.x ? "← FINISH" : "FINISH →");
    }
    if (this.elapsedMs >= this.invulnerableUntil) this.hero.setAlpha(1);

    const body = this.hero.body as Phaser.Physics.Arcade.Body;
    this.animateHeroArtwork(body);
    this.collectAssistedNearbyTarget();
    if (this.status !== "playing") return;
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
        ? movingLeft ? -PLATFORMER_PHYSICS.moveVelocityX : PLATFORMER_PHYSICS.moveVelocityX
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
      const arrow = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX < 0 ? "←" : "→" : deltaY < 0 ? "↑" : "↓";
      this.recoveryGuide = this.add
        .text(this.scale.width / 2, 112, `Try ${arrow} toward the glow`, {
          color: "#211c38",
          fontFamily: "system-ui, sans-serif",
          fontSize: "17px",
          fontStyle: "bold",
          backgroundColor: "rgba(255,213,86,0.96)",
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
    const velocity = PLATFORMER_PHYSICS.moveVelocityX;
    body.setVelocityX(left === right ? 0 : left ? -velocity : velocity);
    body.setVelocityY(up === down ? 0 : up ? -velocity : velocity);
  }

  private showAssistTarget(target: PlannedEntity): void {
    this.assistTargetGuide?.destroy();
    this.assistTargetGuide = this.add
      .ellipse(
        target.x,
        target.y,
        target.width + PLATFORMER_PHYSICS.assistPickupReach,
        target.height + PLATFORMER_PHYSICS.assistPickupReach,
        0xffd556,
        0.13,
      )
      .setStrokeStyle(7, 0xffb629, 0.98)
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
   * Shooter and slingshot worlds use the same deterministic, local projectile
   * contract. It is selected by GameSpec genre/goal, never by a drawing name
   * or model-written code. The target direction is intentional: it keeps the
   * touch control usable for young players while P8 can simulate the same rule.
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
    const label = this.add
      .text(x, y - 18, cue.label, {
        color: `#${cue.color.toString(16).padStart(6, "0")}`,
        fontFamily: "system-ui, sans-serif",
        fontSize: "19px",
        fontStyle: "bold",
        backgroundColor: "rgba(33,28,56,0.9)",
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
        0xffffff,
        0,
      )
      .setStrokeStyle(5, 0x684fe8, 0.96)
      .setDepth(132);
    const heroLabel = this.add
      .text(this.plan.hero.x, Math.max(18, this.plan.hero.y - this.plan.hero.height / 2 - 22), "YOU", {
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        fontSize: "14px",
        fontStyle: "bold",
        backgroundColor: "rgba(104,79,232,0.96)",
        padding: { x: 7, y: 3 },
      })
      .setOrigin(0.5)
      .setDepth(133);
    this.coachingObjects.push(heroRing, heroLabel);
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
        .setStrokeStyle(4, 0xffb629, 0.94)
        .setDepth(131);
      const targetLabel = this.add
        .text(target.x, Math.max(18, target.y - target.height / 2 - 20), this.coaching.objectiveLabel, {
          color: "#211c38",
          fontFamily: "system-ui, sans-serif",
          fontSize: "13px",
          fontStyle: "bold",
          backgroundColor: "rgba(255,213,86,0.96)",
          padding: { x: 7, y: 3 },
        })
        .setOrigin(0.5)
        .setDepth(133);
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
   * Renders an untouched crop from the original child drawing over the
   * deterministic collision primitive. The primitive remains the physics
   * contract; a malformed/missing artwork document simply leaves it visible.
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
    const cropX = Math.floor(left * source.width);
    const cropY = Math.floor(top * source.height);
    const cropWidth = Math.max(1, Math.ceil((right - left) * source.width));
    const cropHeight = Math.max(1, Math.ceil((bottom - top) * source.height));
    const cropTextureKey = `inkling-art-crop-${entity.id}`;
    let isolatedArtwork = false;
    if (!this.textures.exists(cropTextureKey) && source.image) {
      const cropTexture = this.textures.createCanvas(cropTextureKey, cropWidth, cropHeight);
      if (cropTexture) {
        cropTexture.context.drawImage(
          source.image as CanvasImageSource,
          cropX,
          cropY,
          cropWidth,
          cropHeight,
          0,
          0,
          cropWidth,
          cropHeight,
        );
        const isolation = this.removePaperBackground(cropTexture.context, cropWidth, cropHeight);
        isolatedArtwork = isolation.isolated;
        if (isolatedArtwork) {
          if (isolation.backdropColor !== undefined) {
            const pixels = cropTexture.context.getImageData(0, 0, cropWidth, cropHeight);
            if (softlyRemoveKnownBackdrop(
              { data: pixels.data, width: cropWidth, height: cropHeight },
              isolation.backdropColor,
            )) {
              cropTexture.context.putImageData(pixels, 0, 0);
            }
          }
          this.trimTransparentBounds(cropTexture, cropWidth, cropHeight);
        } else {
          const pixels = cropTexture.context.getImageData(0, 0, cropWidth, cropHeight);
          isolatedArtwork = softlyIsolateLocalBackdrop({
            data: pixels.data,
            width: cropWidth,
            height: cropHeight,
          });
          if (!isolatedArtwork) {
            featherSurfaceEdges({ data: pixels.data, width: cropWidth, height: cropHeight });
          }
          cropTexture.context.putImageData(pixels, 0, 0);
          if (isolatedArtwork) this.trimTransparentBounds(cropTexture, cropWidth, cropHeight);
        }
        this.artworkIsolationByEntity.set(entity.id, isolatedArtwork);
        cropTexture.refresh();
      }
    } else if (this.textures.exists(cropTextureKey)) {
      isolatedArtwork = this.artworkIsolationByEntity.get(entity.id) ?? false;
    }

    const hasCropTexture = this.textures.exists(cropTextureKey);
    const fitted = fitArtworkWithin(cropWidth, cropHeight, entity.width, entity.height);
    const image = hasCropTexture
      ? this.add.image(entity.x, entity.y, cropTextureKey).setDisplaySize(fitted.width, fitted.height)
      : this.add
        .image(entity.x, entity.y, this.artworkTextureKey)
        .setCrop(cropX, cropY, cropWidth, cropHeight)
        .setScale(fitted.width / cropWidth);
    const baseScaleX = image.scaleX;
    const baseScaleY = image.scaleY;
    image
      .setAlpha(isolatedArtwork ? alpha : alpha * 0.9)
      .setBlendMode(isolatedArtwork ? Phaser.BlendModes.NORMAL : Phaser.BlendModes.MULTIPLY)
      .setDepth(depth)
      .setData("entityId", entity.id)
      .setData("style_ref", entity.styleRef)
      .setData("inklingBaseScaleX", baseScaleX)
      .setData("inklingBaseScaleY", baseScaleY);
    this.artworkByEntity.set(entity.id, image);
    return image;
  }

  private canRenderEntityArtwork(entity: PlannedEntity): boolean {
    const crop = this.artwork?.entityCrops[entity.id];
    if (!crop || !this.textures.exists(this.artworkTextureKey)) return false;
    const [left, top, right, bottom] = crop;
    const width = right - left;
    const height = bottom - top;
    const area = width * height;
    // A non-hero crop spanning a large fraction of the page is scene context,
    // not a usable sprite. Treating it as an entity reconstructs the source
    // photograph as a conspicuous nested rectangle.
    if (entity.id !== this.plan.hero.id && area >= 0.16) return false;
    const difficultDarkSurface = colorLuminance(this.sceneWorldColor) < 150 && this.sceneSurfaceShare < 0.24;
    if (difficultDarkSurface && (entity.role === "decoration" || entity.role === "hazard")) return false;
    if (!ENVIRONMENTAL_SURFACE_ROLES.has(entity.role)) return true;
    // A dark, highly textured photographed substrate has too little local
    // separation for a surface crop to stop reading as a photo tile.
    if (difficultDarkSurface) return false;
    // Broad scene geometry is a visual/physics layer, not a foreground sprite.
    // Rendering its source rectangle can contain many smaller entities and
    // reconstruct the photograph as overlapping boxes.
    return area < 0.075 && width / Math.max(height, 0.001) < 4;
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
  private addHazardPlaceholder(entity: PlannedEntity, fill: number, stroke: number): void {
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
      scaleX = 1 + Math.sin(phase * 5) * 0.025;
      scaleY = 1 - Math.sin(phase * 5) * 0.025;
      angle = Phaser.Math.Clamp(body.velocity.y / PLATFORMER_PHYSICS.moveVelocityX, -1, 1) * 12;
      if (Math.abs(body.velocity.x) > 1) angle += Math.sign(body.velocity.x) * 4;
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
      chrome.fillStyle(0x151329, 0.2);
      chrome.fillRoundedRect(
        -size / 2 + 2,
        -size / 2 + 3,
        size,
        size,
        layout.cornerRadius,
      );
      chrome.fillStyle(0x24203f, 0.76);
      chrome.fillRoundedRect(
        -size / 2,
        -size / 2,
        size,
        size,
        layout.cornerRadius,
      );
      chrome.lineStyle(Math.max(2, size * 0.035), 0xffffff, 0.34);
      chrome.strokeRoundedRect(
        -size / 2,
        -size / 2,
        size,
        size,
        layout.cornerRadius,
      );

      const icon = this.add.graphics();
      icon.lineStyle(Math.max(4, size * 0.075), 0xffffff, 0.96);
      const reach = size * 0.16;
      if (direction === "action") {
        icon.strokeCircle(0, 0, size * 0.15);
        icon.fillStyle(0xffffff, 0.96);
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
      .circle(x, layout.y, layout.size * 0.58, 0xffffff, 0)
      .setStrokeStyle(Math.max(4, layout.size * 0.045), 0xffd556, 0.98)
      .setScrollFactor(0)
      .setDepth(106);
    const label = this.add
      .text(x, Math.max(18, layout.y - layout.size * 0.72), "START", {
        color: "#211c38",
        fontFamily: "system-ui, sans-serif",
        fontSize: "13px",
        fontStyle: "bold",
        backgroundColor: "rgba(255,213,86,0.96)",
        padding: { x: 7, y: 3 },
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(107);
    this.controlCoachingObjects.push(ring, label);
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
    if (typeof entityId === "string") this.artworkByEntity.get(entityId)?.setVisible(false);
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
  const plan = createPlatformerPlan(playableGame.gameSpec);
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
