// robots.js v2 - EDEN robots and drones. A self-contained WebGL renderer (no libraries): GGX lighting,
// shadow mapping, WebGL2 MSAA + bloom + vignette/grain post (WebGL1 falls back to direct rendering),
// two original concept units, exploded X-ray view revealing the EDEN recorder module, visible data flow
// from each part to the recorder, the antenna and a witness, hover labels and fly-to focus.
// The machines are simulated. The cryptography is real: SHA-256 leaves, an RFC 6962 Merkle root,
// Ed25519 seals where the browser supports them, a witness copy and a rewrite test.
"use strict";
(() => {
const $ = (s, r = document) => r.querySelector(s);
const canvas = $("#stage");
let gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance" });
const GL2 = !!gl;
if (!gl) gl = canvas.getContext("webgl", { antialias: true, alpha: false });
if (!gl) { $("#nogl").hidden = false; return; }
if (!GL2) gl.getExtension("OES_element_index_uint");

// ------------------------------------------------------------------ math (column-major mat4)
const M = {
  id: () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
  mul(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
      o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3]; return o; },
  T: (x, y, z) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1],
  S: (x, y, z) => [x,0,0,0, 0,y,0,0, 0,0,z,0, 0,0,0,1],
  RX(a) { const c = Math.cos(a), s = Math.sin(a); return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]; },
  RY(a) { const c = Math.cos(a), s = Math.sin(a); return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]; },
  RZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]; },
  persp(f, asp, n, fa) { const t = 1 / Math.tan(f / 2); return [t/asp,0,0,0, 0,t,0,0, 0,0,(fa+n)/(n-fa),-1, 0,0,2*fa*n/(n-fa),0]; },
  ortho(l, r, b, t, n, f) { return [2/(r-l),0,0,0, 0,2/(t-b),0,0, 0,0,-2/(f-n),0, -(r+l)/(r-l),-(t+b)/(t-b),-(f+n)/(f-n),1]; },
  lookAt(e, c, u) { const z = norm([e[0]-c[0], e[1]-c[1], e[2]-c[2]]), x = norm(cross(u, z)), y = cross(z, x);
    return [x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -dot(x,e),-dot(y,e),-dot(z,e),1]; },
  inv(a) { const o = new Array(16);
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
const lerp3 = (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
const chain = (...ms) => ms.reduce((a, b) => M.mul(a, b));

// ------------------------------------------------------------------ geometry
function lathe(prof, seg = 40, a0 = 0, a1 = Math.PI * 2) {
  const pos = [], nrm = [], idx = [], n = prof.length;
  const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  const segN = k => { const a = prof[k], b = prof[k+1]; const t = [b[0]-a[0], b[1]-a[1]]; const l = Math.hypot(t[0], t[1]) || 1; return [t[1]/l, -t[0]/l]; };
  for (let k = 0; k < n; k++) {
    const hasP = k > 0 && !same(prof[k-1], prof[k]), hasN = k < n-1 && !same(prof[k+1], prof[k]);
    let nn = hasP && hasN ? (() => { const a = segN(k-1), b = segN(k); return [a[0]+b[0], a[1]+b[1]]; })() : hasN ? segN(k) : hasP ? segN(k-1) : [1, 0];
    const L = Math.hypot(nn[0], nn[1]) || 1; nn = [nn[0]/L, nn[1]/L];
    for (let i = 0; i <= seg; i++) { const a = a0 + (a1 - a0) * i / seg, c = Math.cos(a), s = Math.sin(a);
      pos.push(prof[k][0]*c, prof[k][1], prof[k][0]*s); nrm.push(nn[0]*c, nn[1], nn[0]*s); } }
  for (let k = 0; k < n-1; k++) for (let i = 0; i < seg; i++) { const a = k*(seg+1)+i, b = a+seg+1; idx.push(a, b, a+1, b, b+1, a+1); }
  return { pos, nrm, idx };
}
const cyl = (r, h, s = 32) => lathe([[0,-h/2],[r,-h/2],[r,-h/2],[r,h/2],[r,h/2],[0,h/2]], s);
function capsule(r, len, s = 32) { const p = []; const st = 10;
  for (let i = 0; i <= st; i++) { const a = -Math.PI/2 + i/st*Math.PI/2; p.push([r*Math.cos(a), -len/2 + r*Math.sin(a)]); }
  for (let i = 0; i <= st; i++) { const a = i/st*Math.PI/2; p.push([r*Math.cos(a), len/2 + r*Math.sin(a)]); }
  p[0][0] = 0; p[p.length-1][0] = 0; return lathe(p, s); }
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
const IDX = GL2 ? gl.UNSIGNED_INT : gl.UNSIGNED_INT;
const geoCache = new Map();
function upload(key, make) { if (geoCache.has(key)) return geoCache.get(key); const g = make();
  const v = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, v); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.pos), gl.STATIC_DRAW);
  const n = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, n); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g.nrm), gl.STATIC_DRAW);
  const i = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, i); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(g.idx), gl.STATIC_DRAW);
  const o = { v, n, i, count: g.idx.length }; geoCache.set(key, o); return o; }
const G = {
  cyl: (r, h) => upload("c" + r + "," + h, () => cyl(r, h)), cap: (r, l) => upload("p" + r + "," + l, () => capsule(r, l)),
  sph: r => upload("s" + r, () => capsule(r, 0)), tor: (R, r) => upload("t" + R + "," + r, () => torus(R, r)),
  box: (w, h, d) => upload("b" + w + "," + h + "," + d, () => box(w, h, d)), lathe: (k, p, s, a0, a1) => upload("l" + k, () => lathe(p, s, a0, a1)),
};

// ------------------------------------------------------------------ shaders
function prog(vs, fs) { const p = gl.createProgram();
  for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); gl.attachShader(p, sh); }
  gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let k = 0; k < n; k++) { const a = gl.getActiveUniform(p, k); u[a.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, a.name); }
  return { p, u, aP: gl.getAttribLocation(p, "aP"), aN: gl.getAttribLocation(p, "aN") }; }
const VS = `attribute vec3 aP; attribute vec3 aN; uniform mat4 uM, uVP; uniform mat3 uNM; varying vec3 vW, vN;
void main(){ vec4 w = uM*vec4(aP,1.0); vW = w.xyz; vN = normalize(uNM*aN); gl_Position = uVP*w; }`;
const SHADOW = `uniform sampler2D uSh; uniform mat4 uLVP; uniform float uShTex;
float unpack(vec4 c){ return dot(c, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0)); }
float shadowAt(vec3 w, float bias){ vec4 p = uLVP*vec4(w,1.0); vec3 s = p.xyz/p.w*0.5+0.5;
  if (s.x<0.0||s.x>1.0||s.y<0.0||s.y>1.0||s.z>1.0) return 1.0; float sum = 0.0;
  for (int x=-1;x<=1;x++) for (int y=-1;y<=1;y++){ float d = unpack(texture2D(uSh, s.xy+vec2(float(x),float(y))*uShTex)); sum += (s.z-bias > d) ? 0.0 : 1.0; }
  return sum/9.0; }`;
const FS = `precision highp float; varying vec3 vW, vN; uniform vec3 uCam, uCol, uEm, uLd; uniform float uMet, uRou, uHi, uHov, uTime;
${SHADOW}
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
vec3 envc(vec3 r){ float y = r.y; vec3 sky = mix(vec3(0.05,0.07,0.10), vec3(0.45,0.5,0.58), smoothstep(-0.1,0.9,y));
  sky += vec3(1.0,0.88,0.66)*1.4*smoothstep(0.9,1.0,dot(r,normalize(vec3(0.5,0.6,0.62))));
  sky += vec3(0.35,0.7,1.0)*0.8*smoothstep(0.86,1.0,dot(r,normalize(vec3(-0.8,0.2,-0.4))));
  sky += vec3(1.0,0.8,0.5)*0.35*smoothstep(0.03,0.0,abs(y-0.1));
  return mix(vec3(0.012,0.016,0.022), sky, smoothstep(-0.3,0.05,y)); }
float D(float nh, float a){ float a2 = a*a; float d = nh*nh*(a2-1.0)+1.0; return a2/(3.14159*d*d); }
float Vis(float nv, float nl, float a){ float k = a*0.5; return 0.25/((nv*(1.0-k)+k)*(nl*(1.0-k)+k)); }
void main(){ vec3 N = normalize(vN); vec3 V = normalize(uCam - vW); if (dot(N,V) < 0.0) N = -N;
  float rough = max(uRou, 0.07); float a = rough*rough; vec3 F0 = mix(vec3(0.04), uCol, uMet); vec3 diff = uCol*(1.0-uMet);
  float nv = max(dot(N,V), 0.001); float sh = shadowAt(vW, 0.0018 + 0.004*(1.0-max(dot(N,uLd),0.0)));
  vec3 col = vec3(0.0);
  for (int i=0;i<3;i++){ vec3 L = uLd; vec3 C = vec3(1.0,0.95,0.88)*3.0; float s = sh;
    if (i==1){ L = normalize(vec3(-0.8,0.25,-0.5)); C = vec3(0.35,0.62,1.0)*1.1; s = 1.0; }
    if (i==2){ L = normalize(vec3(-0.25,0.4,-0.95)); C = vec3(1.0,0.78,0.42)*1.5; s = 1.0; }
    float nl = max(dot(N,L),0.0); vec3 H = normalize(L+V); float nh = max(dot(N,H),0.0); float vh = max(dot(V,H),0.0);
    vec3 F = F0+(1.0-F0)*pow(1.0-vh,5.0); vec3 spec = D(nh,a)*Vis(nv,nl,a)*F;
    col += (diff*(1.0-F) + spec*3.14159)*C*nl*s*0.36; }
  vec3 R = reflect(-V,N); vec3 Fe = F0 + (max(vec3(1.0-rough), F0) - F0)*pow(1.0-nv,5.0);
  col += Fe*envc(R)*mix(1.0,0.2,rough)*(0.55+0.45*sh);
  col += diff*mix(vec3(0.035,0.04,0.045), vec3(0.13,0.14,0.16), N.y*0.5+0.5)*(0.75+0.25*sh);
  col += uEm;
  float rim = pow(1.0-nv, 2.0);
  col += vec3(0.95,0.72,0.3)*uHi*(0.25+0.2*sin(uTime*5.0))*(0.35+rim);
  col += vec3(0.4,0.7,1.0)*uHov*0.35*(0.2+rim);
  gl_FragColor = vec4(pow(aces(col*0.85), vec3(1.0/2.2)), 1.0); }`;
