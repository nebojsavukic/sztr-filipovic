/* ==========================================================================
   SZTR FILIPOVIĆ — script.js  (FINAL)
   --------------------------------------------------------------------------
   ARCHITECTURE

   ONE WebGL context. ONE renderer. ONE render loop. ONE camera.
   The four screens are four "rooms" stacked on the Y axis inside a single
   scene; scrolling flies the camera between them. Only the active room is
   ever visible, so draw calls stay flat no matter how far you scroll.

   MODULE MAP
     CONFIG      – every tunable number, in one place
     Quality     – device tier detection (particles, DPR, AA, filtering)
     Textures    – procedural wire-mesh + grass fallback
     Stage       – renderer, scene, camera, lights, resize, RAF loop,
                   adaptive performance governor
     Fence       – GLB loading with a guaranteed procedural fallback
     Rooms       – builds the four scene groups
     WireMorph   – GPU vertex-shader particle morph (panel -> wire coil)
     GrassVideo  – HTML5 VideoTexture pipeline (Higgsfield neural loop)
     Choreo      – all GSAP / ScrollTrigger timelines
     UI          – mode switcher, form, map, section rail

   REVISION NOTES
   [3D]   Grass plane resized 4.4x1.9 -> 4.15x1.65 and moved to z=+0.01 so
          it seats INSIDE the fence frame instead of overhanging it.
   [3D]   GrassVideo.hide() rebuilt: it existed, but fired instantly with no
          animation, which is why switching modes looked broken. It now
          collapses on a GSAP tween and pauses the video decoder.
   [3D]   Wire texture 512 -> 1024, anisotropy up to 16, trilinear mipmapping
          on. Fixes the fuzzy/moire look on the mesh at grazing angles.
   [PERF] Explicit mobile tier below the existing low tier, plus a runtime
          FPS governor that drops resolution if a device cannot keep up.
   ========================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* GSAP loads as a classic script tag, so it lives on window. */
const DIAG = window.__SZTR_DIAG || { errors: [] };
DIAG.three = true;   // ako smo stigli dovde, Three.js se uspešno importovao

const { gsap, ScrollTrigger } = window;

/* GSAP stiže preko klasične <script defer> oznake. Ako CDN padne, window.gsap
   je undefined — proveravamo eksplicitno umesto da pucamo na prvom pozivu. */
if (!gsap || !ScrollTrigger) {
  DIAG.gsap = false;
  throw new Error('GSAP nije učitan sa CDN-a. Proverite internet vezu ili blokator reklama.');
}
DIAG.gsap = true;
gsap.registerPlugin(ScrollTrigger);


/* ==========================================================================
   1. CONFIG
   ========================================================================== */
const CONFIG = {
  modelPath: './assets/ograda.glb',

  /* Vertical spacing between rooms. Large enough that no room enters
     another's frustum, small enough to keep float precision comfortable. */
  roomGap: 40,

  /* Reference dimensions of the fence panel. The grass plane is derived
     from these so the two can never drift apart again. */
  panel: { width: 4.2, height: 1.7, centerY: 1.0 },

  /* Camera keyframes, LOCAL to each room (the room's Y offset is added). */
  cam: {
    heroStart: { pos: [0, 0.45, 9.0],   look: [0, 0.45,   0] },
    heroEnd:   { pos: [0, 0.10, -4.5],  look: [0, 0.10, -14] },  // THROUGH the mesh
    story:     { pos: [3.4, 1.35, 7.2], look: [0.2, 0.55, 0] },
    program:   { pos: [0, 0.85, 7.6],   look: [0, 0.55,  0] },
    contact:   { pos: [0, 1.05, 8.6],   look: [0, 0.55,  0] }
  },

  /* Mouse-driven directional light travel, in world units. Small on
     purpose: a believable specular crawl across steel, not a disco. */
  lightTravel: { x: 6, y: 3 },
  lightDamping: 0.055,

  colors: {
    steel:  0xC3CBC7,
    coat:   0x114232,   // RAL 6005
    spark:  0xFF6A1F,
    ground: 0x0B0D0C
  }
};

/* --------------------------------------------------------------------------
   ZVANIČNI PODACI FIRME
   Jedno mesto istine. Ako se broj telefona ili adresa ikada promene,
   menja se samo ovde — forma, mapa i navigacija to same preuzmu.
   (Podaci u index.html su vidljivi tekst i menjaju se tamo.)
   -------------------------------------------------------------------------- */
const CONTACT = {
  name:     'SZTR Filipović',
  phone:    '034 329 833',
  phoneTel: '+38134329833',
  email:    'zorafilipovic123@gmail.com',
  street:   'Borivoja Agatonovića bb',
  city:     '34000 Kragujevac',
  mapQuery: 'Borivoja Agatonovića bb, 34000 Kragujevac, Srbija',
  founded:  2003
};

/* Screen 3 copy. Written for a homeowner, not a site engineer: every line
   answers "what does this do for MY yard", not "what is this made of". */
const MODE_COPY = {
  panel: 'Najčešći izbor za dvorišta i kuće. Zeleni plastificirani panel koji ne rđa, ' +
         'lepo izgleda sa obe strane i ne traži nikakvo održavanje — postavite ga i zaboravite.',
  wire:  'Najpovoljnije rešenje za veće placeve, njive i voćnjake. Pocinkovana žica ' +
         'izdrži decenijama na otvorenom, a postavljamo je brzo — obično za jedan dan.',
  grass: 'Savršen hlad i privatnost. Komšije više ne gledaju u vaše dvorište, ' +
         'bez zidanja skupih zidova. Provlači se kroz postojeću žicu, bez ikakvih građevinskih radova.'
};

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;


