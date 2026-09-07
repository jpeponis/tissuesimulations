// Tissue Weather — 3D renderer (SPEC 1.9). ES module, named exports only.
// Consumes the model state (SPEC 1.1–1.2) and draws fibers, cells, optional
// g/m point clouds, load arrows and the domain cube with three.js r160.
//
// Public API:
//   new TissueRenderer(canvasEl, opts)  opts: { K, rCell, maxCells, maxPixelRatio, seed,
//                                       autoRotate, autoRotateSpeed, background, fov,
//                                       toneMapping: 'aces'|'agx'|'none', exposure, fogDepth,
//                                       ...look tuning, see the defaults in the constructor }
//   .resize()                    fit canvas to its parent (also automatic via ResizeObserver)
//   .update(state, layers)       copy state → instances; layers {fibers, cells, g, m}
//   .render()                    one frame (controls damping/autorotate + draw)
//   .setAutoRotate(bool)
//   .screenshot()                → PNG data URL of the current frame
//   .dispose()
//   .stats                       read-only { updateMs, fibersVisible, cells }
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const RENDER_POINT_VERT = `
attribute float aVal;
uniform float uScale;
uniform float uSize;
uniform float uMinVal;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  float v = clamp( aVal, 0.0, 1.0 );
  vA = v;
  float size = ( v < uMinVal ) ? 0.0 : uSize * ( 0.35 + 0.65 * v );
  gl_PointSize = clamp( size * uScale / max( -mv.z, 0.05 ), 0.0, 160.0 );
  gl_Position = projectionMatrix * mv;
}`;