const PFS = `precision mediump float; uniform vec3 uId; void main(){ gl_FragColor = vec4(uId,1.0); }`;
const DVS = `attribute vec3 aP; uniform mat4 uM, uLVP; void main(){ gl_Position = uLVP*uM*vec4(aP,1.0); }`;
const DFS = `precision highp float; void main(){ vec4 e = fract(vec4(1.0,255.0,65025.0,16581375.0)*gl_FragCoord.z); e -= e.yzww*vec4(1.0/255.0,1.0/255.0,1.0/255.0,0.0); gl_FragColor = e; }`;
const GFS = `precision highp float; varying vec3 vW, vN; uniform float uTime, uR; uniform vec3 uLd;
${SHADOW}
void main(){ float r = length(vW.xz); float d = abs(fract(r*2.5+0.5)-0.5); float ring = smoothstep(0.016,0.0,d)*step(0.3,r);
  float fade = 1.0-smoothstep(0.3,2.7,r); float pool = exp(-r*r/(uR*uR*4.0));
  float sh = shadowAt(vW, 0.003);
  vec3 c = vec3(0.02,0.03,0.04) + vec3(0.09,0.11,0.13)*pool + vec3(0.85,0.66,0.34)*ring*0.5;
  float sweep = smoothstep(0.05,0.0,abs(r - mod(uTime*0.55,2.7)))*0.3; c += vec3(0.3,0.6,1.0)*sweep*fade;
  c *= mix(0.25, 1.0, sh);
  float a = fade*(0.55 + ring*0.35 + pool*0.3) + (1.0-sh)*0.35*fade;
  gl_FragColor = vec4(c, clamp(a,0.0,1.0)); }`;
const PTVS = `attribute vec3 aP; uniform mat4 uVP; uniform float uTime, uPx; varying float vA;
void main(){ vec3 p = aP; p.y = mod(p.y + uTime*0.035*(0.5+fract(aP.x*7.13)), 3.2); p.x += 0.05*sin(uTime*0.3+aP.z*5.0);
  vec4 c = uVP*vec4(p,1.0); gl_Position = c; gl_PointSize = uPx*(1.2+2.2*fract(aP.z*13.7))/c.w; vA = 0.45+0.55*sin(uTime*0.8+aP.x*20.0); }`;
const PTFS = `precision mediump float; varying float vA; void main(){ float d = length(gl_PointCoord-0.5); float a = smoothstep(0.5,0.0,d)*0.32*vA; gl_FragColor = vec4(vec3(1.0,0.86,0.6)*a, a); }`;
// post (WebGL2 path)
const QVS = `attribute vec2 aP; varying vec2 vU; void main(){ vU = aP*0.5+0.5; gl_Position = vec4(aP,0.0,1.0); }`;
const BRIGHT = `precision mediump float; varying vec2 vU; uniform sampler2D uT; void main(){ vec4 c = texture2D(uT,vU); float l = max(c.r,max(c.g,c.b));
  float sat = (l - min(c.r,min(c.g,c.b)))/max(l,0.001);
  gl_FragColor = vec4(c.rgb*smoothstep(0.6,1.0,l)*(0.08+0.92*sat*sat)*c.a, 1.0); }`;
const BLUR = `precision mediump float; varying vec2 vU; uniform sampler2D uT; uniform vec2 uD;
void main(){ vec3 s = texture2D(uT,vU).rgb*0.227; s += (texture2D(uT,vU+uD*1.385).rgb + texture2D(uT,vU-uD*1.385).rgb)*0.316;
  s += (texture2D(uT,vU+uD*3.231).rgb + texture2D(uT,vU-uD*3.231).rgb)*0.07; gl_FragColor = vec4(s,1.0); }`;
const COMP = `precision mediump float; varying vec2 vU; uniform sampler2D uT, uB1, uB2; uniform float uTime; uniform vec2 uRes;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
void main(){ vec4 c = texture2D(uT,vU); vec2 q = vU-0.5; q.x *= uRes.x/uRes.y;
  vec3 bg = mix(vec3(0.085,0.13,0.17), vec3(0.016,0.024,0.034), smoothstep(0.0,0.95,length(q - vec2(0.0,0.08))));
  vec3 col = mix(bg, c.rgb, c.a) + texture2D(uB1,vU).rgb*0.9 + texture2D(uB2,vU).rgb*0.75;
  col *= mix(1.0, 0.7, smoothstep(0.45,1.15,length(q)*1.3));
  col += (h(vU*uRes + fract(uTime)*91.0)-0.5)*0.018;
  gl_FragColor = vec4(col,1.0); }`;
const P = prog(VS, FS), PP = prog(VS, PFS), PD = prog(DVS, DFS), PG = prog(VS, GFS), PT = prog(PTVS, PTFS);
let PB, PBL, PC; if (GL2) { PB = prog(QVS, BRIGHT); PBL = prog(QVS, BLUR); PC = prog(QVS, COMP); }

// ------------------------------------------------------------------ scene graph
function N(o = {}) { return { geo: o.geo || null, mat: o.mat || null, loc: o.loc || (() => M.id()), kids: [], part: o.part || null, tag: o.tag || null, ex: o.ex || null }; }
function add(p, ...k) { p.kids.push(...k); return p; }
const MAT = {
  armour: { c: [0.66, 0.665, 0.66], met: 0.35, rou: 0.24 }, armour2: { c: [0.46, 0.465, 0.47], met: 0.45, rou: 0.3 },
  carbon: { c: [0.03, 0.032, 0.036], met: 0.55, rou: 0.4 }, carbon2: { c: [0.06, 0.065, 0.075], met: 0.75, rou: 0.28 },
  gold: { c: [0.95, 0.72, 0.34], met: 1.0, rou: 0.24 }, visor: { c: [0.008, 0.01, 0.016], met: 0.95, rou: 0.06 },
  blue: { c: [0.05, 0.2, 0.5], met: 0.0, rou: 0.4, em: [0.3, 0.75, 2.0] }, red: { c: [0.5, 0.05, 0.03], met: 0.1, rou: 0.35, em: [0.9, 0.08, 0.04] },
  glass: { c: [0.02, 0.04, 0.08], met: 0.9, rou: 0.05 }, green: { c: [0.05, 0.4, 0.2], met: 0, rou: 0.4, em: [0.1, 1.2, 0.5] },
  board: { c: [0.04, 0.12, 0.08], met: 0.3, rou: 0.5 },
};
const em = (m, e) => Object.assign({}, m, { em: e });
const st = { t: 0, anim: {}, sel: null, hov: null, model: "humanoid", look: [0, 0], W: {} };
const ease = (cur, tgt, k) => cur + (tgt - cur) * k;
function A(name, def = 0) { if (!(name in st.anim)) st.anim[name] = { v: def, t: def }; return st.anim[name]; }
const X = () => A("explode").v;
function recorderModule(scale = 1) {   // the EDEN recorder: the part that exists and is tested today
  const g = N({ tag: "rec" });
  add(g, N({ geo: G.box(0.1 * scale, 0.07 * scale, 0.05 * scale), mat: MAT.carbon2, part: "recorder" }),
    N({ geo: G.box(0.104 * scale, 0.006, 0.054 * scale), mat: MAT.gold, loc: () => M.T(0, 0.036 * scale, 0), part: "recorder" }),
    N({ geo: G.box(0.104 * scale, 0.006, 0.054 * scale), mat: MAT.gold, loc: () => M.T(0, -0.036 * scale, 0), part: "recorder" }),
    N({ geo: G.cyl(0.016 * scale, 0.004), mat: () => em(MAT.blue, [0.4, 0.9, 2.2 + 2.5 * A("recPulse").v]), loc: () => chain(M.T(0, 0, 0.026 * scale), M.RX(Math.PI / 2)), part: "recorder" }),
    N({ geo: G.tor(0.016 * scale, 0.0025), mat: MAT.gold, loc: () => chain(M.T(0, 0, 0.027 * scale), M.RX(Math.PI / 2)), part: "recorder" }));
  return g;
}