/* ==========================================================================
   2. QUALITY — device tier
   --------------------------------------------------------------------------
   A budget laptop or a mid-range phone is not directly detectable, so we
   infer it from the signals the browser actually gives us: core count,
   memory, coarse pointer, and the GPU string. Everything expensive
   downstream reads from here.

   Three tiers, not two. A phone is a genuinely different budget from a
   cheap laptop: it has a very high DPR, a much weaker fill rate, and it
   throttles hard once it gets warm.
   ========================================================================== */
const Quality = (() => {
  const cores   = navigator.hardwareConcurrency || 4;
  const memory  = navigator.deviceMemory || 4;             // GB, Chromium only
  const coarse  = window.matchMedia('(pointer: coarse)').matches;
  const isPhone = coarse && Math.min(window.innerWidth, window.innerHeight) < 820;

  let integrated = false;
  let maxAnisotropy = 4;
  try {
    const probe = document.createElement('canvas').getContext('webgl');
    const ext = probe && probe.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(probe.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    integrated = /Intel|Iris|UHD|HD Graphics|Mali|Adreno|PowerVR|Apple GPU|SwiftShader|llvmpipe/i.test(name);
    const aniso = probe && probe.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) maxAnisotropy = probe.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    probe?.getExtension('WEBGL_lose_context')?.loseContext();   // free the probe
  } catch (e) { /* probing is best-effort; never let it break boot */ }

  const isLow = isPhone || cores <= 4 || memory <= 4 || integrated;
  const tier = isPhone ? 'mobile' : (isLow ? 'low' : 'high');

  /* DPR is the single biggest fill-rate lever there is. Phones ship
     DPR 3+; rendering the full 3x buffer is what makes a handset stutter
     and get hot. 1.25 on a phone screen is visually near-identical. */
  const dprCap = isPhone ? 1.25 : (isLow ? 1.5 : 2);

  return {
    tier,
    isLow,
    isPhone,
    maxAnisotropy,
    pixelRatio: Math.min(window.devicePixelRatio || 1, dprCap),
    dprCap,
    /* MSAA off on phones only: at DPR 1.25+ on a small panel the aliasing
       is invisible, and the multisample buffer costs real bandwidth. */
    antialias: !isPhone,
    particles: isPhone ? 6000 : (isLow ? 9000 : 24000),
    /* Trilinear mipmapping needs anisotropy to look right at grazing
       angles; this is what stops the wire mesh going fuzzy. */
    anisotropy: Math.min(isLow ? 4 : 16, maxAnisotropy)
  };
})();


/* ==========================================================================
   3. TEXTURES — generated at runtime, zero network requests
   ========================================================================== */
const Textures = {
  _cache: {},

  /* Wire-mesh alpha map. One canvas replaces thousands of cylinder
     polygons: a panel becomes 2 triangles with an alphaTest cutout.
     alphaTest (not transparent:true) means no depth sorting and no
     blending cost — critical when fill rate is the bottleneck.

     RESOLUTION: 1024 (was 512). At 512 the wires were roughly 3 screen
     pixels wide at the hero distance, which is exactly the range where
     bilinear filtering turns a thin line into grey mush.  */
  wireMesh() {
    if (this._cache.wire) return this._cache.wire;

    const S = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#000';           // black = cut away
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = '#fff';         // white = solid wire
    ctx.lineWidth = 13;               // scaled 1:1 with the doubled canvas
    ctx.lineCap = 'square';

    const cells = 8, step = S / cells;
    ctx.beginPath();
    for (let i = 0; i <= cells; i++) {
      const p = i * step;
      ctx.moveTo(p, 0); ctx.lineTo(p, S);   // vertical wires
      ctx.moveTo(0, p); ctx.lineTo(S, p);   // horizontal wires
    }
    ctx.stroke();

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;

    /* THE SHARPNESS FIX
       - generateMipmaps + LinearMipmapLinearFilter = trilinear. Without
         mipmaps a thin wire aliases into shimmering noise the moment the
         camera moves; with them alone it goes blurry at an angle.
       - anisotropy is what recovers the detail at grazing angles, which
         is precisely how you see a fence in the hero fly-through. */
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = Quality.anisotropy;
    tex.needsUpdate = true;

    this._cache.wire = tex;
    return tex;
  },

  /* Fallback for PVC Trava when the Higgsfield MP4 is absent.
     Deliberately painted rather than photographic — an obviously stylised
     placeholder reads better than a broken black plane. */
  grassFallback() {
    if (this._cache.grass) return this._cache.grass;

    const W = 256, H = 256;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1c4a2c');
    bg.addColorStop(1, '#0d2617');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < 900; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const h = 8 + Math.random() * 22;
      ctx.strokeStyle = 'hsl(' + (95 + Math.random() * 35) + ', ' +
                        (35 + Math.random() * 30) + '%, ' +
                        (18 + Math.random() * 26) + '%)';
      ctx.lineWidth = 1 + Math.random() * 1.6;
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.quadraticCurveTo(x + (Math.random() - 0.5) * 9, y + h * 0.5,
                           x + (Math.random() - 0.5) * 14, y);
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Quality.anisotropy;
    this._cache.grass = tex;
    return tex;
  }
};


/* ==========================================================================
   4. STAGE — renderer, scene, camera, lights, loop, perf governor
   ========================================================================== */
