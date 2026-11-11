/* bubble — a 3D editor for graphs of bubbles.
 *
 * model     : nodes {id,label,notes,r,color,pos:[x,y,z]}  +  edges {a,b,kind}
 * kinds     : 'link' (explicit, no overlap) and 'gravity' (explicit, disconnected, pulled near)
 * emergent  : containment and partial overlap are *derived from geometry every frame*, never
 *             stored. drop a bubble inside another and it is inside; drag it out and it isn't.
 *             that is the whole point of the tool, so it can't drift out of sync with the picture.
 * physics   : soft constraints + springs + limited repulsion, run per animation frame until calm.
 */
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const PAL = ['#57c7ff', '#b48cff', '#5fe3a1', '#ffb454', '#ff6b81', '#6ea8ff', '#f5c66b', '#4fd8c2'];
const K = {                       // force tuning, one place
  repel: 26.0,          // all pairs not in containment
  containPull: 7.5,     // child toward parent centre
  containWall: 16.0,    // keep r_child + margin inside r_parent
  linkRest: 1.14,       // × (rA+rB): touching, not merged
  linkStiff: 6.2,
  overlapRest: 0.74,    // × (rA+rB)
  overlapStiff: 5.0,
  gravityRest: 3.4,     // × (rA+rB): far, but held near
  gravityStiff: 1.15,
  overlapKeep: 3.1,     // keeps an overlapping pair from separating or collapsing
  // Every spring here carries a derivative term. Without it a spring is conservative, so a
  // child pulled toward its parent's centre while being repelled by a sibling goes into orbit
  // instead of settling — measured in probe_energy.py: energy pinned at 0.30 forever. Two is
  // close to critical damping for these stiffnesses (2*sqrt(k), m=1).
  springDamp: 2.0,
  repelDamp: 0.9,     // dashpot on the repulsion field, so siblings rest instead of bouncing
  center: 0.30,
  bounds: 150,          // radius inside which origin gravity exerts no force at all

  // ── convergence ──────────────────────────────────────────────────────────────────────
  // Getting a force-directed layout to actually STOP is a different problem from making the
  // forces right. Tuning damping does not solve it: measured in probe_energy.py / probe_settle.py,
  // a damped-spring version decayed to energy 0.22 and then crept for minutes, because the slowest
  // mode of a coupled spring system is arbitrarily slow. So the simulation COOLS instead — a
  // monotone scalar (alpha) multiplies every force and reaches zero in a fixed number of steps,
  // which is how Fruchterman–Reingold and d3-force guarantee termination. "Done" is then a
  // property of the schedule, not a race against a threshold.
  alphaDecay: 0.021,    // 1 - 0.001^(1/300): cools 1 -> ~0 in about 300 steps by construction
  alphaMin: 0.001,      // at or below this the layout is DONE and positions are frozen
  alphaDrag: 0.25,      // held while the pointer is down, so dragging keeps re-flowing
  alphaRelaxed: 0.05,   // below this it looks still; a nudge still takes effect
  velocityDecay: 0.32,  // fraction of velocity discarded each step (d3 uses 0.40)
  maxSpeed: 12,         // units/step; guards against one huge initial kick

  // One knob, measured. The force constants above were tuned for their RELATIVE behaviour; their
  // absolute size was meaningless while the integrator was wrong by dt² (see below). gain scales
  // every acceleration into a range where a bubble reaches its equilibrium well before the cooling
  // schedule runs out: 0.15 lets a gravity pair close the 180 units it needs in one run — measured
  // with probe_gravity.py. Higher is snappier and bouncier; above ~0.4 it overshoots and rings.
  gain: 0.15,
};
/* A STEP IS THE UNIT OF TIME; there is deliberately no dt in the integrator. Two bugs lived here.
   (1) Tying the schedule to elapsed wall time made convergence speed a function of frame rate —
   measured 36 s at 8 fps for a 7-bubble graph. (2) `pos += v*dt` *after* `v += a*dt` made
   displacement scale as dt² = 1/3600, so a gravity spring over a whole cooling run moved a pair
   0.9 units out of the 180 it needed (verify measured bound 5.97× against unbound 6.00×). Velocity
   is now units-per-step and position takes velocity directly, exactly like d3-force. */

const $ = (s) => document.querySelector(s);
/* Cooling state. alpha=1 means "freshly woken, forces at full strength"; it decays monotonically
   and the simulation is over when it reaches alphaMin. Editing the graph re-wakes it. */
const wake = () => { ui.alpha = 1; ui.awake = true; ui.relaxed = false; };
const isDone = () => ui.alpha <= K.alphaMin;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = (used) => { let n; do { n = 'n' + Math.random().toString(36).slice(2, 7); } while (used.has(n)); return n; };

/* ── state ───────────────────────────────────────────────────────────── */
let doc = { version: 1, name: 'untitled', nodes: [], edges: [] };
let dirty = false, lastError = '';
const undoStack = [], redoStack = [];
let tool = 'select', selected = null, pending = null, pendingKind = null;
let showLabels = true, viewMode = 'free';
const ui = { rel: new Map(), parent: new Map(), energy: 0, topSpeed: 0,
             alpha: 0, awake: false, relaxed: false, loaded: false };

/* ── three scaffold ──────────────────────────────────────────────────── */
const host = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x07090f, 0.0075);
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.5, 4000);
camera.position.set(0, 62, 168);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.075;
controls.rotateSpeed = 0.62; controls.zoomSpeed = 0.85; controls.panSpeed = 0.6;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight(0x9dc4ff, 0x0a0d16, 0.72));
const key = new THREE.DirectionalLight(0xdfeaff, 1.05); key.position.set(60, 90, 70); scene.add(key);
const rim = new THREE.DirectionalLight(0x8a6bff, 0.55); rim.position.set(-80, -30, -60); scene.add(rim);

/* faint depth grid + horizon ring: gives 3D a ground truth so overlap vs inside reads */
const grid = new THREE.GridHelper(600, 30, 0x1b2740, 0x111826);
grid.rotation.x = Math.PI / 2; grid.position.y = -110; grid.material.transparent = true; grid.material.opacity = 0.35;
scene.add(grid);
const starGeo = new THREE.BufferGeometry();
{
  const n = 900, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const r = 400 + Math.random() * 900, t = Math.acos(2 * Math.random() - 1), p = Math.random() * 6.283; a[i * 3] = r * Math.sin(t) * Math.cos(p); a[i * 3 + 1] = r * Math.cos(t); a[i * 3 + 2] = r * Math.sin(t) * Math.sin(p); }
  starGeo.setAttribute('position', new THREE.BufferAttribute(a, 3));
}
scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x2f4568, size: 1.6, sizeAttenuation: true, transparent: true, opacity: .8 })));