// ---------- ED-01 "Marble" (original concept by the founder; built here from primitives)
function buildHumanoid() {
  const root = N({ loc: () => M.T(0, Math.sin(st.t * 1.6) * 0.004, 0) });
  const pelvis = N({ loc: () => M.T(0, 0.98 + A("bob").v, 0) });
  add(pelvis, N({ geo: G.lathe("pelvis", [[0,-0.1],[0.13,-0.09],[0.17,0.0],[0.16,0.08],[0,0.09]], 40), mat: MAT.armour, loc: () => M.S(1, 1, 0.72), part: "legs" }),
    N({ geo: G.tor(0.162, 0.006), mat: MAT.gold, loc: () => chain(M.T(0, 0.03, 0), M.S(1, 1, 0.72)) }));
  for (const sd of [-1, 1]) {
    const hip = N({ ex: [0.03 * sd, 0, 0], loc: () => chain(M.T(0.095 * sd, -0.06, 0), M.RX(A("leg" + sd).v)) });
    add(hip, N({ geo: G.sph(0.062), mat: MAT.carbon2 }),
      N({ geo: G.cap(0.058, 0.3), mat: MAT.carbon, loc: () => M.T(0, -0.22, 0), part: "legs" }),
      N({ geo: G.cap(0.066, 0.2), mat: MAT.armour, ex: [0.02 * sd, 0, 0.03], loc: () => chain(M.T(0, -0.19, 0.012), M.S(1, 1, 0.9)), part: "legs" }),
      N({ geo: G.tor(0.07, 0.005), mat: MAT.gold, loc: () => M.T(0, -0.33, 0.01) }));
    const knee = N({ tag: sd > 0 ? "knee" : null, loc: () => chain(M.T(0, -0.44, 0), M.RX(-A("leg" + sd).v * 0.9)) });
    add(knee, N({ geo: G.sph(0.06), mat: MAT.carbon2 }), N({ geo: G.cyl(0.03, 0.012), mat: MAT.blue, loc: () => chain(M.T(0, 0, 0.058), M.RX(Math.PI / 2)) }),
      N({ geo: G.cap(0.05, 0.3), mat: MAT.carbon, loc: () => M.T(0, -0.22, 0), part: "legs" }),
      N({ geo: G.cap(0.056, 0.2), mat: MAT.armour, ex: [0.02 * sd, 0, 0.03], loc: () => chain(M.T(0, -0.18, 0.014), M.S(1, 1, 1.05)), part: "legs" }),
      N({ geo: G.box(0.012, 0.12, 0.01), mat: MAT.blue, loc: () => M.T(0, -0.2, 0.078) }),
      N({ geo: G.tor(0.058, 0.005), mat: MAT.gold, loc: () => M.T(0, -0.33, 0.01) }),
      N({ geo: G.box(0.09, 0.05, 0.22), mat: MAT.carbon2, loc: () => M.T(0, -0.45, 0.03), part: "legs" }),
      N({ geo: G.box(0.094, 0.04, 0.08), mat: MAT.armour, loc: () => M.T(0, -0.445, 0.11), part: "legs" }),
      N({ geo: G.box(0.096, 0.006, 0.226), mat: MAT.gold, loc: () => M.T(0, -0.428, 0.03) }));
    add(hip, knee); add(pelvis, hip);
  }
  const spine = N({ loc: () => chain(M.T(0, 0.08, 0), M.RX(A("lean").v)) });
  for (let k = 0; k < 4; k++) add(spine, N({ geo: G.cyl(0.115 - k * 0.002, 0.035), mat: k % 2 ? MAT.carbon2 : MAT.carbon, loc: () => chain(M.T(0, 0.02 + k * 0.042, 0), M.S(1, 1, 0.78)) }));
  add(spine, N({ geo: G.box(0.03, 0.07, 0.008), mat: MAT.blue, loc: () => M.T(0, 0.09, 0.092) }));
  const chest = N({ loc: () => chain(M.T(0, 0.2, 0), M.S(1, 1 + Math.sin(st.t * 1.6) * 0.006, 1)) });
  const prof = [[0,0],[0.12,0.0],[0.165,0.08],[0.2,0.19],[0.205,0.26],[0.18,0.32],[0.1,0.36],[0,0.36]];
  // inner core: carbon frame + spine column + the recorder module, revealed in X-ray view
  add(chest, N({ geo: G.cyl(0.03, 0.34), mat: MAT.carbon2, loc: () => M.T(0, 0.18, -0.03) }),
    N({ geo: G.lathe("torsoCore", [[0,0.02],[0.11,0.02],[0.15,0.12],[0.16,0.25],[0.12,0.33],[0,0.34]], 32), mat: MAT.carbon, loc: () => M.S(0.9, 1, 0.55) }),
    add(N({ loc: () => M.T(0, 0.2, 0.098) }), recorderModule(1.1)));
  const front = N({ loc: () => chain(M.T(-0.2, 0, 0), M.RY(-X() * 1.6), M.T(0.2, 0, 0)) });
  add(front, N({ geo: G.lathe("torsoF", prof, 32, 0, Math.PI), mat: MAT.armour, loc: () => M.S(1, 1, 0.68), part: "compute", tag: "chestF" }),
    N({ geo: G.lathe("goldF", [[0.182,-0.005],[0.187,0],[0.182,0.005]], 32, 0, Math.PI), mat: MAT.gold, loc: () => chain(M.T(0, 0.3, 0), M.S(1, 1, 0.68)) }),
    N({ geo: G.cyl(0.05, 0.012), mat: MAT.carbon2, loc: () => chain(M.T(0, 0.205, 0.136), M.RX(Math.PI / 2)), part: "compute" }),
    N({ geo: G.tor(0.034, 0.006), mat: MAT.gold, loc: () => chain(M.T(0, 0.205, 0.144), M.RX(Math.PI / 2)), part: "compute" }),
    N({ geo: G.box(0.008, 0.09, 0.008), mat: MAT.gold, loc: () => M.T(0, 0.205, 0.146), part: "compute" }),
    N({ geo: G.cyl(0.02, 0.006), mat: () => em(MAT.blue, [0.25 + 0.3 * A("core", 1).v, 0.6 + 0.5 * A("core", 1).v, 1.6 * A("core", 1).v + 0.5]), loc: () => chain(M.T(0, 0.205, 0.14), M.RX(Math.PI / 2)), part: "compute" }));
  const back = N({ loc: () => chain(M.T(0.2, 0, 0), M.RY(-X() * 1.6), M.T(-0.2, 0, 0)) });
  add(back, N({ geo: G.lathe("torsoB", prof, 32, Math.PI, Math.PI * 2), mat: MAT.armour, loc: () => M.S(1, 1, 0.68), part: "estop" }),
    N({ geo: G.lathe("goldB", [[0.182,-0.005],[0.187,0],[0.182,0.005]], 32, Math.PI, Math.PI * 2), mat: MAT.gold, loc: () => chain(M.T(0, 0.3, 0), M.S(1, 1, 0.68)) }),
    N({ geo: G.box(0.19, 0.2, 0.07), mat: MAT.armour2, loc: () => M.T(0, 0.17, -0.15), part: "estop", tag: "back" }),
    N({ geo: G.box(0.17, 0.01, 0.074), mat: MAT.gold, loc: () => M.T(0, 0.22, -0.15) }),
    N({ geo: G.cyl(0.026, 0.03), mat: () => em(MAT.red, [0.9 * (0.4 + A("stop").v * 2.2), 0.06, 0.03]), loc: () => chain(M.T(0.05, 0.12, -0.19), M.RX(Math.PI / 2)), part: "estop" }),
    N({ geo: G.cyl(0.005, 0.12), mat: MAT.carbon2, loc: () => M.T(-0.07, 0.31, -0.16), part: "radio" }),
    N({ geo: G.sph(0.014), mat: () => em(MAT.blue, [0.3, 0.7, 1.4 + 3 * A("tx").v]), loc: () => M.T(-0.07, 0.375, -0.16), part: "radio", tag: "ant" }));
  add(chest, front, back);
  for (const sd of [-1, 1]) {
    const sh = N({ ex: [0.07 * sd, 0, 0], loc: () => chain(M.T(0.225 * sd, 0.29, 0), M.RZ(0.1 * sd), M.RX(A("arm" + sd).v)) });
    add(sh, N({ geo: G.sph(0.068), mat: MAT.armour, loc: () => M.S(1.1, 0.95, 1), part: "hands" }), N({ geo: G.tor(0.062, 0.005), mat: MAT.gold, loc: () => M.T(0, -0.02, 0) }),
      N({ geo: G.cap(0.042, 0.2), mat: MAT.carbon, loc: () => M.T(0, -0.16, 0), part: "hands" }),
      N({ geo: G.cap(0.049, 0.12), mat: MAT.armour, ex: [0.02 * sd, 0, 0.02], loc: () => M.T(0, -0.15, 0), part: "hands" }));
    const el = N({ loc: () => chain(M.T(0, -0.3, 0), M.RX(A("elb" + sd).v)) });
    add(el, N({ geo: G.sph(0.045), mat: MAT.carbon2 }), N({ geo: G.cap(0.038, 0.2), mat: MAT.carbon, loc: () => M.T(0, -0.14, 0), part: "hands" }),
      N({ geo: G.cap(0.044, 0.12), mat: MAT.armour, ex: [0.02 * sd, 0, 0.02], loc: () => M.T(0, -0.13, 0.005), part: "hands" }),
      N({ geo: G.box(0.006, 0.08, 0.006), mat: MAT.blue, loc: () => M.T(0.046 * sd, -0.13, 0) }),
      N({ geo: G.tor(0.046, 0.005), mat: MAT.gold, loc: () => M.T(0, -0.215, 0) }));
    const hand = N({ tag: sd > 0 ? "hand" : null, loc: () => chain(M.T(0, -0.28, 0), M.RX(A("grip").v * (sd > 0 ? 1 : 0) * 0.4)) });
    add(hand, N({ geo: G.box(0.06, 0.075, 0.028), mat: MAT.carbon2, part: "hands" }));
    for (let f = 0; f < 4; f++) add(hand, N({ geo: G.cap(0.008, 0.05), mat: MAT.carbon, loc: () => chain(M.T(-0.022 + f * 0.015, -0.068, 0), M.RX(A("grip").v * (sd > 0 ? 1.2 : 0.2))), part: "hands" }));
    add(hand, N({ geo: G.cap(0.009, 0.04), mat: MAT.carbon, loc: () => chain(M.T(0.034 * -sd, -0.03, 0.015), M.RZ(0.6 * sd)) }));
    add(el, hand); add(sh, el); add(chest, sh);
  }
  const neck = N({ loc: () => M.T(0, 0.37, 0) });
  add(neck, N({ geo: G.cyl(0.045, 0.07), mat: MAT.carbon2, loc: () => M.T(0, 0.02, 0) }), N({ geo: G.tor(0.047, 0.005), mat: MAT.gold }));
  const head = N({ tag: "head", ex: [0, 0.1, 0], loc: () => chain(M.T(0, 0.15, 0), M.RY(A("yaw").v), M.RX(A("pitch").v)) });
  add(head, N({ geo: G.sph(0.115), mat: MAT.armour, loc: () => M.S(0.92, 1.12, 1.0), part: "sensors" }),
    N({ geo: G.sph(0.11), mat: MAT.visor, loc: () => chain(M.T(0, -0.012, 0.022), M.S(0.84, 0.95, 0.93)), part: "sensors" }),
    N({ geo: G.box(0.03, 0.04, 0.2), mat: MAT.armour, loc: () => M.T(0, 0.09, 0.02) }),
    N({ geo: G.box(0.004, 0.035, 0.004), mat: MAT.gold, loc: () => M.T(0, 0.075, 0.105) }));
  for (const sd of [-1, 1]) add(head,
    N({ geo: G.box(0.05, 0.012, 0.01), mat: () => em(MAT.blue, A("eye").v > 0.5 ? [2.0, 0.7, 0.1] : [0.4, 0.9, 2.3]), loc: () => chain(M.T(0.034 * sd, 0.0, 0.126), M.RY(0.3 * sd), M.RZ(-0.28 * sd)), part: "sensors" }),
    N({ geo: G.cyl(0.04, 0.03), mat: MAT.armour2, loc: () => chain(M.T(0.1 * sd, 0.0, -0.005), M.RZ(Math.PI / 2)), part: "sensors" }),
    N({ geo: G.tor(0.03, 0.006), mat: MAT.blue, loc: () => chain(M.T(0.117 * sd, 0.0, -0.005), M.RZ(Math.PI / 2)), part: "sensors" }),
    N({ geo: G.tor(0.04, 0.005), mat: MAT.gold, loc: () => chain(M.T(0.114 * sd, 0.0, -0.005), M.RZ(Math.PI / 2)) }));
  add(neck, head); add(chest, neck); add(spine, chest); add(pelvis, spine); add(root, pelvis);
  root.anch = { sensors: ["head", [0.04, 0.0, 0.13]], compute: ["chestF", [0, 0.205, 0.105]], hands: ["hand", [0, -0.02, 0.03]], legs: ["knee", [0, -0.2, 0.08]],
    estop: ["back", [0.05, -0.05, -0.06]], radio: ["ant", [0, 0.01, 0]], recorder: ["rec", [0, 0, 0.04]] };
  root.src = { mode: "legs", perception: "sensors", decision: "compute", action: "hands", estop: "estop" };
  root.target = [0, 0.92, 0]; root.dist = 3.9; root.focusDist = 1.5; root.shadowR = 0.42; root.wit = [-0.62, 1.85, 0.2];
  return root;
}