const Stage = {
  renderer: null, scene: null, camera: null,
  dirLight: null, envTexture: null,

  camTarget: new THREE.Vector3(),
  _clock: new THREE.Clock(),
  _pointer: { x: 0, y: 0 },
  _lightGoal: new THREE.Vector3(),
  _updaters: [],

  /* Adaptive governor state */
  _dpr: Quality.pixelRatio,
  _frames: 0,
  _elapsed: 0,
  _downgrades: 0,

  init() {
    const canvas = document.getElementById('webgl');

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: Quality.antialias,
      alpha: true,
      powerPreference: 'high-performance',
      stencil: false,        // unused -> do not allocate the buffer
      depth: true
    });
    this.renderer.setPixelRatio(this._dpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = false;   // a shadow map is an entire
                                               // extra scene pass per light.
                                               // Contact shading is faked
                                               // with a gradient quad.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(CONFIG.colors.ground, 12, 34);

    this.camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 120);
    this.camera.position.set(...CONFIG.cam.heroStart.pos);
    this.camTarget.set(...CONFIG.cam.heroStart.look);

    this._setupLights();
    this._bindEvents();

    /* setAnimationLoop, not requestAnimationFrame: it is XR-safe and the
       browser throttles it automatically when the tab is hidden. */
    this.renderer.setAnimationLoop(() => this._tick());
  },

  /* ------------------------------------------------------------------
     LIGHTING — efficient light types only.

     A HemisphereLight costs one dot product per fragment and supplies the
     sky/ground bounce that sells outdoor metal. One DirectionalLight gives
     the moving specular. The reflections themselves come from a PMREM
     environment baked ONCE at boot — after that it is a free cubemap
     lookup, whereas extra point or area lights cost per-fragment work on
     every frame, forever.

     Total: 2 real-time lights, 0 shadow maps.
     ------------------------------------------------------------------ */
  _setupLights() {
    const hemi = new THREE.HemisphereLight(0x9fb3c8, 0x0B0D0C, 1.25);
    this.scene.add(hemi);

    this.dirLight = new THREE.DirectionalLight(0xffffff, 2.1);
    this.dirLight.position.set(4, 6, 5);
    this.scene.add(this.dirLight);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;
    pmrem.dispose();          // the generator is one-shot; free it at once
  },

  _bindEvents() {
    /* Resize is debounced. Reallocating the drawing buffer mid-drag is
       what causes the "frozen window" feeling on weak GPUs.
       On phones we also ignore height-only changes: the browser toolbar
       collapsing on scroll fires resize constantly, and reacting to it
       would rebuild the buffer several times per swipe. */
    let resizeTimer;
    let lastW = window.innerWidth;
    window.addEventListener('resize', () => {
      if (Quality.isPhone && window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this._resize(), 150);
    });

    /* Pointer -> light goal. We only store the value here; the lerp runs
       in the render loop, so a 1000 Hz mouse cannot generate 1000 scene
       updates per second. Skipped entirely on touch devices. */
    if (!Quality.isPhone) {
      window.addEventListener('pointermove', (e) => {
        this._pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
        this._pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
      }, { passive: true });
    }
  },

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this._dpr);
    this.renderer.setSize(w, h);
    ScrollTrigger.refresh();
  },

  onUpdate(fn) { this._updaters.push(fn); },

  /* ------------------------------------------------------------------
     PERFORMANCE GOVERNOR
     Static tier detection is a guess. This measures the truth: if the
     device sustains under 40 fps across a full second, drop resolution a
     step. Two steps maximum, so it can never degrade into a blurry mess.
     This is what stops a warm, throttled phone from stuttering.
     ------------------------------------------------------------------ */
  _govern(dt) {
    if (this._downgrades >= 2) return;
    this._frames++;
    this._elapsed += dt;
    if (this._elapsed < 1) return;

    const fps = this._frames / this._elapsed;
    this._frames = 0;
    this._elapsed = 0;

    if (fps < 40 && this._dpr > 0.85) {
      this._dpr = Math.max(0.85, this._dpr - 0.3);
      this._downgrades++;
      this.renderer.setPixelRatio(this._dpr);
      console.info('[SZTR] Performanse: rezolucija spuštena na DPR ' + this._dpr.toFixed(2) +
                   ' (izmereno ' + fps.toFixed(0) + ' fps)');
    }
  },

  _tick() {
    const dt = Math.min(this._clock.getDelta(), 0.05);   // clamp after tab-out

    /* Directional light follows the pointer, offset into whichever room
       the camera currently occupies, so the highlight tracks the model
       that is actually on screen. */
    this._lightGoal.set(
      this._pointer.x * CONFIG.lightTravel.x + 3,
      this._pointer.y * CONFIG.lightTravel.y + 6,
      5
    );
    this._lightGoal.y += this.camera.position.y;
    this.dirLight.position.lerp(this._lightGoal, CONFIG.lightDamping);
    this.dirLight.target.position.set(0, this.camera.position.y, 0);
    this.dirLight.target.updateMatrixWorld();

    this.camera.lookAt(this.camTarget);

    for (let i = 0; i < this._updaters.length; i++) this._updaters[i](dt);

    this.renderer.render(this.scene, this.camera);
    this._govern(dt);
  }
};


/* ==========================================================================
   5. FENCE — GLB with a guaranteed procedural fallback
   --------------------------------------------------------------------------
   The site must never show an empty screen because a path was wrong. If
   assets/ograda.glb loads we normalise and use it; if not we build an
   equivalent fence from primitives and nothing downstream can tell.
   ========================================================================== */