const ballGroup = new THREE.Group(); scene.add(ballGroup);
const shellGroup = new THREE.Group(); scene.add(shellGroup);
const lineGroup = new THREE.Group(); scene.add(lineGroup);

const SPHERE = new THREE.SphereGeometry(1, 48, 32);
const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.24 });
const wireProto = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 2));

const meshes = new Map();     // id -> { mesh, wire, sprite, node }
const rings = [];             // overlap intersection rings
const linePool = { used: 0 };

/* ── labels ──────────────────────────────────────────────────────────── */
function labelSprite(text, sub) {
  const c = document.createElement('canvas'); const g = c.getContext('2d');
  const dpr = 2; const w = 512, h = 132;
  c.width = w * dpr / 2; c.height = h * dpr / 2;
  g.scale(dpr / 2, dpr / 2);
  g.font = '600 30px -apple-system, "SF Pro Text", system-ui, sans-serif';
  g.fillStyle = 'rgba(232,240,255,0.98)';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 12;
  g.fillText(String(text || '').slice(0, 34), w / 4, sub ? h / 2 - 14 : h / 2);
  if (sub) { g.font = '500 17px ui-monospace, monospace'; g.fillStyle = 'rgba(150,170,205,.85)'; g.fillText(String(sub).slice(0, 40), w / 4, h / 2 + 20); }
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sp.center.set(0.5, 0);
  return sp;
}

/* ── build / sync the scene from the model ───────────────────────────── */
function sync() {
  const live = new Set();
  for (const n of doc.nodes) {
    live.add(n.id);
    let e = meshes.get(n.id);
    if (!e) {
      const mat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(n.color), roughness: 0.42, metalness: 0.06,
        transparent: true, opacity: 0.19, side: THREE.DoubleSide, depthWrite: false,
        clearcoat: 0.9, clearcoatRoughness: 0.35, sheen: 0.5, ior: 1.35,
      });
      const mesh = new THREE.Mesh(SPHERE, mat); mesh.userData.id = n.id;
      const wire = new THREE.LineSegments(wireProto, new THREE.LineBasicMaterial({ color: new THREE.Color(n.color), transparent: true, opacity: 0.16 }));
      ballGroup.add(mesh); mesh.add(wire);
      const sprite = labelSprite(n.label, n.id);
      shellGroup.add(sprite);
      e = { mesh, wire, sprite, node: n }; meshes.set(n.id, e);
    }
    e.node = n;
    e.mesh.material.color.set(n.color);
    e.wire.material.color.set(n.color);
    e.mesh.scale.setScalar(Math.max(1.5, n.r));
    e.mesh.position.fromArray(n.pos);
    if (e.sprite.userData.text !== n.label || e.sprite.userData.sub !== n.id) {
      const ns = labelSprite(n.label, n.id);
      e.sprite.material.map.dispose(); e.sprite.material = ns.material; e.sprite.material.opacity = 0;
      e.sprite.userData = { text: n.label, sub: n.id };
    }
    const sel = selected === n.id;
    const pend = pending === n.id;
    e.mesh.material.opacity = sel ? 0.44 : 0.19;
    e.mesh.material.emissive = new THREE.Color(sel ? n.color : pend ? '#ffffff' : '#000000');
    e.mesh.material.emissiveIntensity = sel ? 0.55 : pend ? 0.22 : 0;
    e.wire.material.opacity = sel ? 0.5 : 0.16;
    e.sprite.visible = showLabels;
  }
  for (const [id, e] of meshes) if (!live.has(id)) {
    ballGroup.remove(e.mesh); shellGroup.remove(e.sprite);
    e.mesh.material.dispose(); e.sprite.material.map?.dispose(); e.sprite.material.dispose();
    meshes.delete(id);
  }
}

/* ── derived topology: who is inside whom ────────────────────────────── */
function derive() {
  ui.parent.clear();
  const ns = doc.nodes;
  const kids = new Map(ns.map(n => [n.id, []]));
  for (const a of ns) {
    let best = null, bestR = Infinity;
    for (const b of ns) {
      if (a === b) continue;
      if (b.r <= a.r + 1e-6) continue;                       // parent must be strictly bigger
      const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
      if (d + a.r <= b.r + 1e-6 && b.r < bestR) { best = b; bestR = b.r; }
    }
    // a parent must be strictly bigger, so the chain strictly increases in radius and can
    // never cycle — no visited-set needed here
    if (best) { ui.parent.set(a.id, best.id); kids.get(best.id).push(a.id); }
  }
  ui.kids = kids;
}