// ---------- VPD-001 (original concept by the founder): four ducted rotors around a carbon dome
function buildDrone() {
  const root = N({ tag: "droot", loc: () => chain(M.T(A("px").v, 0.95 + Math.sin(st.t * 1.3) * 0.03 + A("alt").v, A("pz").v), M.RY(A("dyaw").v), M.RZ(A("roll").v + Math.sin(st.t * 0.9) * 0.02), M.RX(A("dpitch").v)) });
  const dome = N({ ex: [0, 0.2, 0], tag: "dome" });
  add(dome, N({ geo: G.lathe("dome", [[0.18,0.0],[0.165,0.04],[0.12,0.085],[0.05,0.11],[0,0.112]], 48), mat: MAT.carbon2, part: "fc" }),
    N({ geo: G.tor(0.178, 0.006), mat: MAT.gold, loc: () => M.T(0, 0.0, 0) }),
    N({ geo: G.tor(0.04, 0.006), mat: MAT.gold, loc: () => chain(M.T(0, 0.075, 0.09), M.RX(Math.PI / 2 - 0.75)), part: "fc" }),
    N({ geo: G.box(0.008, 0.06, 0.008), mat: MAT.gold, loc: () => chain(M.T(0, 0.075, 0.093), M.RX(-0.75)), part: "fc" }),
    N({ geo: G.cyl(0.024, 0.004), mat: () => em(MAT.blue, [0.3, 0.75, 1.4 + A("think").v * 2.6]), loc: () => chain(M.T(0, 0.075, 0.084), M.RX(Math.PI / 2 - 0.75)), part: "fc" }),
    N({ geo: G.cyl(0.006, 0.06), mat: MAT.carbon, loc: () => M.T(0, 0.14, -0.03), part: "gps" }),
    N({ geo: G.cyl(0.032, 0.014), mat: MAT.armour, loc: () => M.T(0, 0.175, -0.03), part: "gps", tag: "gps" }),
    N({ geo: G.tor(0.032, 0.004), mat: () => em(MAT.gold, A("fence").v > 0.5 ? [1.6, 0.6, 0.0] : [0, 0, 0]), loc: () => M.T(0, 0.175, -0.03) }));
  const hull = N({});
  add(hull, N({ geo: G.lathe("hull", [[0,-0.07],[0.12,-0.068],[0.17,-0.03],[0.18,0.0],[0.18,0.0],[0,0.0]], 48), mat: MAT.carbon2, part: "fc" }),
    N({ geo: G.box(0.2, 0.012, 0.16), mat: MAT.board, loc: () => M.T(0, 0.006, 0), part: "fc" }),
    add(N({ loc: () => M.T(0.03, 0.045, 0.02) }), recorderModule(1)),
    N({ geo: G.box(0.05, 0.02, 0.05), mat: MAT.carbon, loc: () => M.T(-0.07, 0.02, -0.03), part: "fc" }));
  const batt = N({ ex: [0, 0.05, -0.16], tag: "batt" });
  add(batt, N({ geo: G.box(0.16, 0.05, 0.11), mat: MAT.armour, loc: () => M.T(0, 0.04, -0.17), part: "battery" }),
    N({ geo: G.box(0.164, 0.008, 0.114), mat: MAT.gold, loc: () => M.T(0, 0.045, -0.17) }),
    N({ geo: G.box(0.1, 0.006, 0.012), mat: () => em(MAT.green, A("lowb").v > 0.5 ? [1.8, 0.6, 0.05] : [0.1, 1.3, 0.45]), loc: () => M.T(0, 0.068, -0.17), part: "battery" }));
  const ants = N({ ex: [0, -0.04, -0.1] });
  add(ants, ...[-1, 1].map(sd => N({ geo: G.cyl(0.004, 0.14), mat: MAT.carbon2, loc: () => chain(M.T(0.06 * sd, -0.1, -0.22), M.RX(0.5)), part: "radio" })),
    N({ geo: G.sph(0.01), mat: () => em(MAT.blue, [0.3, 0.75, 1.4 + 3 * A("tx").v]), loc: () => M.T(0.06, -0.165, -0.255), part: "radio", tag: "ant" }));
  const gim = N({ ex: [0, -0.12, 0.05], tag: "cam", loc: () => M.T(0, -0.13, 0.09) });
  add(gim, N({ geo: G.cyl(0.02, 0.05), mat: MAT.carbon, loc: () => M.T(0, 0.04, -0.01) }),
    N({ geo: G.sph(0.055), mat: MAT.armour, loc: () => M.RY(A("gim").v), part: "camera" }),
    N({ geo: G.cyl(0.032, 0.04), mat: MAT.carbon, loc: () => chain(M.RY(A("gim").v), M.T(0, 0, 0.045), M.RX(Math.PI / 2)), part: "camera" }),
    N({ geo: G.cyl(0.022, 0.006), mat: () => em(MAT.glass, [0.1, 0.3 + A("shot").v * 1.5, 0.7 + A("shot").v * 2.5]), loc: () => chain(M.RY(A("gim").v), M.T(0, 0, 0.067), M.RX(Math.PI / 2)), part: "camera" }),
    N({ geo: G.tor(0.032, 0.004), mat: MAT.gold, loc: () => chain(M.RY(A("gim").v), M.T(0, 0, 0.066), M.RX(Math.PI / 2)) }));
  add(root, hull, dome, batt, ants, gim);
  [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sz], k) => {
    const ang = Math.atan2(sz, sx), R = 0.38;
    add(root, N({ geo: G.box(0.26, 0.05, 0.08), mat: MAT.armour, loc: () => chain(M.RY(-ang), M.T(0.2, 0.0, 0)), part: "rotors" }),
      N({ geo: G.box(0.262, 0.012, 0.082), mat: MAT.carbon, loc: () => chain(M.RY(-ang), M.T(0.2, -0.03, 0)) }));
    const pod = N({ tag: k === 0 ? "pod" : null, ex: [Math.cos(ang) * 0.16, 0, Math.sin(ang) * 0.16], loc: () => M.T(R * Math.cos(ang), 0, R * Math.sin(ang)) });
    add(pod, N({ geo: G.lathe("duct", [[0.212,-0.034],[0.236,-0.034],[0.236,-0.034],[0.246,-0.016],[0.246,0.02],[0.236,0.036],[0.236,0.036],[0.212,0.036]], 64), mat: MAT.armour, part: "rotors" }),
      N({ geo: G.lathe("ductIn", [[0.205,-0.036],[0.205,0.036]], 64), mat: MAT.carbon, part: "rotors" }),
      N({ geo: G.lathe("ductLip", [[0.205,0.036],[0.205,0.036],[0.214,0.036],[0.214,0.036]], 64), mat: MAT.carbon2 }),
      ...[0, 1, 2, 3].map(q => N({ geo: G.box(0.2, 0.008, 0.012), mat: MAT.carbon2, loc: () => chain(M.RY(q * Math.PI / 2 + 0.4), M.T(0.11, -0.03, 0)) })),
      N({ geo: G.tor(0.24, 0.006), mat: MAT.carbon, loc: () => M.T(0, -0.036, 0) }),
      N({ geo: G.tor(0.2, 0.006), mat: () => em(MAT.blue, [0.3, 0.7 * A("spin", 1).v + 0.1, 2.2 * A("spin", 1).v + 0.2]), loc: () => M.T(0, -0.03, 0), part: "rotors" }),
      N({ geo: G.tor(0.247, 0.003), mat: MAT.gold, loc: () => M.T(0, 0.004, 0) }),
      N({ geo: G.cyl(0.045, 0.05), mat: MAT.carbon2, part: "rotors" }),
      N({ geo: G.cyl(0.03, 0.054), mat: () => em(MAT.blue, [0.25, 0.6, 1.7 * A("spin", 1).v + 0.25]), part: "rotors" }),
      N({ geo: G.sph(0.012), mat: () => em(k < 2 ? MAT.green : MAT.red, (k < 2 ? [0.1, 1.4, 0.45] : [1.6, 0.08, 0.05]).map(c => c * (0.35 + 0.65 * (Math.sin(st.t * 4 + k) > 0)))), loc: () => M.T(0.245 * Math.sign(sx) * 0.7, 0.0, 0.245 * Math.sign(sz) * 0.7) }));
    const prop = N({ loc: () => chain(M.T(0, 0.01, 0), M.RY(st.t * (6 + 30 * A("spin", 1).v) * (k % 2 ? 1 : -1))) });
    for (let b = 0; b < 3; b++) add(prop, N({ geo: G.box(0.17, 0.004, 0.03), mat: MAT.carbon, loc: () => chain(M.RY(b * Math.PI * 2 / 3), M.T(0.1, 0, 0), M.RX(0.25)) }));
    add(pod, prop); add(root, pod);
  });
  root.anch = { fc: ["dome", [0, 0.09, 0.1]], camera: ["cam", [0, 0, 0.08]], gps: ["gps", [0, 0.015, 0]], radio: ["ant", [0, 0, 0]], battery: ["batt", [0, 0.075, -0.17]],
    rotors: ["pod", [0.17, 0.04, 0.17]], recorder: ["rec", [0, 0.01, 0.03]] };
  root.src = { mode: "fc", decision: "fc", detection: "camera", geofence: "gps", override: "rotors" };
  root.target = [0, 0.95, 0]; root.dist = 2.7; root.focusDist = 1.25; root.shadowR = 0.7; root.live = true;
  Object.defineProperty(root, "wit", { get: () => { const t = root.liveT || root.target; return [t[0] - 0.7, Math.max(1.2, t[1] + 0.55), t[2] + 0.2]; } });
  return root;
}
const MODELS = { humanoid: buildHumanoid(), drone: buildDrone() };
const witGeo = { ring: G.tor(0.09, 0.007), ring2: G.tor(0.06, 0.004), core: G.sph(0.035), part: G.sph(0.016) };

