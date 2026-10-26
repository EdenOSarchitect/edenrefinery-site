// robots.js - EDEN interactive robots page. A small WebGL renderer (no libraries), two original concept
// units (ED-01 "Marble" humanoid, VPD-001 drone), clickable parts, and a live flight recorder whose
// cryptography is real: SHA-256 leaves, an RFC 6962 Merkle root, an Ed25519 seal where the browser
// supports it, a witness copy and a rewrite test. The machines are simulated; the hashing is not.
"use strict";
(() => {
const $ = (s, r = document) => r.querySelector(s);
const canvas = $("#stage");
const gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false });
if (!gl) { $("#nogl").hidden = false; return; }
gl.getExtension("OES_element_index_uint");

// ------------------------------------------------------------------ math (column-major mat4)
const M = {
  id: () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
  mul(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3]; } return o; },
  T: (x, y, z) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1],
  S: (x, y, z) => [x,0,0,0, 0,y,0,0, 0,0,z,0, 0,0,0,1],
  RX(a) { const c = Math.cos(a), s = Math.sin(a); return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]; },
  RY(a) { const c = Math.cos(a), s = Math.sin(a); return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]; },
  RZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]; },
  persp(f, asp, n, fa) { const t = 1 / Math.tan(f / 2); return [t/asp,0,0,0, 0,t,0,0, 0,0,(fa+n)/(n-fa),-1, 0,0,2*fa*n/(n-fa),0]; },
  lookAt(e, c, u) {
    let z = norm([e[0]-c[0], e[1]-c[1], e[2]-c[2]]), x = norm(cross(u, z)), y = cross(z, x);
    return [x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -dot(x,e),-dot(y,e),-dot(z,e),1]; },
  inv(m) { const a = m, o = new Array(16);
    const b00=a[0]*a[5]-a[1]*a[4], b01=a[0]*a[6]-a[2]*a[4], b02=a[0]*a[7]-a[3]*a[4], b03=a[1]*a[6]-a[2]*a[5],
      b04=a[1]*a[7]-a[3]*a[5], b05=a[2]*a[7]-a[3]*a[6], b06=a[8]*a[13]-a[9]*a[12], b07=a[8]*a[14]-a[10]*a[12],
      b08=a[8]*a[15]-a[11]*a[12], b09=a[9]*a[14]-a[10]*a[13], b10=a[9]*a[15]-a[11]*a[13], b11=a[10]*a[15]-a[11]*a[14];
    let d = b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06; d = d ? 1/d : 0;
    o[0]=(a[5]*b11-a[6]*b10+a[7]*b09)*d; o[1]=(a[2]*b10-a[1]*b11-a[3]*b09)*d; o[2]=(a[13]*b05-a[14]*b04+a[15]*b03)*d; o[3]=(a[10]*b04-a[9]*b05-a[11]*b03)*d;
    o[4]=(a[6]*b08-a[4]*b11-a[7]*b07)*d; o[5]=(a[0]*b11-a[2]*b08+a[3]*b07)*d; o[6]=(a[14]*b02-a[12]*b05-a[15]*b01)*d; o[7]=(a[8]*b05-a[10]*b02+a[11]*b01)*d;
    o[8]=(a[4]*b10-a[5]*b08+a[7]*b06)*d; o[9]=(a[1]*b08-a[0]*b10-a[3]*b06)*d; o[10]=(a[12]*b04-a[13]*b02+a[15]*b00)*d; o[11]=(a[9]*b02-a[8]*b04-a[11]*b00)*d;
    o[12]=(a[5]*b07-a[4]*b09-a[6]*b06)*d; o[13]=(a[0]*b09-a[1]*b07+a[2]*b06)*d; o[14]=(a[13]*b01-a[12]*b03-a[14]*b00)*d; o[15]=(a[8]*b03-a[9]*b01+a[10]*b00)*d;
    return o; },
  nrm(m) { const i = M.inv(m); return [i[0],i[4],i[8], i[1],i[5],i[9], i[2],i[6],i[10]]; },
  xf(m, p) { const x=p[0],y=p[1],z=p[2], w=m[3]*x+m[7]*y+m[11]*z+m[15];
    return [(m[0]*x+m[4]*y+m[8]*z+m[12])/w, (m[1]*x+m[5]*y+m[9]*z+m[13])/w, (m[2]*x+m[6]*y+m[10]*z+m[14])/w]; },
};
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
const chain = (...ms) => ms.reduce((a, b) => M.mul(a, b));

// ------------------------------------------------------------------ geometry
function lathe(prof, seg = 40) {   // prof: [[r, y], ...] bottom -> top; repeat a point for a hard edge
  const pos = [], nrm = [], idx = [], n = prof.length;
  const segN = k => { const a = prof[k], b = prof[k+1]; const t = [b[0]-a[0], b[1]-a[1]]; const l = Math.hypot(t[0], t[1]) || 1; return [t[1]/l, -t[0]/l]; };
  const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  for (let k = 0; k < n; k++) {
    let nn; const dp = k > 0 && same(prof[k-1], prof[k]), dn = k < n-1 && same(prof[k+1], prof[k]);
    if (k === n-1 || dn) nn = segN(k-1 >= 0 && !same(prof[k-1], prof[k]) ? k-1 : Math.max(0, k-2));
    else if (k === 0 || dp) nn = segN(k);
    else { const a = segN(k-1), b = segN(k); nn = [(a[0]+b[0])/2, (a[1]+b[1])/2]; }
    if (dn && k > 0) nn = segN(k-1); if (dp && k < n-1) nn = segN(k);
    const L = Math.hypot(nn[0], nn[1]) || 1; nn = [nn[0]/L, nn[1]/L];
    for (let i = 0; i <= seg; i++) { const a = i / seg * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      pos.push(prof[k][0]*c, prof[k][1], prof[k][0]*s); nrm.push(nn[0]*c, nn[1], nn[0]*s); }
  }
  for (let k = 0; k < n-1; k++) for (let i = 0; i < seg; i++) {
    const a = k*(seg+1)+i, b = a+seg+1; idx.push(a, b, a+1, b, b+1, a+1); }
  return { pos, nrm, idx };
}
const cyl = (r, h, s = 32) => lathe([[0,-h/2],[r,-h/2],[r,-h/2],[r,h/2],[r,h/2],[0,h/2]], s);
function capsule(r, len, s = 32) { const p = []; const st = 10;
  for (let i = 0; i <= st; i++) { const a = -Math.PI/2 + i/st*Math.PI/2; p.push([r*Math.cos(a), -len/2 + r*Math.sin(a)]); }
  for (let i = 0; i <= st; i++) { const a = i/st*Math.PI/2; p.push([r*Math.cos(a), len/2 + r*Math.sin(a)]); }
  p[0][0] = 0; p[p.length-1][0] = 0; return lathe(p, s); }
const sphere = (r, s = 32) => capsule(r, 0, s);
function torus(R, r, s = 48, t = 14) { const pos = [], nrm = [], idx = [];
  for (let i = 0; i <= s; i++) { const u = i/s*Math.PI*2, cu = Math.cos(u), su = Math.sin(u);
    for (let j = 0; j <= t; j++) { const v = j/t*Math.PI*2, cv = Math.cos(v), sv = Math.sin(v);
      pos.push((R + r*cv)*cu, r*sv, (R + r*cv)*su); nrm.push(cv*cu, sv, cv*su); } }
  for (let i = 0; i < s; i++) for (let j = 0; j < t; j++) { const a = i*(t+1)+j, b = a+t+1; idx.push(a, b, a+1, b, b+1, a+1); }
  return { pos, nrm, idx }; }