/* ── physics step ────────────────────────────────────────────────────── */
const acc = new Map();
function step() {
  const ns = doc.nodes;
  if (!ns.length) { settle_now(); return; }
  const alpha = ui.alpha;
  const byId = new Map(ns.map(n => [n.id, n]));
  for (const n of ns) { acc.set(n.id, [0, 0, 0]); n.vel = n.vel || [0, 0, 0]; }
  const push = (id, v) => { const a = acc.get(id); a[0] += v[0]; a[1] += v[1]; a[2] += v[2]; };
  const rel = ui.rel; rel.clear();

  // containment: pull child toward parent centre and hold it inside the wall
  for (const [cid, pid] of ui.parent) {
    const c = byId.get(cid), p = byId.get(pid); if (!c || !p) continue;
    rel.set(cid, { kind: 'inside', other: pid });
    const dx = p.pos[0] - c.pos[0], dy = p.pos[1] - c.pos[1], dz = p.pos[2] - c.pos[2];
    const d = Math.hypot(dx, dy, dz) || 1e-6;
    const ux = dx / d, uy = dy / d, uz = dz / d;
    const pull = K.containPull * Math.min(1, d / (p.r * 0.5));
    const rcv = ((p.vel[0] - c.vel[0]) * ux + (p.vel[1] - c.vel[1]) * uy + (p.vel[2] - c.vel[2]) * uz);
    const cf2 = pull - K.springDamp * rcv;   // - : rcv>0 is already closing on the parent
    push(cid, [dx * cf2 / d, dy * cf2 / d, dz * cf2 / d]); push(pid, [-dx * cf2 * 0.18 / d, -dy * cf2 * 0.18 / d, -dz * cf2 * 0.18 / d]);
    const wall = p.r - c.r - Math.max(1.2, p.r * 0.06);
    if (d > wall) { const s = K.containWall * (d - wall); push(cid, [-dx / d * s, -dy / d * s, -dz / d * s]); push(pid, [dx / d * s * 0.18, dy / d * s * 0.18, dz / d * s * 0.18]); }
  }

  // springs for explicit edges + partial-overlap springs
  for (const e of doc.edges) {
    const a = byId.get(e.a), b = byId.get(e.b); if (!a || !b) continue;
    const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1], dz = b.pos[2] - a.pos[2];
    const d = Math.hypot(dx, dy, dz) || 1e-6, ux = dx / d, uy = dy / d, uz = dz / d;
    const sum = a.r + b.r;
    let rest, stiff;
    if (e.kind === 'gravity') { rest = sum * K.gravityRest; stiff = K.gravityStiff; }
    else { rest = sum * K.linkRest; stiff = K.linkStiff; }
    const scale = Math.max(1, Math.sqrt(sum));
    const rv = ((b.vel[0] - a.vel[0]) * ux + (b.vel[1] - a.vel[1]) * uy + (b.vel[2] - a.vel[2]) * uz);
    const f = (stiff * (d - rest) + K.springDamp * rv) / scale;   // + : damping opposes separation
    push(a.id, [ux * f, uy * f, uz * f]); push(b.id, [-ux * f, -uy * f, -uz * f]);
    if (!rel.has(a.id)) rel.set(a.id, { kind: e.kind, other: b.id });
  }

  for (let i = 0; i < ns.length; i++) {
    const a = ns[i];
    // Boundary, not a field. A uniform pull to origin gives every bubble a terminal inward
    // velocity that repulsion then fights forever — measured: energy decayed to ~0.22 and then
    // crept for minutes without landing. Inside K.bounds the force is exactly zero, so a graph
    // that has relaxed stays relaxed; outside it, islands get reeled back into reach.
    const rad = Math.hypot(a.pos[0], a.pos[1], a.pos[2]);
    if (rad > K.bounds) {
      const f = K.center * (rad - K.bounds) * 0.06;
      push(a.id, [-a.pos[0] / rad * f, -a.pos[1] / rad * f, -a.pos[2] / rad * f]);
    }
    for (let j = i + 1; j < ns.length; j++) {
      const b = ns[j];
      const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1], dz = b.pos[2] - a.pos[2];
      const d = Math.hypot(dx, dy, dz) || 1e-6, sum = a.r + b.r;
      const inside = ui.parent.get(a.id) === b.id || ui.parent.get(b.id) === a.id;
      const ux = dx / d, uy = dy / d, uz = dz / d;
      // relative velocity along a->b: >0 means separating. Used by both short-range bands below.
      const rv2 = (b.vel[0] - a.vel[0]) * ux + (b.vel[1] - a.vel[1]) * uy + (b.vel[2] - a.vel[2]) * uz;
      if (inside) continue;                                     // nesting is allowed to nest
      const linked = doc.edges.some(e => (e.a === a.id && e.b === b.id) || (e.b === a.id && e.a === b.id));
      if (d < sum * 0.999) {
        // partial overlap: hold at the intended overlap band, never let them merge
        const target = sum * K.overlapRest;
        const f = (K.overlapKeep * (d - target) + K.springDamp * rv2) / Math.max(1, Math.sqrt(sum));
        push(a.id, [ux * f, uy * f, uz * f]); push(b.id, [-ux * f, -uy * f, -uz * f]);
        if (!linked && !rel.has(a.id)) rel.set(a.id, { kind: 'overlap', other: b.id });
      } else if (d < sum * 2.6) {
        const f = (K.repel * (1 - d / (sum * 2.6)) ** 2 + K.repelDamp * rv2) / Math.max(1, Math.sqrt(sum));
        push(a.id, [-ux * f, -uy * f, -uz * f]); push(b.id, [ux * f, uy * f, uz * f]);
      }
    }
  }

  let energy = 0, peak = 0;
  const drag = dragging ? dragging : null;
  for (const n of ns) {
    if (n === selected_node() || n === drag) { n.vel = [0, 0, 0]; continue; }
    const v = n.vel, a = acc.get(n.id);
    // Forces are scaled by alpha here, once, rather than inside each force: the cooling schedule
    // is what ends the run, so every force must obey it or one of them keeps the graph alive.
    for (let i = 0; i < 3; i++) v[i] = (v[i] + a[i] * alpha * K.gain) * (1 - K.velocityDecay);
    const sp = Math.hypot(v[0], v[1], v[2]);
    if (sp > K.maxSpeed) { const s = K.maxSpeed / sp; v[0] *= s; v[1] *= s; v[2] *= s; }
    n.pos[0] += v[0]; n.pos[1] += v[1]; n.pos[2] += v[2];
    energy += sp * sp; if (sp > peak) peak = sp;
  }
  ui.energy = energy / ns.length;
  ui.topSpeed = Math.sqrt(peak);   // fastest single bubble: what the eye reads as 'still moving'
  ui.alpha += (0 - ui.alpha) * K.alphaDecay;         // cool once per step; monotone by construction
  if (isDone()) settle_now();
  else ui.relaxed = ui.alpha < K.alphaRelaxed;       // looks still, but a nudge still takes
}

/* One place that ends a run: alpha at/below alphaMin, zero velocities, frozen picture. */
function settle_now() {
  ui.alpha = 0; ui.awake = false; ui.relaxed = true; ui.energy = 0; ui.topSpeed = 0;
  for (const n of doc.nodes) n.vel = [0, 0, 0];
}