const Fence = {
  template: null,
  usedFallback: false,

  load(onProgress) {
    return new Promise((resolve) => {
      const loader = new GLTFLoader();
      loader.load(
        CONFIG.modelPath,
        (gltf) => {
          DIAG.model = true;
          this.template = this._normalise(gltf.scene);
          resolve(this.template);
        },
        (evt) => { if (evt.total) onProgress(evt.loaded / evt.total); },
        () => {
          DIAG.model = false;
          console.warn('[SZTR] ' + CONFIG.modelPath + ' nije učitan — koristi se proceduralna ograda. ' +
                       'Na GitHub Pages proverite MALA/VELIKA slova u nazivu foldera i fajla!');
          this.usedFallback = true;
          this.template = this._buildProcedural();
          resolve(this.template);
        }
      );
    });
  },

  /* Centre horizontally, sit the base on y=0, scale to a known width.
     Exported GLBs are routinely in millimetres or offset from origin;
     normalising here keeps every camera number above valid. */
  _normalise(root) {
    const group = new THREE.Group();
    group.add(root);

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const scale = CONFIG.panel.width / Math.max(size.x, 0.0001);

    root.position.sub(centre);
    root.position.y += size.y / 2;
    group.scale.setScalar(scale);

    root.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = child.receiveShadow = false;
      child.frustumCulled = true;

      if (child.material) {
        const m = child.material;
        if ('metalness' in m) m.metalness = 0.85;
        if ('roughness' in m) m.roughness = 0.34;
        if ('envMapIntensity' in m) m.envMapIntensity = 1.15;
        m.side = THREE.DoubleSide;     // required: the camera flies THROUGH it

        /* Apply the same sharpening to any texture the GLB brought with it. */
        ['map', 'alphaMap', 'roughnessMap', 'metalnessMap', 'normalMap'].forEach((slot) => {
          const t = m[slot];
          if (!t) return;
          t.anisotropy = Quality.anisotropy;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.magFilter = THREE.LinearFilter;
          t.generateMipmaps = true;
          t.needsUpdate = true;
        });
      }
    });

    return group;
  },

  _buildProcedural() {
    const group = new THREE.Group();
    const { width, height, centerY } = CONFIG.panel;

    const steel = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.coat, metalness: 0.9, roughness: 0.35, envMapIntensity: 1.2
    });

    const panelMat = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.coat,
      metalness: 0.9,
      roughness: 0.3,
      envMapIntensity: 1.3,
      alphaMap: Textures.wireMesh(),
      /* 0.4 rather than 0.5: with mipmapping on, distant mip levels
         average the wire toward grey, and a 0.5 cut would erode the mesh
         into holes as it recedes. */
      alphaTest: 0.4,
      side: THREE.DoubleSide
    });

    /* Posts as a single InstancedMesh: 4 posts, 1 draw call. */
    const postGeo = new THREE.BoxGeometry(0.09, 2.0, 0.09);
    const posts = new THREE.InstancedMesh(postGeo, steel, 4);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 4; i++) {
      m4.setPosition(-(width / 2) - 0.05 + i * (width / 3), 1.0, 0);
      posts.setMatrixAt(i, m4);
    }
    posts.instanceMatrix.needsUpdate = true;
    group.add(posts);

    /* Panels: 3 planes, alpha-cut into a wire grid. */
    const panelGeo = new THREE.PlaneGeometry(width / 2, height);
    for (let i = 0; i < 3; i++) {
      const panel = new THREE.Mesh(panelGeo, panelMat);
      panel.position.set(-(width / 2) + i * (width / 3) + 0.0, centerY, 0);
      panel.name = 'panel';
      group.add(panel);
    }

    return group;
  },

  /* clone() shares geometry and materials, so four rooms cost one upload.
     Pass true where a room needs its own material instance. */
  instance(uniqueMaterials = false) {
    const copy = this.template.clone(true);
    if (uniqueMaterials) {
      copy.traverse((c) => { if (c.isMesh && c.material) c.material = c.material.clone(); });
    }
    return copy;
  }
};


/* ==========================================================================
   6. ROOMS — one group per screen, stacked on Y
   ========================================================================== */
const Rooms = {
  hero: null, story: null, program: null, contact: null,
  programFence: null,
  storyParts: { post: null, panel: null, impact: null },

  y(index) { return -index * CONFIG.roomGap; },

  build() {
    this.hero    = this._room(0);
    this.story   = this._room(1);
    this.program = this._room(2);
    this.contact = this._room(3);

    /* Room 0 — hero. The camera flies through it. */
    this.hero.add(Fence.instance());

    /* Room 1 — story. Post and panel are separate primitives on purpose:
       it makes the assembly deterministic regardless of how the client's
       GLB happens to name its children. */
    this._buildStory();

    /* Room 2 — programme showcase. Unique materials: this one gets swapped. */
    this.programFence = Fence.instance(true);
    this.program.add(this.programFence);

    /* Room 3 — contact. Auto-rotates. */
    const contactModel = Fence.instance();
    this.contact.add(contactModel);
    Stage.onUpdate((dt) => {
      if (this.contact.visible) contactModel.rotation.y += dt * 0.22;
    });

    [this.hero, this.story, this.program, this.contact].forEach((r) => {
      r.add(this._groundPlane());
      Stage.scene.add(r);
      r.visible = false;
    });
    this.hero.visible = true;
  },

  _room(index) {
    const g = new THREE.Group();
    g.position.y = this.y(index);
    return g;
  },

  /* Fake contact shading: a radial-gradient quad instead of a shadow map.
     One transparent quad versus an entire extra render pass. */
  _groundPlane() {
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.75)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S, S);

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(11, 11),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(c),
        transparent: true, depthWrite: false, opacity: 0.85
      })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0.002;
    return plane;
  },

  _buildStory() {
    const { height, centerY } = CONFIG.panel;

    const steel = new THREE.MeshStandardMaterial({
      color: CONFIG.colors.coat, metalness: 0.9, roughness: 0.33, envMapIntensity: 1.2
    });

    const post = new THREE.Mesh(new THREE.BoxGeometry(0.11, 2.2, 0.11), steel);
    post.position.set(-1.15, 1.1, 0);

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, height),
      new THREE.MeshStandardMaterial({
        color: CONFIG.colors.coat, metalness: 0.9, roughness: 0.3, envMapIntensity: 1.3,
        alphaMap: Textures.wireMesh(), alphaTest: 0.4, side: THREE.DoubleSide
      })
    );
    panel.position.set(0.0, centerY, 0);

    /* Impact ring — expands and fades when the post lands. */
    const impact = new THREE.Mesh(
      new THREE.RingGeometry(0.14, 0.20, 32),
      new THREE.MeshBasicMaterial({
        color: CONFIG.colors.spark, transparent: true, opacity: 0, depthWrite: false
      })
    );
    impact.rotation.x = -Math.PI / 2;
    impact.position.set(-1.15, 0.01, 0);

    this.story.add(post, panel, impact);
    this.storyParts = { post, panel, impact };
  },

  /* Exactly one room is ever drawn. */
  activate(name) {
    this.hero.visible    = (name === 'hero');
    this.story.visible   = (name === 'tradicija');
    this.program.visible = (name === 'program');
    this.contact.visible = (name === 'kontakt');
  }
};