function box(w, h, d) { const x = w/2, y = h/2, z = d/2, pos = [], nrm = [], idx = [];
  const F = [[[1,0,0],[x,-y,-z],[x,y,-z],[x,y,z],[x,-y,z]], [[-1,0,0],[-x,-y,z],[-x,y,z],[-x,y,-z],[-x,-y,-z]],
    [[0,1,0],[-x,y,-z],[-x,y,z],[x,y,z],[x,y,-z]], [[0,-1,0],[-x,-y,z],[-x,-y,-z],[x,-y,-z],[x,-y,z]],
    [[0,0,1],[-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z]], [[0,0,-1],[x,-y,-z],[-x,-y,-z],[-x,y,-z],[x,y,-z]]];
  F.forEach((f, k) => { for (let i = 1; i < 5; i++) { pos.push(...f[i]); nrm.push(...f[0]); } const o = k*4; idx.push(o, o+1, o+2, o, o+2, o+3); });
  return { pos, nrm, idx }; }
const geoCache = new Map();
function upload(key, make) { if (geoCache.has(key)) return geoCache.get(key); const g = make();
  const v = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, v); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.pos), gl.STATIC_DRAW);
  const n = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, n); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.nrm), gl.STATIC_DRAW);
  const i = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, i); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(g.idx), gl.STATIC_DRAW);
  const o = { v, n, i, count: g.idx.length }; geoCache.set(key, o); return o; }
const G = {
  cyl: (r, h) => upload("c" + r + "," + h, () => cyl(r, h)), cap: (r, l) => upload("p" + r + "," + l, () => capsule(r, l)),
  sph: r => upload("s" + r, () => sphere(r)), tor: (R, r) => upload("t" + R + "," + r, () => torus(R, r)),
  box: (w, h, d) => upload("b" + w + "," + h + "," + d, () => box(w, h, d)), lathe: (k, p, s) => upload("l" + k, () => lathe(p, s)),
};

// ------------------------------------------------------------------ shaders
function prog(vs, fs) { const p = gl.createProgram();
  for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); gl.attachShader(p, sh); }
  gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let k = 0; k < n; k++) { const a = gl.getActiveUniform(p, k); u[a.name] = gl.getUniformLocation(p, a.name); }
  return { p, u, aP: gl.getAttribLocation(p, "aP"), aN: gl.getAttribLocation(p, "aN") }; }
const VS = `attribute vec3 aP; attribute vec3 aN; uniform mat4 uM, uVP; uniform mat3 uNM; varying vec3 vW, vN;
void main(){ vec4 w = uM*vec4(aP,1.0); vW = w.xyz; vN = normalize(uNM*aN); gl_Position = uVP*w; }`;
const FS = `precision highp float; varying vec3 vW, vN; uniform vec3 uCam, uCol, uEm; uniform float uMet, uRou, uHi, uTime;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
vec3 envc(vec3 r){ float y = r.y; vec3 sky = mix(vec3(0.05,0.07,0.10), vec3(0.42,0.47,0.55), smoothstep(-0.1,0.9,y));
  sky += vec3(1.0,0.86,0.6)*0.9*smoothstep(0.92,1.0,dot(r,normalize(vec3(0.5,0.6,0.62))));
  sky += vec3(0.4,0.75,1.0)*0.45*smoothstep(0.88,1.0,dot(r,normalize(vec3(-0.8,0.2,-0.4))));
  sky += vec3(0.9,0.75,0.45)*0.25*smoothstep(0.02,0.0,abs(y-0.08));
  return mix(vec3(0.015,0.02,0.03), sky, smoothstep(-0.25,0.05,y)); }
void main(){ vec3 N = normalize(vN); vec3 V = normalize(uCam - vW); if (dot(N,V) < 0.0) N = -N;
  vec3 base = uCol; vec3 diff = base*(1.0-uMet); vec3 F0 = mix(vec3(0.04), base, uMet);
  float sh = mix(6.0, 420.0, pow(1.0-uRou, 2.0)); vec3 col = vec3(0.0);
  vec3 L[3]; vec3 C[3]; L[0]=normalize(vec3(0.5,0.85,0.62)); C[0]=vec3(1.0,0.95,0.88)*2.4;
  L[1]=normalize(vec3(-0.8,0.25,-0.5)); C[1]=vec3(0.35,0.62,1.0)*1.1; L[2]=normalize(vec3(-0.25,0.35,-0.95)); C[2]=vec3(1.0,0.78,0.42)*1.3;
  for (int i=0;i<3;i++){ float nl = max(dot(N,L[i]),0.0); vec3 H = normalize(L[i]+V);
    float spec = pow(max(dot(N,H),0.0), sh)*(sh+8.0)/25.0; vec3 F = F0+(1.0-F0)*pow(1.0-max(dot(H,V),0.0),5.0);
    col += (diff*nl + F*spec*nl)*C[i]; }
  vec3 R = reflect(-V,N); vec3 Fe = F0+(1.0-F0)*pow(1.0-max(dot(N,V),0.0),5.0)*(1.0-uRou);
  col += Fe*envc(R)*(1.0-0.75*uRou)*1.2; col += diff*mix(vec3(0.04,0.045,0.05), vec3(0.14,0.15,0.17), N.y*0.5+0.5);
  col += uEm; col += vec3(0.95,0.72,0.3)*uHi*(0.35+0.25*sin(uTime*5.0))*(0.4+pow(1.0-max(dot(N,V),0.0),2.0));
  gl_FragColor = vec4(pow(aces(col*0.9), vec3(1.0/2.2)), 1.0); }`;
const PFS = `precision mediump float; uniform vec3 uId; void main(){ gl_FragColor = vec4(uId,1.0); }`;
const SFS = `precision mediump float; varying vec3 vW, vN; uniform vec3 uC; uniform float uR, uA;
void main(){ float d = length(vW.xz - uC.xz)/uR; float a = uA*exp(-d*d*3.0); gl_FragColor = vec4(0.0,0.0,0.0,a); }`;
const GFS = `precision mediump float; varying vec3 vW, vN; uniform float uTime;
void main(){ float r = length(vW.xz); float d = abs(fract(r*2.5+0.5)-0.5); float ring = smoothstep(0.018,0.0,d)*step(0.3,r);
  float a = (1.0-smoothstep(0.4,2.6,r)); vec3 c = mix(vec3(0.03,0.045,0.06), vec3(0.85,0.68,0.36), ring*0.6);
  float sweep = smoothstep(0.06,0.0,abs(r - mod(uTime*0.6,2.6)))*0.35; c += vec3(0.3,0.6,1.0)*sweep*a;
  gl_FragColor = vec4(c, a*(0.5+ring*0.45)); }`;
const P = prog(VS, FS), PP = prog(VS, PFS), PS = prog(VS, SFS), PG = prog(VS, GFS);

// ------------------------------------------------------------------ scene graph
function N(o = {}) { return { geo: o.geo || null, mat: o.mat || null, loc: o.loc || (() => M.id()), kids: [], part: o.part || null, anchor: o.anchor || null, name: o.name }; }
function add(p, ...k) { p.kids.push(...k); return p; }
const MAT = {
  armour: { c: [0.66, 0.665, 0.66], met: 0.35, rou: 0.26 }, armour2: { c: [0.46, 0.465, 0.47], met: 0.45, rou: 0.3 },
  carbon: { c: [0.035, 0.037, 0.042], met: 0.55, rou: 0.42 }, carbon2: { c: [0.07, 0.075, 0.085], met: 0.7, rou: 0.3 },
  gold: { c: [0.92, 0.70, 0.34], met: 1.0, rou: 0.28 }, visor: { c: [0.01, 0.012, 0.018], met: 0.9, rou: 0.08 },
  blue: { c: [0.05, 0.2, 0.5], met: 0.0, rou: 0.4, em: [0.25, 0.62, 1.6] }, red: { c: [0.5, 0.05, 0.03], met: 0.1, rou: 0.35, em: [0.9, 0.08, 0.04] },
  glass: { c: [0.02, 0.04, 0.08], met: 0.9, rou: 0.05 }, green: { c: [0.05, 0.4, 0.2], met: 0, rou: 0.4, em: [0.1, 1.2, 0.5] },
};
const st = { t: 0, anim: {}, sel: null, model: "humanoid", look: [0, 0] };
const ease = (cur, tgt, k) => cur + (tgt - cur) * k;
function A(name, def = 0) { if (!(name in st.anim)) st.anim[name] = { v: def, t: def }; return st.anim[name]; }

