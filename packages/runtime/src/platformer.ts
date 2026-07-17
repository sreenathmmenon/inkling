import Phaser from "phaser";

import {
  createPlatformerPlan,
  type PlannedEntity,
  type PlatformerPlan,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./platformer-layout.js";

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
  onStateChange?: (state: PlatformerState) => void;
}

interface Controls {
  cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  left?: Phaser.Input.Keyboard.Key;
  right?: Phaser.Input.Keyboard.Key;
  jump?: Phaser.Input.Keyboard.Key;
  space?: Phaser.Input.Keyboard.Key;
}

function color(value: string | undefined, fallback: number): number {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return fallback;
  return Number.parseInt(value.slice(1), 16);
}

class PlatformerScene extends Phaser.Scene {
  private hero!: Phaser.GameObjects.Rectangle;
  private platforms!: Phaser.Physics.Arcade.StaticGroup;
  private hazards!: Phaser.Physics.Arcade.StaticGroup;
  private collectibles!: Phaser.Physics.Arcade.StaticGroup;
  private goalTrigger!: Phaser.Physics.Arcade.StaticGroup;
  private hud!: Phaser.GameObjects.Text;
  private message!: Phaser.GameObjects.Text;
  private controls: Controls = {};
  private touch = { left: false, right: false, jump: false };
  private jumpWasDown = false;
  private lives = 3;
  private collected = 0;
  private elapsedMs = 0;
  private invulnerableUntil = 0;
  private lastGroundedAt = 0;
  private surviveRemainingMs = 15_000;
  private status: PlatformerStatus = "playing";

  constructor(
    private readonly plan: PlatformerPlan,
    private readonly onStateChange?: (state: PlatformerState) => void,
  ) {
    super("lane-a-platformer");
  }