/* ── relational drawing ──────────────────────────────────────────────── */
function drawRelations() {
  for (const r of rings) { lineGroup.remove(r); r.geometry.dispose(); r.material.dispose(); }
  rings.length = 0;
  while (lineGroup.children.length) { const o = lineGroup.children.pop(); lineGroup.remove(o); o.geometry.dispose(); o.material.dispose(); }

  const byId = new Map(doc.nodes.map(n => [n.id, n]));
  const seg = (pts, mat) => { const g = new THREE.BufferGeometry().setFromPoints(pts); const L = new THREE.Line(g, mat); L.frustumCulled = false; lineGroup.add(L); return L; };
  const solid = (c, o, w) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o });
  const dashed = (c, o) => new THREE.LineDashedMaterial({ color: c, transparent: true, opacity: o, dashSize: 2.4, gapSize: 2.2, scale: 1 });

  for (const e of doc.edges) {
    const a = byId.get(e.a), b = byId.get(e.b); if (!a || !b) continue;
    const A = new THREE.Vector3(...a.pos), B = new THREE.Vector3(...b.pos);
    const d = A.distanceTo(B) || 1e-6, u = B.clone().sub(A).normalize();
    const warm = (selected === e.a || selected === e.b) ? 1 : 0;
    if (e.kind === 'gravity') {
      const L = seg([A.clone().addScaledVector(u, a.r), B.clone().addScaledVector(u, -b.r)], dashed(0x9fb2d4, warm ? .95 : .5));
      L.computeLineDistances();
    } else {
      seg([A.clone().addScaledVector(u, a.r), B.clone().addScaledVector(u, -b.r)], solid(0x7fb8ff, warm ? 1 : .7));
    }
  }

  // partial overlaps: draw the circle where the two shells intersect — reads instantly in 3D
  const ns = doc.nodes;
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
    const a = ns[i], b = ns[j];
    if (ui.parent.get(a.id) === b.id || ui.parent.get(b.id) === a.id) continue;
    const A = new THREE.Vector3(...a.pos), B = new THREE.Vector3(...b.pos);
    const d = A.distanceTo(B); const sum = a.r + b.r;
    if (d >= sum || d < 1e-4) continue;
    const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
    const h = Math.sqrt(Math.max(0.01, a.r * a.r - x * x));
    if (h < 0.6) continue;
    const u = B.clone().sub(A).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), u);
    const pts = [];
    for (let k = 0; k <= 72; k++) { const t = k / 72 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(t) * h, Math.sin(t) * h, 0).applyQuaternion(q).add(A.clone().addScaledVector(u, x))); }
    const ring = seg(pts, solid(0xd8c2ff, .8)); ring.material.linewidth = 1;
    rings.push(ring);
  }

  // containment: soft tether from child to parent shell centre reads the hierarchy even at depth
  for (const [cid, pid] of ui.parent) {
    const c = byId.get(cid), p = byId.get(pid); if (!c || !p) continue;
    const C = new THREE.Vector3(...c.pos), P = new THREE.Vector3(...p.pos);
    const u = C.clone().sub(P); const d = u.length() || 1e-6;
    seg([P, C], solid(new THREE.Color(p.color).getHex(), .1));
  }

  for (const [id, e] of meshes) {
    const n = byId.get(id); if (!n) continue;
    e.mesh.position.fromArray(n.pos);
    const top = n.pos[1] + n.r * 1.06;
    e.sprite.position.set(n.pos[0], top, n.pos[2]);
    const dist = camera.position.distanceTo(e.mesh.position);
    const s = clamp(dist * 0.036, 4.5, 26);
    e.sprite.scale.set(s * 1.9, s * 0.5, 1);
    const a = clamp(1.6 - dist / 460, 0.12, 1);
    e.sprite.material.opacity = showLabels ? a : 0;
    if (viewMode !== 'free') {
      const depth = e.mesh.position.clone().sub(camera.position).length();
      e.sprite.material.opacity *= clamp(1.5 - depth / 900, .2, 1);
    }
  }
}

/* ── camera ──────────────────────────────────────────────────────────── */
function fit(ms = 520) {
  if (!doc.nodes.length) return;
  const box = new THREE.Box3();
  for (const n of doc.nodes) box.expandByPoint(new THREE.Vector3(...n.pos).addScalar(n.r));
  const c = box.getCenter(new THREE.Vector3()); const s = box.getSize(new THREE.Vector3());
  const dist = Math.max(s.length() * 0.85, 40);
  const dir = viewMode === 'top' ? new THREE.Vector3(0, 1, 0.0001) : viewMode === 'front' ? new THREE.Vector3(0, 0, 1) : camera.position.clone().sub(controls.target).normalize();
  const from = camera.position.clone(), to = c.clone().addScaledVector(dir, dist);
  const cf = controls.target.clone(), ct = c.clone();
  const t0 = performance.now();
  (function anim() {
    const k = clamp((performance.now() - t0) / ms, 0, 1), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    camera.position.lerpVectors(from, to, e); controls.target.lerpVectors(cf, ct, e); controls.update();
    if (k < 1) requestAnimationFrame(anim);
  })();
}
function applyView() {
  if (viewMode === 'free') { controls.enableRotate = true; controls.maxPolarAngle = Math.PI; }
  else { controls.enableRotate = false; fit(); }
  $('#btnView').textContent = viewMode === 'free' ? '3D' : viewMode === 'top' ? 'top' : 'front';
  $('#btnView').classList.toggle('active', viewMode !== 'free');
}

/* ── picking & dragging ──────────────────────────────────────────────── */
const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
let dragging = null, dragPlane = new THREE.Plane(), dragOff = new THREE.Vector3(), moved = false, downAt = [0, 0];
const selected_node = () => selected ? doc.nodes.find(n => n.id === selected) : null;