// ---------- ED-01 "Marble" (original concept by the founder; built here from primitives)
function buildHumanoid() {
  const root = N({ loc: () => M.T(0, Math.sin(st.t * 1.6) * 0.004, 0) });
  const em = (m, e) => Object.assign({}, m, { em: e });
  // pelvis + legs
  const pelvis = N({ loc: () => M.T(0, 0.98 + A("bob").v, 0) });
  add(pelvis, N({ geo: G.lathe("pelvis", [[0,-0.1],[0.13,-0.09],[0.17,0.0],[0.16,0.08],[0,0.09]], 40), mat: MAT.armour, loc: () => M.S(1, 1, 0.72), part: "legs" }),
    N({ geo: G.tor(0.162, 0.008), mat: MAT.gold, loc: () => chain(M.T(0, 0.03, 0), M.S(1, 1, 0.72)) }));
  for (const sd of [-1, 1]) {
    const hip = N({ loc: () => chain(M.T(0.095 * sd, -0.06, 0), M.RX(A("leg" + sd).v)) });
    add(hip, N({ geo: G.sph(0.062), mat: MAT.carbon2 }),
      N({ geo: G.cap(0.058, 0.3), mat: MAT.carbon, loc: () => M.T(0, -0.22, 0), part: "legs" }),
      N({ geo: G.cap(0.066, 0.2), mat: MAT.armour, loc: () => chain(M.T(0, -0.19, 0.012), M.S(1, 1, 0.9)), part: "legs" }),
      N({ geo: G.tor(0.07, 0.006), mat: MAT.gold, loc: () => M.T(0, -0.33, 0.01) }));
    const knee = N({ loc: () => chain(M.T(0, -0.44, 0), M.RX(-A("leg" + sd).v * 0.9)) });
    add(knee, N({ geo: G.sph(0.06), mat: MAT.carbon2 }), N({ geo: G.cyl(0.03, 0.012), mat: MAT.blue, loc: () => chain(M.T(0, 0, 0.058), M.RX(Math.PI / 2)) }),
      N({ geo: G.cap(0.05, 0.3), mat: MAT.carbon, loc: () => M.T(0, -0.22, 0), part: "legs" }),
      N({ geo: G.cap(0.056, 0.2), mat: MAT.armour, loc: () => chain(M.T(0, -0.18, 0.014), M.S(1, 1, 1.05)), part: "legs" }),
      N({ geo: G.box(0.012, 0.12, 0.01), mat: MAT.blue, loc: () => M.T(0, -0.2, 0.086) }),
      N({ geo: G.tor(0.058, 0.006), mat: MAT.gold, loc: () => M.T(0, -0.33, 0.01) }),
      N({ geo: G.box(0.09, 0.05, 0.22), mat: MAT.carbon2, loc: () => M.T(0, -0.45, 0.03), part: "legs" }),
      N({ geo: G.box(0.094, 0.04, 0.08), mat: MAT.armour, loc: () => M.T(0, -0.445, 0.11), part: "legs" }),
      N({ geo: G.box(0.096, 0.006, 0.226), mat: MAT.gold, loc: () => M.T(0, -0.428, 0.03) }));
    add(hip, knee); add(pelvis, hip);
  }
  // abdomen (segmented carbon) + torso shell
  const spine = N({ loc: () => chain(M.T(0, 0.08, 0), M.RX(A("lean").v)) });
  for (let k = 0; k < 4; k++) add(spine, N({ geo: G.cyl(0.115 - k * 0.002, 0.035), mat: k % 2 ? MAT.carbon2 : MAT.carbon, loc: () => chain(M.T(0, 0.02 + k * 0.042, 0), M.S(1, 1, 0.78)) }));
  add(spine, N({ geo: G.box(0.03, 0.07, 0.008), mat: MAT.blue, loc: () => M.T(0, 0.09, 0.092) }));
  const chest = N({ loc: () => chain(M.T(0, 0.2, 0), M.S(1, 1 + Math.sin(st.t * 1.6) * 0.008, 1)) });
  add(chest, N({ geo: G.lathe("torso", [[0,0],[0.12,0.0],[0.165,0.08],[0.2,0.19],[0.205,0.26],[0.18,0.32],[0.1,0.36],[0,0.36]], 48), mat: MAT.armour, loc: () => M.S(1, 1, 0.68), part: "compute" }),
    N({ geo: G.lathe("torsoC", [[0,0.005],[0.125,0.005],[0.15,0.04],[0,0.04]], 40), mat: MAT.carbon, loc: () => M.S(1, 1, 0.7) }),
    N({ geo: G.tor(0.182, 0.005), mat: MAT.gold, loc: () => chain(M.T(0, 0.3, 0), M.S(1, 1, 0.68)) }),
    // EDEN mark on the chest: gold ring + vertical bar, with a glowing core behind (the onboard computer)
    N({ geo: G.cyl(0.05, 0.012), mat: MAT.carbon2, loc: () => chain(M.T(0, 0.205, 0.136), M.RX(Math.PI / 2)), part: "compute" }),
    N({ geo: G.tor(0.034, 0.006), mat: MAT.gold, loc: () => chain(M.T(0, 0.205, 0.144), M.RX(Math.PI / 2)), part: "compute" }),
    N({ geo: G.box(0.008, 0.09, 0.008), mat: MAT.gold, loc: () => M.T(0, 0.205, 0.146), part: "compute" }),
    N({ geo: G.cyl(0.02, 0.006), mat: () => em(MAT.blue, [0.2 + 0.25 * A("core", 1).v, 0.55 + 0.4 * A("core", 1).v, 1.5 * A("core", 1).v + 0.4]), loc: () => chain(M.T(0, 0.205, 0.14), M.RX(Math.PI / 2)), part: "compute", anchor: [0, 0.205, 0.16] }),
    // backpack: battery, e-stop, antenna
    N({ geo: G.box(0.19, 0.2, 0.07), mat: MAT.armour2, loc: () => M.T(0, 0.17, -0.15), part: "estop" }),
    N({ geo: G.box(0.17, 0.01, 0.074), mat: MAT.gold, loc: () => M.T(0, 0.22, -0.15) }),
    N({ geo: G.cyl(0.026, 0.03), mat: () => em(MAT.red, [0.9 * (0.4 + A("stop").v * 1.6), 0.06, 0.03]), loc: () => chain(M.T(0.05, 0.12, -0.19), M.RX(Math.PI / 2)), part: "estop", anchor: [0.05, 0.12, -0.21] }),
    N({ geo: G.cyl(0.005, 0.12), mat: MAT.carbon2, loc: () => M.T(-0.07, 0.31, -0.16), part: "radio" }),
    N({ geo: G.sph(0.014), mat: () => em(MAT.blue, [0.3, 0.7, 1.4 + Math.max(0, Math.sin(st.t * 6)) * 2 * A("tx").v]), loc: () => M.T(-0.07, 0.375, -0.16), part: "radio", anchor: [-0.07, 0.38, -0.16] }));
  // arms
  for (const sd of [-1, 1]) {
    const sh = N({ loc: () => chain(M.T(0.225 * sd, 0.29, 0), M.RZ(0.1 * sd), M.RX(A("arm" + sd).v)) });
    add(sh, N({ geo: G.sph(0.068), mat: MAT.armour, loc: () => M.S(1.1, 0.95, 1), part: "hands" }), N({ geo: G.tor(0.072, 0.006), mat: MAT.gold, loc: () => chain(M.T(0, -0.02, 0), M.RZ(Math.PI / 2 * 0)) }),
      N({ geo: G.cap(0.042, 0.2), mat: MAT.carbon, loc: () => M.T(0, -0.16, 0), part: "hands" }),
      N({ geo: G.cap(0.049, 0.12), mat: MAT.armour, loc: () => M.T(0, -0.15, 0), part: "hands" }));
    const el = N({ loc: () => chain(M.T(0, -0.3, 0), M.RX(A("elb" + sd).v)) });
    add(el, N({ geo: G.sph(0.045), mat: MAT.carbon2 }), N({ geo: G.cap(0.038, 0.2), mat: MAT.carbon, loc: () => M.T(0, -0.14, 0), part: "hands" }),
      N({ geo: G.cap(0.044, 0.12), mat: MAT.armour, loc: () => M.T(0, -0.13, 0.005), part: "hands" }),
      N({ geo: G.box(0.006, 0.08, 0.006), mat: MAT.blue, loc: () => M.T(0.046 * sd, -0.13, 0) }),
      N({ geo: G.tor(0.046, 0.005), mat: MAT.gold, loc: () => M.T(0, -0.215, 0) }));
    const hand = N({ loc: () => chain(M.T(0, -0.28, 0), M.RX(A("grip").v * (sd > 0 ? 1 : 0) * 0.4)) });
    add(hand, N({ geo: G.box(0.06, 0.075, 0.028), mat: MAT.carbon2, part: "hands", anchor: sd > 0 ? [0, -0.02, 0.03] : null }));
    for (let f = 0; f < 4; f++) add(hand, N({ geo: G.cap(0.008, 0.05), mat: MAT.carbon, loc: () => chain(M.T(-0.025 + f * 0.017, -0.07, 0), M.RX(A("grip").v * (sd > 0 ? 1.2 : 0.2))), part: "hands" }));
    add(hand, N({ geo: G.cap(0.009, 0.04), mat: MAT.carbon, loc: () => chain(M.T(0.038 * -sd, -0.03, 0.015), M.RZ(0.6 * sd)) }));
    add(el, hand); add(sh, el); add(chest, sh);
  }
  // head
  const neck = N({ loc: () => M.T(0, 0.37, 0) });
  add(neck, N({ geo: G.cyl(0.045, 0.07), mat: MAT.carbon2, loc: () => M.T(0, 0.02, 0) }), N({ geo: G.tor(0.047, 0.005), mat: MAT.gold, loc: () => M.T(0, 0.0, 0) }));
  const head = N({ loc: () => chain(M.T(0, 0.15, 0), M.RY(A("yaw").v), M.RX(A("pitch").v)) });
  add(head, N({ geo: G.sph(0.115), mat: MAT.armour, loc: () => M.S(0.92, 1.12, 1.0), part: "sensors" }),
    N({ geo: G.sph(0.11), mat: MAT.visor, loc: () => chain(M.T(0, -0.012, 0.022), M.S(0.84, 0.95, 0.93)), part: "sensors" }),
    N({ geo: G.box(0.03, 0.04, 0.2), mat: MAT.armour, loc: () => M.T(0, 0.09, 0.02) }),
    N({ geo: G.box(0.004, 0.035, 0.004), mat: MAT.gold, loc: () => M.T(0, 0.075, 0.105) }));
  for (const sd of [-1, 1]) add(head,
    N({ geo: G.box(0.05, 0.012, 0.01), mat: () => em(MAT.blue, A("eye").v > 0.5 ? [1.6, 0.6, 0.1] : [0.35, 0.8, 1.9]), loc: () => chain(M.T(0.034 * sd, 0.0, 0.126), M.RY(0.3 * sd), M.RZ(-0.28 * sd)), part: "sensors", anchor: sd > 0 ? [0.036, 0.0, 0.13] : null }),
    N({ geo: G.cyl(0.04, 0.03), mat: MAT.armour2, loc: () => chain(M.T(0.1 * sd, 0.0, -0.005), M.RZ(Math.PI / 2)), part: "sensors" }),
    N({ geo: G.tor(0.03, 0.006), mat: MAT.blue, loc: () => chain(M.T(0.117 * sd, 0.0, -0.005), M.RZ(Math.PI / 2)), part: "sensors" }),
    N({ geo: G.tor(0.04, 0.005), mat: MAT.gold, loc: () => chain(M.T(0.114 * sd, 0.0, -0.005), M.RZ(Math.PI / 2)) }));
  add(neck, head); add(chest, neck); add(spine, chest); add(pelvis, spine); add(root, pelvis);
  // anchors for hotspots that sit on limbs
  root.hot = { sensors: [0.04, 1.77, 0.13], compute: [0, 1.465, 0.16], hands: [0.3, 1.02, 0.05], legs: [0.1, 0.56, 0.08], estop: [0.05, 1.38, -0.21], radio: [-0.07, 1.64, -0.16] };
  root.target = [0, 0.92, 0]; root.dist = 3.9; root.shadowR = 0.42;
  return root;
}