const RENDER_POINT_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float soft = exp( -dot( q, q ) * 8.0 ) * smoothstep( 0.5, 0.42, length( q ) );
  float a = soft * uOpacity * ( 0.2 + 0.8 * vA );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class TissueRenderer {
  constructor(canvasEl, opts = {}) {
    this.canvas = canvasEl;
    this.opts = Object.assign({
      K: 3,                 // fiber instances per voxel
      rCell: 0.03,          // cell radius (L units), SPEC 1.4
      maxCells: 512,        // initial instance capacity (grows on demand)
      maxPixelRatio: 2,
      seed: 90210,
      autoRotate: true,
      autoRotateSpeed: 0.5, // OrbitControls units: 2.0 = 30 s per orbit
      background: 0x0b0f14,
      fov: 36,
      toneMapping: 'aces',
      exposure: 1.0,
      minRho: 0.03,         // hide fibers below this density
      fogDepth: 2.8,        // fog fully in at (camera distance + fogDepth); smaller = stronger depth cue
      // Look tuning. Defaults were chosen from headless screenshot comparisons
      // (tools/render_smoke.mjs); SPEC 1.9 numbers are the reference the scales multiply.
      fiberRadiusScale: 0.6,  // × SPEC radius 0.12 h sqrt(rho)  (1.0 looked like matchsticks)
      fiberLengthScale: 1.35, // × SPEC length h (0.5 + 0.9 FA)  (longer threads weave across voxels)
      fiberMinRadius: 0.025,  // × h, floor so sparse fibers stay visible hairlines
      fiberShape: 'cylinder', // 'cylinder' | 'capsule'
      fiberRoughness: 0.5, fiberEmissive: 0.2, fiberRim: 0.5,
      fiberAlbedo: 1.0, fiberSaturation: 1.25,   // albedo compensation: lit+tone-mapped colour desaturates
      cellRoughness: 0.55, cellEmissive: 0.35, cellRim: 0.45,
      cellAlbedo: 0.55, cellSaturation: 1.15,
      cellColorMid: null,     // e.g. '#f2f2f2' for a diverging blue→pale→orange ramp (default: straight lerp)
      keyIntensity: 1.6, fillIntensity: 0.3, hemiIntensity: 0.55,
      keyColor: 0xfff1dc, fillColor: 0x8fb0ff, hemiSky: 0xc9d6ea, hemiGround: 0x3a2a1c,
      pointBlending: 'normal', // 'normal' | 'additive'  (additive turns teal+magenta into white)
      pointOpacity: 0.45, pointSize: 1.8, // g/m point clouds (size × h); 0.45 reads as a haze, additive blooms white
      wireColor: 0x4a5a70,
    }, opts);
    this.stats = { updateMs: 0, fibersVisible: 0, cells: 0 };
    this._disposed = false;

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
    this._tmpV.set(0.64, -0.70, 0.32).normalize().multiplyScalar(2.75).add(this.center);
    camera.position.copy(this._tmpV);
    camera.lookAt(this.center);
    this.camera = camera;

    const controls = new OrbitControls(camera, canvasEl);
    controls.target.copy(this.center);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 1.0;
    controls.maxDistance = 9;
    controls.autoRotate = !!this.opts.autoRotate;
    controls.autoRotateSpeed = this.opts.autoRotateSpeed;
    controls.update();
    this.controls = controls;
    this._onPointerDown = () => { this.controls.autoRotate = false; };
    canvasEl.addEventListener('pointerdown', this._onPointerDown, { passive: true });

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

    // --- colours (linear working space) ---------------------------------------
    const c = new THREE.Color();
    const lin = (hex, sat) => { c.set(hex); return TissueRenderer._saturate([c.r, c.g, c.b], sat); };
    this._cNew = lin('#cfe8ff', this.opts.fiberSaturation);
    this._cMat = lin('#e0a24a', this.opts.fiberSaturation);
    this._cQui = lin('#4ea3ff', this.opts.cellSaturation);
    this._cAct = lin('#ff7a3d', this.opts.cellSaturation);
    this._cMid = this.opts.cellColorMid ? lin(this.opts.cellColorMid, 1) : null;

    // --- materials ------------------------------------------------------------
    this._uRimFiber = { value: this.opts.fiberRim };
    this._uRimPowFiber = { value: 2.5 };
    this._uRimCell = { value: this.opts.cellRim };
    this._uRimPowCell = { value: 3.0 };
    this.fiberMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setScalar(this.opts.fiberAlbedo), roughness: this.opts.fiberRoughness, metalness: 0.04,
      emissive: 0xffffff, emissiveIntensity: this.opts.fiberEmissive,
    });
    TissueRenderer._patchInstanceGlow(this.fiberMat, this._uRimFiber, this._uRimPowFiber);
    this.cellMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setScalar(this.opts.cellAlbedo), roughness: this.opts.cellRoughness, metalness: 0.0,
      emissive: 0xffffff, emissiveIntensity: this.opts.cellEmissive,
    });
    TissueRenderer._patchInstanceGlow(this.cellMat, this._uRimCell, this._uRimPowCell);

    // --- static scenery: wire cube, load arrows ------------------------------
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const wireMat = new THREE.LineBasicMaterial({ color: this.opts.wireColor, transparent: true, opacity: 0.85 });
    const wire = new THREE.LineSegments(edges, wireMat);
    wire.position.copy(this.center);
    scene.add(wire);
    this._wire = { geo: edges, mat: wireMat, obj: wire };
    this._buildLoad();

    // --- dynamic content -----------------------------------------------------
    this.fibers = null;
    this.fields = null;
    this.cells = null;
    this._buildCells(this.opts.maxCells);

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

  // Tint the constant emissive by the per-instance colour and add a rim term,
  // so fibers/cells never go black on their shadow side and read as a "cloud".
  static _patchInstanceGlow(material, uRim, uRimPow) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRim = uRim;
      shader.uniforms.uRimPow = uRimPow;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uRim;\nuniform float uRimPow;')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n' +
          '#ifdef USE_COLOR\n' +
          '  totalEmissiveRadiance *= vColor;\n' +
          '  float rrRim = pow( 1.0 - saturate( abs( dot( normalize( vViewPosition ), normal ) ) ), uRimPow );\n' +
          '  totalEmissiveRadiance += vColor * uRim * rrRim;\n' +
          '#endif');
    };
    material.customProgramCacheKey = () => 'tissue-instance-glow';
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

  _buildLoad() {
    const group = new THREE.Group();
    const arrowMat = new THREE.MeshStandardMaterial({
      color: 0xd6f26b, emissive: 0xd6f26b, emissiveIntensity: 0.35, roughness: 0.5,
      transparent: true, opacity: 0.6, depthWrite: false,
    });
    const plateMat = new THREE.MeshBasicMaterial({
      color: 0xd6f26b, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide,
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
    group.visible = false;
    this.scene.add(group);
    this.load = { group, top, bottom, arrowMat, plateMat, geos: [shaftGeo, coneGeo, plateGeo] };
  }

  _disposeFibers() {
    if (!this.fibers) return;
    this.scene.remove(this.fibers.mesh);
    this.fibers.geo.dispose();
    this.fibers.mesh.dispose();
    this.fibers = null;
    if (this.fields) {
      for (const L of [this.fields.g, this.fields.m]) {
        this.scene.remove(L.points);
        L.geo.dispose();
        L.mat.dispose();
      }
      this.fields = null;
    }
  }

  // Fixed per-instance jitter: offset inside the voxel, random unit vector r_j,
  // and mild length/radius variation. Rebuilt only when N changes.
  _buildFibers(N) {
    this._disposeFibers();
    const K = this.opts.K, V = N * N * N, count = V * K, h = 1 / N;
    const rand = TissueRenderer._rng(this.opts.seed);
    const base = new Float32Array(count * 3);
    const rvec = new Float32Array(count * 3);
    const jit = new Float32Array(count * 2);
    const centers = new Float32Array(V * 3);
    for (let v = 0; v < V; v++) {
      const i = (v / (N * N)) | 0, j = ((v / N) | 0) % N, k = v % N;
      const cx = (i + 0.5) * h, cy = (j + 0.5) * h, cz = (k + 0.5) * h;
      centers[3 * v] = cx; centers[3 * v + 1] = cy; centers[3 * v + 2] = cz;
      for (let q = 0; q < K; q++) {
        const o = v * K + q;
        base[3 * o] = cx + (rand() - 0.5) * 0.9 * h;
        base[3 * o + 1] = cy + (rand() - 0.5) * 0.9 * h;
        base[3 * o + 2] = cz + (rand() - 0.5) * 0.9 * h;
        const z = rand() * 2 - 1, ph = rand() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - z * z));
        rvec[3 * o] = s * Math.cos(ph); rvec[3 * o + 1] = s * Math.sin(ph); rvec[3 * o + 2] = z;
        jit[2 * o] = 0.78 + 0.5 * rand();      // length factor
        jit[2 * o + 1] = 0.85 + 0.3 * rand();  // radius factor
      }
    }
    // Local +Y is the fiber axis. Capsule: rounded (spindle-like after anisotropic scale) ends.
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

    // g / m point clouds share the voxel-centre positions.
    const posAttr = new THREE.BufferAttribute(centers, 3);
    const mkLayer = (hex, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', posAttr);
      const attr = new THREE.BufferAttribute(new Float32Array(V), 1);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aVal', attr);
      g.boundingSphere = new THREE.Sphere(this.center.clone(), 1);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(hex) },
          uOpacity: { value: opacity },
          uSize: { value: this.opts.pointSize * h },
          uMinVal: { value: 0.02 },
          uScale: { value: 400 },
        },
        vertexShader: RENDER_POINT_VERT,
        fragmentShader: RENDER_POINT_FRAG,
        transparent: true, depthWrite: false, depthTest: true,
        blending: this.opts.pointBlending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const points = new THREE.Points(g, mat);
      points.frustumCulled = false;
      points.visible = false;
      this.scene.add(points);
      return { points, geo: g, mat, attr };
    };
    this.fields = { g: mkLayer('#2ee6c8', this.opts.pointOpacity), m: mkLayer('#ff4fd8', this.opts.pointOpacity) };
    this._updatePointScale();
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
    if (!this.fields) return;
    const hPx = this.renderer.domElement.height;  // drawing-buffer pixels
    const s = hPx / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5));
    this.fields.g.mat.uniforms.uScale.value = s;
    this.fields.m.mat.uniforms.uScale.value = s;
  }

  resize() {
    if (this._disposed) return;
    const canvas = this.canvas;
    const parent = canvas.parentElement;
    let w = parent ? parent.clientWidth : canvas.clientWidth;
    let h = parent ? parent.clientHeight : canvas.clientHeight;
    if (!(w > 0) || !(h > 0)) return;
    w = Math.floor(w); h = Math.floor(h);
    const dpr = Math.min(window.devicePixelRatio || 1, this.opts.maxPixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._updatePointScale();
  }

  // Copy model state into instance matrices/colours. No per-instance allocations.
  update(state, layers = { fibers: true, cells: true, g: false, m: false }) {
    if (this._disposed || !state) return;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    const showF = layers.fibers !== false;
    const showC = layers.cells !== false;
    const showG = !!layers.g;
    const showM = !!layers.m;
    const N = state.N | 0;
    if (N > 0 && (!this.fibers || this.fibers.N !== N)) this._buildFibers(N);

    if (this.fibers) {
      this.fibers.mesh.visible = showF;
      if (showF) this._updateFibers(state);
      this.fields.g.points.visible = showG;
      this.fields.m.points.visible = showM;
      if (showG && state.g) this._updateField(this.fields.g, state.g);
      if (showM && state.m) this._updateField(this.fields.m, state.m);
    }
    if (showC) this._updateCells(state); else this.cells.mesh.visible = false;
    this._updateLoad(state.dials ? state.dials.strain : 0);
    if (t0) this.stats.updateMs = performance.now() - t0;
  }

  _updateFibers(state) {
    const F = this.fibers, K = F.K, V = F.V, h = F.h;
    const M = F.mesh.instanceMatrix.array, C = F.mesh.instanceColor.array;
    const rho = state.rho, rhoMat = state.rhoMat, fa = state.fa;
    if (!rho) { TissueRenderer._hideRange(M, 0, F.count); F.mesh.instanceMatrix.needsUpdate = true; this.stats.fibersVisible = 0; return; }
    const fx = state.fx, fy = state.fy, fz = state.fz;
    const base = F.base, rv = F.rvec, jit = F.jit;
    const cN = this._cNew, cM = this._cMat;
    const rMul = 0.12 * h * this.opts.fiberRadiusScale, minRho = this.opts.minRho;
    const rMin = this.opts.fiberMinRadius * h;
    const lMul = h * this.opts.fiberLengthScale / F.geoHeight;
    const nV = Math.min(V, rho.length);
    let visible = 0;
    for (let v = 0; v < V; v++) {
      let r = v < nV ? rho[v] : 0;
      if (!(r >= minRho)) { TissueRenderer._hideRange(M, v * K, K); continue; }
      if (r > 2) r = 2;
      let a = fa ? fa[v] : 0;
      if (!(a > 0)) a = 0; else if (a > 1) a = 1;
      let ux = fx ? fx[v] : 0, uy = fy ? fy[v] : 0, uz = fz ? fz[v] : 1;
      const ul = ux * ux + uy * uy + uz * uz;
      if (!(ul > 1e-12)) { a = 0; ux = 0; uy = 0; uz = 1; }
      else if (Math.abs(ul - 1) > 1e-4) { const inv = 1 / Math.sqrt(ul); ux *= inv; uy *= inv; uz *= inv; }
      const rad = Math.max(rMin, rMul * Math.sqrt(r)), len = lMul * (0.5 + 0.9 * a);
      let phi = rhoMat ? rhoMat[v] / r : 0;
      if (!(phi > 0)) phi = 0; else if (phi > 1) phi = 1;
      const cue = 0.6 + 0.4 * Math.min(r, 1);
      const cr = (cN[0] + (cM[0] - cN[0]) * phi) * cue;
      const cg = (cN[1] + (cM[1] - cN[1]) * phi) * cue;
      const cb = (cN[2] + (cM[2] - cN[2]) * phi) * cue;
      const ia = 1 - a;
      for (let q = 0; q < K; q++) {
        const idx = v * K + q, o3 = idx * 3, o = idx * 16;
        const rx = rv[o3], ry = rv[o3 + 1], rz = rv[o3 + 2];
        const s = (ux * rx + uy * ry + uz * rz) < 0 ? -a : a;   // f_signed = f * sign(f·r)
        let dx = s * ux + ia * rx, dy = s * uy + ia * ry, dz = s * uz + ia * rz;
        const dl = dx * dx + dy * dy + dz * dz;
        if (dl < 1e-10) { dx = rx; dy = ry; dz = rz; }
        else { const inv = 1 / Math.sqrt(dl); dx *= inv; dy *= inv; dz *= inv; }
        // orthonormal frame (u, d, w): cylinder axis is local +Y
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

  _updateCells(state) {
    let n = state.nCells | 0;
    if (state.alpha) n = Math.min(n, state.alpha.length);
    if (state.cx) n = Math.min(n, (state.cx.length / 3) | 0); else n = 0;
    if (n > this.cells.capacity) this._buildCells(Math.max(n, this.cells.capacity * 2));
    const mesh = this.cells.mesh;
    const M = mesh.instanceMatrix.array, C = mesh.instanceColor.array;
    const X = state.cx, P = state.cp, A = state.alpha, rc = this.opts.rCell;
    const cQ = this._cQui, cA = this._cAct, cMid = this._cMid;
    for (let i = 0; i < n; i++) {
      const o3 = i * 3, o = i * 16;
      let al = A ? A[i] : 0;
      if (!(al > 0)) al = 0; else if (al > 1) al = 1;
      let px = P ? P[o3] : 1, py = P ? P[o3 + 1] : 0, pz = P ? P[o3 + 2] : 0;
      const pl = px * px + py * py + pz * pz;
      if (!(pl > 1e-12)) { px = 1; py = 0; pz = 0; }
      else if (Math.abs(pl - 1) > 1e-4) { const inv = 1 / Math.sqrt(pl); px *= inv; py *= inv; pz *= inv; }
      const a = rc * (1 + 1.5 * al), b = rc * (1 - 0.3 * al);
      let ax, ay, az;
      if (px < 0.9 && px > -0.9) { const inv = 1 / Math.sqrt(py * py + pz * pz); ax = 0; ay = pz * inv; az = -py * inv; }
      else { const inv = 1 / Math.sqrt(px * px + pz * pz); ax = -pz * inv; ay = 0; az = px * inv; }
      const bx = py * az - pz * ay, by = pz * ax - px * az, bz = px * ay - py * ax;
      M[o] = px * a; M[o + 1] = py * a; M[o + 2] = pz * a; M[o + 3] = 0;
      M[o + 4] = ax * b; M[o + 5] = ay * b; M[o + 6] = az * b; M[o + 7] = 0;
      M[o + 8] = bx * b; M[o + 9] = by * b; M[o + 10] = bz * b; M[o + 11] = 0;
      M[o + 12] = X[o3]; M[o + 13] = X[o3 + 1]; M[o + 14] = X[o3 + 2]; M[o + 15] = 1;
      if (cMid === null) {
        C[o3] = cQ[0] + (cA[0] - cQ[0]) * al;
        C[o3 + 1] = cQ[1] + (cA[1] - cQ[1]) * al;
        C[o3 + 2] = cQ[2] + (cA[2] - cQ[2]) * al;
      } else if (al < 0.5) {
        const w = al * 2;
        C[o3] = cQ[0] + (cMid[0] - cQ[0]) * w; C[o3 + 1] = cQ[1] + (cMid[1] - cQ[1]) * w; C[o3 + 2] = cQ[2] + (cMid[2] - cQ[2]) * w;
      } else {
        const w = al * 2 - 1;
        C[o3] = cMid[0] + (cA[0] - cMid[0]) * w; C[o3 + 1] = cMid[1] + (cA[1] - cMid[1]) * w; C[o3 + 2] = cMid[2] + (cA[2] - cMid[2]) * w;
      }
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

  _updateLoad(strain) {
    let s = +strain;
    if (!(s > 0)) s = 0; else if (s > 1) s = 1;
    const L = this.load;
    L.group.visible = s >= 0.02;
    if (!L.group.visible) return;
    const len = 0.14 + 0.36 * s, th = 0.55 + 0.9 * s;
    L.top.scale.set(th, len, th);
    L.bottom.scale.set(th, len, th);
    L.arrowMat.opacity = 0.35 + 0.45 * s;
    L.plateMat.opacity = 0.02 + 0.06 * s;
  }

  render() {
    if (this._disposed) return;
    this.controls.update();
    const d = this.camera.position.distanceTo(this.controls.target);
    this.scene.fog.near = d - 0.25;
    this.scene.fog.far = d + this.opts.fogDepth;
    this.renderer.render(this.scene, this.camera);
  }

  setAutoRotate(on) {
    this.controls.autoRotate = !!on;
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
    this.controls.dispose();
    this._disposeFibers();
    if (this.cells) { this.scene.remove(this.cells.mesh); this.cells.geo.dispose(); this.cells.mesh.dispose(); this.cells = null; }
    this.fiberMat.dispose();
    this.cellMat.dispose();
    this._wire.geo.dispose(); this._wire.mat.dispose();
    for (const g of this.load.geos) g.dispose();
    this.load.arrowMat.dispose(); this.load.plateMat.dispose();
    this.renderer.dispose();
  }
}