function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1; ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects([...meshes.values()].map(m => m.mesh), false);
  if (!hits.length) return null;
  // prefer the innermost bubble of whatever stack we hit, so nesting is grabbable
  const order = hits.map(h => h.object.userData.id);
  let best = order[0], depth = 0;
  for (const id of order) { let d = 0, p = ui.parent.get(id); while (p) { d++; p = ui.parent.get(p); } if (d > depth) { depth = d; best = id; } }
  return { id: best, point: hits[0].point, all: order };
}
function screen(ev) { const r = renderer.domElement.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  downAt = screen(ev); moved = false;
  const hit = pick(ev);
  if (tool === 'node') {
    snapshot();
    if (hit && (ev.metaKey || ev.ctrlKey)) { addNode(hit.id); return; }
    const r = renderer.domElement.getBoundingClientRect();
    addNode(null, hit ? null : unproject(ev));
    return;
  }
  if (tool === 'link' || tool === 'overlap' || tool === 'contain' || tool === 'gravity') { pendingPairClick(hit, ev); return; }
  if (tool === 'cut') { if (hit) { snapshot(); cutFrom(hit.id); } return; }
  if (tool === 'delete') { if (hit) { snapshot(); delNode(hit.id); } return; }
  // select tool
  if (!hit) { select(null); return; }
  select(hit.id);
  const n = doc.nodes.find(x => x.id === hit.id);
  dragging = n; controls.enabled = false;
  const nrm = camera.getWorldDirection(new THREE.Vector3()).negate();
  dragPlane.setFromNormalAndCoplanarPoint(nrm, new THREE.Vector3(...n.pos));
  const p = new THREE.Vector3(); ray.ray.intersectPlane(dragPlane, p);
  dragOff.set(n.pos[0] - p.x, n.pos[1] - p.y, n.pos[2] - p.z);
  renderer.domElement.setPointerCapture(ev.pointerId);
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  if (downAt && (Math.abs(screen(ev)[0] - downAt[0]) > 3 || Math.abs(screen(ev)[1] - downAt[1]) > 3)) moved = true;
  if (!dragging) return;
  const p = new THREE.Vector3(); if (!ray.ray.intersectPlane(dragPlane, p)) return;
  const par = ui.parent.get(dragging.id);
  dragging.pos[0] = p.x + dragOff.x; dragging.pos[1] = p.y + dragOff.y; dragging.pos[2] = p.z + dragOff.z;
  if (par) {                                   // keep a nested bubble legal while dragging
    const q = doc.nodes.find(n => n.id === par); const d = new THREE.Vector3().fromArray(dragging.pos).sub(new THREE.Vector3(...q.pos));
    const lim = Math.max(0, q.r - dragging.r - 1);
    if (d.length() > lim) { d.setLength(lim); dragging.pos = q.pos.map((v, i) => v + d.getComponent(i)); }
  }
  dragging.vel = [0, 0, 0];
  if (ui.alpha < K.alphaDrag) { ui.alpha = K.alphaDrag; ui.awake = true; ui.relaxed = false; }
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  if (dragging) {
    if (moved) markDirty();
    dragging = null; controls.enabled = true; renderInspector();
  }
});

function unproject(ev) {
  const p = new THREE.Vector3(); ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), p);
  if (!isFinite(p.x)) return null;
  return [p.x, p.y, p.z];
}

/* ── editing operations ──────────────────────────────────────────────── */
function addNode(parentId, pos) {
  const used = new Set(doc.nodes.map(n => n.id));
  const par = parentId ? doc.nodes.find(n => n.id === parentId) : null;
  let r = par ? Math.max(3, par.r * 0.55) : 11 + Math.random() * 6;
  const p = pos || (par ? [par.pos[0] + (Math.random() - .5) * 2, par.pos[1] + (Math.random() - .5) * 2, par.pos[2] + (Math.random() - .5) * 2]
    : (camera.position.clone().add(controls.target).multiplyScalar(0.5).toArray().map(v => v + (Math.random() - .5) * 30)));
  const n = { id: uid(used), label: 'new bubble', notes: '', r: +r.toFixed(1), color: PAL[doc.nodes.length % PAL.length], pos: p.map(v => +v.toFixed(2)), vel: [0, 0, 0] };
  doc.nodes.push(n); select(n.id); markDirty(); wake(); sync(); renderInspector();
  toast(`bubble “${n.label}”${par ? ` inside “${par.label}”` : ''}`);
}
function link(a, b, kind) {
  if (a === b) { toast('that is the same bubble', 'err'); return; }
  const ex = doc.edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  if (ex && ex.kind === kind) { toast('already linked like that'); return; }
  if (ex) { ex.kind = kind; markDirty(); wake(); return toast('relationship changed'); }
  doc.edges.push({ a, b, kind }); markDirty(); wake();
  const names = { link: 'linked', gravity: 'gravitationally bound' };
  toast(kind === 'link' ? 'linked, no overlap' : kind === 'gravity' ? 'disconnected but pulled near' : 'linked');
}
function pendingPairClick(hit, ev) {
  if (!hit) { pending = null; renderInspector(); return; }
  const kind = tool === 'contain' ? 'contain' : tool;
  if (tool === 'contain') {
    if (!pending) { pending = hit.id; toast('now click the bubble to put inside it'); return; }
    snapshot();
    const out = doc.nodes.find(n => n.id === pending), inn = doc.nodes.find(n => n.id === hit.id);
    if (out.r <= inn.r * 1.02) {                       // grow the outer until it really encloses
      out.r = +(inn.r * 1.9 + 2).toFixed(1);
    }
    const d = new THREE.Vector3().fromArray(inn.pos).sub(new THREE.Vector3(...out.pos));
    inn.pos = [+out.pos[0], +out.pos[1], +out.pos[2]];
    markDirty(); pending = null; wake(); sync(); renderInspector();
    toast(`“${inn.label}” now encapsulated by “${out.label}”`);
    return;
  }
  if (!pending) { pending = hit.id; pendingKind = kind; toast(kind === 'link' ? 'pick the second bubble to link' : 'pick the second bubble'); renderInspector(); return; }
  snapshot(); link(pending, hit.id, kind); pending = null; pendingKind = null; renderInspector();
}
function cutFrom(id) {
  const before = doc.edges.length;
  doc.edges = doc.edges.filter(e => e.a !== id && e.b !== id);
  markDirty(); wake(); sync();
  toast(doc.edges.length === before ? 'nothing to cut there' : `cut ${before - doc.edges.length} link${before - doc.edges.length > 1 ? 's' : ''}`);
}
function delNode(id) {
  const n = doc.nodes.find(x => x.id === id); if (!n) return;
  doc.nodes = doc.nodes.filter(x => x.id !== id);
  doc.edges = doc.edges.filter(e => e.a !== id && e.b !== id);
  const kids = ui.kids?.get(id) || [];
  for (const k of kids) { const c = doc.nodes.find(x => x.id === k); }   // children fall out on their own
  if (selected === id) selected = null;
  markDirty(); sync(); renderInspector(); wake();
  toast(`deleted “${n.label}”`);
}
function select(id) { selected = id; renderInspector(); }