// ---------- VPD-001 (original concept by the founder): four ducted rotors around a carbon dome
function buildDrone() {
  const em = (m, e) => Object.assign({}, m, { em: e });
  const root = N({ loc: () => chain(M.T(0, 0.95 + Math.sin(st.t * 1.3) * 0.03 + A("alt").v, 0), M.RY(A("dyaw").v), M.RZ(A("roll").v + Math.sin(st.t * 0.9) * 0.02), M.RX(A("dpitch").v)) });
  add(root, N({ geo: G.lathe("dome", [[0,-0.07],[0.12,-0.068],[0.17,-0.03],[0.18,0.0],[0.165,0.04],[0.12,0.085],[0.05,0.11],[0,0.112]], 48), mat: MAT.carbon2, part: "fc" }),
    N({ geo: G.tor(0.178, 0.008), mat: MAT.gold, loc: () => M.T(0, -0.002, 0) }),
    N({ geo: G.tor(0.04, 0.006), mat: MAT.gold, loc: () => chain(M.T(0, 0.075, 0.09), M.RX(Math.PI / 2 - 0.75)), part: "fc" }),
    N({ geo: G.box(0.008, 0.06, 0.008), mat: MAT.gold, loc: () => chain(M.T(0, 0.075, 0.093), M.RX(-0.75)), part: "fc" }),
    N({ geo: G.cyl(0.024, 0.004), mat: () => em(MAT.blue, [0.3, 0.7, 1.2 + A("think").v * 2.2]), loc: () => chain(M.T(0, 0.075, 0.084), M.RX(Math.PI / 2 - 0.75)), part: "fc", anchor: [0, 0.09, 0.1] }),
    N({ geo: G.box(0.16, 0.05, 0.11), mat: MAT.armour, loc: () => M.T(0, 0.04, -0.17), part: "battery" }),
    N({ geo: G.box(0.164, 0.008, 0.114), mat: MAT.gold, loc: () => M.T(0, 0.045, -0.17) }),
    N({ geo: G.box(0.1, 0.006, 0.012), mat: () => em(MAT.green, A("lowb").v > 0.5 ? [1.4, 0.5, 0.05] : [0.1, 1.1, 0.4]), loc: () => M.T(0, 0.068, -0.17), part: "battery", anchor: [0, 0.075, -0.17] }),
    // GPS mast
    N({ geo: G.cyl(0.006, 0.06), mat: MAT.carbon, loc: () => M.T(0, 0.14, -0.03), part: "gps" }),
    N({ geo: G.cyl(0.032, 0.014), mat: MAT.armour, loc: () => M.T(0, 0.175, -0.03), part: "gps", anchor: [0, 0.19, -0.03] }),
    N({ geo: G.tor(0.032, 0.004), mat: () => em(MAT.gold, A("fence").v > 0.5 ? [1.2, 0.5, 0.0] : [0, 0, 0]), loc: () => M.T(0, 0.175, -0.03) }),
    // antennas
    ...[-1, 1].map(sd => N({ geo: G.cyl(0.004, 0.14), mat: MAT.carbon2, loc: () => chain(M.T(0.06 * sd, -0.1, -0.22), M.RX(0.5)), part: "radio" })),
    N({ geo: G.sph(0.01), mat: () => em(MAT.blue, [0.3, 0.7, 1.2 + Math.max(0, Math.sin(st.t * 7)) * 2 * A("tx").v]), loc: () => M.T(0.06, -0.165, -0.255), part: "radio", anchor: [0.06, -0.17, -0.26] }),
    // gimbal camera with a sensor cluster
    N({ geo: G.cyl(0.02, 0.05), mat: MAT.carbon, loc: () => M.T(0, -0.09, 0.08) }),
    N({ geo: G.sph(0.055), mat: MAT.armour, loc: () => chain(M.T(0, -0.13, 0.09), M.RY(A("gim").v)), part: "camera" }),
    N({ geo: G.cyl(0.032, 0.04), mat: MAT.carbon, loc: () => chain(M.T(0, -0.13, 0.09), M.RY(A("gim").v), M.T(0, 0, 0.045), M.RX(Math.PI / 2)), part: "camera" }),
    N({ geo: G.cyl(0.022, 0.006), mat: () => em(MAT.glass, [0.08, 0.25 + A("shot").v, 0.6 + A("shot").v * 1.5]), loc: () => chain(M.T(0, -0.13, 0.09), M.RY(A("gim").v), M.T(0, 0, 0.067), M.RX(Math.PI / 2)), part: "camera", anchor: [0, -0.13, 0.17] }),
    N({ geo: G.tor(0.032, 0.004), mat: MAT.gold, loc: () => chain(M.T(0, -0.13, 0.09), M.RY(A("gim").v), M.T(0, 0, 0.066), M.RX(Math.PI / 2)) }));
  // four ducted rotors on short armoured arms (X layout)
  const pods = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
  pods.forEach(([sx, sz], k) => {
    const ang = Math.atan2(sz, sx), R = 0.38;
    add(root, N({ geo: G.box(0.26, 0.05, 0.08), mat: MAT.armour, loc: () => chain(M.RY(-ang), M.T(0.2, 0.0, 0)), part: "rotors" }),
      N({ geo: G.box(0.262, 0.012, 0.082), mat: MAT.carbon, loc: () => chain(M.RY(-ang), M.T(0.2, -0.03, 0)) }));
    const pod = N({ loc: () => M.T(R * Math.cos(ang), 0, R * Math.sin(ang)) });
    add(pod, N({ geo: G.lathe("duct", [[0.212,-0.034],[0.236,-0.034],[0.236,-0.034],[0.246,-0.016],[0.246,0.02],[0.236,0.036],[0.236,0.036],[0.212,0.036]], 64), mat: MAT.armour, part: "rotors" }),
      N({ geo: G.lathe("ductIn", [[0.205,-0.036],[0.205,0.036]], 64), mat: MAT.carbon, part: "rotors" }),
      N({ geo: G.lathe("ductLip", [[0.205,0.036],[0.205,0.036],[0.214,0.036],[0.214,0.036]], 64), mat: MAT.carbon2 }),
      ...[0, 1, 2, 3].map(q => N({ geo: G.box(0.2, 0.008, 0.012), mat: MAT.carbon2, loc: () => chain(M.RY(q * Math.PI / 2 + 0.4), M.T(0.11, -0.03, 0)) })),
      N({ geo: G.tor(0.24, 0.006), mat: MAT.carbon, loc: () => M.T(0, -0.036, 0) }),
      N({ geo: G.tor(0.2, 0.006), mat: () => em(MAT.blue, [0.25, 0.6 * A("spin", 1).v + 0.1, 1.8 * A("spin", 1).v + 0.2]), loc: () => M.T(0, -0.03, 0), part: "rotors" }),
      N({ geo: G.tor(0.247, 0.003), mat: MAT.gold, loc: () => M.T(0, 0.004, 0) }),
      N({ geo: G.cyl(0.045, 0.05), mat: MAT.carbon2, part: "rotors" }),
      N({ geo: G.cyl(0.03, 0.054), mat: () => em(MAT.blue, [0.2, 0.55, 1.4 * A("spin", 1).v + 0.2]), part: "rotors" }),
      N({ geo: G.sph(0.012), mat: () => em(k < 2 ? MAT.green : MAT.red, (k < 2 ? [0.1, 1.2, 0.4] : [1.3, 0.08, 0.05]).map(c => c * (0.4 + 0.6 * (Math.sin(st.t * 4 + k) > 0)))), loc: () => M.T(0.245 * (sx > 0 ? 1 : -1) * 0.7, 0.0, 0.245 * (sz > 0 ? 1 : -1) * 0.7) }));
    const prop = N({ loc: () => chain(M.T(0, 0.01, 0), M.RY(st.t * (6 + 30 * A("spin", 1).v) * (k % 2 ? 1 : -1))) });
    for (let b = 0; b < 3; b++) add(prop, N({ geo: G.box(0.17, 0.004, 0.03), mat: MAT.carbon, loc: () => chain(M.RY(b * Math.PI * 2 / 3), M.T(0.1, 0, 0), M.RX(0.25)) }));
    add(pod, prop); add(root, pod);
  });
  root.hot = { fc: [0, 0.09, 0.1], camera: [0, -0.13, 0.17], gps: [0, 0.19, -0.03], radio: [0.06, -0.17, -0.26], battery: [0, 0.075, -0.17], rotors: [0.44, 0.04, 0.44] }; root.hotLocal = true;
  root.target = [0, 0.95, 0]; root.dist = 2.7; root.shadowR = 0.7;
  return root;
}
const MODELS = { humanoid: buildHumanoid(), drone: buildDrone() };