// ------------------------------------------------------------------ world positions of anchors
function anchorPos(name) { const mdl = MODELS[st.model];
  if (name === "witness") return mdl.wit;
  const a = mdl.anch[name]; if (!a) return mdl.target; const W = st.W[a[0]]; return W ? M.xf(W, a[1]) : mdl.target; }

// ------------------------------------------------------------------ camera + input
const cam = { yaw: 0.55, pitch: 0.1, dist: 3.9, tgt: [0, 0.95, 0], idle: 0, goalT: null, goalD: null };
let moved = 0, downAt = 0; const pts = new Map(); let hovT = 0;
const tip = $("#tip");
canvas.addEventListener("pointerdown", e => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); moved = 0; downAt = performance.now(); cam.idle = 0; });
canvas.addEventListener("pointermove", e => {
  const r = canvas.getBoundingClientRect(); st.look = [((e.clientX - r.left) / r.width - 0.5) * 2, ((e.clientY - r.top) / r.height - 0.5) * 2];
  if (!pts.has(e.pointerId)) { if (e.pointerType === "mouse") { const now = performance.now(); if (now - hovT > 90) { hovT = now; hover(e.clientX, e.clientY); } } return; }
  const prev = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
  if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (cam.pinch) { cam.dist = Math.min(6, Math.max(0.9, cam.dist * cam.pinch / d)); cam.goalD = null; } cam.pinch = d; return; }
  const dx = e.clientX - prev[0], dy = e.clientY - prev[1]; moved += Math.abs(dx) + Math.abs(dy);
  cam.yaw -= dx * 0.008; cam.pitch = Math.min(1.1, Math.max(-0.35, cam.pitch + dy * 0.006)); cam.idle = 0; });
canvas.addEventListener("pointerleave", () => { st.hov = null; tip.hidden = true; canvas.style.cursor = ""; });
const up = e => { const was = pts.has(e.pointerId); pts.delete(e.pointerId); cam.pinch = null; if (was && moved < 6 && performance.now() - downAt < 600) { const p = pickAt(e.clientX, e.clientY); select(p, true); } };
canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", e => pts.delete(e.pointerId));
canvas.addEventListener("dblclick", () => overview());
canvas.addEventListener("wheel", e => { e.preventDefault(); cam.dist = Math.min(6, Math.max(0.9, cam.dist * (1 + Math.sign(e.deltaY) * 0.08))); cam.goalD = null; cam.idle = 0; }, { passive: false });
addEventListener("keydown", e => { if (e.key === "Escape") overview(); });
function hover(cx, cy) { const p = pickAt(cx, cy); st.hov = p; canvas.style.cursor = p ? "pointer" : "";
  if (p) { const r = canvas.getBoundingClientRect(); tip.hidden = false; tip.textContent = INFO[st.model][p][0]; tip.style.transform = `translate(${cx - r.left + 14}px, ${cy - r.top + 10}px)`; } else tip.hidden = true; }
function overview() { const m = MODELS[st.model]; cam.goalT = m.target.slice(); cam.goalD = m.dist; cam.focus = null; select(null); }

// ------------------------------------------------------------------ rendering infrastructure
let VP, eye, W = 1, H = 1, dpr = 1, LVP;
function resize() { dpr = Math.min(GL2 ? 1.75 : 2, window.devicePixelRatio || 1); const r = canvas.getBoundingClientRect(); W = Math.max(2, Math.round(r.width * dpr)); H = Math.max(2, Math.round(r.height * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; } }
function bind(pr, g) { gl.bindBuffer(gl.ARRAY_BUFFER, g.v); gl.enableVertexAttribArray(pr.aP); gl.vertexAttribPointer(pr.aP, 3, gl.FLOAT, false, 0, 0);
  if (pr.aN >= 0) { gl.bindBuffer(gl.ARRAY_BUFFER, g.n); gl.enableVertexAttribArray(pr.aN); gl.vertexAttribPointer(pr.aN, 3, gl.FLOAT, false, 0, 0); }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.i); }
function unbindN(pr) { if (pr.aN >= 0) gl.disableVertexAttribArray(pr.aN); }
function walk(n, parent, fn) { let m = parent; if (n.ex) { const e = X(); m = M.mul(m, M.T(n.ex[0] * e, n.ex[1] * e, n.ex[2] * e)); } m = M.mul(m, n.loc());
  if (n.tag) st.W[n.tag] = m; if (n.geo) fn(n, m); for (const k of n.kids) walk(k, m, fn); }
function tex(w, h, filter) { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; }
function fboTex(w, h, depth, filter = gl.LINEAR) { const f = gl.createFramebuffer(), t = tex(w, h, filter); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  if (depth) { const d = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, d); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, d); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); return { f, t, w, h }; }
const SHN = 2048; const shadow = fboTex(SHN, SHN, true, gl.NEAREST);
let post = null;
function ensurePost() { if (!GL2) return; if (post && post.W === W && post.H === H) return;
  const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
  const msF = gl.createFramebuffer(), msC = gl.createRenderbuffer(), msD = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, msC); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, W, H);
  gl.bindRenderbuffer(gl.RENDERBUFFER, msD); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, W, H);
  gl.bindFramebuffer(gl.FRAMEBUFFER, msF); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msC); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msD);
  const w2 = Math.max(1, W >> 1), h2 = Math.max(1, H >> 1), w4 = Math.max(1, W >> 2), h4 = Math.max(1, H >> 2);
  post = { W, H, msF, res: fboTex(W, H, false), a2: fboTex(w2, h2), b2: fboTex(w2, h2), a4: fboTex(w4, h4), b4: fboTex(w4, h4) };
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
function pass(pr, target, w, h, setup) { gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.f : null); gl.viewport(0, 0, w, h); gl.useProgram(pr.p);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(pr.aP); gl.vertexAttribPointer(pr.aP, 2, gl.FLOAT, false, 0, 0); setup(); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
// dust
const dustN = 420, dustArr = new Float32Array(dustN * 3); for (let i = 0; i < dustN; i++) { const a = Math.random() * Math.PI * 2, r = 0.4 + Math.random() * 2.6; dustArr.set([Math.cos(a) * r, Math.random() * 3.2, Math.sin(a) * r], i * 3); }
const dustB = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, dustB); gl.bufferData(gl.ARRAY_BUFFER, dustArr, gl.STATIC_DRAW);
const groundG = upload("ground", () => lathe([[0,0],[2.8,0]], 96));
const I3 = [1,0,0,0,1,0,0,0,1];

