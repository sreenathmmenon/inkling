import Phaser from "phaser";

import {
  createPlatformerPlan,
  type PlannedEntity,
  type PlatformerPlan,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./platformer-layout.js";
import {
  resolvePlayableGame,
  type ArtworkManifest,
} from "./artwork.js";
import {
  ONE_WAY_PLATFORM_COLLISION,
  PLATFORMER_PHYSICS,
} from "./platformer-physics.js";
import { createTouchControlLayout } from "./platformer-controls.js";

export type PlatformerStatus = "playing" | "won" | "lost";

export interface PlatformerState {
  status: PlatformerStatus;
  lives: number;
  collected: number;
  collectibleTotal: number;
}

export interface PlatformerOptions {
  parent: string | HTMLElement;
  gameSpec: unknown;
  artwork?: ArtworkManifest;
  onStateChange?: (state: PlatformerState) => void;
}

interface Controls {
  cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  left?: Phaser.Input.Keyboard.Key;
  right?: Phaser.Input.Keyboard.Key;
  jump?: Phaser.Input.Keyboard.Key;
  down?: Phaser.Input.Keyboard.Key;
  space?: Phaser.Input.Keyboard.Key;
}

function color(value: string | undefined, fallback: number): number {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return fallback;
  return Number.parseInt(value.slice(1), 16);
}

class PlatformerScene extends Phaser.Scene {
  private readonly artworkTextureKey = "inkling-original-art";
  private hero!: Phaser.GameObjects.Rectangle;
  private heroArtwork: Phaser.GameObjects.Image | undefined;
  private readonly artworkByEntity = new Map<string, Phaser.GameObjects.Image>();
  private platforms!: Phaser.Physics.Arcade.StaticGroup;
  private hazards!: Phaser.Physics.Arcade.StaticGroup;
  private collectibles!: Phaser.Physics.Arcade.StaticGroup;
  private goalTrigger!: Phaser.Physics.Arcade.StaticGroup;
  private target!: Phaser.Physics.Arcade.StaticGroup;
  private projectiles!: Phaser.Physics.Arcade.Group;
  private hud!: Phaser.GameObjects.Text;
  private message!: Phaser.GameObjects.Text;
  private controls: Controls = {};
  private touch = { left: false, right: false, jump: false, down: false, action: false };
  private touchButtons: Phaser.GameObjects.Container[] = [];
  private touchResizeObserver: ResizeObserver | undefined;
  private jumpWasDown = false;
  private lives = 3;
  private collected = 0;
  private elapsedMs = 0;
  private invulnerableUntil = 0;
  private lastGroundedAt = 0;
  private lastJumpPressedAt = -Infinity;
  private jumpsRemaining: number = PLATFORMER_PHYSICS.maxJumps;
  private surviveRemainingMs = PLATFORMER_PHYSICS.surviveDurationMs;
  private lastProjectileAt = -Infinity;
  private status: PlatformerStatus = "playing";

  private get usesFreeMovement(): boolean {
    return this.plan.contract.movement === "free" || this.plan.contract.movement === "launch";
  }

  constructor(
    private readonly plan: PlatformerPlan,
    private readonly artwork: ArtworkManifest | undefined,
    private readonly onStateChange?: (state: PlatformerState) => void,
  ) {
    super("lane-a-platformer");
  }

  preload(): void {
    if (this.artwork) this.load.image(this.artworkTextureKey, this.artwork.sourceDataUrl);
  }

  create(): void {
    this.physics.resume();
    this.status = "playing";
    this.lives = this.plan.lives;
    this.collected = 0;
    this.elapsedMs = 0;
    this.invulnerableUntil = 0;
    this.lastGroundedAt = 0;
    this.lastJumpPressedAt = -Infinity;
    this.jumpsRemaining = PLATFORMER_PHYSICS.maxJumps;
    this.surviveRemainingMs = PLATFORMER_PHYSICS.surviveDurationMs;
    this.touch = { left: false, right: false, jump: false, down: false, action: false };
    this.jumpWasDown = false;

    const paper = color(this.plan.palette[0], 0xfffaf0);
    const ink = color(this.plan.palette[1], 0x263238);
    const heroColor = color(this.plan.palette[2], 0xffca58);
    const platformColor = color(this.plan.palette[3], 0x5f9f45);
    const dangerColor = color(this.plan.palette[4], 0xd84343);
    const collectibleColor = color(this.plan.palette[5], 0x4c9bd6);

    this.cameras.main.setBackgroundColor(this.usesFreeMovement ? 0xe8edff : paper);
    // Free-movement scenes are composed from individual original-art crops so a
    // collectible can actually disappear when collected. A full photo behind
    // it would make every object look static even when the game is working.
    if (!this.usesFreeMovement) this.addOriginalDrawingBackground(0.13);
    this.add
      .text(24, 18, this.plan.title, {
        color: `#${ink.toString(16).padStart(6, "0")}`,
        fontFamily: "system-ui, sans-serif",
        fontSize: "22px",
        fontStyle: "bold",
      })
      .setDepth(20);
    if (this.usesFreeMovement) {
      this.add
        .text(WORLD_WIDTH - 24, 22, this.plan.contract.instruction, {
          color: `#${ink.toString(16).padStart(6, "0")}`,
          fontFamily: "system-ui, sans-serif",
          fontSize: "16px",
          fontStyle: "bold",
        })
        .setOrigin(1, 0)
        .setAlpha(0.78)
        .setDepth(20);
    }

    this.platforms = this.physics.add.staticGroup();
    for (const platform of this.plan.platforms) {
      if (this.usesFreeMovement && platform.id === "lane_a_safety_floor") continue;
      const alpha = platform.id === "lane_a_safety_floor" ? 0.5 : 1;
      const shape = this.rectangle(platform, platformColor, ink, alpha);
      this.physics.add.existing(shape, true);
      const body = shape.body as Phaser.Physics.Arcade.StaticBody;
      // Drawn platforms are landing surfaces. Let the hero pass through their
      // underside and sides, then collide with the top while descending. This
      // is the same one-way contract used by the deterministic P8 simulation.
      Object.assign(body.checkCollision, ONE_WAY_PLATFORM_COLLISION);
      this.platforms.add(shape);
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
    if (!this.usesFreeMovement) this.physics.add.collider(this.hero, this.platforms);

    this.hazards = this.physics.add.staticGroup();
    for (const hazard of this.plan.hazards) {
      const shape = this.rectangle(hazard, dangerColor, ink, 1);
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
    const hasVisibleGoal = this.plan.goalKind !== "survive" && this.plan.goalKind !== "defeat_boss" && !(
      this.plan.goalKind === "collect_all" && this.plan.goal.id === "lane_a_goal"
    );
    if (hasVisibleGoal) {
      this.rectangle(this.plan.goal, dangerColor, ink, 0.85);
      this.addArtwork(this.plan.goal, 4, 1);
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
    }

    this.target = this.physics.add.staticGroup();
    this.projectiles = this.physics.add.group();
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

    this.hud = this.add.text(24, 50, "", {
      color: `#${ink.toString(16).padStart(6, "0")}`,
      fontFamily: "ui-monospace, monospace",
      fontSize: "18px",
      backgroundColor: "rgba(255,255,255,0.68)",
      padding: { x: 8, y: 5 },
    });
    this.message = this.add
      .text(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, "", {
        align: "center",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        fontSize: "42px",
        fontStyle: "bold",
        backgroundColor: "rgba(38,50,56,0.9)",
        padding: { x: 28, y: 20 },
      })
      .setOrigin(0.5)
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
    this.createTouchControls();
    this.input.on(Phaser.Input.Events.GAME_OUT, this.resetTouchControls, this);
    if (typeof ResizeObserver !== "undefined") {
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
    });
    this.publishState();
  }

  update(_time: number, delta: number): void {
    if (this.status !== "playing") return;
    this.elapsedMs += delta;
    if (this.elapsedMs >= this.invulnerableUntil) this.hero.setAlpha(1);

    const body = this.hero.body as Phaser.Physics.Arcade.Body;
    this.animateHeroArtwork(body);
    if (this.usesFreeMovement) {
      this.updateFreeMovementControls(body);
      this.tryProjectileAction();
      if (this.plan.goalKind === "survive") {
        this.surviveRemainingMs -= delta;
        if (this.surviveRemainingMs <= 0) this.win();
      }
      this.updateHud();
      return;
    }
    if (body.blocked.down || body.touching.down) {
      this.lastGroundedAt = this.elapsedMs;
      this.jumpsRemaining = PLATFORMER_PHYSICS.maxJumps;
    }
    const movingLeft = Boolean(this.controls.cursors?.left.isDown || this.controls.left?.isDown || this.touch.left);
    const movingRight = Boolean(this.controls.cursors?.right.isDown || this.controls.right?.isDown || this.touch.right);
    if (this.plan.contract.movement === "auto_ground") {
      // Runners advance by default, but the same left/right controls remain
      // available so a required item behind the hero never makes the game
      // impossible. This is part of the genre contract, not drawing-specific.
      body.setVelocityX(movingLeft ? -PLATFORMER_PHYSICS.moveVelocityX : PLATFORMER_PHYSICS.moveVelocityX);
    } else if (movingLeft === movingRight) body.setVelocityX(0);
    else body.setVelocityX(movingLeft ? -PLATFORMER_PHYSICS.moveVelocityX : PLATFORMER_PHYSICS.moveVelocityX);

    const jumpDown = Boolean(
      this.controls.cursors?.up.isDown ||
        this.controls.jump?.isDown ||
        this.controls.space?.isDown ||
        this.touch.jump,
    );
    if (jumpDown && !this.jumpWasDown) this.lastJumpPressedAt = this.elapsedMs;
    if (
      this.elapsedMs - this.lastJumpPressedAt <= PLATFORMER_PHYSICS.jumpBufferMs &&
      (
        this.elapsedMs - this.lastGroundedAt <= PLATFORMER_PHYSICS.coyoteTimeMs ||
        this.jumpsRemaining > 0
      )
    ) {
      body.setVelocityY(PLATFORMER_PHYSICS.jumpVelocityY);
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
    this.updateHud();
  }

  private updateFreeMovementControls(body: Phaser.Physics.Arcade.Body): void {
    const left = Boolean(this.controls.cursors?.left.isDown || this.controls.left?.isDown || this.touch.left);
    const right = Boolean(this.controls.cursors?.right.isDown || this.controls.right?.isDown || this.touch.right);
    const up = Boolean(this.controls.cursors?.up.isDown || this.controls.jump?.isDown || this.touch.jump);
    const down = Boolean(this.controls.cursors?.down.isDown || this.controls.down?.isDown || this.touch.down);
    const velocity = PLATFORMER_PHYSICS.moveVelocityX;
    body.setVelocityX(left === right ? 0 : left ? -velocity : velocity);
    body.setVelocityY(up === down ? 0 : up ? -velocity : velocity);
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
    const body = projectile.body as Phaser.Physics.Arcade.Body;
    body.setAllowGravity(false);
    body.setVelocity(
      (deltaX / magnitude) * PLATFORMER_PHYSICS.projectileVelocity,
      (deltaY / magnitude) * PLATFORMER_PHYSICS.projectileVelocity,
    );
    body.setCollideWorldBounds(true);
    body.onWorldBounds = true;
    this.projectiles.add(projectile);
    this.time.delayedCall(1_500, () => projectile.destroy());
  }

  private rectangle(
    entity: PlannedEntity,
    fill: number,
    stroke: number,
    alpha: number,
  ): Phaser.GameObjects.Rectangle {
    const usesOriginalArtwork = Boolean(
      this.artwork?.entityCrops[entity.id] && this.textures.exists(this.artworkTextureKey),
    );
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
        this.removePaperBackground(cropTexture.context, cropWidth, cropHeight);
        this.trimTransparentBounds(cropTexture, cropWidth, cropHeight);
        cropTexture.refresh();
      }
    }

    const isolatedArtwork = this.textures.exists(cropTextureKey);
    const image = isolatedArtwork
      ? this.add.image(entity.x, entity.y, cropTextureKey).setDisplaySize(entity.width, entity.height)
      : this.add
        .image(entity.x, entity.y, this.artworkTextureKey)
        .setCrop(cropX, cropY, cropWidth, cropHeight)
        .setScale(entity.width / cropWidth, entity.height / cropHeight);
    const baseScaleX = image.scaleX;
    const baseScaleY = image.scaleY;
    image
      .setAlpha(alpha)
      .setBlendMode(isolatedArtwork ? Phaser.BlendModes.NORMAL : Phaser.BlendModes.MULTIPLY)
      .setDepth(depth)
      .setData("entityId", entity.id)
      .setData("style_ref", entity.styleRef)
      .setData("inklingBaseScaleX", baseScaleX)
      .setData("inklingBaseScaleY", baseScaleY);
    this.artworkByEntity.set(entity.id, image);
    return image;
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
  ): void {
    const pixels = context.getImageData(0, 0, width, height);
    const sampleRadius = Math.max(1, Math.min(4, Math.floor(Math.min(width, height) / 6)));
    const redSamples: number[] = [];
    const greenSamples: number[] = [];
    const blueSamples: number[] = [];
    const sampleCorner = (startX: number, startY: number): void => {
      for (let y = startY; y < startY + sampleRadius; y += 1) {
        for (let x = startX; x < startX + sampleRadius; x += 1) {
          const offset = (y * width + x) * 4;
          redSamples.push(pixels.data[offset] ?? 0);
          greenSamples.push(pixels.data[offset + 1] ?? 0);
          blueSamples.push(pixels.data[offset + 2] ?? 0);
        }
      }
    };
    sampleCorner(0, 0);
    sampleCorner(width - sampleRadius, 0);
    sampleCorner(0, height - sampleRadius);
    sampleCorner(width - sampleRadius, height - sampleRadius);
    const median = (values: number[]): number => {
      const ordered = values.sort((left, right) => left - right);
      return ordered[Math.floor(ordered.length / 2)] ?? 0;
    };
    const paperRed = median(redSamples);
    const paperGreen = median(greenSamples);
    const paperBlue = median(blueSamples);
    const paperLightness = Math.max(paperRed, paperGreen, paperBlue);
    const paperDarkness = Math.min(paperRed, paperGreen, paperBlue);
    // Light neutral paper needs a narrow tolerance so faint graphite survives.
    // Dark or colored paper varies more under phone lighting and needs a wider
    // one. Only matching pixels connected to the crop border are removed, so
    // enclosed white chalk or similarly colored child strokes remain intact.
    const tolerance = paperDarkness > 205 && paperLightness - paperDarkness < 24 ? 18 : 42;
    const toleranceSquared = tolerance * tolerance;
    const matchesPaper = (pixelIndex: number): boolean => {
      const offset = pixelIndex * 4;
      const redDistance = (pixels.data[offset] ?? 0) - paperRed;
      const greenDistance = (pixels.data[offset + 1] ?? 0) - paperGreen;
      const blueDistance = (pixels.data[offset + 2] ?? 0) - paperBlue;
      return redDistance * redDistance + greenDistance * greenDistance + blueDistance * blueDistance <= toleranceSquared;
    };
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let queueLength = 0;
    let cursor = 0;
    const enqueue = (x: number, y: number): void => {
      const pixelIndex = y * width + x;
      if (visited[pixelIndex] || !matchesPaper(pixelIndex)) return;
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
      pixels.data[pixelIndex * 4 + 3] = 0;
      if (x > 0) enqueue(x - 1, y);
      if (x + 1 < width) enqueue(x + 1, y);
      if (y > 0) enqueue(x, y - 1);
      if (y + 1 < height) enqueue(x, y + 1);
    }
    context.putImageData(pixels, 0, 0);
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

  /** Keeps the original drawing visible without redrawing or restyling it. */
  private addOriginalDrawingBackground(alpha: number): void {
    if (!this.artwork || !this.textures.exists(this.artworkTextureKey)) return;
    const source = this.textures.get(this.artworkTextureKey).source[0];
    if (!source?.width || !source.height) return;
    const scale = Math.min(WORLD_WIDTH / source.width, WORLD_HEIGHT / source.height);
    this.add
      .image(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, this.artworkTextureKey)
      .setScale(scale)
      .setAlpha(alpha)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
      .setDepth(-10);
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
      const button = this.add.container(x, layout.y).setDepth(100);
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
  }

  private collect(gameObject: Phaser.GameObjects.GameObject): void {
    const body = gameObject.body as Phaser.Physics.Arcade.StaticBody | null;
    if (!body?.enable) return;
    body.enable = false;
    (gameObject as Phaser.GameObjects.Rectangle).setVisible(false);
    const entityId = gameObject.getData("entityId");
    if (typeof entityId === "string") this.artworkByEntity.get(entityId)?.setVisible(false);
    this.collected += 1;
    if (
      this.plan.goalKind === "collect_all" &&
      this.collected >= this.plan.collectibles.length
    ) {
      this.win();
      return;
    }
    this.publishState();
  }

  private touchGoal(): void {
    if (this.plan.goalKind === "survive") return;
    if (
      this.plan.goalKind === "collect_all" &&
      this.collected < this.plan.collectibles.length
    ) {
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
  }

  private win(): void {
    if (this.status !== "playing") return;
    this.status = "won";
    this.physics.pause();
    this.message.setText("You win!\nTap to play again").setVisible(true);
    this.publishState();
  }

  private lose(): void {
    this.status = "lost";
    this.physics.pause();
    this.message.setText("Try again\nTap to restart").setVisible(true);
    this.publishState();
  }

  private updateHud(): void {
    const collectibleText = this.plan.collectibles.length
      ? `  Stars ${this.collected}/${this.plan.collectibles.length}`
      : "";
    const surviveText = this.plan.goalKind === "survive"
      ? `  Time ${Math.max(0, Math.ceil(this.surviveRemainingMs / 1000))}`
      : "";
    this.hud.setText(`Lives ${this.lives}${collectibleText}${surviveText}`);
  }

  private publishState(): void {
    this.updateHud();
    this.onStateChange?.({
      status: this.status,
      lives: this.lives,
      collected: this.collected,
      collectibleTotal: this.plan.collectibles.length,
    });
  }
}

/** Launches deterministic Lane A. It never loads prompts, models, or Lane B code. */
export function launchPlatformer(options: PlatformerOptions): Phaser.Game {
  const playableGame = resolvePlayableGame(options.gameSpec);
  const plan = createPlatformerPlan(playableGame.gameSpec);
  const artwork = options.artwork ?? playableGame.artwork;
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent: options.parent,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    backgroundColor: plan.palette[0] ?? "#fffaf0",
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
    scene: new PlatformerScene(plan, artwork, options.onStateChange),
  });
}