// ------------------------------------------------------------------ camera + input
const cam = { yaw: 0.55, pitch: 0.1, dist: 3.9, tgt: [0, 0.95, 0], idle: 0 };
let drag = null, moved = 0; const pts = new Map();
canvas.addEventListener("pointerdown", e => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); drag = [e.clientX, e.clientY]; moved = 0; cam.idle = 0; });
canvas.addEventListener("pointermove", e => {
  const r = canvas.getBoundingClientRect(); st.look = [((e.clientX - r.left) / r.width - 0.5) * 2, ((e.clientY - r.top) / r.height - 0.5) * 2];
  if (!pts.has(e.pointerId)) return; const prev = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
  if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (cam.pinch) cam.dist = Math.min(6, Math.max(1.4, cam.dist * cam.pinch / d)); cam.pinch = d; return; }
  const dx = e.clientX - prev[0], dy = e.clientY - prev[1]; moved += Math.abs(dx) + Math.abs(dy);
  cam.yaw -= dx * 0.008; cam.pitch = Math.min(1.1, Math.max(-0.35, cam.pitch + dy * 0.006)); cam.idle = 0; });
const up = e => { pts.delete(e.pointerId); cam.pinch = null; if (moved < 6 && drag) pick(e.clientX, e.clientY); drag = null; };
canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", e => { pts.delete(e.pointerId); drag = null; });
canvas.addEventListener("wheel", e => { e.preventDefault(); cam.dist = Math.min(6, Math.max(1.4, cam.dist * (1 + Math.sign(e.deltaY) * 0.08))); cam.idle = 0; }, { passive: false });