// ------------------------------------------------------------------ particles (data flow)
const parts = [];
const clock = () => performance.now() / 1000;
function flow(from, to, col, dur = 0.7, then) { parts.push({ from, to, col, t0: clock(), dur, then }); }
function partPos(p, u) { const a = typeof p.from === "function" ? p.from() : anchorPos(p.from), b = typeof p.to === "function" ? p.to() : anchorPos(p.to);
  const mid = lerp3(a, b, 0.5); mid[1] += 0.12 + 0.15 * Math.hypot(b[0] - a[0], b[2] - a[2]); const s = 1 - u;
  return [s*s*a[0] + 2*s*u*mid[0] + u*u*b[0], s*s*a[1] + 2*s*u*mid[1] + u*u*b[1], s*s*a[2] + 2*s*u*mid[2] + u*u*b[2]]; }

// ------------------------------------------------------------------ frame
function drawModel(pr, mdl, setMat) { walk(mdl, M.id(), (n, m) => { bind(pr, n.geo); gl.uniformMatrix4fv(pr.u.uM, false, m); if (setMat) setMat(n, m); gl.drawElements(gl.TRIANGLES, n.geo.count, IDX, 0); }); }
function draw(t) {
  resize(); const mdl = MODELS[st.model];
  // camera
  if (mdl.live) mdl.liveT = [A("px").v * 0.7, 0.95 + A("alt").v * 0.75, A("pz").v * 0.7];
  if (cam.focus) cam.goalT = anchorPos(cam.focus); else if (mdl.live && !st.sel) cam.goalT = mdl.liveT;
  if (cam.goalT) cam.tgt = lerp3(cam.tgt, cam.goalT, 0.07); if (cam.goalYaw != null) { cam.yaw = ease(cam.yaw, cam.goalYaw, 0.06); if (Math.abs(cam.yaw - cam.goalYaw) < 0.01) cam.goalYaw = null; } if (cam.goalD) cam.dist = ease(cam.dist, cam.goalD, 0.07);
  cam.idle += 1 / 60; if (cam.idle > 4 && !pts.size && !st.sel) cam.yaw += 0.0022;
  eye = [cam.tgt[0] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw), cam.tgt[1] + cam.dist * Math.sin(cam.pitch) + 0.1, cam.tgt[2] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw)];
  VP = M.mul(M.persp(0.62, W / H, 0.05, 40), M.lookAt(eye, cam.tgt, [0, 1, 0]));
  // light-space matrix + shadow pass
  const Ld = norm([0.45, 0.85, 0.55]), c = mdl.target, R = 1.25;
  LVP = M.mul(M.ortho(-R, R, -R, R, 0.1, 8), M.lookAt([c[0] + Ld[0] * 4, c[1] + Ld[1] * 4, c[2] + Ld[2] * 4], c, [0, 1, 0]));
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.f); gl.viewport(0, 0, SHN, SHN); gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.useProgram(PD.p); gl.uniformMatrix4fv(PD.u.uLVP, false, LVP);
  drawModel(PD, mdl); if (PD.aN >= 0) unbindN(PD);
  // main scene target
  if (GL2) { ensurePost(); gl.bindFramebuffer(gl.FRAMEBUFFER, post.msF); gl.clearColor(0, 0, 0, 0); }
  else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0.03, 0.045, 0.06, 1); }
  gl.viewport(0, 0, W, H); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const shadowU = pr => { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shadow.t); gl.uniform1i(pr.u.uSh, 0); gl.uniformMatrix4fv(pr.u.uLVP, false, LVP); gl.uniform1f(pr.u.uShTex, 1 / SHN); gl.uniform3fv(pr.u.uLd, Ld); };
  // ground
  gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
  gl.useProgram(PG.p); shadowU(PG); bind(PG, groundG); gl.uniformMatrix4fv(PG.u.uM, false, M.id()); gl.uniformMatrix4fv(PG.u.uVP, false, VP); gl.uniformMatrix3fv(PG.u.uNM, false, I3);
  gl.uniform1f(PG.u.uTime, t); gl.uniform1f(PG.u.uR, mdl.shadowR); gl.drawElements(gl.TRIANGLES, groundG.count, IDX, 0);
  gl.depthMask(true); gl.disable(gl.BLEND);
  // model
  gl.useProgram(P.p); shadowU(P); gl.uniformMatrix4fv(P.u.uVP, false, VP); gl.uniform3fv(P.u.uCam, eye); gl.uniform1f(P.u.uTime, t);
  const setMat = (n, m) => { const mt = typeof n.mat === "function" ? n.mat() : n.mat; gl.uniformMatrix3fv(P.u.uNM, false, M.nrm(m));
    gl.uniform3fv(P.u.uCol, mt.c); gl.uniform3fv(P.u.uEm, mt.em || [0, 0, 0]); gl.uniform1f(P.u.uMet, mt.met); gl.uniform1f(P.u.uRou, mt.rou);
    gl.uniform1f(P.u.uHi, st.sel && n.part === st.sel ? 1 : 0); gl.uniform1f(P.u.uHov, st.hov && n.part === st.hov && st.hov !== st.sel ? 1 : 0); };
  drawModel(P, mdl, setMat);
  // witness node
  const wv = A("witVis").v; if (wv > 0.02) { const wp = mdl.wit, s = wv, wc = A("witRed").v > 0.5 ? [2.2, 0.25, 0.1] : A("witGreen").v > 0.5 ? [0.25, 1.8, 0.7] : [0.5, 0.9, 2.0];
    const draws = [[witGeo.ring, chain(M.T(...wp), M.S(s, s, s), M.RY(t * 0.9), M.RX(1.1 + Math.sin(t) * 0.2)), MAT.gold],
      [witGeo.ring2, chain(M.T(...wp), M.S(s, s, s), M.RY(-t * 1.6), M.RZ(0.9)), MAT.gold],
      [witGeo.core, chain(M.T(...wp), M.S(s, s, s)), em(MAT.glass, wc.map(v => v * (1 + 0.6 * A("witPulse").v)))]];
    for (const [g, m, mt] of draws) { bind(P, g); gl.uniformMatrix4fv(P.u.uM, false, m); gl.uniformMatrix3fv(P.u.uNM, false, M.nrm(m)); gl.uniform3fv(P.u.uCol, mt.c); gl.uniform3fv(P.u.uEm, mt.em || [0, 0, 0]);
      gl.uniform1f(P.u.uMet, mt.met); gl.uniform1f(P.u.uRou, mt.rou); gl.uniform1f(P.u.uHi, st.sel === "witness" ? 1 : 0); gl.uniform1f(P.u.uHov, 0); gl.drawElements(gl.TRIANGLES, g.count, IDX, 0); } }
  // data-flow particles with short trails
  for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; const u = (clock() - p.t0) / p.dur; if (u >= 1) { parts.splice(i, 1); p.then && p.then(); continue; }
    for (let k = 0; k < 5; k++) { const uu = Math.max(0, u - k * 0.035); const pos = partPos(p, uu); const sc = 1 - k * 0.17; const m = chain(M.T(...pos), M.S(sc, sc, sc));
      bind(P, witGeo.part); gl.uniformMatrix4fv(P.u.uM, false, m); gl.uniformMatrix3fv(P.u.uNM, false, I3); gl.uniform3fv(P.u.uCol, [0, 0, 0]);
      gl.uniform3fv(P.u.uEm, p.col.map(v => v * (1.6 - k * 0.25))); gl.uniform1f(P.u.uMet, 0); gl.uniform1f(P.u.uRou, 1); gl.uniform1f(P.u.uHi, 0); gl.uniform1f(P.u.uHov, 0);
      gl.drawElements(gl.TRIANGLES, witGeo.part.count, IDX, 0); } }
  // dust motes
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.depthMask(false); gl.useProgram(PT.p);
  gl.bindBuffer(gl.ARRAY_BUFFER, dustB); gl.enableVertexAttribArray(PT.aP); gl.vertexAttribPointer(PT.aP, 3, gl.FLOAT, false, 0, 0);
  gl.uniformMatrix4fv(PT.u.uVP, false, VP); gl.uniform1f(PT.u.uTime, t); gl.uniform1f(PT.u.uPx, 2.2 * dpr); gl.drawArrays(gl.POINTS, 0, dustN);
  gl.depthMask(true); gl.disable(gl.BLEND); if (P.aN >= 0) unbindN(P);
  // post
  if (GL2) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, post.msF); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, post.res.f);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    const tx = (pr, name, t2, unit) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t2); gl.uniform1i(pr.u[name], unit); };
    pass(PB, post.a2, post.a2.w, post.a2.h, () => tx(PB, "uT", post.res.t, 0));
    pass(PBL, post.b2, post.b2.w, post.b2.h, () => { tx(PBL, "uT", post.a2.t, 0); gl.uniform2f(PBL.u.uD, 1 / post.a2.w, 0); });
    pass(PBL, post.a2, post.a2.w, post.a2.h, () => { tx(PBL, "uT", post.b2.t, 0); gl.uniform2f(PBL.u.uD, 0, 1 / post.a2.h); });
    pass(PBL, post.a4, post.a4.w, post.a4.h, () => { tx(PBL, "uT", post.a2.t, 0); gl.uniform2f(PBL.u.uD, 1.5 / post.a2.w, 0); });
    pass(PBL, post.b4, post.b4.w, post.b4.h, () => { tx(PBL, "uT", post.a4.t, 0); gl.uniform2f(PBL.u.uD, 0, 1.5 / post.a4.h); });
    pass(PC, null, W, H, () => { tx(PC, "uT", post.res.t, 0); tx(PC, "uB1", post.a2.t, 1); tx(PC, "uB2", post.b4.t, 2); gl.uniform1f(PC.u.uTime, t); gl.uniform2f(PC.u.uRes, W, H); });
    gl.activeTexture(gl.TEXTURE0);
  }
  placeHotspots(); hud();
}
// picking by colour id
let pk = null;
function pickAt(cx, cy) {
  const r = canvas.getBoundingClientRect(); const x = Math.round((cx - r.left) * dpr), y = Math.round(H - (cy - r.top) * dpr);
  if (!pk || pk.w !== W || pk.h !== H) pk = fboTex(W, H, true, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, pk.f); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  gl.useProgram(PP.p); gl.uniformMatrix4fv(PP.u.uVP, false, VP); const list = [null];
  drawModel(PP, MODELS[st.model], n => { let id = 0; if (n.part) { id = list.indexOf(n.part); if (id < 0) { list.push(n.part); id = list.length - 1; } } gl.uniform3f(PP.u.uId, id / 255, 0, 0); });
  if (A("witVis").v > 0.5) { const m = chain(M.T(...MODELS[st.model].wit), M.S(1.4, 1.4, 1.4)); list.push("witness"); bind(PP, witGeo.core); gl.uniformMatrix4fv(PP.u.uM, false, m); gl.uniform3f(PP.u.uId, (list.length - 1) / 255, 0, 0); gl.drawElements(gl.TRIANGLES, witGeo.core.count, IDX, 0); }
  if (PP.aN >= 0) unbindN(PP);
  const px = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return list[px[0]] || null; }

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
for (const m of ["humanoid", "drone"]) Object.assign(INFO[m], {
  recorder: ["EDEN recorder module", "The part that exists and is tested today. It hashes every entry, builds the Merkle tree and signs each seal. In the production design the signing key lives in a secure chip so it can't be copied off the machine; today's prototype keeps it in software.", '{"type":"seal","log":"…","n":8,"root":"854f…","sig":"Ed25519 …"}', "Measured: Ed25519 seal in 0.12 ms on a laptop, 0.64 ms on a phone."],
  witness: ["Witness", "An outside party (an insurer, auditor, customer or regulator) that keeps a copy of every seal and refuses any later version that contradicts it. Green: holding the seal. Red: a rewrite was caught.", '{"type":"witness_receipt","seal_id":"…","n":8,"received_at":"…"}', "Measured: a witness round trip over HTTP takes about 1.5 ms."] });
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
function hotList() { return [...Object.keys(MODELS[st.model].anch), "witness"]; }
function renderHotspots() { hotWrap.innerHTML = ""; let i = 1;
  for (const k of hotList()) { const b = document.createElement("button"); b.className = "hot" + (k === "recorder" ? " rec" : k === "witness" ? " wit" : ""); b.dataset.part = k;
    b.textContent = k === "recorder" ? "E" : k === "witness" ? "W" : i++; b.setAttribute("aria-label", INFO[st.model][k][0]);
    b.addEventListener("click", ev => { ev.stopPropagation(); select(k, true); }); hotWrap.appendChild(b); } }