  create(): void {
    this.physics.resume();
    this.status = "playing";
    this.lives = this.plan.lives;
    this.collected = 0;
    this.elapsedMs = 0;
    this.invulnerableUntil = 0;
    this.lastGroundedAt = 0;
    this.surviveRemainingMs = 15_000;
    this.touch = { left: false, right: false, jump: false };
    this.jumpWasDown = false;

    const paper = color(this.plan.palette[0], 0xfffaf0);
    const ink = color(this.plan.palette[1], 0x263238);
    const heroColor = color(this.plan.palette[2], 0xffca58);
    const platformColor = color(this.plan.palette[3], 0x5f9f45);
    const dangerColor = color(this.plan.palette[4], 0xd84343);
    const collectibleColor = color(this.plan.palette[5], 0x4c9bd6);

    this.cameras.main.setBackgroundColor(paper);
    this.add
      .text(24, 18, this.plan.title, {
        color: `#${ink.toString(16).padStart(6, "0")}`,
        fontFamily: "system-ui, sans-serif",
        fontSize: "22px",
        fontStyle: "bold",
      })
      .setDepth(20);

    this.platforms = this.physics.add.staticGroup();
    for (const platform of this.plan.platforms) {
      const alpha = platform.id === "lane_a_safety_floor" ? 0.5 : 1;
      const shape = this.rectangle(platform, platformColor, ink, alpha);
      this.physics.add.existing(shape, true);
      this.platforms.add(shape);
    }

    this.hero = this.rectangle(this.plan.hero, heroColor, ink, 1);
    this.physics.add.existing(this.hero, false);
    const heroBody = this.hero.body as Phaser.Physics.Arcade.Body;
    heroBody.setCollideWorldBounds(true);
    heroBody.setMaxVelocity(250, 700);
    this.physics.add.collider(this.hero, this.platforms);

    this.hazards = this.physics.add.staticGroup();
    for (const hazard of this.plan.hazards) {
      const shape = this.rectangle(hazard, dangerColor, ink, 1);
      this.physics.add.existing(shape, true);
      const body = shape.body as Phaser.Physics.Arcade.StaticBody;
      body.setSize(hazard.width * 0.72, hazard.height * 0.72);
      this.hazards.add(shape);
    }
    this.physics.add.overlap(this.hero, this.hazards, () => this.hitHazard());

    this.collectibles = this.physics.add.staticGroup();
    for (const collectible of this.plan.collectibles) {
      const shape = this.rectangle(collectible, collectibleColor, ink, 1);
      this.physics.add.existing(shape, true);
      this.collectibles.add(shape);
    }
    this.physics.add.overlap(this.hero, this.collectibles, (_hero, collected) => {
      this.collect(collected as Phaser.GameObjects.GameObject);
    });

    this.rectangle(this.plan.goal, dangerColor, ink, 0.85);
    this.goalTrigger = this.physics.add.staticGroup();
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
        space: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      };
    }
    this.createTouchControls(ink);
    this.publishState();
  }

  update(_time: number, delta: number): void {
    if (this.status !== "playing") return;
    this.elapsedMs += delta;
    if (this.elapsedMs >= this.invulnerableUntil) this.hero.setAlpha(1);

    const body = this.hero.body as Phaser.Physics.Arcade.Body;
    if (body.blocked.down || body.touching.down) this.lastGroundedAt = this.elapsedMs;
    const movingLeft = Boolean(this.controls.cursors?.left.isDown || this.controls.left?.isDown || this.touch.left);
    const movingRight = Boolean(this.controls.cursors?.right.isDown || this.controls.right?.isDown || this.touch.right);
    if (movingLeft === movingRight) body.setVelocityX(0);
    else body.setVelocityX(movingLeft ? -220 : 220);

    const jumpDown = Boolean(
      this.controls.cursors?.up.isDown ||
        this.controls.jump?.isDown ||
        this.controls.space?.isDown ||
        this.touch.jump,
    );
    if (
      jumpDown &&
      !this.jumpWasDown &&
      this.elapsedMs - this.lastGroundedAt <= 120
    ) {
      body.setVelocityY(-520);
    }
    this.jumpWasDown = jumpDown;

    if (this.plan.goalKind === "survive") {
      this.surviveRemainingMs -= delta;
      if (this.surviveRemainingMs <= 0) this.win();
    }
    this.updateHud();
  }

  private rectangle(
    entity: PlannedEntity,
    fill: number,
    stroke: number,
    alpha: number,
  ): Phaser.GameObjects.Rectangle {
    return this.add
      .rectangle(entity.x, entity.y, entity.width, entity.height, fill, alpha)
      .setStrokeStyle(4, stroke, Math.min(1, alpha + 0.25))
      .setData("entityId", entity.id)
      .setData("role", entity.role)
      .setData("style_ref", entity.styleRef);
  }

  private createTouchControls(ink: number): void {
    const makeButton = (
      x: number,
      label: string,
      property: keyof typeof this.touch,
    ): void => {
      const button = this.add
        .circle(x, WORLD_HEIGHT - 68, 43, ink, 0.28)
        .setStrokeStyle(3, ink, 0.65)
        .setDepth(100)
        .setInteractive();
      this.add
        .text(x, WORLD_HEIGHT - 68, label, {
          color: "#ffffff",
          fontFamily: "system-ui, sans-serif",
          fontSize: "28px",
          fontStyle: "bold",
        })
        .setOrigin(0.5)
        .setDepth(101);
      button.on("pointerdown", () => {
        this.touch[property] = true;
      });
      button.on("pointerup", () => {
        this.touch[property] = false;
      });
      button.on("pointerout", () => {
        this.touch[property] = false;
      });
    };
    makeButton(70, "◀", "left");
    makeButton(170, "▶", "right");
    makeButton(WORLD_WIDTH - 75, "↑", "jump");
    this.input.on("pointerup", () => {
      this.touch = { left: false, right: false, jump: false };
    });
  }

  private collect(gameObject: Phaser.GameObjects.GameObject): void {
    const body = gameObject.body as Phaser.Physics.Arcade.StaticBody | null;
    if (!body?.enable) return;
    body.enable = false;
    (gameObject as Phaser.GameObjects.Rectangle).setVisible(false);
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
    this.invulnerableUntil = this.elapsedMs + 900;
    this.hero.setAlpha(0.45);
    this.respawn();
    this.publishState();
  }

  private respawn(): void {
    const body = this.hero.body as Phaser.Physics.Arcade.Body;
    body.reset(this.plan.hero.x, this.plan.hero.y);
    body.setVelocity(0, 0);
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
  const plan = createPlatformerPlan(options.gameSpec);
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent: options.parent,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    backgroundColor: plan.palette[0] ?? "#fffaf0",
    physics: {
      default: "arcade",
      arcade: {
        gravity: { x: 0, y: 1050 },
        fixedStep: true,
        fps: 60,
      },
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: new PlatformerScene(plan, options.onStateChange),
  });
}