// ------------------------------------------------------------------ rendering
let VP, eye, W = 1, H = 1, dpr = 1;
function resize() { dpr = Math.min(2, window.devicePixelRatio || 1); const r = canvas.getBoundingClientRect(); W = Math.max(1, Math.round(r.width * dpr)); H = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; } }
function bind(pr, g) { gl.bindBuffer(gl.ARRAY_BUFFER, g.v); gl.enableVertexAttribArray(pr.aP); gl.vertexAttribPointer(pr.aP, 3, gl.FLOAT, false, 0, 0);
  if (pr.aN >= 0) { gl.bindBuffer(gl.ARRAY_BUFFER, g.n); gl.enableVertexAttribArray(pr.aN); gl.vertexAttribPointer(pr.aN, 3, gl.FLOAT, false, 0, 0); }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.i); }
function walk(n, parent, fn) { const m = M.mul(parent, n.loc()); if (n.geo) fn(n, m); for (const k of n.kids) walk(k, m, fn); }
const ids = []; let groundG, shadowG;
function draw(t) {
  resize(); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const mdl = MODELS[st.model]; cam.tgt = cam.tgt.map((v, i) => ease(v, mdl.target[i], 0.08));
  cam.idle += 1 / 60; if (cam.idle > 3 && !pts.size) cam.yaw += 0.0025;
  eye = [cam.tgt[0] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), cam.tgt[1] + cam.dist * Math.sin(cam.pitch) + 0.15, cam.tgt[2] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw)];
  VP = M.mul(M.persp(0.62, W / H, 0.05, 40), M.lookAt(eye, cam.tgt, [0, 1, 0]));
  gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
  // ground + shadow (blended, no depth write)
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
  groundG = groundG || upload("ground", () => lathe([[0,0],[2.8,0]], 96));
  gl.useProgram(PG.p); bind(PG, groundG); gl.uniformMatrix4fv(PG.u.uM, false, M.id()); gl.uniformMatrix4fv(PG.u.uVP, false, VP); gl.uniformMatrix3fv(PG.u.uNM, false, [1,0,0,0,1,0,0,0,1]); gl.uniform1f(PG.u.uTime, t);
  gl.drawElements(gl.TRIANGLES, groundG.count, gl.UNSIGNED_INT, 0);
  gl.useProgram(PS.p); bind(PS, groundG); gl.uniformMatrix4fv(PS.u.uM, false, M.T(0, 0.002, 0)); gl.uniformMatrix4fv(PS.u.uVP, false, VP); gl.uniformMatrix3fv(PS.u.uNM, false, [1,0,0,0,1,0,0,0,1]);
  gl.uniform3f(PS.u.uC, 0, 0, 0); gl.uniform1f(PS.u.uR, mdl.shadowR); gl.uniform1f(PS.u.uA, st.model === "drone" ? 0.45 : 0.75);
  gl.drawElements(gl.TRIANGLES, groundG.count, gl.UNSIGNED_INT, 0);
  gl.depthMask(true); gl.disable(gl.BLEND);
  gl.useProgram(P.p); gl.uniformMatrix4fv(P.u.uVP, false, VP); gl.uniform3fv(P.u.uCam, eye); gl.uniform1f(P.u.uTime, t);
  walk(mdl, M.id(), (n, m) => { const mat = typeof n.mat === "function" ? n.mat() : n.mat; bind(P, n.geo);
    gl.uniformMatrix4fv(P.u.uM, false, m); gl.uniformMatrix3fv(P.u.uNM, false, M.nrm(m));
    gl.uniform3fv(P.u.uCol, mat.c); gl.uniform3fv(P.u.uEm, mat.em || [0, 0, 0]); gl.uniform1f(P.u.uMet, mat.met); gl.uniform1f(P.u.uRou, mat.rou);
    gl.uniform1f(P.u.uHi, st.sel && n.part === st.sel ? 1 : 0); gl.drawElements(gl.TRIANGLES, n.geo.count, gl.UNSIGNED_INT, 0); });
  placeHotspots(mdl);
}
// picking by colour id
let fbo = null, fbT = null, fbD = null, fbW = 0, fbH = 0;
function pick(cx, cy) {
  const r = canvas.getBoundingClientRect(); const x = Math.round((cx - r.left) * dpr), y = Math.round(H - (cy - r.top) * dpr);
  if (!fbo || fbW !== W || fbH !== H) { fbo = gl.createFramebuffer(); fbT = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, fbT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    fbD = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, fbD); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbT, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, fbD); fbW = W; fbH = H; }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST);
  gl.useProgram(PP.p); gl.uniformMatrix4fv(PP.u.uVP, false, VP); const parts = [null];
  walk(MODELS[st.model], M.id(), (n, m) => { let id = 0; if (n.part) { id = parts.indexOf(n.part); if (id < 0) { parts.push(n.part); id = parts.length - 1; } }
    bind(PP, n.geo); gl.uniformMatrix4fv(PP.u.uM, false, m); gl.uniform3f(PP.u.uId, id / 255, 0, 0); gl.drawElements(gl.TRIANGLES, n.geo.count, gl.UNSIGNED_INT, 0); });
  const px = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const part = parts[px[0]] || null; select(part); }

// ------------------------------------------------------------------ parts, hotspots, info panel
const INFO = {
  humanoid: {
    sensors: ["Head cameras and sensors", "A SHA-256 fingerprint of every key camera frame and sensor reading a decision used. The video stays on the robot; the fingerprint proves which frame it was.", '{"kind":"perception","input":"sha256:3f9a…","model":"vision v4.2"}', "Measured: a 16 KiB key frame hashed and recorded in 0.02–0.03 ms on a laptop CPU, 0.12 ms on a phone."],
    compute: ["Onboard computer", "Every decision: which exact model version made it, in which mode, with what confidence and on whose authority.", '{"kind":"decision","model":"grasp-net v4.2","confidence":94,"mode":"AUTONOMOUS"}', "Measured: about 0.07% of one phone CPU core at 6 decisions a second."],
    hands: ["Hands and arms", "Every grasp, release and force limit, tied to the decision that caused it. Delete or reorder one and verification fails.", '{"kind":"action","grip":"close","force_n":18,"limit_n":40}', "Checking a decision is about 4,000× cheaper than re-running it (measured)."],
    legs: ["Legs and balance", "Motion and mode changes: autonomous, supervised or teleoperated, and who took control.", '{"kind":"mode","from":"SUPERVISED","to":"AUTONOMOUS","approved_by":"op-17"}', "Order is proven: the record shows exactly what happened before what."],
    estop: ["Emergency stop", "Stops and overrides are sealed the moment they happen, with who triggered them. An urgent seal locks everything before it, so nobody can rewrite what led up to the stop.", '{"kind":"estop","by":"op-17","reason":"person_in_path"}', "The question after an incident, 'what did it decide and who was in control?', gets an answer anyone can check."],
    radio: ["Radio link", "Only the seal leaves the robot: about 411 bytes, sent to witnesses such as the insurer or the site owner. The full log stays on board.", '{"type":"seal","n":1840,"root":"9c1e…","sig":"…"}', "Measured: ~7.5 MB of log per robot-hour on board; a few hundred bytes per seal over the air."],
  },
  drone: {
    fc: ["Flight controller", "Every autonomous choice (hold, avoid, return home) with the exact model version that made it.", '{"kind":"decision","action":"avoid","model":"nav v3.1"}', "Sealing a decision takes about 0.1 ms on phone-class hardware (measured)."],
    camera: ["Gimbal camera", "A fingerprint of each frame the detector used, plus what it detected and the score.", '{"kind":"detection","input":"sha256:a71c…","label":"vehicle","score":91}', "The satellite edition seals 2,000 images in a 713-byte pass summary (measured)."],
    gps: ["GPS and geofence", "Position fixes and geofence events, sealed in order. Timestamps are claims until anchored to a trusted time source; the order is proven.", '{"kind":"geofence","event":"warning","distance_m":40}', "Settles 'it never left the permitted area' with evidence, not assurances."],
    radio: ["Radio link", "Airtime is precious, so only seals go over the air: a few hundred bytes to the operator, the airspace authority or the insurer.", '{"type":"seal","n":412,"root":"5b0d…","sig":"…"}', "The full log stays on the drone and can be checked later against the seals already sent."],
    battery: ["Battery", "Low-battery decisions and the thresholds behind them, such as returning home at 20%.", '{"kind":"decision","action":"return_home","battery_pct":20}', "Proves the drone followed its rules, or shows exactly where it didn't."],
    rotors: ["Rotors and pilot override", "Manual takeovers are sealed with who took control and when, so 'the drone did it' versus 'the pilot did it' is settled by evidence.", '{"kind":"override","by":"pilot p-03","mode":"MANUAL"}', "A rewrite of who was in control fails against the witness's seal."],
  },
};
const SPEC = {
  humanoid: ["ED-01 · MARBLE", "concept humanoid", [["Height", "1.82 m"], ["Mass", "78 kg"], ["Battery", "2.3 kWh, swappable"], ["Runtime", "4–5 h typical work"], ["Payload", "20 kg (two hands)"],
    ["Sensors", "Stereo cameras, LiDAR, tactile and force sensing in hands, IMU"], ["Safety", "Physical e-stop, speed and force limits near people"], ["Recorder", "EDEN on a separate secure module, key held in hardware"]]],
  drone: ["VPD-001", "concept ducted quadcopter", [["Size", "42 cm across, 14 cm high"], ["Mass", "≈1.4 kg"], ["Propulsion", "Four ducted rotors (quieter and safer than open props)"], ["Flight time", "25–30 min"],
    ["Top speed", "≈60 km/h"], ["Sensors", "4K gimbal camera, optional thermal, obstacle sensing, GNSS"], ["Operation", "Within UK CAA rules for its class"], ["Recorder", "EDEN on the flight computer, seals sent over the radio link"]]],
};
function renderSpec() { const [name, sub, rows] = SPEC[st.model];
  $("#unitTag").innerHTML = `<b>${name}</b><span>${sub}</span>`;
  $("#specCard").innerHTML = `<div class="eye">Target specification</div><h3>${name}</h3><table class="spec">${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}</table><p class="note">Concept design. These are engineering targets for a unit that could be built, not a product for sale.</p>`; }
