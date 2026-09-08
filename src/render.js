// Tissue Weather — 3D renderer (EXTENDING.md §4). ES module, named exports only.
// Draws whatever a tissue definition describes: fiber species (oriented rods),
// gel species (translucent haze), scaffold species (dissolving lattice), cell
// types (ellipsoids), diffusible fields (point clouds), load arrows (only when
// the tissue has a dial with role 'load') and the domain cube — three.js r160.
//
// Public API:
//   new TissueRenderer(canvasEl, opts)   opts: see the defaults in the constructor
//   .setTissue(tissue)                   (re)build layers from tissue.species / cellTypes / fields / dials
//   .update(state, layers)               state → instances; layers { fibers, cells, scaffold, gel, wound, fields: { <key>: bool } }
//                                        (fibers/cells/scaffold/gel/wound default on, fields default off)
//   Load arrows read the role:'load' dial through its own [min, max] (cartilage compresses
//   0 … 0.2), so the arrow length/opacity is the NORMALISED value, not the raw one.
//   A cell type's `radius` may be a number or { by: 'a'|'b', min, max } (radius by state).
//   .render()                            one frame (controls damping/autorotate + draw)
//   .resize()                            fit canvas to its parent, keep the cube framed (aspect 0.6 … 2.4)
//   .setAutoRotate(bool)                 fires opts.onAutoRotate(bool) when the value changes
//   .resetView()                         camera back to the default framing (Home key, "Reset view" button)
//   .layoutParams()                      the fiber recipe actually in use → export meta.render (src/recipe.js)
//   .markDirty()                         force the next update() to rebuild (see the dirty check below)
//   .screenshot()                        → PNG data URL of the current frame
//   .legendSwatches()                    → [{ key, kind, label, css }] for the app legend
//   .dispose()
//   .stats                               read-only { updateMs, updates, skipped, fibersVisible, cells, gelVisible, strutsVisible }
//   TissueRenderer.tissueFromState(state) fallback definition when no tissue was set (all species as grey fibers)
//
// Dirty check (docs/REVIEW.md B1). update() rebuilds instance buffers only when something it
// draws changed: it compares `state.revision` (the engine's monotonic counter), N, the cell
// count and the layer set with the last call and returns early otherwise — the load arrows and
// the wound marker (both O(1)) are still refreshed. A state WITHOUT `revision` (tools/
// render_smoke.html, any hand-built state) always takes the full path, so nothing that fed the
// renderer before v0.4 needs to change. stats.updates / stats.skipped count the two paths.
//
// Keyboard (docs/REVIEW.md B2, WCAG 2.1.1). With the canvas focused: ←/→/↑/↓ orbit, +/− dolly,
// Home reframes (resetView). Implemented on camera.position via THREE.Spherical around
// controls.target — OrbitControls' own key support is a no-op with enablePan off and its
// rotateLeft/dollyIn are closure-private in r160. Everything else (Space, R, I, digits) is left
// alone so the app's shortcuts still reach it; any key on the canvas stops auto-rotate, like a
// pointerdown (WCAG 2.2.2), through setAutoRotate → opts.onAutoRotate.
//
// Colour (docs/REVIEW.md E4). The definition's hex IS the colour: fiber/cell/gel saturation
// factors default to 1.0, and legendSwatches() puts each hex through the same exposure and tone
// curve as the GPU (a CPU copy of three's ACES / AgX), so a swatch matches the unlit colour of
// the thing it labels to ≤ 1/255 per channel (tools/render_smoke.mjs asserts it). Scene lighting,
// the rim term and the depth cue are NOT applied — a lit fiber is brighter than its swatch.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RECIPE_FIBER, recipeFiberLayout, recipeFiberScales, recipeFiberRadius, recipeFiberLength, recipeFiberFade, recipeFiberDir, recipeRenderMeta } from './recipe.js';

// Depth cue (Beer–Lambert): path length from an instance centre to the face of
// the unit block along the direction toward the camera. Instances seen deep in
// the block darken; instances on the camera-facing faces stay bright.
const RENDER_GLSL_CUE = `
float tissueDepthCue( vec3 p, vec3 d, float k ) {
  vec3 ad = max( abs( d ), vec3( 1e-4 ) );
  vec3 face = mix( p, 1.0 - p, step( 0.0, d ) );
  vec3 t = face / ad;
  float dist = max( 0.0, min( t.x, min( t.y, t.z ) ) );
  return exp( -k * dist );
}`;

// Soft sprites for diffusible fields and the Points variant of the gel haze.
const RENDER_POINT_VERT = `
attribute float aVal;
attribute vec3 aCol;
uniform float uScale;
uniform float uSize;
uniform float uMinVal;
uniform float uSizePow;
varying float vA;
varying vec3 vCol;
void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  float v = clamp( aVal, 0.0, 1.0 );
  vA = v;
  vCol = aCol;
  float size = ( v < uMinVal ) ? 0.0 : uSize * ( 0.35 + 0.65 * pow( v, uSizePow ) );
  gl_PointSize = clamp( size * uScale / max( -mv.z, 0.05 ), 0.0, 220.0 );
  gl_Position = projectionMatrix * mv;
}`;