function placeHotspots() { const r = canvas.getBoundingClientRect(); const mdl = MODELS[st.model]; const fwd = norm([cam.tgt[0] - eye[0], cam.tgt[1] - eye[1], cam.tgt[2] - eye[2]]);
  for (const b of hotWrap.children) { const k = b.dataset.part; const p = anchorPos(k); const c = M.xf(VP, p);
    let vis = 1; if (k === "recorder") vis = Math.max(0, (X() - 0.4) / 0.6); if (k === "witness") vis = A("witVis").v;
    const x = (c[0] * 0.5 + 0.5) * r.width, y = (1 - (c[1] * 0.5 + 0.5)) * r.height;
    const behind = dot(norm([p[0] - mdl.target[0], 0, p[2] - mdl.target[2]]), norm([fwd[0], 0, fwd[2]])) > 0.45 && k !== "witness";
    b.style.transform = `translate(${x}px, ${y}px)`; b.style.opacity = vis * (behind ? 0.3 : 1); b.style.pointerEvents = vis > 0.5 ? "auto" : "none";
    b.classList.toggle("on", st.sel === k); } }
function select(part, fly) { st.sel = part; const box = $("#part");
  if (part && fly) { cam.focus = part === "witness" ? null : part; cam.goalD = MODELS[st.model].focusDist; if (part === "witness") { cam.goalT = MODELS[st.model].wit.slice(); } }
  if (!part) { box.innerHTML = `<div class="eye">Tap a part or a glowing number</div><h3>What EDEN records, part by part</h3><p>Each part of the ${st.model === "drone" ? "drone" : "robot"} produces a different kind of record. Hover or tap the model to explore. Turn on <b>X-ray</b> to see the EDEN recorder inside. Double-click or press Esc to zoom back out.</p>`; return; }
  const [t, d, ex, m] = INFO[st.model][part];
  box.innerHTML = `<div class="eye">${st.model === "drone" ? "VPD-001" : "ED-01"} · ${part === "witness" ? "outside the machine" : "part"}</div><h3>${t}</h3><p>${d}</p><pre>${ex.replace(/</g, "&lt;")}</pre><p class="meas">${m}</p>`; }
function hud() { const h = $("#hud"); if (!h) return; const n = rec.entries.length;
  const s = rec.tampered >= 0 ? `<span class="r">rewrite caught</span>` : rec.witness ? `<span class="g">witness holds seal</span>` : rec.seal ? "sealed" : n ? "recording" : "idle";
  const txt = `<b>${n}</b> entries · root <code>${rec.seal ? rec.seal.root.slice(0, 8) : "—"}</code> · ${s}`; if (h.dataset.v !== txt) { h.innerHTML = txt; h.dataset.v = txt; } }

// ------------------------------------------------------------------ the recorder (real cryptography)
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
function canon(v) { if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  if (typeof v === "number" && !Number.isInteger(v)) throw new Error("floats are forbidden"); return JSON.stringify(v); }
async function sha(...ps) { const n = ps.reduce((a, p) => a + p.length, 0), b = new Uint8Array(n); let o = 0; for (const p of ps) { b.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b)); }
const leafHash = e => sha(new Uint8Array([0]), enc.encode(canon(e)));
async function mth(L) { if (L.length === 1) return L[0]; let k = 1; while (k * 2 < L.length) k *= 2; return sha(new Uint8Array([1]), await mth(L.slice(0, k)), await mth(L.slice(k))); }
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
    ["decision", { action: "waypoint", wp: 1, model: "nav v3.1" }, "wp1", "Waypoint 1 reached"],
    ["detection", { label: "vehicle", score: 91, frame: "gimbal" }, "shot", "Vehicle detected · score 91"],
    ["geofence", { event: "warning", distance_m: 40 }, "fence", "Geofence warning: 40 m from boundary"],
    ["decision", { action: "avoid", obstacle: "bird", model: "nav v3.1" }, "avoid", "Obstacle avoided (bird)"],
    ["decision", { action: "return_home", battery_pct: 20 }, "lowb", "Battery 20% → return home"],
    ["override", { by: "pilot p-03", mode: "MANUAL" }, "override", "Pilot p-03 takes manual control"],
    ["mode", { to: "LANDED" }, "land", "Landed safely"]],
};
const rec = { entries: [], leaves: [], seal: null, witness: null, key: null, running: false, tampered: -1, gen: 0 };
async function keyPair() { if (rec.key !== null) return rec.key;
  try { rec.key = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]); } catch (e) { rec.key = false; } return rec.key; }
function ui() { const log = $("#log"); log.innerHTML = rec.entries.map((e, i) => `<tr class="${i === rec.tampered ? "bad" : ""}"><td>${e.i}</td><td>${e.kind}</td><td>${e.txt}</td><td><code>${rec.leaves[i] ? hex(rec.leaves[i]).slice(0, 12) : "…"}</code></td></tr>`).join("") || `<tr><td colspan="4" class="empty">No entries yet. Press Run.</td></tr>`;
  const lw = $(".logwrap"); if (lw) lw.scrollTop = lw.scrollHeight;
  $("#bRun").disabled = rec.running || rec.entries.length >= SCRIPT[st.model].length; $("#bSeal").disabled = rec.running || !rec.entries.length || !!rec.seal;
  $("#bWit").disabled = !rec.seal || !!rec.witness || rec.tampered >= 0; $("#bTam").disabled = !rec.witness || rec.tampered >= 0; }