const hotWrap = $("#hotspots");
function renderHotspots() { hotWrap.innerHTML = ""; const mdl = MODELS[st.model]; let i = 1;
  for (const k of Object.keys(mdl.hot)) { const b = document.createElement("button"); b.className = "hot"; b.dataset.part = k; b.textContent = i++;
    b.setAttribute("aria-label", INFO[st.model][k][0]); b.addEventListener("click", ev => { ev.stopPropagation(); select(k); }); hotWrap.appendChild(b); } }
function placeHotspots(mdl) { const r = canvas.getBoundingClientRect(); const toCam = norm([eye[0] - mdl.target[0], 0, eye[2] - mdl.target[2]]);
  const rm = mdl.hotLocal ? mdl.loc() : M.id();
  for (const b of hotWrap.children) { const p = M.xf(rm, mdl.hot[b.dataset.part]); const c = M.xf(VP, p);
    const x = (c[0] * 0.5 + 0.5) * r.width, y = (1 - (c[1] * 0.5 + 0.5)) * r.height;
    const face = dot(norm([p[0] - mdl.target[0], 0, p[2] - mdl.target[2]]), toCam);
    b.style.transform = `translate(${x}px, ${y}px)`; b.style.opacity = face < -0.35 ? 0.35 : 1; b.classList.toggle("on", st.sel === b.dataset.part); } }
function select(part) { st.sel = part; const box = $("#part");
  if (!part) { box.innerHTML = `<div class="eye">Tap a glowing number</div><h3>What EDEN records, part by part</h3><p>Each part of the ${st.model === "drone" ? "drone" : "robot"} produces a different kind of record. Tap a number on the model to see what gets sealed, and an example entry.</p>`; return; }
  const [t, d, ex, m] = INFO[st.model][part];
  box.innerHTML = `<div class="eye">${st.model === "drone" ? "VPD-001" : "ED-01"} · part</div><h3>${t}</h3><p>${d}</p><pre>${ex.replace(/</g, "&lt;")}</pre><p class="meas">${m}</p>`; }

// ------------------------------------------------------------------ the recorder (real cryptography)
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
function canon(v) { if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  if (typeof v === "number" && !Number.isInteger(v)) throw new Error("floats are forbidden"); return JSON.stringify(v); }
async function sha(...parts) { const n = parts.reduce((a, p) => a + p.length, 0), b = new Uint8Array(n); let o = 0; for (const p of parts) { b.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b)); }
const leafHash = e => sha(new Uint8Array([0]), enc.encode(canon(e)));
async function mth(L) { if (L.length === 1) return L[0]; let k = 1; while (k * 2 < L.length) k *= 2;
  return sha(new Uint8Array([1]), await mth(L.slice(0, k)), await mth(L.slice(k))); }
const SCRIPT = {
  humanoid: [["mode", { from: "SUPERVISED", to: "AUTONOMOUS", approved_by: "op-17" }, "step", "Mode → autonomous (approved by op-17)"],
    ["perception", { frame: "cam-front", label: "shelf B4" }, "look", "Shelf B4 scanned (frame fingerprinted)"],
    ["decision", { action: "pick", item: "tote 2291", model: "grasp-net v4.2", confidence: 94 }, "think", "Pick tote 2291 · confidence 94"],
    ["action", { grip: "close", force_n: 18, limit_n: 40 }, "grip", "Grasp closed at 18 N (limit 40 N)"],
    ["perception", { frame: "cam-front", label: "person", distance_mm: 1200 }, "look", "Person detected at 1.2 m"],
    ["decision", { action: "slow", speed_mm_s: 300, model: "safety v2.0" }, "think", "Slow to 0.3 m/s"],
    ["estop", { by: "op-17", reason: "person_in_path" }, "estop", "E-stop pressed by op-17"],
    ["mode", { from: "STOPPED", to: "TELEOPERATED", by: "op-17" }, "override", "Teleoperation taken by op-17"]],
  drone: [["mode", { to: "TAKEOFF", approved_by: "pilot p-03" }, "takeoff", "Take-off approved by pilot p-03"],
    ["decision", { action: "waypoint", wp: 1, model: "nav v3.1" }, "think", "Waypoint 1 reached"],
    ["detection", { label: "vehicle", score: 91, frame: "gimbal" }, "shot", "Vehicle detected · score 91"],
    ["geofence", { event: "warning", distance_m: 40 }, "fence", "Geofence warning: 40 m from boundary"],
    ["decision", { action: "avoid", obstacle: "bird", model: "nav v3.1" }, "avoid", "Obstacle avoided (bird)"],
    ["decision", { action: "return_home", battery_pct: 20 }, "lowb", "Battery 20% → return home"],
    ["override", { by: "pilot p-03", mode: "MANUAL" }, "override", "Pilot p-03 takes manual control"],
    ["mode", { to: "LANDED" }, "land", "Landed safely"]],
};
const rec = { entries: [], leaves: [], seal: null, witness: null, key: null, running: false, tampered: -1 };
async function keyPair() { if (rec.key !== null) return rec.key;
  try { rec.key = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]); } catch (e) { rec.key = false; } return rec.key; }
