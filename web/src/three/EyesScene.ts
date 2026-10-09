import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * The VisionSwap mascot, built from primitives so it costs no download:
 * two lavender eyeballs with heavy lids, peeking over a pair of white
 * wayfarers. `setShield(t)` slides the glasses up over the eyes (t = 1).
 */

export const BRAND = {
  violet: 0x8804fe,
  eyeWhite: 0xe9e2f7,
  lid: 0xfbfaff,
  pupil: 0x0b021e,
  lens: 0x16013a,
  frame: 0xfaf9ff,
};

type Opts = {
  /** Draw with a transparent background (the page paints the violet). */
  transparent?: boolean;
  /** Start with the glasses fully on. */
  shielded?: boolean;
  /** Smaller, cheaper render for the in-app mascot. */
  compact?: boolean;
};

const EYE_R = 1;
const EYE_X = 1.12;
const EYE_Y = 0.3;

function roundedPath(shape: THREE.Shape | THREE.Path, pts: [number, number][], r: number | number[]) {
  const n = pts.length;
  const rad = (i: number) => (Array.isArray(r) ? r[i % r.length] : r);
  const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
  ];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const lp = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const ln = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    const ri = Math.min(rad(i), lp / 2, ln / 2);
    const a = lerp(cur, prev, ri / lp);
    const b = lerp(cur, next, ri / ln);
    if (i === 0) shape.moveTo(a[0], a[1]);
    else shape.lineTo(a[0], a[1]);
    shape.quadraticCurveTo(cur[0], cur[1], b[0], b[1]);
  }
  shape.closePath();
}

/** Wayfarer lens outline, centred on 0,0. `side` = -1 for the left lens. */
function lensPoints(side: -1 | 1, cx: number): [number, number][] {
  const s = side;
  const raw: [number, number][] = [
    [-0.94 * s, 0.5],
    [0.86 * s, 0.52],
    [0.66 * s, -0.46],
    [-0.62 * s, -0.5],
    [-0.86 * s, -0.24],
  ];
  const pts = raw.map(([x, y]) => [x + cx, y] as [number, number]);
  return s === 1 ? pts.reverse() : pts;
}

function remapUV(geo: THREE.BufferGeometry) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x);
    uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y);
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

function lensTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d")!;
  const base = g.createLinearGradient(0, 0, 0, 128);
  base.addColorStop(0, "#26075e");
  base.addColorStop(0.5, "#11022c");
  base.addColorStop(1, "#070117");
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 128);
  // the soft diagonal sheen seen on the logo's lenses
  const sheen = g.createLinearGradient(40, 0, 150, 128);
  sheen.addColorStop(0, "rgba(160,90,255,0)");
  sheen.addColorStop(0.5, "rgba(150,80,255,0.2)");
  sheen.addColorStop(1, "rgba(160,90,255,0)");
  g.fillStyle = sheen;
  g.fillRect(0, 0, 256, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class Eye {
  root = new THREE.Group();
  ball = new THREE.Group();
  lid = new THREE.Group();
  private gaze = new THREE.Vector2();
  private gazeTarget = new THREE.Vector2();
  lidBase: number;

  constructor(side: -1 | 1, mats: Record<string, THREE.Material>) {
    const ballGeo = new THREE.SphereGeometry(EYE_R, 64, 48);
    const ball = new THREE.Mesh(ballGeo, mats.eye);
    ball.castShadow = true;
    ball.receiveShadow = true;
    this.ball.add(ball);

    // pupil: a flattened glossy ellipsoid sitting on the front of the ball
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), mats.pupil);
    pupil.scale.set(0.35, 0.47, 0.085);
    pupil.position.set(0, -0.02, EYE_R * 0.962);
    this.ball.add(pupil);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mats.glint);
    glint.scale.set(0.05, 0.085, 0.02);
    glint.position.set(0.12, 0.17, EYE_R * 1.035);
    glint.rotation.z = -0.35;
    this.ball.add(glint);
    this.root.add(this.ball);

    // heavy lid: a spherical cap with a rolled rim
    const cover = Math.PI * 0.5;
    const LID_R = EYE_R * 1.085;
    const capGeo = new THREE.SphereGeometry(LID_R, 64, 24, 0, Math.PI * 2, 0, cover);
    const cap = new THREE.Mesh(capGeo, mats.lid);
    cap.castShadow = true;
    const rimR = LID_R * Math.sin(cover) - 0.01;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.055, 16, 96), mats.lidRim);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = LID_R * Math.cos(cover);
    rim.castShadow = true;
    this.lid.add(cap, rim);
    // slant the lids toward the nose for the unimpressed look
    this.lid.rotation.z = side * 0.24;
    this.lidBase = -0.4;
    this.lid.rotation.x = this.lidBase;
    this.root.add(this.lid);

    this.root.position.set(side * EYE_X, EYE_Y, 0);
    this.root.scale.set(1, 1.04, 1);
  }

  look(x: number, y: number) {
    this.gazeTarget.set(x, y);
  }

  update(dt: number, blink: number) {
    const k = 1 - Math.exp(-dt * 14);
    this.gaze.lerp(this.gazeTarget, k);
    this.ball.rotation.y = this.gaze.x * 0.75;
    this.ball.rotation.x = -this.gaze.y * 0.45;
    this.lid.rotation.x = this.lidBase + blink * 1.75 + Math.max(0, -this.gaze.y) * 0.12;
  }
}