const RENDER_POINT_FRAG = `
uniform float uOpacity;
uniform float uSoft;
varying float vA;
varying vec3 vCol;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float soft = exp( -dot( q, q ) * uSoft ) * smoothstep( 0.5, 0.42, length( q ) );
  float a = soft * uOpacity * ( 0.2 + 0.8 * vA );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( vCol, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Translucent instanced material for gel spheres and scaffold struts: per-instance
// colour + alpha, view-angle edge fade (soft blobs), flat low-contrast lighting,
// depth cue, fog. Normals are transformed by mat3(instanceMatrix): exact for the
// uniform scale of spheres and for the radial/axial normals of axis-scaled cylinders.
const RENDER_HAZE_VERT = `
attribute float aAlpha;
uniform vec3 uCamDir;
uniform float uDepthCue;
varying float vAlpha;
varying vec3 vCol;
varying vec3 vNrm;
varying vec3 vToCam;
varying float vCue;
#include <common>
#include <fog_pars_vertex>
${RENDER_GLSL_CUE}
void main() {
  mat4 im = modelMatrix * instanceMatrix;
  vec4 wp = im * vec4( position, 1.0 );
  vNrm = normalize( mat3( im ) * normal );
  vToCam = cameraPosition - wp.xyz;
  vAlpha = aAlpha;
  vCol = instanceColor;
  vCue = tissueDepthCue( im[3].xyz, uCamDir, uDepthCue );
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const RENDER_HAZE_FRAG = `
uniform float uOpacity;
uniform float uEdgeFade;
uniform vec3 uLightDir;
uniform float uAmbient;
uniform float uDiffuse;
uniform float uRim;
varying float vAlpha;
varying vec3 vCol;
varying vec3 vNrm;
varying vec3 vToCam;
varying float vCue;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec3 n = normalize( vNrm );
  vec3 v = normalize( vToCam );
  float ndv = saturate( abs( dot( n, v ) ) );
  float a = vAlpha * uOpacity * pow( ndv, uEdgeFade );
  if ( a < 0.003 ) discard;
  float ndl = saturate( dot( n, uLightDir ) );
  float rim = pow( 1.0 - ndv, 2.0 ) * uRim;
  vec3 col = vCol * ( uAmbient + uDiffuse * ndl + rim ) * vCue;
  gl_FragColor = vec4( col, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const RENDER_EMPTY = Object.freeze({});
const RENDER_LUT_N = 33;

export class TissueRenderer {
  constructor(canvasEl, opts = {}) {
    this.canvas = canvasEl;
    const reduced = (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
    this._optSet = new Set(Object.keys(opts));   // which opts the caller passed explicitly
    this.opts = Object.assign({
      K: RECIPE_FIBER.K,    // fiber instances per voxel
      maxCells: 512,        // initial cell instance capacity (grows on demand)
      maxPixelRatio: 1.5,   // start at min(dpr, 1.5) — MSAA at dpr 2 costs more than it shows (REVIEW §5); pass 2 to opt out
      seed: RECIPE_FIBER.seed,
      autoRotate: undefined, // default: on, unless prefers-reduced-motion matches (explicit true/false overrides)
      autoRotateSpeed: 0.5, // OrbitControls units: 2.0 = 30 s per orbit
      onAutoRotate: null,   // (on: boolean) => void, called by setAutoRotate when the value changes
      keyOrbitStep: Math.PI / 24,  // radians per arrow key press
      keyDollyStep: 1.12,   // distance factor per +/− press
      background: 0x0b0f14,
      fov: 36,
      cameraDistance: 2.75, // framing distance at aspect ≥ 0.87; resize() scales it for narrow viewports
      toneMapping: 'aces',
      exposure: 1.0,
      fogDepth: 2.8,        // fog fully in at (camera distance + fogDepth); smaller = stronger depth cue
      depthCue: 0.55,       // Beer–Lambert darkening per unit path length into the block (0 = off)
      // --- fibers (v0.1 look; the layout and the laws live in src/recipe.js) ---
      minRho: RECIPE_FIBER.minDensity,             // full-strength fibers at or above this total fiber density
      minRhoRamp: RECIPE_FIBER.minDensityRamp,     // fade in from minRho × this instead of popping in (1 = v0.1 hard cut)
      fiberRadiusScale: RECIPE_FIBER.radiusScale,  // × SPEC radius 0.12 h sqrt(rho)
      fiberLengthScale: RECIPE_FIBER.lengthScale,  // × SPEC length h (0.5 + 0.9 FA)
      fiberMinRadius: RECIPE_FIBER.minRadius,      // × h, floor so sparse fibers stay visible hairlines
      fiberShape: 'cylinder', // 'cylinder' | 'capsule'
      fiberRoughness: 0.5, fiberEmissive: 0.2, fiberRim: 0.5,
      fiberAlbedo: 1.0, fiberSaturation: 1.0,      // 1.0: the definition hex is the colour (REVIEW E4)
      // --- cells ---
      cellRoughness: 0.55, cellEmissive: 0.35, cellRim: 0.45,
      cellRimGel: 1.05,       // rim strength used instead of cellRim when the tissue has a gel species
      cellRimTint: 0.7,       // 0 = the rim takes the cell's own colour, 1 = a white rim (contrast against a same-hue haze)
      cellAlbedo: 0.55, cellSaturation: 1.0,
      cellRamp: 'oklab',      // 'oklab' | 'oklch' | 'rgb' — interpolation space for colors[0] → colors[1]
      cellMidLift: 0.06,      // OKLab lightness lift at the ramp midpoint (bell-shaped), 0 = none
      cellColorMid: '#f1e3d3', // explicit mid colour the ramp passes through (OKLab, piecewise); null = straight OKLab lerp (+lift)
      cellAspectExp: 0.8,     // long semi-axis = r·A^exp, short = r·A^(exp-1)  (A = aspect from shape)
      // --- gel haze ---
      gelStyle: 'spheres',    // 'spheres' | 'points'
      gelMin: 0.02,           // hide below this density
      gelSize: 0.62,          // sphere radius = gelSize · h · density^(1/3) (≈ overlapping neighbours at density 1)
      gelOpacity: 0.28,       // × min(1, density)
      gelEdgeFade: 1.6,       // alpha ∝ |n·v|^fade — softens silhouettes into a haze
      gelCellFade: 0.55,      // gel alpha × (1 − this) in a voxel that holds a cell (≈ one cell radius: cells keep contrast in dense gel)
      gelAmbient: 0.62, gelDiffuse: 0.22, gelRim: 0.0,
      gelSaturation: 1.0,
      gelPointSize: 2.6, gelPointOpacity: 0.5, gelPointSoft: 6.0,
      // --- scaffold lattice ---
      scaffoldMin: 0.025,     // hide struts below this density
      scaffoldRadius: 0.075,  // × h at density 1
      scaffoldMinRadius: 0.018, // × h
      scaffoldOpacity: 0.9,   // × density^scaffoldAlphaExp
      scaffoldAlphaExp: 0.6,
      scaffoldRadiusExp: 0.5,
      scaffoldBreak: 0.4,     // below this density struts shorten about their midpoint (lattice fragments); 0 = off
      scaffoldAmbient: 0.55, scaffoldDiffuse: 0.55, scaffoldRim: 0.25, scaffoldEdgeFade: 0.0,
      scaffoldSaturation: 1.0,
      // --- lights / fields / misc ---
      keyIntensity: 1.6, fillIntensity: 0.3, hemiIntensity: 0.55,
      keyColor: 0xfff1dc, fillColor: 0x8fb0ff, hemiSky: 0xc9d6ea, hemiGround: 0x3a2a1c,
      pointBlending: 'normal', // 'normal' | 'additive'
      pointOpacity: 0.45, pointSize: 1.8, // field point clouds (size × h)
      wireColor: 0x4a5a70,
      loadColor: '#d9c9a3',
      // --- wound marker (state.wound; hidden when the state has none) ---
      woundColor: '#ff8f7a',
      woundOpacity: 0.15,     // persistent outline: the wound stays marked after it has healed
      woundOpacityPeak: 0.55, // extra opacity right after the injury …
      woundFadeDays: 7,       // … decaying with this time constant (opacity = 0.15 + 0.55·e^(−age/7))
      woundGhost: 0.35,       // × that opacity, drawn again without depth test so the outline reads
                              // through the matrix in front of it (0 = only the occluded version)
      woundMeridians: 6, woundRings: 3, woundSegments: 48,
    }, opts);
    if (this.opts.autoRotate === undefined) this.opts.autoRotate = !reduced;
    this.stats = { updateMs: 0, updates: 0, skipped: 0, fibersVisible: 0, cells: 0, gelVisible: 0, strutsVisible: 0 };
    this._disposed = false;
    this.tissue = null;
    // dirty check (B1): last (revision, N, cell count, layer key) fed to the full update path
    this._dirty = true; this._lastRev = undefined; this._lastKey = -1; this._lastN = -1; this._lastCells = -1;

    // --- renderer -----------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({
      canvas: canvasEl, antialias: true, alpha: false, stencil: false,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const tm = this.opts.toneMapping;
    renderer.toneMapping = tm === 'none' ? THREE.NoToneMapping
      : tm === 'agx' ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.opts.exposure;
    this.renderer = renderer;

    // --- scene, camera (z is the load axis, so z is "up") -------------------
    const scene = new THREE.Scene();
    const bg = new THREE.Color(this.opts.background);
    scene.background = bg;
    scene.fog = new THREE.Fog(bg.getHex(), 2.4, 5.2);
    this.scene = scene;
    this.center = new THREE.Vector3(0.5, 0.5, 0.5);

    const camera = new THREE.PerspectiveCamera(this.opts.fov, 1, 0.05, 40);
    camera.up.set(0, 0, 1);
    this._tmpV = new THREE.Vector3();
    this._viewDir = new THREE.Vector3(0.64, -0.70, 0.32).normalize();   // default framing direction (Blender parity: E5)
    this._fitDist = this.opts.cameraDistance;
    this._tmpV.copy(this._viewDir).multiplyScalar(this._fitDist).add(this.center);
    camera.position.copy(this._tmpV);
    camera.lookAt(this.center);
    this.camera = camera;
    // keyboard orbit works in a y-up spherical frame, like OrbitControls: rotate the offset into
    // it, edit theta/phi, rotate back — so "up" is the camera's up (z here), not three's default
    this._sph = new THREE.Spherical();
    this._upQuat = new THREE.Quaternion().setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0));
    this._upQuatInv = this._upQuat.clone().invert();

    const controls = new OrbitControls(camera, canvasEl);
    controls.target.copy(this.center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 1.0;
    controls.maxDistance = 12;
    controls.autoRotate = !!this.opts.autoRotate;
    controls.autoRotateSpeed = this.opts.autoRotateSpeed;
    controls.update();
    this.controls = controls;
    this._onPointerDown = () => { this.setAutoRotate(false); };
    canvasEl.addEventListener('pointerdown', this._onPointerDown, { passive: true });
    this._onCanvasKey = (e) => this._handleKey(e);
    canvasEl.addEventListener('keydown', this._onCanvasKey);

    // --- lights ---------------------------------------------------------------
    const hemi = new THREE.HemisphereLight(this.opts.hemiSky, this.opts.hemiGround, this.opts.hemiIntensity);
    hemi.position.set(0, 0, 1);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(this.opts.keyColor, this.opts.keyIntensity);
    key.position.set(0.5 - 1.6, 0.5 - 2.2, 0.5 + 2.6);
    key.target.position.copy(this.center);
    scene.add(key, key.target);
    const fill = new THREE.DirectionalLight(this.opts.fillColor, this.opts.fillIntensity);
    fill.position.set(0.5 + 2.4, 0.5 + 1.8, 0.5 - 1.1);
    fill.target.position.copy(this.center);
    scene.add(fill, fill.target);
    this._lights = [hemi, key, fill];
    this._keyDir = new THREE.Vector3(-1.6, -2.2, 2.6).normalize();

    // --- shared uniforms (one object each, referenced by every material) -------
    this._uCamDir = { value: new THREE.Vector3(0, -1, 0) };
    this._uDepthCue = { value: +this.opts.depthCue || 0 };
    this._mix = new Float32Array(3);   // scratch triple for species colour mixing

    // --- materials ------------------------------------------------------------
    this._uRimFiber = { value: this.opts.fiberRim };
    this._uRimPowFiber = { value: 2.5 };
    this._uTintFiber = { value: 0 };
    this._uRimCell = { value: this.opts.cellRim };
    this._uRimPowCell = { value: 3.0 };
    this._uTintCell = { value: 0 };   // raised by setTissue when the tissue has a gel species
    this.fiberMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setScalar(this.opts.fiberAlbedo), roughness: this.opts.fiberRoughness, metalness: 0.04,
      emissive: 0xffffff, emissiveIntensity: this.opts.fiberEmissive,
    });
    this._patchInstanceGlow(this.fiberMat, this._uRimFiber, this._uRimPowFiber, this._uTintFiber);
    this.cellMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setScalar(this.opts.cellAlbedo), roughness: this.opts.cellRoughness, metalness: 0.0,
      emissive: 0xffffff, emissiveIntensity: this.opts.cellEmissive,
    });
    this._patchInstanceGlow(this.cellMat, this._uRimCell, this._uRimPowCell, this._uTintCell);
    this.gelMat = this._makeHazeMaterial({
      opacity: this.opts.gelOpacity, edgeFade: this.opts.gelEdgeFade,
      ambient: this.opts.gelAmbient, diffuse: this.opts.gelDiffuse, rim: this.opts.gelRim,
    });
    this.scaffoldMat = this._makeHazeMaterial({
      opacity: this.opts.scaffoldOpacity, edgeFade: this.opts.scaffoldEdgeFade,
      ambient: this.opts.scaffoldAmbient, diffuse: this.opts.scaffoldDiffuse, rim: this.opts.scaffoldRim,
    });

    // --- static scenery: wire cube, load arrows ------------------------------
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const wireMat = new THREE.LineBasicMaterial({ color: this.opts.wireColor, transparent: true, opacity: 0.85 });
    const wire = new THREE.LineSegments(edges, wireMat);
    wire.position.copy(this.center);
    scene.add(wire);
    this._wire = { geo: edges, mat: wireMat, obj: wire };
    this._buildLoad();
    this._buildWound();

    // --- dynamic content -----------------------------------------------------
    this.fibers = null;     // { mesh, geo, base, rvec, jit, N, K, V, h, count, geoHeight }
    this.gel = null;        // { mesh, geo, alpha, jit } | { points, geo, valAttr, colAttr } (gelStyle)
    this.scaffold = null;   // { mesh, geo, alpha, mid, axis, len, va, vb, count }
    this.fields = null;     // [{ key, points, geo, mat, attr }]
    this._gridN = 0;
    this.cells = null;
    this._buildCells(this.opts.maxCells);

    // tissue-derived tables (filled by setTissue)
    this._fiberSp = []; this._gelSp = []; this._scafSp = [];
    this._fiberArr = []; this._gelArr = []; this._scafArr = [];
    this._cellTypes = [];
    this._fieldDefs = [];
    this._loadKey = null; this._loadMin = 0; this._loadSpan = 1;
    this._gelFade = 0;
    // optional per-species `render` hints (EXTENDING §1, B5), collapsed to one set per kind
    this._fiberHint = TissueRenderer._noHint(); this._gelHint = TissueRenderer._noHint(); this._scafHint = TissueRenderer._noHint();
    this._gelStyle = this.opts.gelStyle;
    this._fiberSc = recipeFiberScales(1, null);   // replaced per grid in _buildFibers
    this._dir3 = new Float64Array(3);             // scratch for recipeFiberDir (no per-instance allocation)
    this._spKeysRef = null; this._fdKeysRef = null; this._indicesDirty = true;

    // --- sizing ---------------------------------------------------------------
    this._ro = null;
    const parent = canvasEl.parentElement;
    if (typeof ResizeObserver !== 'undefined' && parent) {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(parent);
    } else if (typeof window !== 'undefined') {
      this._onWinResize = () => this.resize();
      window.addEventListener('resize', this._onWinResize);
    }
    this.resize();
  }

  // ---------------------------------------------------------------------------
  // helpers

  // Seeded PRNG (mulberry32) so per-instance jitter is reproducible.
  static _rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Scale saturation of a linear-RGB triple around its luminance (1 = unchanged).
  static _saturate(rgb, sat) {
    if (!(sat > 0) || sat === 1) return rgb;
    const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return rgb.map((x) => Math.max(0, l + (x - l) * sat));
  }

  // CSS/hex colour → linear RGB triple with a saturation factor applied.
  static _lin(css, sat = 1) {
    const c = new THREE.Color(css);
    return TissueRenderer._saturate([c.r, c.g, c.b], sat);
  }

  /**
   * CPU copy of three r160's tone mapping (tonemapping_pars_fragment.glsl), linear RGB in and
   * out, so a legend swatch can be encoded exactly the way the GPU encodes an unlit surface of
   * the same colour (REVIEW E4). `mode` is the renderer's `toneMapping` opt: 'aces' (default),
   * 'agx' or 'none'; anything else falls back to ACES, which is what the constructor selects.
   * Verified against the GPU in tools/render_smoke.mjs (≤ 1/255 per channel after encoding).
   */
  static toneMap(rgb, mode = 'aces', exposure = 1) {
    const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
    // NoToneMapping drops the whole tonemapping_fragment include, exposure and all
    if (mode === 'none') return [sat(rgb[0]), sat(rgb[1]), sat(rgb[2])];
    let r = rgb[0] * exposure, g = rgb[1] * exposure, b = rgb[2] * exposure;
    if (mode === 'agx') {
      // LINEAR_SRGB_TO_LINEAR_REC2020 is applied BEFORE the exposure in three r160
      let x = 0.6274 * rgb[0] + 0.3293 * rgb[1] + 0.0433 * rgb[2];
      let y = 0.0691 * rgb[0] + 0.9195 * rgb[1] + 0.0113 * rgb[2];
      let z = 0.0164 * rgb[0] + 0.0880 * rgb[1] + 0.8956 * rgb[2];
      x *= exposure; y *= exposure; z *= exposure;
      const ir = 0.856627153315983 * x + 0.0951212405381588 * y + 0.0482516061458583 * z;
      const ig = 0.137318972929847 * x + 0.761241990602591 * y + 0.101439036467562 * z;
      const ib = 0.11189821299995 * x + 0.0767994186031903 * y + 0.811302368396859 * z;
      const lo = -12.47393, span = 4.026069 - (-12.47393);
      const norm = (v) => {
        const u = (Math.log2(Math.max(v, 1e-10)) - lo) / span;
        return u < 0 ? 0 : u > 1 ? 1 : u;
      };
      const poly = (u) => {
        const u2 = u * u, u4 = u2 * u2;
        return 15.5 * u4 * u2 - 40.14 * u4 * u + 31.96 * u4 - 6.868 * u2 * u + 0.4298 * u2 + 0.1191 * u - 0.00232;
      };
      const cr = poly(norm(ir)), cg = poly(norm(ig)), cb = poly(norm(ib));
      const or_ = 1.1271005818144368 * cr - 0.11060664309660323 * cg - 0.016493938717834573 * cb;
      const og = -0.1413297634984383 * cr + 1.157823702216272 * cg - 0.016493938717834257 * cb;
      const ob = -0.14132976349843826 * cr - 0.11060664309660294 * cg + 1.2519364065950405 * cb;
      const p = (v) => Math.pow(Math.max(0, v), 2.2);
      const pr = p(or_), pg = p(og), pb = p(ob);
      return [sat(1.6605 * pr - 0.5876 * pg - 0.0728 * pb),
        sat(-0.1246 * pr + 1.1329 * pg - 0.0083 * pb),
        sat(-0.0182 * pr - 0.1006 * pg + 1.1187 * pb)];
    }
    // ACESFilmicToneMapping
    r /= 0.6; g /= 0.6; b /= 0.6;
    const ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
    const ig = 0.07600 * r + 0.90834 * g + 0.01566 * b;
    const ib = 0.02840 * r + 0.13383 * g + 0.83777 * b;
    const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
    const fr = fit(ir), fg = fit(ig), fb = fit(ib);
    return [sat(1.60475 * fr - 0.53108 * fg - 0.07367 * fb),
      sat(-0.10208 * fr + 1.10813 * fg - 0.00605 * fb),
      sat(-0.00327 * fr - 0.07276 * fg + 1.07602 * fb)];
  }

  // A legend swatch: the definition colour through this renderer's exposure + tone curve, sRGB.
  _swatchCss(rgb, alpha) {
    return TissueRenderer._css(TissueRenderer.toneMap(rgb, this.opts.toneMapping, this.opts.exposure), alpha);
  }

  // The per-kind defaults when a species declares no `render` block.
  static _noHint() {
    return { minDensity: null, radiusScale: 1, opacity: 1, style: null };
  }

  /**
   * Collapse the optional `render` hints of one species group into one set (EXTENDING §1, B5).
   * A kind is drawn by ONE instanced layer whose instances mix every species of that kind, so a
   * hint cannot be per species on screen: `minDensity` takes the LOWEST value declared (the
   * layer must appear as soon as any of its species should), `radiusScale` and `opacity` the
   * MEAN of the declared ones, `style` the first declared. Undeclared → the renderer opt.
   */
  static _hintOf(defs) {
    const h = TissueRenderer._noHint();
    let rs = 0, rsN = 0, op = 0, opN = 0;
    for (const s of defs) {
      const r = s && s.render;
      if (!r || typeof r !== 'object') continue;
      const md = +r.minDensity;
      if (Number.isFinite(md) && md >= 0) h.minDensity = h.minDensity === null ? md : Math.min(h.minDensity, md);
      const sc = +r.radiusScale;
      if (Number.isFinite(sc) && sc > 0) { rs += sc; rsN++; }
      const o = +r.opacity;
      if (Number.isFinite(o) && o >= 0) { op += o; opN++; }
      if (!h.style && typeof r.style === 'string') h.style = r.style;
    }
    if (rsN) h.radiusScale = rs / rsN;
    if (opN) h.opacity = op / opN;
    return h;
  }

  // linear RGB triple → CSS rgb()/rgba() string in sRGB (clamped).
  static _css(rgb, alpha) {
    const c = new THREE.Color().setRGB(Math.min(1, Math.max(0, rgb[0])), Math.min(1, Math.max(0, rgb[1])), Math.min(1, Math.max(0, rgb[2])), THREE.LinearSRGBColorSpace);
    return TissueRenderer._cssOf(c, alpha);
  }

  // THREE.Color → CSS string in sRGB (getHexString converts from the linear working space).
  static _cssOf(c, alpha) {
    const hex = c.getHexString();
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return alpha === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
  }

  static _toOklab(rgb) {
    const [r, g, b] = rgb;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }

  static _fromOklab(lab) {
    const [L, a, b] = lab;
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return [Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
  }

  // Colour ramp LUT (linear RGB, RENDER_LUT_N entries) from c0 to c1.
  // mode 'rgb': straight lerp (v0.1 — muddy purple half-way between blue and orange).
  // mode 'oklab': perceptual lerp; chroma dips to a neutral in the middle, optionally lifted in lightness.
  // mode 'oklch': perceptual lerp with hue interpolated along the shorter arc.
  // mid: explicit mid colour (linear RGB) → piecewise OKLab through it.
  static _rampLUT(c0, c1, mode, lift, mid) {
    const n = RENDER_LUT_N, out = new Float32Array(3 * n);
    const A = TissueRenderer._toOklab(c0), B = TissueRenderer._toOklab(c1);
    const M = mid ? TissueRenderer._toOklab(mid) : null;
    let h0 = Math.atan2(A[2], A[1]), h1 = Math.atan2(B[2], B[1]);
    if (h1 - h0 > Math.PI) h1 -= 2 * Math.PI; else if (h0 - h1 > Math.PI) h1 += 2 * Math.PI;
    const C0 = Math.hypot(A[1], A[2]), C1 = Math.hypot(B[1], B[2]);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      let rgb;
      if (mode === 'rgb' && !M) {
        rgb = [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
      } else if (M) {
        const P = t < 0.5 ? A : M, Q = t < 0.5 ? M : B, w = t < 0.5 ? t * 2 : t * 2 - 1;
        rgb = TissueRenderer._fromOklab([P[0] + (Q[0] - P[0]) * w, P[1] + (Q[1] - P[1]) * w, P[2] + (Q[2] - P[2]) * w]);
      } else if (mode === 'oklch') {
        const L = A[0] + (B[0] - A[0]) * t, C = C0 + (C1 - C0) * t, h = h0 + (h1 - h0) * t;
        rgb = TissueRenderer._fromOklab([L + lift * Math.sin(Math.PI * t), C * Math.cos(h), C * Math.sin(h)]);
      } else {
        rgb = TissueRenderer._fromOklab([A[0] + (B[0] - A[0]) * t + lift * Math.sin(Math.PI * t), A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
      }
      out[3 * i] = rgb[0]; out[3 * i + 1] = rgb[1]; out[3 * i + 2] = rgb[2];
    }
    return out;
  }

  // Zero the 3x3 part of `count` instance matrices starting at instance `from`.
  static _hideRange(arr, from, count) {
    for (let i = 0; i < count; i++) {
      const o = (from + i) * 16;
      arr[o] = arr[o + 1] = arr[o + 2] = 0;
      arr[o + 4] = arr[o + 5] = arr[o + 6] = 0;
      arr[o + 8] = arr[o + 9] = arr[o + 10] = 0;
      arr[o + 15] = 1;
    }
  }

  // A generic definition derived from a state (used when setTissue was never called):
  // every species becomes a grey→amber fiber, every field a hue, one round cell type.
  static tissueFromState(state) {
    const greys = ['#cfd8e3', '#e0a24a', '#9fd3c7', '#c9a4ff'];
    const hues = ['#3fd6c4', '#e05bd0', '#ffd166', '#7cc7ff', '#ff8a80'];
    const species = (state.speciesKeys || []).map((key, i) => ({ key, label: key, kind: 'fiber', color: greys[i % greys.length] }));
    const fields = (state.fieldKeys || []).map((key, i) => ({ key, label: key, color: hues[i % hues.length] }));
    return {
      key: state.tissue || 'generic', name: 'Generic tissue', species, fields,
      cellTypes: [{ key: 'cell', label: 'Cell', colors: ['#4ea3ff', '#ff7a3d'], shape: { by: 'a', aspectMin: 1, aspectMax: 2.5 }, radius: 0.03 }],
      dials: state.dials && 'strain' in state.dials ? [{ key: 'strain', role: 'load' }] : [],
    };
  }

  // Tint the constant emissive by the per-instance colour, add a rim term (so fibers/cells
  // never go black on their shadow side) and apply the depth cue to albedo + emissive.
  // uRimTint mixes the rim colour toward white: a white rim is what separates a teal cell
  // from a teal gel haze (same hue, no edge otherwise).
  _patchInstanceGlow(material, uRim, uRimPow, uRimTint) {
    const uCamDir = this._uCamDir, uDepthCue = this._uDepthCue;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRim = uRim;
      shader.uniforms.uRimPow = uRimPow;
      shader.uniforms.uRimTint = uRimTint || { value: 0 };
      shader.uniforms.uCamDir = uCamDir;
      shader.uniforms.uDepthCue = uDepthCue;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uCamDir;\nuniform float uDepthCue;\nvarying float vCue;\n' + RENDER_GLSL_CUE)
        .replace('#include <project_vertex>',
          '#include <project_vertex>\n' +
          '#ifdef USE_INSTANCING\n' +
          '  vCue = tissueDepthCue( ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz, uCamDir, uDepthCue );\n' +
          '#else\n  vCue = 1.0;\n#endif');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uRim;\nuniform float uRimPow;\nuniform float uRimTint;\nvarying float vCue;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vCue;')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n' +
          '#ifdef USE_COLOR\n' +
          '  totalEmissiveRadiance *= vColor;\n' +
          '  float rrRim = pow( 1.0 - saturate( abs( dot( normalize( vViewPosition ), normal ) ) ), uRimPow );\n' +
          '  totalEmissiveRadiance += mix( vColor, vec3( 1.0 ), uRimTint ) * uRim * rrRim;\n' +
          '  totalEmissiveRadiance *= vCue;\n' +
          '#endif');
    };
    material.customProgramCacheKey = () => 'tissue-instance-glow-3';
  }

  _makeHazeMaterial(p) {
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uOpacity: { value: p.opacity }, uEdgeFade: { value: p.edgeFade },
        uLightDir: { value: this._keyDir.clone() },
        uAmbient: { value: p.ambient }, uDiffuse: { value: p.diffuse }, uRim: { value: p.rim },
      }]),
      vertexShader: RENDER_HAZE_VERT, fragmentShader: RENDER_HAZE_FRAG,
      transparent: true, depthWrite: false, depthTest: true, fog: true,
    });
    // shared uniform objects (assigned after merge, which clones)
    mat.uniforms.uCamDir = this._uCamDir;
    mat.uniforms.uDepthCue = this._uDepthCue;
    return mat;
  }

  _buildLoad() {
    const group = new THREE.Group();
    const col = new THREE.Color(this.opts.loadColor);
    const arrowMat = new THREE.MeshStandardMaterial({
      color: col, emissive: col, emissiveIntensity: 0.25, roughness: 0.5,
      transparent: true, opacity: 0.6, depthWrite: false,
    });
    const plateMat = new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide,
    });
    const shaftGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.68, 12, 1, false);
    shaftGeo.translate(0, 0.34, 0);
    const coneGeo = new THREE.ConeGeometry(0.115, 0.32, 16);
    coneGeo.translate(0, 0.84, 0);
    const plateGeo = new THREE.PlaneGeometry(1, 1);
    const makeArrow = (dirSign) => {
      const a = new THREE.Group();
      a.add(new THREE.Mesh(shaftGeo, arrowMat), new THREE.Mesh(coneGeo, arrowMat));
      a.rotation.x = dirSign * Math.PI / 2;   // +Y → ±Z
      a.position.set(0.5, 0.5, dirSign > 0 ? 1.015 : -0.015);
      return a;
    };
    const top = makeArrow(+1), bottom = makeArrow(-1);
    const plateTop = new THREE.Mesh(plateGeo, plateMat);
    plateTop.position.set(0.5, 0.5, 1.0);
    const plateBot = new THREE.Mesh(plateGeo, plateMat);
    plateBot.position.set(0.5, 0.5, 0.0);
    group.add(top, bottom, plateTop, plateBot);
    group.traverse((o) => { o.renderOrder = 4; });
    group.visible = false;
    this.scene.add(group);
    this.load = { group, top, bottom, arrowMat, plateMat, geos: [shaftGeo, coneGeo, plateGeo] };
  }

  // Latitude/longitude wire sphere of unit radius (meridians through the ±up poles + rings),
  // as LineSegments positions. Cheap and read as a globe, unlike a triangulated wireframe.
  static _wireSphereGeo(meridians, rings, seg) {
    const pos = new Float32Array(6 * seg * (meridians + rings));
    let o = 0;
    const push = (x0, y0, z0, x1, y1, z1) => {
      pos[o] = x0; pos[o + 1] = y0; pos[o + 2] = z0; pos[o + 3] = x1; pos[o + 4] = y1; pos[o + 5] = z1; o += 6;
    };
    for (let m = 0; m < meridians; m++) {
      const a = Math.PI * m / meridians, ca = Math.cos(a), sa = Math.sin(a);
      for (let s = 0; s < seg; s++) {
        const t0 = 2 * Math.PI * s / seg, t1 = 2 * Math.PI * (s + 1) / seg;
        push(Math.cos(t0) * ca, Math.cos(t0) * sa, Math.sin(t0), Math.cos(t1) * ca, Math.cos(t1) * sa, Math.sin(t1));
      }
    }
    for (let r = 1; r <= rings; r++) {
      const phi = -Math.PI / 2 + Math.PI * r / (rings + 1), z = Math.sin(phi), rr = Math.cos(phi);
      for (let s = 0; s < seg; s++) {
        const t0 = 2 * Math.PI * s / seg, t1 = 2 * Math.PI * (s + 1) / seg;
        push(Math.cos(t0) * rr, Math.sin(t0) * rr, z, Math.cos(t1) * rr, Math.sin(t1) * rr, z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
  }

  // Wound marker (REVIEW B4): a wire sphere on state.wound, opacity 0.15 + 0.55·e^(−age/7) —
  // bright while the injury is fresh, then a faint outline that stays, so "find the hole" works
  // long after the hole has filled in. Hidden when the state carries no wound (reset, fake states).
  _buildWound() {
    const o = this.opts;
    const geo = TissueRenderer._wireSphereGeo(Math.max(2, o.woundMeridians | 0), Math.max(0, o.woundRings | 0), Math.max(8, o.woundSegments | 0));
    const col = new THREE.Color(o.woundColor);
    const mat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: o.woundOpacity, depthWrite: false });
    const obj = new THREE.LineSegments(geo, mat);
    obj.renderOrder = 5;
    obj.visible = false;
    obj.frustumCulled = false;
    // second, fainter pass without depth test: a wound buried in dense matrix would otherwise be
    // completely hidden, and "find the hole" is the whole point of the marker. Child of `obj`, so
    // it inherits the transform and the visibility.
    let ghost = null, ghostMat = null;
    if (+o.woundGhost > 0) {
      ghostMat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: o.woundOpacity * o.woundGhost, depthWrite: false, depthTest: false });
      ghost = new THREE.LineSegments(geo, ghostMat);
      ghost.renderOrder = 6;
      ghost.frustumCulled = false;
      obj.add(ghost);
    }
    this.scene.add(obj);
    this.woundMarker = { obj, geo, mat, ghost, ghostMat };
  }

  // `wound` is state.wound ({ center, radius, time } in WORLD units) or null; `show` is the layer.
  _updateWound(state, show) {
    const W = this.woundMarker;
    if (!W) return;
    const w = show ? state.wound : null;
    if (!w || !w.center || !(w.radius > 0)) { W.obj.visible = false; return; }
    const invL = state.L > 0 ? 1 / state.L : 1;
    W.obj.position.set(w.center[0] * invL, w.center[1] * invL, w.center[2] * invL);
    const r = w.radius * invL;
    W.obj.scale.set(r, r, r);
    let age = (+state.time || 0) - (+w.time || 0);
    if (!(age > 0)) age = 0;
    const fade = this.opts.woundFadeDays > 0 ? Math.exp(-age / this.opts.woundFadeDays) : 0;
    const op = this.opts.woundOpacity + this.opts.woundOpacityPeak * fade;
    W.mat.opacity = op;
    if (W.ghostMat) W.ghostMat.opacity = op * this.opts.woundGhost;
    W.obj.visible = true;
  }

  // ---------------------------------------------------------------------------
  // tissue definition → colour tables, layer plan

  setTissue(tissue) {
    this.tissue = tissue || null;
    const T = tissue || { species: [], cellTypes: [], fields: [], dials: [] };
    const mk = (s, sat) => ({ key: s.key, label: s.label || s.key, color: s.color || '#cccccc', col: TissueRenderer._lin(s.color || '#cccccc', sat), idx: -1 });
    const species = T.species || [];
    const rawFiber = species.filter((s) => (s.kind || 'fiber') === 'fiber');
    const rawGel = species.filter((s) => s.kind === 'gel');
    const rawScaf = species.filter((s) => s.kind === 'scaffold');
    this._fiberHint = TissueRenderer._hintOf(rawFiber);
    this._gelHint = TissueRenderer._hintOf(rawGel);
    this._scafHint = TissueRenderer._hintOf(rawScaf);
    // an explicit gelStyle opt wins over a species hint; otherwise the definition may ask for points
    this._gelStyle = (!this._optSet.has('gelStyle') && (this._gelHint.style === 'points' || this._gelHint.style === 'spheres'))
      ? this._gelHint.style : this.opts.gelStyle;
    this.gelMat.uniforms.uOpacity.value = this.opts.gelOpacity * this._gelHint.opacity;
    this.scaffoldMat.uniforms.uOpacity.value = this.opts.scaffoldOpacity * this._scafHint.opacity;
    this._fiberSp = rawFiber.map((s) => mk(s, this.opts.fiberSaturation));
    this._gelSp = rawGel.map((s) => mk(s, this.opts.gelSaturation));
    this._scafSp = rawScaf.map((s) => mk(s, this.opts.scaffoldSaturation));
    this._fiberArr = new Array(this._fiberSp.length).fill(null);
    this._gelArr = new Array(this._gelSp.length).fill(null);
    this._scafArr = new Array(this._scafSp.length).fill(null);
    const explicitMid = this.opts.cellColorMid ? TissueRenderer._lin(this.opts.cellColorMid, 1) : null;
    this._cellTypes = (T.cellTypes && T.cellTypes.length ? T.cellTypes : [{ key: 'cell', label: 'Cell' }]).map((ct) => {
      const cols = ct.colors && ct.colors.length ? ct.colors : ['#4ea3ff', '#ff7a3d'];
      const c0 = TissueRenderer._lin(cols[0], this.opts.cellSaturation);
      const c1 = TissueRenderer._lin(cols[cols.length > 1 ? 1 : 0], this.opts.cellSaturation);
      const mid = cols.length > 2 ? TissueRenderer._lin(cols[1], this.opts.cellSaturation) : explicitMid;
      const sh = ct.shape || {};
      // radius: a number, or { by: 'a'|'b', min, max } — the radius then follows that cell state
      const rd = ct.radius;
      const byState = rd && typeof rd === 'object';
      const rMin = byState ? (+rd.min > 0 ? +rd.min : 0.02) : (+rd > 0 ? +rd : 0.03);
      const rMax = byState ? (+rd.max > 0 ? +rd.max : rMin) : rMin;
      return {
        key: ct.key, label: ct.label || ct.key, radius: rMin,
        rBy: byState ? (rd.by === 'b' ? 1 : 0) : -1, rMin, rMax,
        by: sh.by === 'b' ? 1 : 0, aMin: +(sh.aspectMin) > 0 ? +sh.aspectMin : 1, aMax: +(sh.aspectMax) > 0 ? +sh.aspectMax : 1,
        lut: TissueRenderer._rampLUT(c0, c1, this.opts.cellRamp, this.opts.cellMidLift, mid),
      };
    });
    // a gel species means cells can sit inside a haze of their own hue: give them a whiter rim
    // and thin the haze in the voxels that hold them
    const hasGel = this._gelSp.length > 0;
    this._uRimCell.value = hasGel ? this.opts.cellRimGel : this.opts.cellRim;
    this._uTintCell.value = hasGel ? this.opts.cellRimTint : 0;
    this._gelFade = hasGel && +this.opts.gelCellFade > 0 ? Math.min(0.95, +this.opts.gelCellFade) : 0;
    // fields: optional `pointScale` (B5) scales this field's sprites (1 = the renderer default)
    this._fieldDefs = (T.fields || []).map((f) => ({
      key: f.key, label: f.label || f.key, color: f.color || '#3fd6c4',
      col: TissueRenderer._lin(f.color || '#3fd6c4', 1),
      pointScale: +f.pointScale > 0 ? +f.pointScale : 1, idx: -1,
    }));
    // load dial: any range (fibrous strain 0–1, cartilage compression 0–0.2) → normalise for the arrows
    const loadDial = (T.dials || []).find((d) => d.role === 'load');
    this._loadKey = loadDial ? loadDial.key : null;
    const lMin = loadDial && Number.isFinite(+loadDial.min) ? +loadDial.min : 0;
    const lMax = loadDial && Number.isFinite(+loadDial.max) ? +loadDial.max : 1;
    this._loadMin = lMin;
    this._loadSpan = lMax > lMin ? lMax - lMin : 1;
    this._spKeysRef = null; this._fdKeysRef = null; this._indicesDirty = true;
    this._dirty = true;    // the dirty check must not skip the first update after a tissue change
    this.load.group.visible = false;
    if (this.woundMarker) this.woundMarker.obj.visible = false;   // no stale marker from the old tissue
    this._disposeGrid();   // rebuilt for state.N on the next update()
  }

  // Resolve species/field indices against the state's key arrays — only when those arrays
  // change identity or the tissue changed (no allocation on the steady-state path). Falls
  // back to the definition's own order when the state carries no key arrays.
  _resolveIndices(state) {
    const sk = state.speciesKeys || null, fk = state.fieldKeys || null;
    if (this._indicesDirty || sk !== this._spKeysRef || fk !== this._fdKeysRef) {
      this._indicesDirty = false; this._spKeysRef = sk; this._fdKeysRef = fk;
      const tsp = (this.tissue && this.tissue.species) || [], tfd = (this.tissue && this.tissue.fields) || [];
      for (const g of [this._fiberSp, this._gelSp, this._scafSp]) {
        for (const s of g) s.idx = sk ? sk.indexOf(s.key) : tsp.findIndex((x) => x.key === s.key);
      }
      for (const f of this._fieldDefs) f.idx = fk ? fk.indexOf(f.key) : tfd.findIndex((x) => x.key === f.key);
    }
    const sp = state.species || null;
    TissueRenderer._bindArrays(this._fiberSp, this._fiberArr, sp);
    TissueRenderer._bindArrays(this._gelSp, this._gelArr, sp);
    TissueRenderer._bindArrays(this._scafSp, this._scafArr, sp);
  }

  static _bindArrays(defs, arr, sp) {
    for (let i = 0; i < defs.length; i++) {
      const ix = defs[i].idx;
      arr[i] = (sp && ix >= 0 && ix < sp.length) ? sp[ix] : null;
    }
  }

  // ---------------------------------------------------------------------------
  // grid-dependent layers (rebuilt when N or the tissue changes)

  _disposeGrid() {
    if (this.fibers) { this.scene.remove(this.fibers.mesh); this.fibers.geo.dispose(); this.fibers.mesh.dispose(); this.fibers = null; }
    if (this.gel) {
      if (this.gel.mesh) { this.scene.remove(this.gel.mesh); this.gel.geo.dispose(); this.gel.mesh.dispose(); }
      if (this.gel.points) { this.scene.remove(this.gel.points); this.gel.geo.dispose(); this.gel.mat.dispose(); }
      this.gel = null;
    }
    if (this.scaffold) { this.scene.remove(this.scaffold.mesh); this.scaffold.geo.dispose(); this.scaffold.mesh.dispose(); this.scaffold = null; }
    if (this.fields) {
      for (const L of this.fields) { this.scene.remove(L.points); L.geo.dispose(); L.mat.dispose(); }
      this.fields = null;
    }
    this._gridN = 0;
  }

  _buildGrid(N) {
    this._disposeGrid();
    const V = N * N * N, h = 1 / N;
    const centers = new Float32Array(V * 3);
    for (let v = 0; v < V; v++) {
      const i = (v / (N * N)) | 0, j = ((v / N) | 0) % N, k = v % N;
      centers[3 * v] = (i + 0.5) * h; centers[3 * v + 1] = (j + 0.5) * h; centers[3 * v + 2] = (k + 0.5) * h;
    }
    this._gridN = N;
    this._buildFibers(N, centers);
    if (this._gelSp.length) this._buildGel(N, centers);
    if (this._scafSp.length) this._buildScaffold(N, centers);
    this._buildFields(N, centers);
    this._updatePointScale();
  }

  /**
   * One jittered point per voxel, clamped so the whole sprite stays inside the block
   * (the same treatment the gel spheres get; sprites on the boundary layer would otherwise
   * bleed past the faces of the cube). `margin` is the sprite's world half-size.
   */
  static _jitterPoints(N, centers, seed, margin) {
    const V = N * N * N, h = 1 / N, rand = TissueRenderer._rng(seed);
    const out = new Float32Array(V * 3);
    const lo = margin > 0.5 ? 0.5 : (margin > 0 ? margin : 0), hi = 1 - lo;
    for (let v = 0; v < V; v++) {
      for (let d = 0; d < 3; d++) {
        let p = centers[3 * v + d] + (rand() - 0.5) * 0.55 * h;
        out[3 * v + d] = p < lo ? lo : p > hi ? hi : p;
      }
    }
    return out;
  }

  // Renderer opts + the fiber species' optional `render` hints → the src/recipe.js override bag.
  _fiberOverrides() {
    const o = this.opts, hint = this._fiberHint;
    return {
      seed: o.seed, K: o.K,
      radiusScale: o.fiberRadiusScale * hint.radiusScale,
      lengthScale: o.fiberLengthScale,
      minRadius: o.fiberMinRadius,
      minDensity: hint.minDensity !== null ? hint.minDensity : o.minRho,
      minDensityRamp: o.minRhoRamp,
    };
  }

  _fiberScales(h) {
    return recipeFiberScales(h, this._fiberOverrides());
  }

  /** The fiber recipe actually in use, in the `meta.render` shape (src/recipe.js header, E2). */
  layoutParams() {
    return recipeRenderMeta(this._fiberOverrides());
  }

  // Per-instance layout (offset inside the voxel, random unit vector r_j, length/radius jitter)
  // and the density/FA laws both come from src/recipe.js, so the Blender importer can reproduce
  // this exact arrangement. `centers` is unused here — the recipe derives voxel centres itself.
  _buildFibers(N, centers) {   // eslint-disable-line no-unused-vars
    const K = this.opts.K, V = N * N * N, count = V * K, h = 1 / N;
    const { base, rvec, jit } = recipeFiberLayout(N, K, this.opts.seed);
    this._fiberSc = this._fiberScales(h);
    const capsule = this.opts.fiberShape === 'capsule';
    const geo = capsule ? new THREE.CapsuleGeometry(1, 2, 2, 6) : new THREE.CylinderGeometry(1, 1, 1, 6, 1, false);
    const geoHeight = capsule ? 4 : 1;
    const mesh = new THREE.InstancedMesh(geo, this.fiberMat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    TissueRenderer._hideRange(mesh.instanceMatrix.array, 0, count);
    this.scene.add(mesh);
    this.fibers = { mesh, geo, base, rvec, jit, N, K, V, h, count, geoHeight };
  }

  _buildGel(N, centers) {
    const V = N * N * N, h = 1 / N;
    if (this._gelStyle === 'points') {
      const g = new THREE.BufferGeometry();
      const pos = TissueRenderer._jitterPoints(N, centers, this.opts.seed ^ 0x27d4eb2d, 0.5 * this.opts.gelPointSize * h * this._gelHint.radiusScale);
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const valAttr = new THREE.BufferAttribute(new Float32Array(V), 1); valAttr.setUsage(THREE.DynamicDrawUsage);
      const colAttr = new THREE.BufferAttribute(new Float32Array(V * 3), 3); colAttr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aVal', valAttr); g.setAttribute('aCol', colAttr);
      g.boundingSphere = new THREE.Sphere(this.center.clone(), 1);
      const mat = this._makePointMaterial(this.opts.gelPointOpacity * this._gelHint.opacity, this.opts.gelPointSize * h * this._gelHint.radiusScale, this.opts.gelPointSoft, 0.33);
      const points = new THREE.Points(g, mat);
      points.frustumCulled = false; points.renderOrder = 2; points.visible = false;
      this.scene.add(points);
      this.gel = { points, geo: g, mat, valAttr, colAttr, occ: new Uint8Array(V), V, h };
      return;
    }
    const rand = TissueRenderer._rng(this.opts.seed ^ 0x5bd1e995);
    const jit = new Float32Array(V * 4);   // dx, dy, dz (× h), size factor
    for (let v = 0; v < V; v++) {
      jit[4 * v] = (rand() - 0.5) * 0.5; jit[4 * v + 1] = (rand() - 0.5) * 0.5; jit[4 * v + 2] = (rand() - 0.5) * 0.5;
      jit[4 * v + 3] = 0.85 + 0.3 * rand();
    }
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(V), 1);
    alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', alpha);
    const mesh = new THREE.InstancedMesh(geo, this.gelMat, V);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(V * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.visible = false;
    TissueRenderer._hideRange(mesh.instanceMatrix.array, 0, V);
    this.scene.add(mesh);
    this.gel = { mesh, geo, alpha, jit, centers, occ: new Uint8Array(V), V, h };
  }

  // Lattice of struts between voxel centres: for every voxel a strut along +x, +y, +z to its
  // neighbour (half length to the block face for the last layer), plus half struts from the
  // first layer to the face, so the lattice fills the whole block.
  _buildScaffold(N, centers) {
    const V = N * N * N, h = 1 / N, stride = [N * N, N, 1];
    const count = 3 * V + 3 * N * N;
    const mid = new Float32Array(count * 3), len = new Float32Array(count);
    const axis = new Uint8Array(count), va = new Int32Array(count), vb = new Int32Array(count);
    let s = 0;
    for (let v = 0; v < V; v++) {
      const idx = [(v / (N * N)) | 0, ((v / N) | 0) % N, v % N];
      for (let d = 0; d < 3; d++) {
        const cx = centers[3 * v], cy = centers[3 * v + 1], cz = centers[3 * v + 2];
        const last = idx[d] === N - 1;
        const L = last ? 0.5 * h : h;
        mid[3 * s] = cx + (d === 0 ? L * 0.5 : 0); mid[3 * s + 1] = cy + (d === 1 ? L * 0.5 : 0); mid[3 * s + 2] = cz + (d === 2 ? L * 0.5 : 0);
        len[s] = L; axis[s] = d; va[s] = v; vb[s] = last ? -1 : v + stride[d];
        s++;
        if (idx[d] === 0) {   // half strut toward the low face
          mid[3 * s] = cx - (d === 0 ? h * 0.25 : 0); mid[3 * s + 1] = cy - (d === 1 ? h * 0.25 : 0); mid[3 * s + 2] = cz - (d === 2 ? h * 0.25 : 0);
          len[s] = 0.5 * h; axis[s] = d; va[s] = v; vb[s] = -1;
          s++;
        }
      }
    }
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, false);
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', alpha);
    const mesh = new THREE.InstancedMesh(geo, this.scaffoldMat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.visible = false;
    TissueRenderer._hideRange(mesh.instanceMatrix.array, 0, count);
    this.scene.add(mesh);
    // per-voxel scratch (density, mixed colour) so each strut only averages two lookups
    this.scaffold = { mesh, geo, alpha, mid, len, axis, va, vb, count: s, V, h, vd: new Float32Array(V), vc: new Float32Array(3 * V) };
  }

  _makePointMaterial(opacity, size, soft, sizePow) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: opacity }, uSize: { value: size }, uMinVal: { value: 0.02 },
        uScale: { value: 400 }, uSoft: { value: soft }, uSizePow: { value: sizePow },
      },
      vertexShader: RENDER_POINT_VERT, fragmentShader: RENDER_POINT_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: this.opts.pointBlending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
  }

  // A field's sprite size is `pointSize · h · (fields[i].pointScale ?? 1)` (B5): a field whose
  // haze should read as a coarse cloud rather than a fine mist says so in the definition.
  _buildFields(N, centers) {
    const V = N * N * N, h = 1 / N;
    this.fields = this._fieldDefs.map((f, i) => {
      const size = this.opts.pointSize * h * f.pointScale;
      const margin = 0.5 * size;
      const g = new THREE.BufferGeometry();
      // own jittered, clamped cloud per field: two hazes interleave instead of coinciding,
      // and no sprite hangs outside the cube
      g.setAttribute('position', new THREE.BufferAttribute(TissueRenderer._jitterPoints(N, centers, (this.opts.seed ^ 0x1b873593) + 7919 * i, margin), 3));
      const attr = new THREE.BufferAttribute(new Float32Array(V), 1);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aVal', attr);
      const colArr = new Float32Array(V * 3);
      const c = new THREE.Color(f.color);
      for (let v = 0; v < V; v++) { colArr[3 * v] = c.r; colArr[3 * v + 1] = c.g; colArr[3 * v + 2] = c.b; }
      g.setAttribute('aCol', new THREE.BufferAttribute(colArr, 3));
      g.boundingSphere = new THREE.Sphere(this.center.clone(), 1);
      const mat = this._makePointMaterial(this.opts.pointOpacity, size, 8.0, 1.0);
      const points = new THREE.Points(g, mat);
      points.frustumCulled = false; points.renderOrder = 3; points.visible = false;
      this.scene.add(points);
      return { key: f.key, def: f, points, geo: g, mat, attr };
    });
  }

  _buildCells(capacity) {
    if (this.cells) {
      this.scene.remove(this.cells.mesh);
      this.cells.geo.dispose();
      this.cells.mesh.dispose();
    }
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const mesh = new THREE.InstancedMesh(geo, this.cellMat, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    TissueRenderer._hideRange(mesh.instanceMatrix.array, 0, capacity);
    this.scene.add(mesh);
    this.cells = { mesh, geo, capacity };
  }

  _updatePointScale() {
    const hPx = this.renderer.domElement.height;  // drawing-buffer pixels
    const s = hPx / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5));
    if (this.fields) for (const L of this.fields) L.mat.uniforms.uScale.value = s;
    if (this.gel && this.gel.points) this.gel.mat.uniforms.uScale.value = s;
  }

  // Fit the canvas to its parent and keep the cube framed. The framing distance
  // grows for narrow viewports (aspect < 0.95) so the cube's width still fits; a
  // user zoom (distance / fit distance) is preserved across resizes.
  resize() {
    if (this._disposed) return;
    const canvas = this.canvas;
    const parent = canvas.parentElement;
    let w = parent ? parent.clientWidth : canvas.clientWidth;
    let h = parent ? parent.clientHeight : canvas.clientHeight;
    if (!(w > 0) || !(h > 0)) return;
    w = Math.floor(w); h = Math.floor(h);
    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, this.opts.maxPixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, true);
    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const fit = this.opts.cameraDistance * Math.max(1, 0.95 / aspect);
    if (Math.abs(fit - this._fitDist) > 1e-6) {
      const cur = this.camera.position.distanceTo(this.controls.target);
      const zoom = cur / this._fitDist;
      this._fitDist = fit;
      this._tmpV.copy(this.camera.position).sub(this.controls.target).setLength(fit * zoom);
      this.camera.position.copy(this.controls.target).add(this._tmpV);
      this.controls.update();
    }
    this._updatePointScale();
  }

  // ---------------------------------------------------------------------------
  // per-frame state → instances (no per-instance allocation)

  /**
   * Layer set as one integer, so the dirty check can compare it without allocating: bits 0-4 are
   * fibers / cells / scaffold / gel / wound, bits 5+ one per field of the current tissue (in
   * definition order; a tissue with more than 26 fields simply stops distinguishing them, which
   * only costs a redundant update).
   */
  _layerKey(layers) {
    let k = (layers.fibers !== false ? 1 : 0) | (layers.cells !== false ? 2 : 0)
      | (layers.scaffold !== false ? 4 : 0) | (layers.gel !== false ? 8 : 0)
      | (layers.wound !== false ? 16 : 0);
    if (this.fields) {
      const fl = layers.fields || RENDER_EMPTY;
      const n = this.fields.length < 26 ? this.fields.length : 26;
      for (let i = 0; i < n; i++) {
        const key = this.fields[i].key;
        if (!!fl[key] || (!layers.fields && !!layers[key])) k |= 1 << (5 + i);
      }
    }
    return k;
  }

  /** Force the next update() to rebuild everything (after changing opts by hand, say). */
  markDirty() { this._dirty = true; }

  update(state, layers = RENDER_EMPTY) {
    if (this._disposed || !state) return;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    if (!this.tissue) this.setTissue(TissueRenderer.tissueFromState(state));
    const showF = layers.fibers !== false;
    const showC = layers.cells !== false;
    const showS = layers.scaffold !== false;
    const showG = layers.gel !== false;
    const showW = layers.wound !== false;
    const fl = layers.fields || RENDER_EMPTY;
    const N = state.N | 0;
    if (N > 0 && this._gridN !== N) { this._buildGrid(N); this._dirty = true; }
    this._resolveIndices(state);

    // B1: nothing the instance buffers depend on has changed → keep them, refresh only the two
    // O(1) overlays. `revision` missing (render_smoke, hand-built states) → always rebuild.
    const rev = state.revision;
    const key = this._layerKey(layers);
    const nC = state.nCells | 0;
    if (rev !== undefined && !this._dirty && rev === this._lastRev && key === this._lastKey && N === this._lastN && nC === this._lastCells) {
      this.stats.skipped++;
      this._updateWound(state, showW);
      this._updateLoad(this._loadKey && state.dials ? state.dials[this._loadKey] : 0);
      if (t0) this.stats.updateMs = performance.now() - t0;
      return;
    }
    this._dirty = false; this._lastRev = rev; this._lastKey = key; this._lastN = N; this._lastCells = nC;
    this.stats.updates++;

    if (this.fibers) {
      this.fibers.mesh.visible = showF;
      if (showF) this._updateFibers(state); else this.stats.fibersVisible = 0;
    }
    if (this.gel) {
      const obj = this.gel.mesh || this.gel.points;
      obj.visible = showG;
      if (showG) this._updateGel(state); else this.stats.gelVisible = 0;
    } else this.stats.gelVisible = 0;
    if (this.scaffold) {
      this.scaffold.mesh.visible = showS;
      if (showS) this._updateScaffold(state); else this.stats.strutsVisible = 0;
    } else this.stats.strutsVisible = 0;
    if (this.fields) {
      const F = state.fields;
      for (let i = 0; i < this.fields.length; i++) {
        const L = this.fields[i];
        const on = !!fl[L.key] || (!layers.fields && !!layers[L.key]);
        const ix = L.def.idx;
        const src = F && ix >= 0 && ix < F.length ? F[ix] : (state[L.key] && state[L.key].length ? state[L.key] : null);
        L.points.visible = on && !!src;
        if (on && src) this._updateField(L, src);
      }
    }
    if (showC) this._updateCells(state); else { this.cells.mesh.visible = false; this.stats.cells = 0; }
    this._updateWound(state, showW);
    this._updateLoad(this._loadKey && state.dials ? state.dials[this._loadKey] : 0);
    if (t0) this.stats.updateMs = performance.now() - t0;
  }

  _updateFibers(state) {
    const F = this.fibers, K = F.K, V = F.V, h = F.h;
    const M = F.mesh.instanceMatrix.array, C = F.mesh.instanceColor.array;
    const sp = this._fiberArr, nSp = sp.length;
    let total = state.fiberTotal || null;
    if (!total && nSp === 1) total = sp[0];
    const fa = state.fa, fx = state.fx, fy = state.fy, fz = state.fz;
    const base = F.base, rv = F.rvec, jit = F.jit;
    const sc = this._fiberSc, lScale = 1 / F.geoHeight, dir = this._dir3;
    const c0 = nSp ? this._fiberSp[0].col : null;
    let visible = 0;
    for (let v = 0; v < V; v++) {
      let r;
      if (total) r = v < total.length ? total[v] : 0;
      else { r = 0; for (let s = 0; s < nSp; s++) { const arr = sp[s]; if (arr && v < arr.length) r += arr[v]; } }
      // fade in over [minDensity·ramp, minDensity] instead of popping in at a hairline (REVIEW §5)
      const fade = recipeFiberFade(r, sc);
      if (!(fade > 0)) { TissueRenderer._hideRange(M, v * K, K); continue; }
      let a = fa ? fa[v] : 0;
      if (!(a > 0)) a = 0; else if (a > 1) a = 1;
      let ux = fx ? fx[v] : 0, uy = fy ? fy[v] : 0, uz = fz ? fz[v] : 1;
      const ul = ux * ux + uy * uy + uz * uz;
      if (!(ul > 1e-12)) { a = 0; ux = 0; uy = 0; uz = 1; }
      else if (Math.abs(ul - 1) > 1e-4) { const inv = 1 / Math.sqrt(ul); ux *= inv; uy *= inv; uz *= inv; }
      const rad = recipeFiberRadius(r, sc) * fade, len = recipeFiberLength(a, sc) * lScale;
      // colour = density-weighted mix of fiber species colours (linear RGB), × density brightness cue
      let cr = 0, cg = 0, cb = 0, wsum = 0;
      for (let s = 0; s < nSp; s++) {
        const arr = sp[s]; if (!arr) continue;
        let w = v < arr.length ? arr[v] : 0; if (!(w > 0)) continue;
        const col = this._fiberSp[s].col;
        cr += w * col[0]; cg += w * col[1]; cb += w * col[2]; wsum += w;
      }
      if (wsum > 0) { const inv = 1 / wsum; cr *= inv; cg *= inv; cb *= inv; }
      else if (c0) { cr = c0[0]; cg = c0[1]; cb = c0[2]; }
      else { cr = cg = cb = 0.8; }
      const cue = 0.6 + 0.4 * Math.min(r, 1);
      cr *= cue; cg *= cue; cb *= cue;
      for (let q = 0; q < K; q++) {
        const idx = v * K + q, o3 = idx * 3, o = idx * 16;
        recipeFiberDir(dir, ux, uy, uz, a, rv[o3], rv[o3 + 1], rv[o3 + 2]);
        const dx = dir[0], dy = dir[1], dz = dir[2];
        let ax, ay, az;
        if (dx < 0.9 && dx > -0.9) { const inv = 1 / Math.sqrt(dy * dy + dz * dz); ax = 0; ay = dz * inv; az = -dy * inv; }
        else { const inv = 1 / Math.sqrt(dx * dx + dz * dz); ax = -dz * inv; ay = 0; az = dx * inv; }
        const bx = dy * az - dz * ay, by = dz * ax - dx * az, bz = dx * ay - dy * ax;
        const rr = rad * jit[idx * 2 + 1], ll = len * jit[idx * 2];
        M[o] = ax * rr; M[o + 1] = ay * rr; M[o + 2] = az * rr; M[o + 3] = 0;
        M[o + 4] = dx * ll; M[o + 5] = dy * ll; M[o + 6] = dz * ll; M[o + 7] = 0;
        M[o + 8] = bx * rr; M[o + 9] = by * rr; M[o + 10] = bz * rr; M[o + 11] = 0;
        M[o + 12] = base[o3]; M[o + 13] = base[o3 + 1]; M[o + 14] = base[o3 + 2]; M[o + 15] = 1;
        C[o3] = cr; C[o3 + 1] = cg; C[o3 + 2] = cb;
      }
      visible += K;
    }
    F.mesh.instanceMatrix.needsUpdate = true;
    F.mesh.instanceColor.needsUpdate = true;
    this.stats.fibersVisible = visible;
  }

  // Σ of a species group at voxel v → density and mixed colour (written into this._mix).
  _mixSpecies(defs, arrs, v) {
    let d = 0, cr = 0, cg = 0, cb = 0;
    for (let s = 0; s < arrs.length; s++) {
      const arr = arrs[s]; if (!arr || v >= arr.length) continue;
      const w = arr[v]; if (!(w > 0)) continue;
      const col = defs[s].col;
      d += w; cr += w * col[0]; cg += w * col[1]; cb += w * col[2];
    }
    const mx = this._mix;
    if (d > 0) { const inv = 1 / d; mx[0] = cr * inv; mx[1] = cg * inv; mx[2] = cb * inv; }
    else if (defs.length) { const col = defs[0].col; mx[0] = col[0]; mx[1] = col[1]; mx[2] = col[2]; }
    else { mx[0] = mx[1] = mx[2] = 0.7; }
    return d;
  }

  /**
   * Mark the voxels that hold a cell (≈ one cell radius at N = 12), so the haze can be thinned
   * there and a cell of the same hue as the gel still reads. Returns the mask or null.
   */
  _cellOccupancy(state, G, N) {
    const occ = G.occ;
    if (!this._gelFade || !occ || !state.cx) return null;
    occ.fill(0);
    let n = state.nCells | 0;
    n = Math.min(n, (state.cx.length / 3) | 0);
    const X = state.cx, invL = state.L > 0 ? 1 / state.L : 1;
    for (let i = 0; i < n; i++) {
      let a = (X[3 * i] * invL * N) | 0, b = (X[3 * i + 1] * invL * N) | 0, c = (X[3 * i + 2] * invL * N) | 0;
      a = a < 0 ? 0 : a >= N ? N - 1 : a; b = b < 0 ? 0 : b >= N ? N - 1 : b; c = c < 0 ? 0 : c >= N ? N - 1 : c;
      occ[(a * N + b) * N + c] = 1;
    }
    return occ;
  }

  _updateGel(state) {
    const G = this.gel, V = G.V, h = G.h, defs = this._gelSp, arrs = this._gelArr;
    const minD = this._gelHint.minDensity !== null ? this._gelHint.minDensity : this.opts.gelMin;
    const occ = this._cellOccupancy(state, G, this._gridN);
    const keep = 1 - this._gelFade;
    let visible = 0;
    if (G.points) {
      const A = G.valAttr.array, C = G.colAttr.array;
      for (let v = 0; v < V; v++) {
        const d = this._mixSpecies(defs, arrs, v);
        if (!(d >= minD)) { A[v] = 0; continue; }
        A[v] = (d > 1 ? 1 : d) * (occ && occ[v] ? keep : 1);
        const mx = this._mix; C[3 * v] = mx[0]; C[3 * v + 1] = mx[1]; C[3 * v + 2] = mx[2];
        visible++;
      }
      G.valAttr.needsUpdate = true; G.colAttr.needsUpdate = true;
      this.stats.gelVisible = visible;
      return;
    }
    const M = G.mesh.instanceMatrix.array, C = G.mesh.instanceColor.array, AL = G.alpha.array;
    const jit = G.jit, cen = G.centers, size = this.opts.gelSize * h * this._gelHint.radiusScale;
    for (let v = 0; v < V; v++) {
      const d = this._mixSpecies(defs, arrs, v);
      const o = v * 16;
      if (!(d >= minD)) { M[o] = M[o + 5] = M[o + 10] = 0; M[o + 1] = M[o + 2] = M[o + 4] = M[o + 6] = M[o + 8] = M[o + 9] = 0; AL[v] = 0; continue; }
      const s = size * Math.cbrt(d > 1.5 ? 1.5 : d) * jit[4 * v + 3];
      M[o] = s; M[o + 1] = 0; M[o + 2] = 0; M[o + 3] = 0;
      M[o + 4] = 0; M[o + 5] = s; M[o + 6] = 0; M[o + 7] = 0;
      M[o + 8] = 0; M[o + 9] = 0; M[o + 10] = s; M[o + 11] = 0;
      // jittered centre, clamped so the sphere stays inside the block (no haze bulging past the faces)
      const lo = s < 0.5 ? s : 0.5, hi = 1 - lo;
      let px = cen[3 * v] + jit[4 * v] * h, py = cen[3 * v + 1] + jit[4 * v + 1] * h, pz = cen[3 * v + 2] + jit[4 * v + 2] * h;
      px = px < lo ? lo : px > hi ? hi : px; py = py < lo ? lo : py > hi ? hi : py; pz = pz < lo ? lo : pz > hi ? hi : pz;
      M[o + 12] = px; M[o + 13] = py; M[o + 14] = pz; M[o + 15] = 1;
      const mx = this._mix; C[3 * v] = mx[0]; C[3 * v + 1] = mx[1]; C[3 * v + 2] = mx[2];
      AL[v] = (d > 1 ? 1 : d) * (occ && occ[v] ? keep : 1);
      visible++;
    }
    G.mesh.instanceMatrix.needsUpdate = true; G.mesh.instanceColor.needsUpdate = true; G.alpha.needsUpdate = true;
    this.stats.gelVisible = visible;
  }

  // Fill per-voxel density + mixed colour scratch arrays for a species group (single-species fast path).
  _voxelMix(defs, arrs, vd, vc, V) {
    const nSp = arrs.length;
    if (nSp === 1) {
      const arr = arrs[0], col = defs[0].col, n = arr ? Math.min(V, arr.length) : 0;
      for (let v = 0; v < n; v++) { const w = arr[v]; vd[v] = w > 0 ? w : 0; }
      for (let v = n; v < V; v++) vd[v] = 0;
      for (let v = 0; v < V; v++) { vc[3 * v] = col[0]; vc[3 * v + 1] = col[1]; vc[3 * v + 2] = col[2]; }
      return;
    }
    for (let v = 0; v < V; v++) {
      vd[v] = this._mixSpecies(defs, arrs, v);
      const mx = this._mix; vc[3 * v] = mx[0]; vc[3 * v + 1] = mx[1]; vc[3 * v + 2] = mx[2];
    }
  }

  _updateScaffold(state) {
    const S = this.scaffold, n = S.count, h = S.h, V = S.V;
    const M = S.mesh.instanceMatrix.array, C = S.mesh.instanceColor.array, AL = S.alpha.array;
    const mid = S.mid, len = S.len, axis = S.axis, va = S.va, vb = S.vb, vd = S.vd, vc = S.vc;
    const minD = this._scafHint.minDensity !== null ? this._scafHint.minDensity : this.opts.scaffoldMin;
    const rMul = this.opts.scaffoldRadius * h * this._scafHint.radiusScale, rMin = this.opts.scaffoldMinRadius * h;
    const rExp = this.opts.scaffoldRadiusExp, aExp = this.opts.scaffoldAlphaExp, sqrtR = rExp === 0.5;
    const brk = this.opts.scaffoldBreak, brkInv = brk > 0 ? 1 / brk : 0;
    this._voxelMix(this._scafSp, this._scafArr, vd, vc, V);
    let visible = 0;
    for (let s = 0; s < n; s++) {
      const a = va[s], b = vb[s];
      let d = vd[a], cr = vc[3 * a], cg = vc[3 * a + 1], cb = vc[3 * a + 2];
      if (b >= 0) {
        const d2 = vd[b], w = d + d2;
        if (w > 0) { const inv = 1 / w; cr = (cr * d + vc[3 * b] * d2) * inv; cg = (cg * d + vc[3 * b + 1] * d2) * inv; cb = (cb * d + vc[3 * b + 2] * d2) * inv; }
        d = 0.5 * w;
      }
      const o = s * 16;
      if (!(d >= minD)) { TissueRenderer._hideRange(M, s, 1); AL[s] = 0; continue; }
      const dd = d > 1 ? 1 : d;
      const r = Math.max(rMin, rMul * (sqrtR ? Math.sqrt(dd) : Math.pow(dd, rExp)));
      // below `scaffoldBreak` the strut shortens about its midpoint: the lattice fragments at the nodes
      const L = (dd < brk) ? len[s] * (0.3 + 0.7 * dd * brkInv) : len[s];
      const ax = axis[s];
      // cylinder axis is local +Y → map onto world axis `ax`; the two radial axes are the others
      M[o + 3] = 0; M[o + 7] = 0; M[o + 11] = 0; M[o + 15] = 1;
      M[o] = M[o + 1] = M[o + 2] = M[o + 4] = M[o + 5] = M[o + 6] = M[o + 8] = M[o + 9] = M[o + 10] = 0;
      if (ax === 0) { M[o + 4] = L; M[o + 1] = r; M[o + 10] = r; }        // Y→x, X→y, Z→z
      else if (ax === 1) { M[o + 5] = L; M[o] = r; M[o + 10] = r; }       // Y→y
      else { M[o + 6] = L; M[o] = r; M[o + 9] = r; }                      // Y→z, X→x, Z→y
      M[o + 12] = mid[3 * s]; M[o + 13] = mid[3 * s + 1]; M[o + 14] = mid[3 * s + 2];
      C[3 * s] = cr; C[3 * s + 1] = cg; C[3 * s + 2] = cb;
      AL[s] = Math.pow(dd, aExp);
      visible++;
    }
    S.mesh.instanceMatrix.needsUpdate = true; S.mesh.instanceColor.needsUpdate = true; S.alpha.needsUpdate = true;
    this.stats.strutsVisible = visible;
  }

  _updateCells(state) {
    let n = state.nCells | 0;
    if (state.ca) n = Math.min(n, state.ca.length);
    if (state.cx) n = Math.min(n, (state.cx.length / 3) | 0); else n = 0;
    if (n > this.cells.capacity) this._buildCells(Math.max(n, this.cells.capacity * 2));
    const mesh = this.cells.mesh;
    const M = mesh.instanceMatrix.array, C = mesh.instanceColor.array;
    const X = state.cx, P = state.cp, A = state.ca, B = state.cb, TY = state.ctype;
    const types = this._cellTypes, nTypes = types.length;
    const invL = state.L > 0 ? 1 / state.L : 1;
    const ex = this.opts.cellAspectExp, lutMax = RENDER_LUT_N - 1;
    for (let i = 0; i < n; i++) {
      const o3 = i * 3, o = i * 16;
      let ty = TY ? TY[i] : 0; if (!(ty >= 0 && ty < nTypes)) ty = 0;
      const T = types[ty];
      let al = A ? A[i] : 0;
      if (!(al > 0)) al = 0; else if (al > 1) al = 1;
      let bl = B ? B[i] : 0;
      if (!(bl > 0)) bl = 0; else if (bl > 1) bl = 1;
      const sh = T.by === 1 ? bl : al;
      const rad = T.rBy < 0 ? T.rMin : T.rMin + (T.rMax - T.rMin) * (T.rBy === 1 ? bl : al);
      let px = P ? P[o3] : 1, py = P ? P[o3 + 1] : 0, pz = P ? P[o3 + 2] : 0;
      const pl = px * px + py * py + pz * pz;
      if (!(pl > 1e-12)) { px = 1; py = 0; pz = 0; }
      else if (Math.abs(pl - 1) > 1e-4) { const inv = 1 / Math.sqrt(pl); px *= inv; py *= inv; pz *= inv; }
      const asp = T.aMin + (T.aMax - T.aMin) * sh;
      const a = rad * Math.pow(asp, ex), b = rad * Math.pow(asp, ex - 1);
      let ax, ay, az;
      if (px < 0.9 && px > -0.9) { const inv = 1 / Math.sqrt(py * py + pz * pz); ax = 0; ay = pz * inv; az = -py * inv; }
      else { const inv = 1 / Math.sqrt(px * px + pz * pz); ax = -pz * inv; ay = 0; az = px * inv; }
      const bx = py * az - pz * ay, by = pz * ax - px * az, bz = px * ay - py * ax;
      M[o] = px * a; M[o + 1] = py * a; M[o + 2] = pz * a; M[o + 3] = 0;
      M[o + 4] = ax * b; M[o + 5] = ay * b; M[o + 6] = az * b; M[o + 7] = 0;
      M[o + 8] = bx * b; M[o + 9] = by * b; M[o + 10] = bz * b; M[o + 11] = 0;
      M[o + 12] = X[o3] * invL; M[o + 13] = X[o3 + 1] * invL; M[o + 14] = X[o3 + 2] * invL; M[o + 15] = 1;
      // colour: LUT lookup with linear interpolation between neighbouring entries
      const lut = T.lut, f = al * lutMax, i0 = f | 0, i1 = i0 < lutMax ? i0 + 1 : i0, w = f - i0;
      C[o3] = lut[3 * i0] + (lut[3 * i1] - lut[3 * i0]) * w;
      C[o3 + 1] = lut[3 * i0 + 1] + (lut[3 * i1 + 1] - lut[3 * i0 + 1]) * w;
      C[o3 + 2] = lut[3 * i0 + 2] + (lut[3 * i1 + 2] - lut[3 * i0 + 2]) * w;
    }
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.stats.cells = n;
  }

  _updateField(layer, field) {
    const a = layer.attr.array;
    if (field.length === a.length) a.set(field);
    else { const n = Math.min(a.length, field.length); for (let i = 0; i < n; i++) a[i] = field[i]; }
    layer.attr.needsUpdate = true;
  }

  // `load` is the raw dial value; the arrows show it normalised over the dial's own
  // [min, max] (0–1 strain, 0–0.2 compression — both read as "none … full").
  _updateLoad(load) {
    const L = this.load;
    if (!this._loadKey) { L.group.visible = false; return; }
    let s = (+load - this._loadMin) / this._loadSpan;
    if (!(s > 0)) s = 0; else if (s > 1) s = 1;
    L.group.visible = s >= 0.02;
    if (!L.group.visible) return;
    const len = 0.10 + 0.22 * s, th = 0.5 + 0.7 * s; // keep the arrows clear of the HUD text
    L.top.scale.set(th, len, th);
    L.bottom.scale.set(th, len, th);
    L.arrowMat.opacity = 0.35 + 0.45 * s;
    L.plateMat.opacity = 0.02 + 0.06 * s;
  }

  // ---------------------------------------------------------------------------
  // legend

  /**
   * [{ key, kind, label, css }] — CSS colour/gradient strings for the app legend (E4).
   * Each colour is the definition's own hex (saturation factors default to 1.0) put through
   * THIS renderer's exposure and tone curve on the CPU, then encoded to sRGB — the same two
   * steps the GPU applies to an unlit surface of that colour, so the swatch and the thing it
   * labels agree to ≤ 1/255 per channel (tools/render_smoke.mjs checks it against the GPU).
   * Scene lighting, the rim term and the depth cue are deliberately NOT applied: they vary per
   * pixel, and a legend that dimmed with the fog would stop being a key.
   */
  legendSwatches() {
    const out = [];
    for (const s of this._fiberSp) out.push({ key: `species:${s.key}`, kind: 'fiber', label: s.label, css: this._swatchCss(s.col) });
    for (const s of this._gelSp) {
      const c = this._swatchCss(s.col), c2 = this._swatchCss(s.col, 0.45);
      out.push({ key: `species:${s.key}`, kind: 'gel', label: s.label, css: `radial-gradient(circle at 50% 50%, ${c} 0%, ${c2} 45%, transparent 78%)` });
    }
    for (const s of this._scafSp) {
      const c = this._swatchCss(s.col);
      out.push({ key: `species:${s.key}`, kind: 'scaffold', label: s.label,
        css: `repeating-linear-gradient(90deg, ${c} 0 2px, transparent 2px 7px), repeating-linear-gradient(0deg, ${c} 0 2px, transparent 2px 7px)` });
    }
    for (const T of this._cellTypes) {
      const stops = [];
      for (let i = 0; i <= 4; i++) {
        const j = Math.round((RENDER_LUT_N - 1) * i / 4);
        stops.push(`${this._swatchCss([T.lut[3 * j], T.lut[3 * j + 1], T.lut[3 * j + 2]])} ${i * 25}%`);
      }
      out.push({ key: `cell:${T.key}`, kind: 'cell', label: T.label, css: `linear-gradient(90deg, ${stops.join(', ')})` });
    }
    for (const f of this._fieldDefs) {
      out.push({ key: `field:${f.key}`, kind: 'field', label: f.label,
        css: `radial-gradient(circle at 50% 50%, ${this._swatchCss(f.col)} 0%, ${this._swatchCss(f.col, 0.55)} 40%, transparent 75%)` });
    }
    if (this._loadKey) {
      const d = (this.tissue && this.tissue.dials || []).find((x) => x.key === this._loadKey);
      out.push({ key: `load:${this._loadKey}`, kind: 'load', label: (d && d.label) || 'Load', css: this._swatchCss(TissueRenderer._lin(this.opts.loadColor, 1)) });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // frame

  render() {
    if (this._disposed) return;
    this.controls.update();
    const d = this.camera.position.distanceTo(this.controls.target);
    this.scene.fog.near = d - 0.25;
    this.scene.fog.far = d + this.opts.fogDepth;
    this._uCamDir.value.copy(this.camera.position).sub(this.center).normalize();
    this.renderer.render(this.scene, this.camera);
  }

  /** Auto-rotate on/off. Fires opts.onAutoRotate(on) when the value actually changes (B3), so a
   *  UI toggle stays in sync when the renderer stops rotating by itself (pointerdown, keydown). */
  setAutoRotate(on) {
    const v = !!on;
    if (this.controls.autoRotate === v) return;
    this.controls.autoRotate = v;
    const cb = this.opts.onAutoRotate;
    if (typeof cb === 'function') cb(v);
  }

  /** Default framing: target back on the cube's centre, camera on the default direction. */
  resetView() {
    if (this._disposed) return;
    this.controls.target.copy(this.center);
    this.camera.up.set(0, 0, 1);
    this._tmpV.copy(this._viewDir).multiplyScalar(this._fitDist).add(this.center);
    this.camera.position.copy(this._tmpV);
    this.camera.lookAt(this.center);
    this.controls.update();
  }

  /**
   * Orbit the camera around controls.target by (dTheta, dPhi) radians, in the same y-up spherical
   * frame OrbitControls uses (so "up" is camera.up = +z here). No allocation, no private
   * OrbitControls state: move camera.position, then let controls.update() re-derive its own.
   */
  _orbit(dTheta, dPhi) {
    const t = this.controls.target;
    const off = this._tmpV.copy(this.camera.position).sub(t).applyQuaternion(this._upQuat);
    const sp = this._sph.setFromVector3(off);
    sp.theta += dTheta;
    const eps = 1e-4;
    sp.phi = Math.min(Math.PI - eps, Math.max(eps, sp.phi + dPhi));
    sp.makeSafe();
    off.setFromSpherical(sp).applyQuaternion(this._upQuatInv);
    this.camera.position.copy(t).add(off);
    this.camera.lookAt(t);
    this.controls.update();
  }

  /** Dolly by a distance factor (>1 = further away), clamped to the controls' min/max distance. */
  _dolly(factor) {
    const t = this.controls.target;
    const off = this._tmpV.copy(this.camera.position).sub(t);
    const d = off.length() * factor;
    off.setLength(Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, d)));
    this.camera.position.copy(t).add(off);
    this.controls.update();
  }

  /**
   * Keyboard camera on the focused canvas (B2/B3). Arrows orbit, +/− dolly, Home reframes. The
   * directions are three's own OrbitControls key mapping, which its rotateLeft/rotateUp would
   * have produced: ArrowUp/ArrowDown move the camera toward the +z / −z pole (phi ∓ step),
   * ArrowLeft/ArrowRight swing the azimuth (theta ∓ step). Every other key is left for the app's
   * shortcuts (Space, R, I, digits) and never sees preventDefault; a modifier chord is ignored
   * so browser shortcuts keep working. Any real key press stops auto-rotate, exactly as a
   * pointerdown does — that is the WCAG 2.2.2 "stop the motion" mechanism for keyboard users.
   */
  _handleKey(e) {
    if (this._disposed || e.defaultPrevented) return;
    const k = e.key;
    if (k === 'Tab' || k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'CapsLock') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    this.setAutoRotate(false);
    const rot = +this.opts.keyOrbitStep || 0, dolly = +this.opts.keyDollyStep || 1;
    if (k === 'ArrowLeft') this._orbit(-rot, 0);
    else if (k === 'ArrowRight') this._orbit(rot, 0);
    else if (k === 'ArrowUp') this._orbit(0, -rot);
    else if (k === 'ArrowDown') this._orbit(0, rot);
    else if (k === '+' || k === '=' || k === 'Add') this._dolly(1 / dolly);
    else if (k === '-' || k === '_' || k === 'Subtract') this._dolly(dolly);
    else if (k === 'Home') this.resetView();
    else return;               // not ours: no preventDefault, the app still gets it
    e.preventDefault();
  }

  // PNG data URL of the current frame (renders first so no preserveDrawingBuffer needed).
  screenshot() {
    this.render();
    return this.canvas.toDataURL('image/png');
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._ro) this._ro.disconnect();
    if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('keydown', this._onCanvasKey);
    this.controls.dispose();
    this._disposeGrid();
    if (this.cells) { this.scene.remove(this.cells.mesh); this.cells.geo.dispose(); this.cells.mesh.dispose(); this.cells = null; }
    this.fiberMat.dispose();
    this.cellMat.dispose();
    this.gelMat.dispose();
    this.scaffoldMat.dispose();
    this._wire.geo.dispose(); this._wire.mat.dispose();
    if (this.woundMarker) {
      this.scene.remove(this.woundMarker.obj);
      this.woundMarker.geo.dispose(); this.woundMarker.mat.dispose();
      if (this.woundMarker.ghostMat) this.woundMarker.ghostMat.dispose();
      this.woundMarker = null;
    }
    for (const g of this.load.geos) g.dispose();
    this.load.arrowMat.dispose(); this.load.plateMat.dispose();
    this.renderer.dispose();
  }
}