function ui() { const log = $("#log"); log.innerHTML = rec.entries.map((e, i) => `<tr class="${i === rec.tampered ? "bad" : ""}"><td>${e.i}</td><td>${e.kind}</td><td>${e.txt}</td><td><code>${rec.leaves[i] ? hex(rec.leaves[i]).slice(0, 12) : "…"}</code></td></tr>`).join("") || `<tr><td colspan="4" class="empty">No entries yet. Press Run.</td></tr>`;
  $("#bRun").disabled = rec.running || rec.entries.length >= SCRIPT[st.model].length; $("#bSeal").disabled = rec.running || !rec.entries.length || rec.tampered >= 0;
  $("#bWit").disabled = !rec.seal || !!rec.witness || rec.tampered >= 0; $("#bTam").disabled = !rec.witness || rec.tampered >= 0; }
function status(html, cls = "") { const s = $("#status"); s.className = "status " + cls; s.innerHTML = html; }
function trigger(a) { const set = (k, v, back, ms = 900) => { A(k).t = v; if (back !== undefined) setTimeout(() => (A(k).t = back), ms); };
  if (st.model === "humanoid") ({ step: () => { set("leg1", -0.35, 0, 450); setTimeout(() => set("leg-1", -0.35, 0, 450), 450); set("bob", -0.015, 0, 900); },
    look: () => set("pitch", 0.25, 0, 1100), think: () => set("core", 2.2, 1, 900), grip: () => { set("arm1", -1.1, 0, 1600); set("elb1", -0.6, 0, 1600); set("grip", 1, 0, 1400); },
    estop: () => { set("stop", 1); set("eye", 1); set("arm1", 0); }, override: () => { set("eye", 0); set("stop", 0.3); set("tx", 1, 0, 2500); } })[a]?.();
  else ({ takeoff: () => { set("alt", 0.25, 0, 2200); set("spin", 1.4, 1, 2200); }, think: () => set("think", 1, 0, 900), shot: () => { set("gim", 0.7, 0, 1400); set("shot", 1, 0, 600); },
    fence: () => { set("fence", 1, 0, 1600); set("roll", 0.15, 0, 900); }, avoid: () => { set("roll", -0.35, 0, 900); set("dpitch", 0.15, 0, 900); },
    lowb: () => { set("lowb", 1); set("dyaw", A("dyaw").t + Math.PI, undefined); }, override: () => { set("spin", 0.4, 1, 1400); set("tx", 1, 0, 2500); }, land: () => { set("alt", -0.55); set("spin", 0.15); } })[a]?.(); }
async function run() { rec.running = true; ui(); status("Recording… each entry is hashed on your device as it happens.");
  const sc = SCRIPT[st.model];
  for (let k = rec.entries.length; k < sc.length; k++) { const [kind, body, a, txt] = sc[k];
    const e = { v: 1, log: st.model === "drone" ? "vpd-001/mission-7" : "ed-01/shift-3", i: k, t: "T+" + String(k * 4).padStart(3, "0") + "s", kind, actor: st.model === "drone" ? "VPD-001" : "ED-01", body };
    rec.entries.push(Object.assign({ txt }, e)); rec.leaves.push(await leafHash(e)); trigger(a); ui(); await new Promise(r => setTimeout(r, 750)); }
  rec.running = false; ui(); status("Recorded " + rec.entries.length + " entries. Now seal them."); }
const plain = e => { const o = Object.assign({}, e); delete o.txt; return o; };
async function doSeal() { const root = hex(await mth(rec.leaves)); const s = { v: 1, type: "seal", log: rec.entries[0].log, n: rec.entries.length, root };
  const k = await keyPair(); let sig = "";
  if (k) sig = hex(await crypto.subtle.sign({ name: "Ed25519" }, k.privateKey, enc.encode("EDEN-EVIDENCE-SEAL-v1\0" + canon(s))));
  rec.seal = Object.assign({}, s, { sig }); trigger("think"); A("tx").t = 1; setTimeout(() => (A("tx").t = 0), 2000);
  const bytes = enc.encode(canon(rec.seal)).length, logBytes = rec.entries.reduce((a, e) => a + enc.encode(canon(plain(e))).length, 0);
  status(`Sealed. Root <code>${root.slice(0, 16)}…</code> covers all ${s.n} entries${sig ? `, signed with Ed25519 (<code>${sig.slice(0, 12)}…</code>)` : " (this browser can't sign Ed25519; the root check below still works)"}. The seal is ${bytes} bytes; the log it covers is ${logBytes} bytes.`, "ok"); ui(); }
function doWitness() { rec.witness = { root: rec.seal.root, n: rec.seal.n, received: new Date().toISOString().slice(11, 19) + " UTC" };
  status(`Witness holds a copy of the seal (root <code>${rec.witness.root.slice(0, 16)}…</code>), received at ${rec.witness.received}. From now on, any rewrite of these ${rec.witness.n} entries can be caught.`, "ok"); ui(); }
async function doTamper() { const i = rec.entries.findIndex(e => e.kind === (st.model === "drone" ? "override" : "estop"));
  const e = rec.entries[i]; const forged = st.model === "drone" ? Object.assign({}, e, { body: { by: "autopilot", mode: "AUTO" }, txt: "Autopilot kept control (rewritten)" })
    : Object.assign({}, e, { body: { by: "robot", reason: "self_test" }, txt: "Robot stopped itself for a self-test (rewritten)" });
  rec.entries[i] = forged; rec.leaves[i] = await leafHash(plain(forged)); rec.tampered = i;
  const root = hex(await mth(rec.leaves)); const s = { v: 1, type: "seal", log: forged.log, n: rec.entries.length, root };
  const k = await keyPair(); let sigOk = null;
  if (k) { const sig = await crypto.subtle.sign({ name: "Ed25519" }, k.privateKey, enc.encode("EDEN-EVIDENCE-SEAL-v1\0" + canon(s)));
    sigOk = await crypto.subtle.verify({ name: "Ed25519" }, k.publicKey, sig, enc.encode("EDEN-EVIDENCE-SEAL-v1\0" + canon(s))); }
  status(`<b>An insider rewrote entry ${i}</b> to change who was in control, then re-sealed with the real key.<br>` +
    (sigOk === null ? "" : `Signature on the new seal: <span class="okc">valid</span> (whoever holds the key can always sign).<br>`) +
    `New root <code>${root.slice(0, 16)}…</code> vs the witness's <code>${rec.witness.root.slice(0, 16)}…</code> → <span class="badc">REWRITE DETECTED</span>.`, "bad"); ui(); }
function reset() { rec.entries = []; rec.leaves = []; rec.seal = null; rec.witness = null; rec.tampered = -1; rec.running = false; st.anim = {};
  status("Press <b>Run</b> to record a " + (st.model === "drone" ? "mission" : "shift") + ". Everything is computed in your browser."); ui(); }
$("#bRun").addEventListener("click", run); $("#bSeal").addEventListener("click", doSeal); $("#bWit").addEventListener("click", doWitness);
$("#bTam").addEventListener("click", doTamper); $("#bReset").addEventListener("click", reset);
for (const b of document.querySelectorAll("[data-model]")) b.addEventListener("click", () => { if (rec.running) return; st.model = b.dataset.model;
  for (const x of document.querySelectorAll("[data-model]")) x.setAttribute("aria-selected", x === b); cam.dist = MODELS[st.model].dist; reset(); select(null); renderHotspots(); renderSpec();
  $("#runLabel").textContent = st.model === "drone" ? "Run mission" : "Run shift"; });

// ------------------------------------------------------------------ loop
renderHotspots(); renderSpec(); select(null); reset();
let last = performance.now();
function frame(now) { const dt = Math.min(0.05, (now - last) / 1000); last = now; st.t += dt;
  for (const k in st.anim) { const a = st.anim[k]; a.v = ease(a.v, a.t, 1 - Math.pow(0.002, dt)); }
  if (st.model === "humanoid" && A("stop").t < 0.5) { A("yaw").t = st.look[0] * 0.5; }
  draw(st.t); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
window.__eden = { st, rec, select };
})();