/* ── persistence ─────────────────────────────────────────────────────── */
function clean() {
  return { version: 1, name: doc.name, nodes: doc.nodes.map(n => ({ id: n.id, label: n.label, notes: n.notes, r: +(+n.r).toFixed(2), color: n.color, pos: n.pos.map(v => +(+v).toFixed(3)) })), edges: doc.edges.map(e => ({ a: e.a, b: e.b, kind: e.kind })) };
}
function hydrate(d) {
  if (!d || !Array.isArray(d.nodes)) throw new Error('not a bubble graph: no nodes array');
  const ids = new Set();
  for (const n of d.nodes) {
    if (typeof n.id !== 'string' || !n.id) throw new Error('every node needs a string id');
    if (ids.has(n.id)) throw new Error(`duplicate id "${n.id}"`);
    ids.add(n.id);
    n.label = n.label ?? n.id; n.notes = n.notes ?? '';
    n.r = clamp(+n.r || 10, 0.6, 900);
    n.color = /^#[0-9a-f]{6}$/i.test(n.color || '') ? n.color : PAL[ids.size % PAL.length];
    n.pos = Array.isArray(n.pos) && n.pos.length === 3 ? n.pos.map(Number) : [(Math.random() - .5) * 90, (Math.random() - .5) * 90, (Math.random() - .5) * 90];
    n.vel = [0, 0, 0];
  }
  d.edges = (d.edges || []).filter(e => ids.has(e.a) && ids.has(e.b) && ['link', 'gravity'].includes(e.kind) && e.a !== e.b)
    .map(e => ({ a: e.a, b: e.b, kind: e.kind }));
  doc = { version: 1, name: d.name || 'untitled', nodes: d.nodes, edges: d.edges };
  selected = null; pending = null;
  for (const [id, e] of meshes) { ballGroup.remove(e.mesh); shellGroup.remove(e.sprite); }
  meshes.clear();
  dirty = false; lastError = '';
  sync(); derive(); wake(); renderInspector(); setStatus('loaded', true);
  setTimeout(fit, 60);
}
function setStatus(t, saved) {
  $('#statusText').textContent = t;
  $('#status').classList.toggle('saved', !!saved && !dirty);
  $('#status').classList.toggle('err', !!lastError);
}
function markDirty() { dirty = true; lastError = ''; setStatus('unsaved — export to keep it'); }

/* ── the whole storage model, in one place ──────────────────────────────────────────────
   There is no server side. The graph lives in this tab and on disk only when YOU take it:
   Export writes a .json you own, Import reads one back. No database, no PUT, no hidden
   localStorage copy that silently disagrees with what is on screen or follows the browser
   instead of the file. That is deliberate, and it was his call ("saving to json on server is so
   extracomplication"): a server that stores people's structures is a liability, not a feature.

   Consequence I own: reload loses unsaved work. `dirty` exists to make that loud — the status
   chip, and beforeunload. */
function filename() {
  return (doc.name || 'graph').trim().replace(/[^a-z0-9-_ ]+/gi, '').replace(/\s+/g, '_').slice(0, 60) + '.json';
}
function exportFile() {
  const text = JSON.stringify(clean(), null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  markExported();
  toast('exported ' + filename(), 'ok');
}
function markExported() { dirty = false; lastError = ''; setStatus('exported ' + timeNow(), true); }
const timeNow = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* Import is the only way a file gets in: picker, drag-drop, or paste. All three run hydrate(),
   which validates rather than trusts — a malformed file must say so, not paint half a graph. */
async function importFile(file) {
  let text;
  try { text = await file.text(); }
  catch (e) { toast('could not read ' + file.name + ': ' + e.message, 'err'); return; }
  let data;
  try { data = JSON.parse(text); }
  catch (e) { toast('not valid json: ' + e.message, 'err'); return; }
  try { snapshot(); hydrate(data); }
  catch (e) { toast('not a usable graph: ' + e.message, 'err'); return; }
  doc.name = file.name.replace(/\.json$/i, '');
  markDirty();
  toast('loaded ' + file.name + ' — export again to keep it under this name', 'ok');
}

/* Drag a .json onto the page and it loads. Guarded so dragging text or an image out of another
   tab — which fires the same event — does not look like a corrupted import. */
function installDragDrop() {
  let depth = 0;
  const hasFile = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFile(e)) return; depth++; document.body.classList.add('dropping'); });
  addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dropping'); } });
  addEventListener('dragover', (e) => { if (hasFile(e)) e.preventDefault(); });
  addEventListener('drop', (e) => {
    if (!hasFile(e)) return;
    e.preventDefault(); depth = 0; document.body.classList.remove('dropping');
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (!/\.json$/i.test(f.name) && f.type !== 'application/json') { toast('that is not a .json graph file', 'err'); return; }
    importFile(f);
  });
}

/* ── undo ────────────────────────────────────────────────────────────── */
function snapshot() { undoStack.push(JSON.stringify(clean())); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; }
function undo() {
  if (!undoStack.length) return toast('nothing to undo');
  redoStack.push(JSON.stringify(clean())); hydrate(JSON.parse(undoStack.pop())); markDirty(); toast('undone');
}
function redo() {
  if (!redoStack.length) return toast('nothing to redo');
  undoStack.push(JSON.stringify(clean())); hydrate(JSON.parse(redoStack.pop())); markDirty(); toast('redone');
}