export class EyesScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rig = new THREE.Group();
  private glasses = new THREE.Group();
  private eyes: Eye[] = [];
  private timer = new THREE.Timer();
  private raf = 0;
  private visible = true;
  private disposed = false;
  private shield = 0;
  private shieldTarget = 0;
  private pointer = new THREE.Vector2(0, 0);
  private hasPointer = false;
  private lastPointerAt = 0;
  private idleTarget = new THREE.Vector2();
  private nextSaccade = 0;
  private blinkT = -1;
  private nextBlink = 1.6;
  private io?: IntersectionObserver;
  private ro?: ResizeObserver;
  private reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private compact: boolean;

  constructor(private host: HTMLElement, opts: Opts = {}) {
    this.compact = !!opts.compact;
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: this.compact ? "low-power" : "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.compact ? 1.5 : 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = !this.compact;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    if (!opts.transparent) renderer.setClearColor(BRAND.violet, 1);
    else renderer.setClearColor(0x000000, 0);
    this.renderer = renderer;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    this.camera.position.set(0, 0.2, 12.5);
    this.camera.lookAt(0, 0, 0);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = env;
    pmrem.dispose();

    const mats = {
      eye: new THREE.MeshPhysicalMaterial({
        color: BRAND.eyeWhite,
        roughness: 0.32,
        clearcoat: 0.55,
        clearcoatRoughness: 0.25,
        sheen: 0.4,
        sheenColor: new THREE.Color(0xffffff),
        envMapIntensity: 0.7,
      }),
      lid: new THREE.MeshPhysicalMaterial({
        color: BRAND.lid,
        roughness: 0.42,
        clearcoat: 0.3,
        side: THREE.DoubleSide,
        envMapIntensity: 0.6,
      }),
      lidRim: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.35, envMapIntensity: 0.6 }),
      pupil: new THREE.MeshPhysicalMaterial({
        color: BRAND.pupil,
        roughness: 0.3,
        clearcoat: 0.6,
        clearcoatRoughness: 0.35,
        envMapIntensity: 0.5,
      }),
      glint: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    };

    for (const side of [-1, 1] as const) {
      const e = new Eye(side, mats);
      this.eyes.push(e);
      this.rig.add(e.root);
    }

    this.buildGlasses();
    this.rig.add(this.glasses);
    this.scene.add(this.rig);

    // light: a soft key from the upper left, violet bounce from below
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6a10d8, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-2.6, 5.5, 11);
    key.castShadow = !this.compact;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -5;
    key.shadow.camera.right = 5;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -4;
    key.shadow.radius = 16;
    key.shadow.blurSamples = 24;
    key.shadow.bias = -0.0004;
    this.scene.add(key);
    const rim = new THREE.PointLight(0xb070ff, 30, 30, 2);
    rim.position.set(3.5, -3, -2);
    this.scene.add(rim);

    if (!this.compact) {
      const catcher = new THREE.Mesh(
        new THREE.PlaneGeometry(30, 20),
        new THREE.ShadowMaterial({ color: 0x2a0060, opacity: 0.2 }),
      );
      catcher.position.z = -1.6;
      catcher.receiveShadow = true;
      this.scene.add(catcher);
    }

    this.shield = this.shieldTarget = opts.shielded ? 1 : 0;
    this.applyShield(this.shield);

    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible) this.start();
    });
    this.io.observe(host);
    window.addEventListener("pointermove", this.onPointer, { passive: true });
    if (import.meta.env.DEV) (window as unknown as { __eyes?: EyesScene[] }).__eyes = [...((window as unknown as { __eyes?: EyesScene[] }).__eyes ?? []), this];
    this.start();
  }

  private buildGlasses() {
    const frameMat = new THREE.MeshPhysicalMaterial({
      color: BRAND.frame,
      roughness: 0.26,
      clearcoat: 0.9,
      clearcoatRoughness: 0.18,
      envMapIntensity: 0.75,
    });
    const lensMat = new THREE.MeshPhysicalMaterial({
      color: 0x7a6c9a,
      map: lensTexture(),
      roughness: 0.05,
      metalness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      envMapIntensity: 1.1,
      transparent: true,
      opacity: 0.96,
    });

    const LX = 1.12;
    const outer: [number, number][] = [
      [-2.24, 0.76],
      [2.24, 0.76],
      [2.16, 0.3],
      [1.86, -0.66],
      [0.4, -0.66],
      [0.2, -0.1],
      [-0.2, -0.1],
      [-0.4, -0.66],
      [-1.86, -0.66],
      [-2.16, 0.3],
    ];
    const frameShape = new THREE.Shape();
    roundedPath(frameShape, outer, [0.18, 0.18, 0.2, 0.32, 0.3, 0.2, 0.2, 0.3, 0.32, 0.2]);
    for (const side of [-1, 1] as const) {
      const hole = new THREE.Path();
      roundedPath(hole, lensPoints(side, side * LX), 0.2);
      frameShape.holes.push(hole);
    }
    const frameGeo = new THREE.ExtrudeGeometry(frameShape, {
      depth: 0.16,
      bevelEnabled: true,
      bevelThickness: 0.06,
      bevelSize: 0.05,
      bevelSegments: 6,
      curveSegments: 18,
    });
    frameGeo.translate(0, 0, -0.08);
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.castShadow = true;
    this.glasses.add(frame);

    for (const side of [-1, 1] as const) {
      const ls = new THREE.Shape();
      roundedPath(ls, lensPoints(side, side * LX), 0.2);
      const lg = new THREE.ExtrudeGeometry(ls, {
        depth: 0.05,
        bevelEnabled: true,
        bevelThickness: 0.02,
        bevelSize: 0.06,
        bevelSegments: 3,
        curveSegments: 18,
      });
      remapUV(lg);
      lg.translate(0, 0, -0.02);
      const lens = new THREE.Mesh(lg, lensMat);
      lens.castShadow = true;
      this.glasses.add(lens);

      // temple arm running back toward the "ears"
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.15, 2.6), frameMat);
      arm.position.set(side * 2.14, 0.5, -1.35);
      arm.rotation.y = side * 0.08;
      arm.castShadow = true;
      this.glasses.add(arm);
    }
    this.glasses.rotation.z = -0.055;
  }

  /** 0 = glasses slipped down (peeking), 1 = glasses on. */
  setShield(t: number) {
    this.shieldTarget = THREE.MathUtils.clamp(t, 0, 1);
    this.start();
  }

  /** Point the eyes at a screen position (client coords). */
  lookAtClient(x: number, y: number) {
    const r = this.host.getBoundingClientRect();
    const nx = ((x - (r.left + r.width / 2)) / Math.max(window.innerWidth * 0.5, 1)) * 1.1;
    const ny = -((y - (r.top + r.height / 2)) / Math.max(window.innerHeight * 0.5, 1)) * 1.1;
    // never look so far down that the pupils vanish behind the lids and glasses
    this.pointer.set(THREE.MathUtils.clamp(nx, -1, 1), THREE.MathUtils.clamp(ny, -0.35, 0.9));
    this.hasPointer = true;
    this.lastPointerAt = performance.now();
  }

  blink() {
    if (this.blinkT < 0) this.blinkT = 0;
  }

  private onPointer = (e: PointerEvent) => this.lookAtClient(e.clientX, e.clientY);

  private applyShield(s: number) {
    const e = s * s * (3 - 2 * s);
    this.glasses.position.set(0, THREE.MathUtils.lerp(-0.86, EYE_Y - 0.02, e), THREE.MathUtils.lerp(1.22, 1.32, e));
    this.glasses.rotation.x = THREE.MathUtils.lerp(0.16, 0.02, e);
    this.glasses.rotation.z = THREE.MathUtils.lerp(-0.07, -0.015, e);
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // keep the whole face in frame on tall, narrow screens
    const fitW = 6.4 / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect);
    this.camera.position.z = Math.max(12.5, fitW + 2);
    this.camera.updateProjectionMatrix();
    this.renderOnce();
  }

  private start() {
    if (this.raf || this.disposed || !this.visible) return;
    this.timer.update();
    // after a pause, don't open with an overdue blink
    this.nextBlink = Math.max(this.nextBlink, this.timer.getElapsed() + 1.2 + Math.random() * 1.5);
    this.raf = requestAnimationFrame(this.tick);
  }

  private renderOnce() {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  }

  private tick = () => {
    this.raf = 0;
    if (this.disposed || !this.visible) return;
    this.timer.update();
    const rawDt = this.timer.getDelta();
    const dt = Math.min(rawDt, 0.05);
    const t = this.timer.getElapsed();
    // coming back from a hidden tab: let the eyes open first
    if (rawDt > 0.5) this.nextBlink = Math.max(this.nextBlink, t + 1.2 + Math.random() * 1.5);

    // gaze: follow the pointer, wander when it goes quiet
    const idle = !this.hasPointer || performance.now() - this.lastPointerAt > 2600;
    if (idle && t > this.nextSaccade) {
      const glance = Math.random();
      this.idleTarget.set(
        glance < 0.35 ? -0.85 : glance < 0.7 ? 0.85 : (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.3) * 0.5,
      );
      this.nextSaccade = t + 0.9 + Math.random() * 2.2;
    }
    const g = idle ? this.idleTarget : this.pointer;

    // blinking
    if (!this.reduced && t > this.nextBlink && this.blinkT < 0) {
      this.blinkT = 0;
      this.nextBlink = t + 2.4 + Math.random() * 3.8;
    }
    let blink = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const d = 0.16;
      blink = this.blinkT < d ? this.blinkT / d : Math.max(0, 1 - (this.blinkT - d) / d);
      if (this.blinkT > d * 2) this.blinkT = -1;
    }

    for (const e of this.eyes) {
      e.look(g.x, g.y);
      e.update(dt, blink);
    }

    const ks = 1 - Math.exp(-dt * 6);
    this.shield += (this.shieldTarget - this.shield) * ks;
    if (Math.abs(this.shieldTarget - this.shield) < 0.0005) this.shield = this.shieldTarget;
    this.applyShield(this.shield);

    const bob = this.reduced ? 0 : Math.sin(t * 1.1) * 0.06;
    this.rig.position.y = bob;
    const tiltK = 1 - Math.exp(-dt * 3);
    this.rig.rotation.y += (g.x * 0.22 - this.rig.rotation.y) * tiltK;
    this.rig.rotation.x += (-g.y * 0.12 - this.rig.rotation.x) * tiltK;

    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.tick);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("pointermove", this.onPointer);
    this.io?.disconnect();
    this.ro?.disconnect();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