function status(html, cls = "") { const s = $("#status"); s.className = "status " + cls; s.innerHTML = html; }
const BLUE = [0.4, 0.85, 2.4], GOLD = [2.2, 1.5, 0.5], RED = [2.6, 0.35, 0.15];
function trigger(a) { const set = (k, v, back, ms = 900) => { A(k).t = v; if (back !== undefined) setTimeout(() => (A(k).t = back), ms); };
  if (st.model === "humanoid") ({ step: () => { set("leg1", -0.35, 0, 450); setTimeout(() => set("leg-1", -0.35, 0, 450), 450); set("bob", -0.015, 0, 900); },
    look: () => set("pitch", 0.25, 0, 1100), think: () => set("core", 2.4, 1, 900), grip: () => { set("arm1", -1.1, 0, 1600); set("elb1", -0.6, 0, 1600); set("grip", 1, 0, 1400); },
    estop: () => { set("stop", 1); set("eye", 1); set("arm1", 0); }, override: () => { set("eye", 0); set("stop", 0.3); set("tx", 1, 0, 2500); } })[a]?.();
  else ({ takeoff: () => { set("alt", 0.25, 0, 2200); set("spin", 1.4, 1, 2200); }, wp1: () => { set("px", 0.35); set("pz", 0.15); set("dpitch", 0.12, 0, 700); set("think", 1, 0, 900); },
    shot: () => { set("gim", 0.7, 0, 1400); set("shot", 1, 0, 600); }, fence: () => { set("fence", 1, 0, 1600); set("roll", 0.15, 0, 900); set("px", 0.15); },
    avoid: () => { set("roll", -0.35, 0, 900); set("dpitch", 0.15, 0, 900); set("pz", -0.15); }, lowb: () => { set("lowb", 1); set("dyaw", A("dyaw").t + Math.PI); set("px", 0); set("pz", 0); },
    override: () => { set("spin", 0.4, 1, 1400); set("tx", 1, 0, 2500); }, land: () => { set("alt", -0.74); set("spin", 0.15); } })[a]?.(); }
async function run() { rec.running = true; const gen = rec.gen; ui(); status("Recording… each entry is hashed on your device as it happens, and travels from the part to the recorder.");
  const sc = SCRIPT[st.model], mdl = MODELS[st.model];
  for (let k = rec.entries.length; k < sc.length; k++) { if (gen !== rec.gen) return; const [kind, body, a, txt] = sc[k];
    const e = { v: 1, log: st.model === "drone" ? "vpd-001/mission-7" : "ed-01/shift-3", i: k, t: "T+" + String(k * 4).padStart(3, "0") + "s", kind, actor: st.model === "drone" ? "VPD-001" : "ED-01", body };
    trigger(a); flow(mdl.src[kind] || "recorder", "recorder", BLUE, 0.65, () => { A("recPulse").t = 1; setTimeout(() => (A("recPulse").t = 0), 250); });
    rec.entries.push(Object.assign({ txt }, e)); rec.leaves.push(await leafHash(e)); ui(); await new Promise(r => setTimeout(r, 900)); }
  if (gen !== rec.gen) return; rec.running = false; ui(); status("Recorded " + rec.entries.length + " entries. Now seal them."); }
const plain = e => { const o = Object.assign({}, e); delete o.txt; return o; };
async function doSeal() { const root = hex(await mth(rec.leaves)); const s = { v: 1, type: "seal", log: rec.entries[0].log, n: rec.entries.length, root };
  const k = await keyPair(); let sig = "";
  if (k) sig = hex(await crypto.subtle.sign({ name: "Ed25519" }, k.privateKey, enc.encode("EDEN-EVIDENCE-SEAL-v1\0" + canon(s))));
  rec.seal = Object.assign({}, s, { sig }); A("recPulse").t = 1; setTimeout(() => (A("recPulse").t = 0), 500);
  flow("recorder", "radio", GOLD, 0.6, () => { A("tx").t = 1; setTimeout(() => (A("tx").t = 0), 1500); });
  const bytes = enc.encode(canon(rec.seal)).length, logBytes = rec.entries.reduce((a, e) => a + enc.encode(canon(plain(e))).length, 0);
  status(`Sealed. Root <code>${root.slice(0, 16)}…</code> covers all ${s.n} entries${sig ? `, signed with Ed25519 (<code>${sig.slice(0, 12)}…</code>)` : " (this browser can't sign Ed25519; the root check below still works)"}. The seal is ${bytes} bytes; the log it covers is ${logBytes} bytes.`, "ok"); ui(); }
function doWitness() { rec.witness = { root: rec.seal.root, n: rec.seal.n, received: new Date().toISOString().slice(11, 19) + " UTC" }; A("witVis").t = 1; A("witGreen").t = 0; ui();
  flow("radio", "witness", GOLD, 1.1, () => { A("witGreen").t = 1; A("witPulse").t = 1; setTimeout(() => (A("witPulse").t = 0), 600); });
  status(`The seal travels to the witness (root <code>${rec.witness.root.slice(0, 16)}…</code>, received ${rec.witness.received}). From now on, any rewrite of these ${rec.witness.n} entries can be caught.`, "ok"); }
async function doTamper() { const mdl = MODELS[st.model]; const kind = st.model === "drone" ? "override" : "estop"; const i = rec.entries.findIndex(e => e.kind === kind);
  const e = rec.entries[i]; const forged = st.model === "drone" ? Object.assign({}, e, { body: { by: "autopilot", mode: "AUTO" }, txt: "Autopilot kept control (rewritten)" })
    : Object.assign({}, e, { body: { by: "robot", reason: "self_test" }, txt: "Robot stopped itself for a self-test (rewritten)" });
  rec.entries[i] = forged; rec.leaves[i] = await leafHash(plain(forged)); rec.tampered = i; ui();
  const root = hex(await mth(rec.leaves)); const s = { v: 1, type: "seal", log: forged.log, n: rec.entries.length, root };
  const k = await keyPair(); let sigOk = null;
  if (k) { const sig = await crypto.subtle.sign({ name: "Ed25519" }, k.privateKey, enc.encode("EDEN-EVIDENCE-SEAL-v1\0" + canon(s)));
    sigOk = await crypto.subtle.verify({ name: "Ed25519" }, k.publicKey, sig, enc.encode("EDEN-EVIDENCE-SEAL-v1\0" + canon(s))); }
  status(`<b>An insider rewrites entry ${i}</b> to change who was in control, re-seals with the real key and sends it to the witness…`, "");
  flow(mdl.src[kind], "recorder", RED, 0.6, () => flow("recorder", "radio", RED, 0.5, () => flow("radio", "witness", RED, 1.0, () => {
    A("witRed").t = 1; A("witGreen").t = 0; A("witPulse").t = 1; setTimeout(() => (A("witPulse").t = 0), 900);
    status(`<b>An insider rewrote entry ${i}</b> to change who was in control, then re-sealed with the real key.<br>` +
      (sigOk === null ? "" : `Signature on the new seal: <span class="okc">valid</span> (whoever holds the key can always sign).<br>`) +
      `New root <code>${root.slice(0, 16)}…</code> vs the witness's <code>${rec.witness.root.slice(0, 16)}…</code> → <span class="badc">REWRITE DETECTED</span>. The witness refuses it.`, "bad"); ui(); }))); }
function reset() { rec.gen++; rec.entries = []; rec.leaves = []; rec.seal = null; rec.witness = null; rec.tampered = -1; rec.running = false; parts.length = 0;
  const keep = { explode: st.anim.explode }; st.anim = {}; if (keep.explode) st.anim.explode = keep.explode;
  status("Press <b>Run</b> to record a " + (st.model === "drone" ? "mission" : "shift") + ". Everything is computed in your browser."); ui(); }
$("#bRun").addEventListener("click", run); $("#bSeal").addEventListener("click", doSeal); $("#bWit").addEventListener("click", doWitness);
$("#bTam").addEventListener("click", doTamper); $("#bReset").addEventListener("click", reset);
$("#bX").addEventListener("click", () => { const on = A("explode").t < 0.5; A("explode").t = on ? 1 : 0; $("#bX").setAttribute("aria-pressed", on); if (on) { cam.goalYaw = 0.5 + Math.round((cam.yaw - 0.5) / (Math.PI * 2)) * Math.PI * 2; cam.idle = -6; select("recorder", true); } });
$("#bView").addEventListener("click", overview);
for (const b of document.querySelectorAll("[data-model]")) b.addEventListener("click", () => { st.model = b.dataset.model;
  for (const x of document.querySelectorAll("[data-model]")) x.setAttribute("aria-selected", x === b); st.W = {};
  reset(); A("explode").t = 0; A("explode").v = 0; $("#bX").setAttribute("aria-pressed", false); overview(); cam.dist = MODELS[st.model].dist; cam.tgt = MODELS[st.model].target.slice();
  renderHotspots(); renderSpec(); $("#runLabel").textContent = st.model === "drone" ? "Run mission" : "Run shift"; });

// ------------------------------------------------------------------ loop
renderHotspots(); renderSpec(); select(null); reset();
let last = performance.now();
function frame(now) { const dt = Math.min(0.05, (now - last) / 1000); last = now; st.t += dt;
  for (const k in st.anim) { const a = st.anim[k]; a.v = ease(a.v, a.t, 1 - Math.pow(k === "explode" ? 0.02 : 0.002, dt)); }
  if (st.model === "humanoid" && A("stop").t < 0.5) A("yaw").t = st.look[0] * 0.5;
  draw(st.t); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
window.__eden = { st, rec, select, A };
})();