/* ==========================================================================
   7. WIREMORPH — "Pletena Žica"
   --------------------------------------------------------------------------
   The panel dissolves into a vertex cloud and reforms as a rolled coil.
   Both end states are baked into buffer attributes at build time; the
   morph is one uniform. Per frame the CPU increments two floats — all
   interpolation, swirl and roll happen in the vertex shader. That is the
   acceleration: work moved off the JS main thread onto the GPU.
   ========================================================================== */
const WireMorph = {
  points: null,
  material: null,
  progress: { v: 0 },
  _roll: 0,

  build() {
    const N = Quality.particles;
    const start  = new Float32Array(N * 3);   // points ON the fence wires
    const target = new Float32Array(N * 3);   // points ON the coil
    const rand   = new Float32Array(N);

    const W = CONFIG.panel.width;
    const H = CONFIG.panel.height;
    const baseY = CONFIG.panel.centerY - H / 2;
    const VERT = 22, HORZ = 10;

    for (let i = 0; i < N; i++) {
      const i3 = i * 3;

      /* START: distributed along the wire lines of the panel */
      if (i % 2 === 0) {                                  // vertical wire
        const col = Math.floor(Math.random() * VERT) / (VERT - 1);
        start[i3]     = -W / 2 + col * W;
        start[i3 + 1] = baseY + Math.random() * H;
      } else {                                            // horizontal wire
        const row = Math.floor(Math.random() * HORZ) / (HORZ - 1);
        start[i3]     = -W / 2 + Math.random() * W;
        start[i3 + 1] = baseY + row * H;
      }
      start[i3 + 2] = (Math.random() - 0.5) * 0.03;       // slight weave depth

      /* TARGET: a spiral coil on its side, like a roll of mesh */
      const u = i / N;
      const ang = u * Math.PI * 2 * 6;                    // 6 turns
      const r = 0.30 + (ang / (Math.PI * 2)) * 0.085;     // opening spiral
      target[i3]     = (Math.random() - 0.5) * 2.4;       // width of the roll
      target[i3 + 1] = 0.78 + Math.sin(ang) * r;
      target[i3 + 2] = Math.cos(ang) * r;

      rand[i] = Math.random();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(start, 3));
    geo.setAttribute('aTarget',  new THREE.BufferAttribute(target, 3));
    geo.setAttribute('aRandom',  new THREE.BufferAttribute(rand, 1));
    /* The cloud swings well outside its rest bounds mid-swirl, so give it
       a generous manual sphere rather than letting three cull it early. */
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 6);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uProgress: { value: 0 },
        uTime:     { value: 0 },
        uSize:     { value: Quality.isLow ? 20.0 : 26.0 },
        uDpr:      { value: Quality.pixelRatio },
        uColorA:   { value: new THREE.Color(CONFIG.colors.steel) },
        uColorB:   { value: new THREE.Color(CONFIG.colors.spark) }
      },
      vertexShader: [
        'attribute vec3  aTarget;',
        'attribute float aRandom;',
        'uniform float uProgress, uTime, uSize, uDpr;',
        'varying float vMix;',
        'void main() {',
        '  float p = clamp(uProgress, 0.0, 1.0);',
        // Per-particle stagger: the cloud comes apart in waves, not as a block.
        '  float local = clamp((p - aRandom * 0.28) / 0.72, 0.0, 1.0);',
        '  float e = local * local * (3.0 - 2.0 * local);',
        '  vec3 pos = mix(position, aTarget, e);',
        // Swirl peaks halfway and vanishes at both ends, so the fence and
        // the coil are each perfectly clean shapes.
        '  float swirl = sin(p * 3.14159265);',
        '  float a = aRandom * 6.2831853 + uTime * 0.7 + p * 5.0;',
        '  pos.x += cos(a) * swirl * (0.55 + aRandom * 0.85);',
        '  pos.y += sin(a * 1.4) * swirl * (0.35 + aRandom * 0.55);',
        '  pos.z += sin(a) * swirl * (0.55 + aRandom * 0.85);',
        '  vec4 mv = modelViewMatrix * vec4(pos, 1.0);',
        '  gl_Position = projectionMatrix * mv;',
        '  gl_PointSize = uSize * uDpr * (1.0 / max(-mv.z, 0.1));',
        '  vMix = swirl * (0.35 + aRandom * 0.65);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColorA, uColorB;',
        'varying float vMix;',
        'void main() {',
        // Round, soft-edged points. discard beats alpha=0: it skips the
        // blend entirely on fragments we do not want.
        '  vec2 uv = gl_PointCoord - 0.5;',
        '  float d = dot(uv, uv);',
        '  if (d > 0.25) discard;',
        '  float falloff = 1.0 - smoothstep(0.0, 0.25, d);',
        '  vec3 col = mix(uColorA, uColorB, vMix);',
        '  gl_FragColor = vec4(col, falloff * 0.85);',
        '}'
      ].join('\n')
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.visible = false;
    Rooms.program.add(this.points);

    Stage.onUpdate((dt) => {
      if (!this.points.visible) return;
      this.material.uniforms.uTime.value += dt;
      /* Rolling coil. The rotation is scaled BY progress, so at progress 0
         the fence-shaped cloud is guaranteed to sit perfectly upright. */
      this._roll += dt * 0.9;
      this.points.rotation.x = this._roll * this.material.uniforms.uProgress.value;
    });
  },

  show(solidFence) {
    this.points.visible = true;
    gsap.killTweensOf(this.progress);
    gsap.to(this.progress, {
      v: 1, duration: 2.0, ease: 'power2.inOut',
      onStart: () => { solidFence.visible = false; },
      onUpdate: () => { this.material.uniforms.uProgress.value = this.progress.v; }
    });
  },

  hide(solidFence) {
    gsap.killTweensOf(this.progress);
    gsap.to(this.progress, {
      v: 0, duration: 1.5, ease: 'power2.inOut',
      onUpdate: () => { this.material.uniforms.uProgress.value = this.progress.v; },
      onComplete: () => { this.points.visible = false; solidFence.visible = true; }
    });
  }
};