/* ── inspector ───────────────────────────────────────────────────────── */
function relRow(other, kind, removable) {
  const o = doc.nodes.find(n => n.id === other); if (!o) return '';
  const colour = kind === 'inside' ? '#5fe3a1' : kind === 'overlap' ? '#b48cff' : kind === 'gravity' ? '#9fb2d4' : '#7fb8ff';
  return `<div class="rel"><i style="background:${colour}"></i><b>${esc(o.label)}</b><span class="kind" style="color:${colour}">${kind}</span>${removable ? `<span class="x" data-cut="${esc(other)}" title="cut this link">✕</span>` : ''}</div>`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderInspector() {
  const box = $('#inspector');
  if (pending) {
    const p = doc.nodes.find(n => n.id === pending);
    box.innerHTML = `<div class="insp-title">pending <span class="relchip" style="background:rgba(255,180,84,.16);color:var(--warn)">⌫ cancel</span></div>
      <p class="empty">first bubble picked: <b>${esc(p?.label || pending)}</b>. click the second one in the scene.</p>`;
    return;
  }
  const n = selected_node();
  if (!n) {
    box.innerHTML = `<div class="insp-title">nothing selected</div>
      <p class="empty">click a bubble to edit it, or pick a tool on the left.<br><br>
      <kbd>2</kbd> adds a bubble where you click · <kbd>⌘</kbd>+<kbd>2</kbd> then click a bubble to nest inside it ·
      <kbd>3</kbd> <kbd>4</kbd> <kbd>5</kbd> <kbd>6</kbd> set relationships · <kbd>⌫</kbd> deletes.</p>`;
    return;
  }
  const parent = ui.parent.get(n.id), kids = ui.kids?.get(n.id) || [];
  const edges = doc.edges.filter(e => e.a === n.id || e.b === n.id);
  const others = doc.nodes.filter(o => o.id !== n.id && !ui.parent.get(o.id) === false && (ui.parent.get(o.id) === n.id)).length;
  box.innerHTML = `
    <div class="insp-title">bubble <span class="relchip" style="background:${esc(n.color)}22;color:${esc(n.color)}">${esc(n.id)}</span></div>
    <div class="field"><label>label</label><input type="text" id="fLabel" value="${esc(n.label)}"></div>
    <div class="field"><label>notes</label><textarea id="fNotes" placeholder="what is this thing">${esc(n.notes)}</textarea></div>
    <div class="field"><label>radius <span class="val" style="float:right">${(+n.r).toFixed(1)}</span></label>
      <input type="range" id="fR" min="1" max="120" step="0.5" value="${clamp(n.r, 1, 120)}"></div>
    <div class="field"><label>colour</label><div class="swatches">${PAL.map(c => `<span class="sw ${c === n.color ? 'sel' : ''}" data-c="${c}" style="background:${c}"></span>`).join('')}</div></div>
    <div class="field"><label>position</label><div class="rowline" style="font:500 11.5px/1 var(--mono);color:var(--dim)">${n.pos.map(v => (+v).toFixed(1)).join('  ·  ')}</div></div>
    <div class="field"><label>relationships</label><div class="rels">
      ${parent ? relRow(parent, 'inside', false) : ''}
      ${kids.map(k => relRow(k, 'contains', false)).join('')}
      ${edges.map(e => relRow(e.a === n.id ? e.b : e.a, e.kind, true)).join('')}
      ${!parent && !kids.length && !edges.length ? '<div class="empty" style="padding:2px 0">disconnected. use <b>6</b> to give it a gravitational pull toward something.</div>' : ''}
    </div></div>
    <div class="field"><label>make</label><div class="rowline">
      <button class="btn" data-do="gravity">gravity pull</button>
      <button class="btn" data-do="out">pop out</button>
    </div></div>
    <div class="insp-actions">
      <button class="btn" data-do="fit">focus</button>
      <button class="btn danger" data-do="del">delete</button>
    </div>`;

  const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  bind('#fLabel', 'input', (e) => { n.label = e.target.value; markDirty(); const m = meshes.get(n.id); if (m) { const s = labelSprite(n.label, n.id); m.sprite.material.map?.dispose(); m.sprite.material = s.material; m.sprite.userData = { text: n.label, sub: n.id }; } });
  bind('#fNotes', 'input', (e) => { n.notes = e.target.value; markDirty(); });
  bind('#fR', 'input', (e) => { n.r = +e.target.value; markDirty(); wake(); sync(); const v = $('#fR').previousElementSibling; if (v) v.innerHTML = `radius <span class="val" style="float:right">${n.r.toFixed(1)}</span>`; });
  box.querySelectorAll('.sw').forEach(s => s.addEventListener('click', () => { n.color = s.dataset.c; markDirty(); sync(); renderInspector(); }));
  box.querySelectorAll('[data-cut]').forEach(x => x.addEventListener('click', () => { snapshot(); doc.edges = doc.edges.filter(e => !((e.a === n.id && e.b === x.dataset.cut) || (e.b === n.id && e.a === x.dataset.cut))); markDirty(); wake(); renderInspector(); }));
  box.querySelectorAll('[data-do]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.do;
    if (k === 'del') { snapshot(); delNode(n.id); }
    if (k === 'fit') { const d = new THREE.Vector3(...n.pos); controls.target.copy(d); fit(320); }
    if (k === 'gravity') { tool = 'gravity'; setTool(); toast('now click what it should be pulled toward'); }
    if (k === 'out' && parent) {
      snapshot();
      const p = doc.nodes.find(x => x.id === parent);
      const dir = new THREE.Vector3(n.pos[0] - p.pos[0], n.pos[1] - p.pos[1], n.pos[2] - p.pos[2]); if (dir.length() < .01) dir.set(1, 0, 0);
      dir.setLength(p.r + n.r + 6); n.pos = [p.pos[0] + dir.x, p.pos[1] + dir.y, p.pos[2] + dir.z].map(v => +v.toFixed(2));
      markDirty(); wake(); renderInspector(); toast('released from enclosure');
    }
  }));
}

/* ── tools / chrome ──────────────────────────────────────────────────── */
function setTool() { document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool)); }
document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => { tool = b.dataset.tool; pending = null; setTool(); renderInspector(); }));
$('#btnLabels').addEventListener('click', () => { showLabels = !showLabels; $('#btnLabels').classList.toggle('active', showLabels); sync(); });
$('#btnView').addEventListener('click', () => { viewMode = viewMode === 'free' ? 'top' : viewMode === 'top' ? 'front' : 'free'; applyView(); });
$('#btnFit').addEventListener('click', () => fit());
$('#btnRelax').addEventListener('click', () => { wake(); toast('re-relaxing'); });
$('#btnExport').addEventListener('click', () => { snapshot(); exportFile(); });
$('#btnNew').addEventListener('click', () => { snapshot(); hydrate({ name: 'untitled', nodes: [], edges: [] }); toast('empty graph — press 2 and click to place a bubble'); markDirty(); });
$('#btnImport').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (f) await importFile(f);
  e.target.value = '';                       // so picking the same file twice re-imports it
});
installDragDrop();
/* Paste a .json graph from the clipboard. Only when not typing, and only if it parses as a graph,
   so pasting into the label field stays a normal paste. */
addEventListener('paste', async (e) => {
  if (/^(input|textarea)$/i.test(document.activeElement?.tagName || '')) return;
  const text = e.clipboardData?.getData('text') || '';
  if (!text.trim().startsWith('{')) return;
  try { const d = JSON.parse(text); if (!Array.isArray(d.nodes)) return; snapshot(); hydrate(d); markDirty(); toast('pasted graph', 'ok'); }
  catch (err) { /* not json, not our business */ }
});
$('#btnHelp').addEventListener('click', () => $('#help').classList.toggle('hidden'));

addEventListener('keydown', (e) => {
  const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '');
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); snapshot(); exportFile(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  const map = { '1': 'select', '2': 'node', '3': 'link', '4': 'overlap', '5': 'contain', '6': 'gravity', '7': 'cut', '8': 'delete' };
  if (map[e.key]) { tool = map[e.key]; pending = null; setTool(); renderInspector(); return; }
  if (e.key === 'Escape') { pending = null; select(null); return; }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    if (pending) { pending = null; renderInspector(); toast('cleared'); return; }
    if (selected) { snapshot(); delNode(selected); }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'f') fit(); if (k === 'r') { wake(); } if (k === 'l') $('#btnLabels').click();
  if (k === 'v' && !e.shiftKey) { viewMode = viewMode === 'free' ? 'top' : viewMode === 'top' ? 'front' : 'free'; applyView(); }
  if (k === '?' || (k === '/' && e.shiftKey)) $('#help').classList.toggle('hidden');
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