/* ==========================================================================
   8. GRASSVIDEO — "PVC Trava"
   --------------------------------------------------------------------------
   Instancing tens of thousands of grass blades would kill a budget GPU.
   Instead one quad carries a looping video texture of PVC grass woven
   through mesh. Generate that loop with Higgsfield and drop it in at
   assets/higgsfield-trava-loop.mp4 (prompt + encoding in the README).

   GEOMETRY FIX
   The plane was 4.4 x 1.9 against a 4.2 x 1.7 panel, so the grass hung
   over the frame on every side and broke the symmetry. It is now
   4.15 x 1.65 — very slightly INSIDE the frame, leaving a thin margin of
   visible steel all the way round — and sits at z = +0.01, just in front
   of the panel, which is where woven-in grass physically sits.

   0.01 is a deliberate number: far enough to beat z-fighting at this
   depth range (near 0.1 / far 120), close enough that no gap is visible
   at any camera angle the choreography allows.
   ========================================================================== */
const GrassVideo = {
  mesh: null,
  video: null,
  texture: null,
  fallbackTex: null,
  isVideoReady: false,

  /* Derived from the panel so the two can never drift apart again. */
  get size() {
    return { w: CONFIG.panel.width - 0.05, h: CONFIG.panel.height - 0.05 };
  },

  build() {
    this.video = document.getElementById('grass-video');

    this.texture = new THREE.VideoTexture(this.video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;   // video frames have no mipmaps
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.fallbackTex = Textures.grassFallback();
    this.fallbackTex.repeat.set(3, 1);

    const mat = new THREE.MeshBasicMaterial({
      map: this.fallbackTex,
      toneMapped: false,
      transparent: true,
      opacity: 1
    });

    this.video.addEventListener('canplay', () => {
      this.isVideoReady = true;
      mat.map = this.texture;
      mat.needsUpdate = true;
    }, { once: true });

    this.video.addEventListener('error', () => {
      console.warn('[SZTR] Higgsfield video loop nije pronađen — koristi se rezervna tekstura.');
    }, { once: true });

    /* 4.15 x 1.65, seated inside the frame at z = +0.01 */
    const { w, h } = this.size;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    this.mesh.position.set(0, CONFIG.panel.centerY, 0.01);
    this.mesh.visible = false;
    Rooms.program.add(this.mesh);

    /* Gentle drift on the fallback only — the real video loops itself. */
    Stage.onUpdate((dt) => {
      if (this.mesh.visible && !this.isVideoReady) this.fallbackTex.offset.x += dt * 0.012;
    });
  },

  show() {
    gsap.killTweensOf([this.mesh.scale, this.mesh.material]);
    this.mesh.visible = true;
    this.mesh.material.opacity = 0;

    /* Grows from the bottom edge up, as if being threaded into the mesh. */
    gsap.fromTo(this.mesh.scale,
      { y: 0.05, x: 0.9 },
      { y: 1, x: 1, duration: 0.85, ease: 'back.out(1.4)' }
    );
    gsap.to(this.mesh.material, { opacity: 1, duration: 0.5, ease: 'power2.out' });

    /* play() returns a promise that rejects under autoplay policy. The
       element is muted so it should not, but never leak an unhandled
       rejection into the console. */
    this.video.play?.().catch(() => {});
  },

  /* ------------------------------------------------------------------
     hide() — REBUILT

     The previous version flipped .visible to false in a single frame,
     which made switching away from PVC Trava look like the grass was
     stuck or popping. It now collapses on the same curve it grew on, and
     only then leaves the scene.

     Crucially, .visible = false alone does NOT stop the video decoding.
     The <video> element keeps running, burning CPU and battery behind a
     hidden mesh. We pause it explicitly, and rewind to 0 so the next
     reveal starts on a clean first frame instead of mid-loop.
     ------------------------------------------------------------------ */
  hide() {
    gsap.killTweensOf([this.mesh.scale, this.mesh.material]);

    gsap.to(this.mesh.scale, {
      y: 0.05, x: 0.9, duration: 0.5, ease: 'power3.in'
    });

    gsap.to(this.mesh.material, {
      opacity: 0,
      duration: 0.45,
      ease: 'power2.in',
      onComplete: () => {
        this.mesh.visible = false;
        this.mesh.scale.set(1, 1, 1);       // reset for the next show()
        this.mesh.material.opacity = 1;

        /* Stop the decoder. This is the part that actually saves power. */
        if (this.video) {
          this.video.pause?.();
          try { this.video.currentTime = 0; } catch (e) { /* not seekable yet */ }
        }
      }
    });
  }
};


/* ==========================================================================
   9. CHOREO — scroll choreography
   --------------------------------------------------------------------------
   ONE master timeline scrubs the camera through all four rooms. Its
   internal durations are proportional to the section heights in
   index.html (200 / 200 / 150 / 150 vh -> 2 / 2 / 1.5 / 1.5), so scroll
   distance and animation time stay locked together.

   Deliberately NO ScrollTrigger pinning: pinning rewrites layout on every
   tick and is the most common cause of scroll jank on weak hardware. Tall
   sections with sticky children give the same effect, handled entirely by
   the compositor.
   ========================================================================== */
const Choreo = {
  init() {
    this._cameraTimeline();
    this._roomSwitching();
    this._storyAssembly();
    this._heroCopyFade();
  },

  /* Tween camera position + look target to a keyframe in a given room. */
  _to(tl, key, roomIndex, duration, ease = 'none', position = undefined) {
    const k = CONFIG.cam[key];
    const y = Rooms.y(roomIndex);
    tl.to(Stage.camera.position, {
      x: k.pos[0], y: k.pos[1] + y, z: k.pos[2], duration, ease
    }, position)
      .to(Stage.camTarget, {
        x: k.look[0], y: k.look[1] + y, z: k.look[2], duration, ease
      }, '<');   // '<' = start together with the previous tween
  },

  _cameraTimeline() {
    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: '#scroll-content',
        start: 'top top',
        end: 'bottom bottom',
        /* scrub:1 adds a second of catch-up smoothing and acts as a
           natural rate limiter — the camera cannot update more often than
           the GSAP ticker no matter how fast the wheel spins. */
        scrub: prefersReducedMotion ? true : 1,
        invalidateOnRefresh: true
      }
    });

    /* SCREEN 1 — straight through the mesh */
    this._to(tl, 'heroEnd', 0, 2, 'power1.inOut');

    /* -> SCREEN 2 (arrive early, hold while the visitor reads) */
    this._to(tl, 'story', 1, 1.2, 'power2.inOut');
    tl.to({}, { duration: 0.8 });

    /* -> SCREEN 3 */
    this._to(tl, 'program', 2, 0.8, 'power2.inOut');
    tl.to({}, { duration: 0.7 });

    /* -> SCREEN 4 */
    this._to(tl, 'contact', 3, 0.8, 'power2.inOut');
    tl.to({}, { duration: 0.7 });
  },

  /* Show exactly one room, and light the matching rail label. */
  _roomSwitching() {
    ['hero', 'tradicija', 'program', 'kontakt'].forEach((id) => {
      ScrollTrigger.create({
        trigger: '#' + id,
        start: 'top center',
        end: 'bottom center',
        onToggle: (self) => {
          if (!self.isActive) return;
          Rooms.activate(id);
          document.querySelectorAll('.rail-link').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.rail === id);
          });
        }
      });
    });
  },

  /* ------------------------------------------------------------------
     SCREEN 2 — the assembly.

     Elastic easing must NOT be scrubbed. A scrubbed elastic curve
     reverses direction as the visitor scrolls, which reads as a bug. So
     this fires ONCE on entry as a real-time timeline, and resets if the
     visitor scrolls back above it.
     ------------------------------------------------------------------ */
  _storyAssembly() {
    const { post, panel, impact } = Rooms.storyParts;
    let hasPlayed = false;

    const reset = () => {
      gsap.killTweensOf([post.position, panel.position, panel.rotation, impact.scale, impact.material]);
      post.position.y = 4.6;              // hovering above the ground
      panel.position.set(2.6, CONFIG.panel.centerY, 0);
      panel.rotation.y = -0.9;
      panel.visible = false;
      impact.scale.setScalar(1);
      impact.material.opacity = 0;
    };

    const play = () => {
      const tl = gsap.timeline();

      /* 1. The post drops and anchors. power4.in = slow lift, hard landing. */
      tl.to(post.position, { y: 1.1, duration: 0.65, ease: 'power4.in' });

      /* 2. Impact ring on contact. */
      tl.set(impact.scale, { x: 1, y: 1, z: 1 })
        .to(impact.material, { opacity: 0.9, duration: 0.06 }, '<')
        .to(impact.scale, { x: 7, y: 7, z: 7, duration: 0.8, ease: 'power3.out' }, '<')
        .to(impact.material, { opacity: 0, duration: 0.8, ease: 'power2.out' }, '<');

      /* 3. The panel swings in and snaps home. elastic.out(1, 0.55):
            amplitude 1, period 0.55 — enough overshoot to read as sprung
            steel, not enough to feel rubbery. */
      tl.to(panel, { visible: true, duration: 0 }, '-=0.55')
        .to(panel.position, { x: 0, duration: 1.25, ease: 'elastic.out(1, 0.55)' }, '<')
        .to(panel.rotation, { y: 0, duration: 1.1, ease: 'elastic.out(1, 0.6)' }, '<');
    };

    reset();

    ScrollTrigger.create({
      trigger: '#tradicija',
      start: 'top 55%',
      onEnter: () => { if (!hasPlayed) { hasPlayed = true; play(); } },
      onLeaveBack: () => { hasPlayed = false; reset(); }
    });
  },

  /* Fade the hero headline as the camera enters the mesh, so the
     high-contrast text never fights the geometry passing through it. */
  _heroCopyFade() {
    gsap.to('#hero-copy', {
      opacity: 0,
      y: -40,
      ease: 'none',
      scrollTrigger: { trigger: '#hero', start: 'top top', end: '55% top', scrub: true }
    });
  }
};


/* ==========================================================================
   10. UI — mode switcher, form, map
   ========================================================================== */
const UI = {
  init() {
    this._modes();
    this._form();
    this._map();
  },

  /* ---- Screen 3 material switcher ---- */
  _modes() {
    const buttons = document.querySelectorAll('.mode-btn');
    const desc = document.getElementById('program-desc');
    const solidFence = Rooms.programFence;
    let current = 'panel';

    const setMode = (mode) => {
      if (mode === current) return;

      /* Always tear the previous mode down first — never assume state. */
      if (current === 'wire')  WireMorph.hide(solidFence);
      if (current === 'grass') GrassVideo.hide();

      if (mode === 'wire')  WireMorph.show(solidFence);
      if (mode === 'grass') GrassVideo.show();
      if (mode === 'panel') solidFence.visible = true;

      current = mode;

      desc.textContent = MODE_COPY[mode];
      gsap.fromTo(desc, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out' });

      buttons.forEach((b) => {
        const active = b.dataset.mode === mode;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
    };

    buttons.forEach((b) => {
      b.setAttribute('aria-pressed', String(b.classList.contains('is-active')));
      b.addEventListener('click', () => setMode(b.dataset.mode));
    });
  },

  /* ---- Screen 4 quote form ----
     No backend is wired up, so a valid submission opens the visitor's mail
     client pre-filled. To use a real endpoint, replace the mailto block
     with a fetch() to Formspree or your own handler. */
  _form() {
    const form = document.getElementById('quote-form');
    const status = document.getElementById('form-status');

    /* Error text speaks plainly and says what to do, not what failed. */
    const rules = {
      'f-name':   (v) => v.trim().length >= 2         || 'Upišite svoje ime, da znamo kome se javljamo.',
      'f-phone':  (v) => /^[+\d\s()\/-]{6,}$/.test(v) || 'Upišite broj telefona na koji možemo da vas dobijemo.',
      'f-meters': (v) => Number(v) > 0                || 'Upišite otprilike koliko metara vam treba — slobodno na oko.'
    };

    const validateField = (id) => {
      const input = document.getElementById(id);
      const errorEl = document.querySelector('[data-error-for="' + id + '"]');
      const result = rules[id](input.value);
      const ok = result === true;
      input.classList.toggle('is-invalid', !ok);
      input.setAttribute('aria-invalid', String(!ok));
      errorEl.textContent = ok ? '' : result;
      return ok;
    };

    /* Validate on blur, then live once a field has been flagged — the
       least annoying pattern that still catches errors before submit. */
    Object.keys(rules).forEach((id) => {
      const input = document.getElementById(id);
      input.addEventListener('blur', () => validateField(id));
      input.addEventListener('input', () => {
        if (input.classList.contains('is-invalid')) validateField(id);
      });
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const allValid = Object.keys(rules).map(validateField).every(Boolean);

      if (!allValid) {
        status.style.color = '#FF7A5C';
        status.textContent = 'Još samo par podataka — pogledajte označena polja.';
        document.querySelector('.field.is-invalid')?.focus();
        return;
      }

      const data = new FormData(form);
      const body = [
        'Ime: ' + data.get('name'),
        'Telefon: ' + data.get('phone'),
        'Dužina: ' + data.get('meters') + ' m',
        'Napomena: ' + (data.get('note') || '—')
      ].join('\n');

      window.location.href =
        'mailto:' + CONTACT.email + '?subject=' +
        encodeURIComponent('Upit za ponudu — ' + data.get('name')) +
        '&body=' + encodeURIComponent(body);

      status.style.color = '#FF6A1F';
      status.textContent = 'Otvaramo vaš program za poštu. Javljamo se u roku od 24 sata.';
    });
  },

  /* ---- Click-to-load map ----
     Saves roughly 800 KB and a third-party connection until it is wanted.
     The ?output=embed form needs no Google API key and no billing account,
     which is what makes this safe to ship as-is. */
  _map() {
    const slot = document.getElementById('map-slot');
    const button = document.getElementById('map-load');
    if (!slot || !button) return;

    button.addEventListener('click', () => {
      const iframe = document.createElement('iframe');
      iframe.src = 'https://www.google.com/maps?q=' +
                   encodeURIComponent(CONTACT.mapQuery) +
                   '&z=15&hl=sr&output=embed';
      iframe.loading = 'lazy';
      iframe.referrerPolicy = 'no-referrer-when-downgrade';
      iframe.title = 'Lokacija radionice SZTR Filipović — ' + CONTACT.street + ', ' + CONTACT.city;
      iframe.setAttribute('allowfullscreen', '');
      slot.innerHTML = '';
      slot.appendChild(iframe);

      /* Direct link out to full Google Maps navigation, for visitors who
         want turn-by-turn rather than a static preview. */
      const link = document.createElement('a');
      link.href = 'https://www.google.com/maps/dir/?api=1&destination=' +
                  encodeURIComponent(CONTACT.mapQuery);
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'map-directions btn-ghost';
      link.textContent = 'Otvori navigaciju';
      slot.appendChild(link);
    });
  }
};


/* ==========================================================================
   11. BOOT
   ========================================================================== */
const Loader = {
  el: document.getElementById('loader'),
  bar: document.getElementById('loader-bar'),
  pct: document.getElementById('loader-pct'),

  set(p) {
    const v = Math.round(Math.min(p, 1) * 100);
    if (this.bar) this.bar.style.width = v + '%';
    if (this.pct) this.pct.textContent = v + '%';
  },

  finish() {
    this.set(1);
    gsap.to(this.el, {
      opacity: 0, duration: 0.7, delay: 0.25, ease: 'power2.inOut',
      /* Remove, do not merely hide: a full-screen element left in the
         tree still composites on every frame. */
      onComplete: () => this.el.remove()
    });
  }
};

async function boot() {
  Stage.init();

  await Fence.load((p) => Loader.set(p * 0.9));

  Rooms.build();
  WireMorph.build();
  GrassVideo.build();
  Choreo.init();
  UI.init();

  /* Compile shaders before the first visible frame so the fly-through
     does not stutter in its opening milliseconds. */
  Stage.renderer.compile(Stage.scene, Stage.camera);

  ScrollTrigger.refresh();
  Loader.finish();
  DIAG.ready = true;   // gasi watchdog iz bootstrap guard-a u index.html

  console.info(
    '[SZTR] Spremno · tier: ' + Quality.tier +
    ' · DPR: ' + Quality.pixelRatio.toFixed(2) +
    ' · AA: ' + Quality.antialias +
    ' · anizotropija: ' + Quality.anisotropy +
    ' · čestice: ' + Quality.particles +
    ' · model: ' + (Fence.usedFallback ? 'proceduralni fallback' : CONFIG.modelPath)
  );
}

boot().catch((err) => {
  console.error('[SZTR] Greška pri pokretanju:', err);
  Loader.el?.remove();   // never leave the visitor staring at a stuck loader
});