function toast(msg, cls) {
  const t = document.createElement('div'); t.className = 'toast ' + (cls || ''); t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => { t.style.transition = 'opacity .4s, transform .4s'; t.style.opacity = 0; t.style.transform = 'translateY(-6px)'; setTimeout(() => t.remove(), 420); }, cls === 'err' ? 4200 : 2100);
}

/* ── main loop ───────────────────────────────────────────────────────── */
let last = performance.now(), frames = 0, lastStat = 0;
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  derive();
  if (ui.awake || dragging) {
    ui.relaxed = false;
    // The cooling schedule is counted in STEPS, so driving it from elapsed wall time would make
    // convergence speed a function of frame rate — measured at 8 fps under software rasterisation,
    // a dt-derived version took 36 s for a 7-bubble graph. Fixed step, bounded count per frame, and
    // a wall-clock ceiling so a big graph can never starve the draw.
    if (dragging && ui.alpha < K.alphaDrag) ui.alpha = K.alphaDrag;   // keep re-flowing under the pointer
    const end = performance.now() + 8;
    for (let n = 0; n < 300; n++) {
      if (isDone()) break;
      step();
      if (n >= 7 && performance.now() > end) break;   // always >=8 steps, then yield to the draw
    }
  }
  sync(); drawRelations(); controls.update();
  renderer.render(scene, camera);
  if (now - lastStat > 220) {
    lastStat = now;
    $('#statNodes').textContent = doc.nodes.length;
    $('#statRels').textContent = doc.edges.length + (ui.parent ? ui.parent.size : 0);
    $('#statEnergy').textContent = isDone() ? 'calm' : (ui.relaxed ? 'settled' : 'relaxing');
    if (dirty) setStatus('unsaved — export to keep it');
  }
  requestAnimationFrame(loop);
}

/* ── seed graph, shown when there is nothing saved yet ───────────────── */
const SEED = {
  name: 'demo — all four relationships',
  nodes: [
    { id: 'system', label: 'system', notes: 'encloses what belongs to it', r: 34, color: '#5fe3a1', pos: [-52, 14, -10] },
    { id: 'api', label: 'api', notes: 'inside system', r: 15, color: '#57c7ff', pos: [-58, 12, -8] },
    { id: 'auth', label: 'auth', notes: 'also inside, overlapping api', r: 12, color: '#b48cff', pos: [-40, 17, -4] },
    { id: 'store', label: 'data store', notes: 'linked to system — close, not overlapping', r: 17, color: '#6ea8ff', pos: [6, -6, 22] },
    { id: 'queue', label: 'queue', notes: 'linked to the store', r: 11, color: '#f5c66b', pos: [38, 6, 44] },
    { id: 'moon', label: 'moon', notes: 'disconnected, but gravitationally bound to the store', r: 8, color: '#9fb2d4', pos: [-18, -46, 30] },
    { id: 'far', label: 'far away thing', notes: 'no relationships at all — origin gravity only', r: 13, color: '#ff6b81', pos: [70, 48, -58] },
  ],
  edges: [
    { a: 'system', b: 'store', kind: 'link' },
    { a: 'store', b: 'queue', kind: 'link' },
    { a: 'store', b: 'moon', kind: 'gravity' },
  ],
};

/* ── boot ────────────────────────────────────────────────────────────── */
/* small live handle for smoke tests and console poking: reads real state, never a copy */
window.__bubble = {
  threeRev: THREE.REVISION, K, wake, clean, exportDoc: clean, hydrate, exportFile,
  // Cool to a freeze the way the frame loop does, but synchronously, so a test never depends on
  // when a frame happened to land. Same derive()+step() pair, same schedule, no rAF luck.
  cool: () => { let i = 0; while (ui.alpha > K.alphaMin && i++ < 5000) { derive(); step(); } return ui.alpha; },
  stepOnce: () => { derive(); step(); return ui.alpha; },   // for probe_gravity.py traces
  /* Where the graph actually lands on screen, in CSS pixels. Added because a screenshot script that
     cannot ask "is the subject in frame?" produces black rectangles and calls them screenshots —
     shot.py asserts on this instead of eyeballing it. */
  screenBox: () => {
    const v = new THREE.Vector3();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of doc.nodes) {
      v.set(...n.pos).project(camera);
      const px = (v.x * 0.5 + 0.5) * innerWidth, py = (-v.y * 0.5 + 0.5) * innerHeight;
      x0 = Math.min(x0, px - 4); x1 = Math.max(x1, px + 4);
      y0 = Math.min(y0, py - 4); y1 = Math.max(y1, py + 4);
    }
    return doc.nodes.length ? { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0,
                                vw: innerWidth, vh: innerHeight } : null;
  },
  get doc() { return doc; }, get ui() { return ui; }, get selected() { return selected; },
  kinds() {                                   // every relationship the model currently asserts
    const out = { inside: [], contains: [], link: [], gravity: [], overlap: [] };
    for (const [c, p] of ui.parent) out.inside.push([c, p]);
    for (const e of doc.edges) out[e.kind].push([e.a, e.b]);
    const ns = doc.nodes;
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i], b = ns[j];
      if (ui.parent.get(a.id) === b.id || ui.parent.get(b.id) === a.id) continue;
      const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
      if (d > 1e-4 && d < a.r + b.r) out.overlap.push([a.id, b.id]);
    }
    return out;
  },
};
(async function boot() {
  // Nothing is fetched and nothing is restored: the demo graph is the empty state, and a real
  // graph arrives only by Import, drag-drop or paste. Deterministic first paint, no 404 in the
  // console, and no chance of showing someone else's structure because a file was lying around.
  hydrate(JSON.parse(JSON.stringify(SEED)));
  dirty = false; setStatus('demo graph — Open to load yours', true);
  toast('this is a demo. press 2 and click to start, or drop a .json anywhere', 'ok');
  $('#btnLabels').classList.add('active');
  setTool(); applyView();
  $('#loading').classList.add('gone');
  requestAnimationFrame(loop);
  ui.loaded = true;
})();
