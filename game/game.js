// EDEN Observatory — float in orbit among the real satellites and stars, in their positions now.
// Hand-written WebGL, no frameworks. Orbits: satellite.js (SGP4, MIT). Stars: d3-celestial (BSD-3).
import * as SAT from "./sat/index.js";

const $ = s => document.querySelector(s);
const RE = 6371, MU = 398600.4418, U = 1000;            // km; render unit = 1000 km
const canvas = $("#sky");
const gl = canvas.getContext("webgl", { antialias: true, alpha: false, premultipliedAlpha: false, powerPreference: "high-performance" });
if (!gl) { $("#loadMsg").textContent = "This page needs WebGL, which your browser has switched off."; throw new Error("no webgl"); }
gl.getExtension("OES_element_index_uint");

/* ---------- maths ---------- */
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const add = (a, b, k = 1) => [a[0]+b[0]*k, a[1]+b[1]*k, a[2]+b[2]*k];
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const mulv = (a, k) => [a[0]*k, a[1]*k, a[2]*k];
const len = v => Math.hypot(v[0], v[1], v[2]);
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const M = {
  mul(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3]; return o; },
  T: (x, y, z) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1],
  RZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]; },
  persp(f, asp, n, fa) { const t = 1 / Math.tan(f / 2); return [t/asp,0,0,0, 0,t,0,0, 0,0,(fa+n)/(n-fa),-1, 0,0,2*fa*n/(n-fa),0]; },
  view(f, u) { const z = mulv(f, -1), x = norm(cross(u, z)), y = cross(z, x); return [x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, 0,0,0,1]; },
};
const jd = d => d.getTime() / 86400000 + 2440587.5;
function sunDir(d) {                                     // low-precision solar position, ECI (good to ~0.01°)
  const n = jd(d) - 2451545.0, L = (280.460 + 0.9856474 * n) * D2R, g = (357.528 + 0.9856003 * n) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R, eps = (23.439 - 0.0000004 * n) * D2R;
  return norm([Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)]);
}
const radec = (ra, dec) => [Math.cos(dec*D2R)*Math.cos(ra*D2R), Math.cos(dec*D2R)*Math.sin(ra*D2R), Math.sin(dec*D2R)];
function inShadow(p, s) { const a = dot(p, s); if (a > 0) return false; return len(add(p, s, -a)) < RE; }

/* ---------- GL helpers ---------- */
function prog(vs, fs) { const p = gl.createProgram();
  for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); gl.attachShader(p, sh); }
  gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}, a = {}; for (let k = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); k < n; k++) { const i = gl.getActiveUniform(p, k); u[i.name] = gl.getUniformLocation(p, i.name); }
  for (let k = 0, n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); k < n; k++) { const i = gl.getActiveAttrib(p, k); a[i.name] = gl.getAttribLocation(p, i.name); }
  return { p, u, a }; }
function buf(data, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, usage); return b; }
function attr(pr, name, b, size, stride = 0, off = 0) { const l = pr.a[name]; if (l === undefined || l < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, off); }
function off(pr) { for (const k in pr.a) gl.disableVertexAttribArray(pr.a[k]); }
function texture(urls, fallback) { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(fallback));
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE); urls = urls.filter(u => !/_4k/.test(u) || max >= 4096);
  const next = k => { if (k >= urls.length) return; const img = new Image(); img.onerror = () => next(k + 1); img.onload = () => { gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); const ext = gl.getExtension("EXT_texture_filter_anisotropic"); if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    setTimeout(() => next(k + 1), 400); }; img.src = urls[k]; };
  next(0); return t; }

/* ---------- shaders ---------- */
const STAR_VS = `attribute vec3 aP; attribute vec3 aC; attribute float aS; uniform mat4 uVP; uniform float uPx; varying vec3 vC; varying float vA;
void main(){ vec4 p = uVP*vec4(aP*100.0,1.0); gl_Position = p.xyww; gl_PointSize = max(1.0, aS*uPx); vC = aC; vA = clamp(aS*uPx/1.6,0.25,1.0); }`;
const STAR_FS = `precision mediump float; varying vec3 vC; varying float vA;
void main(){ vec2 c = gl_PointCoord-0.5; float d = length(c); float a = smoothstep(0.5,0.0,d); a = a*a*vA; gl_FragColor = vec4(vC*a, a); }`;
const LINE_VS = `attribute vec3 aP; attribute float aK; uniform mat4 uVP; uniform float uHi; varying float vH;
void main(){ vec4 p = uVP*vec4(aP*100.0,1.0); gl_Position = p.xyww; vH = abs(aK-uHi)<0.5 ? 1.0 : 0.0; }`;
const LINE_FS = `precision mediump float; varying float vH; uniform float uBase, uHiA;
void main(){ float a = mix(uBase, uHiA, vH); gl_FragColor = vec4(mix(vec3(0.45,0.62,0.85), vec3(0.95,0.78,0.42), vH)*a, a); }`;
const SUN_VS = `attribute vec2 aQ; uniform mat4 uVP; uniform vec3 uSun; uniform float uSz, uAsp; varying vec2 vQ;
void main(){ vec4 p = uVP*vec4(uSun*100.0,1.0); p = p.xyww; p.xy += aQ*uSz*vec2(1.0/uAsp,1.0)*p.w; gl_Position = p; vQ = aQ; }`;
const SUN_FS = `precision mediump float; varying vec2 vQ;
void main(){ float d = length(vQ); float core = smoothstep(0.09,0.05,d); float glow = exp(-d*5.5)*0.9 + exp(-d*18.0);
  float rays = pow(max(0.0,1.0-abs(vQ.x)*14.0),3.0)*exp(-abs(vQ.y)*2.4)*0.35 + pow(max(0.0,1.0-abs(vQ.y)*14.0),3.0)*exp(-abs(vQ.x)*2.4)*0.35;
  vec3 c = vec3(1.0,0.93,0.8)*(glow+rays) + vec3(1.0)*core; gl_FragColor = vec4(c, 1.0); }`;
const EARTH_VS = `attribute vec3 aP; attribute vec2 aT; uniform mat4 uVP, uM; varying vec2 vT; varying vec3 vN, vW;
void main(){ vec4 w = uM*vec4(aP,1.0); vW = w.xyz; vN = normalize(mat3(uM)*aP); vT = aT; gl_Position = uVP*w; }`;
const EARTH_FS = `precision highp float; varying vec2 vT; varying vec3 vN, vW; uniform sampler2D uDay, uNight, uCloud, uSpec; uniform vec3 uSun; uniform float uCloudOff;
void main(){ vec3 n = normalize(vN); vec3 v = normalize(-vW); float l = dot(n,uSun);
  vec3 day = texture2D(uDay,vT).rgb; day = pow(day, vec3(1.1));
  float cl = texture2D(uCloud, vT+vec2(uCloudOff,0.0)).r; float spec = texture2D(uSpec,vT).r;
  vec3 night = texture2D(uNight,vT).rgb*vec3(1.0,0.82,0.55)*1.6;
  float dl = smoothstep(-0.12,0.25,l);
  vec3 h = normalize(uSun+v); float sp = pow(max(dot(n,h),0.0),60.0)*spec*0.55*dl;
  vec3 lit = mix(day, vec3(1.0), cl*0.85)*(0.06+1.05*max(l,0.0)) + vec3(1.0,0.95,0.85)*sp;
  vec3 col = mix(night*(1.0-cl*0.8), lit, dl);
  float rim = pow(1.0-max(dot(n,v),0.0), 6.0);
  vec3 sky = vec3(0.32,0.55,1.0)*rim*(0.05+0.9*smoothstep(-0.2,0.4,l));
  float tw = exp(-abs(l)*12.0)*rim; sky += vec3(1.0,0.45,0.15)*tw*0.3;
  gl_FragColor = vec4(col+sky, 1.0); }`;
const ATM_FS = `precision highp float; varying vec2 vT; varying vec3 vN, vW; uniform vec3 uSun;
void main(){ vec3 n = normalize(vN); vec3 v = normalize(-vW); float f = 1.0-abs(dot(n,v)); float l = dot(n,uSun);
  float g = pow(f, 7.0)*1.5*smoothstep(-0.3,0.35,l); vec3 c = mix(vec3(1.0,0.5,0.2), vec3(0.35,0.6,1.0), smoothstep(-0.05,0.3,l));
  gl_FragColor = vec4(c*g, g); }`;
const SAT_VS = `attribute vec3 aP; attribute vec3 aC; attribute float aL; uniform mat4 uVP; uniform float uPx, uFocal;
varying vec3 vC; varying float vS, vL;
void main(){ gl_Position = uVP*vec4(aP,1.0); float d = max(length(aP), 0.0005);
  float s = clamp(uFocal*0.15/d, 2.8, 46.0); gl_PointSize = s*uPx; vS = s; vC = aC; vL = aL; }`;
const SAT_FS = `precision mediump float; varying vec3 vC; varying float vS, vL;
void main(){ vec2 c = gl_PointCoord-0.5; float d = length(c);
  float glow = smoothstep(0.5,0.0,d); glow *= glow;
  float a = glow;
  if (vS > 12.0) { vec2 q = abs(c); float body = step(q.x,0.07)*step(q.y,0.09);
    float pan = step(0.11,q.x)*step(q.x,0.47)*step(q.y,0.075)*(0.75+0.25*step(0.5,fract(c.x*14.0)));
    float k = smoothstep(12.0,20.0,vS); a = mix(glow, max(body, pan*0.9) + glow*0.25, k); }
  vec3 col = mix(vec3(0.75,0.3,0.25)*0.6, vC*1.15, vL); float al = a*mix(0.55,1.0,vL); gl_FragColor = vec4(col*al, al); }`;
const ORB_VS = `attribute vec3 aP; attribute float aF; uniform mat4 uVP; uniform vec3 uCam; varying float vF;
void main(){ gl_Position = uVP*vec4(aP-uCam,1.0); vF = aF; }`;
const ORB_FS = `precision mediump float; varying float vF; uniform vec3 uCol;
void main(){ float a = 0.15+0.6*vF; gl_FragColor = vec4(uCol*a, a); }`;
const PS = prog(STAR_VS, STAR_FS), PL = prog(LINE_VS, LINE_FS), PSun = prog(SUN_VS, SUN_FS), PE = prog(EARTH_VS, EARTH_FS),
      PA = prog(EARTH_VS, ATM_FS), PSat = prog(SAT_VS, SAT_FS), PO = prog(ORB_VS, ORB_FS);

/* ---------- Earth mesh (vertices in Earth-fixed frame, render units) ---------- */
function sphere(r, sx = 128, sy = 64) { const p = [], t = [], idx = [];
  for (let j = 0; j <= sy; j++) { const lat = 90 - 180 * j / sy; for (let i = 0; i <= sx; i++) { const lon = -180 + 360 * i / sx;
    p.push(...mulv(radec(lon, lat), r)); t.push(i / sx, j / sy); } }
  for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) { const a = j * (sx + 1) + i, b = a + sx + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  return { p: buf(new Float32Array(p)), t: buf(new Float32Array(t)), i: buf(new Uint32Array(idx), gl.ELEMENT_ARRAY_BUFFER), n: idx.length }; }
const earth = sphere(RE / U), atmo = sphere(RE * 1.018 / U, 96, 48);
const TX = { day: texture(["tex/day_2k.jpg", "tex/day_4k.jpg"], [20, 40, 70, 255]), night: texture(["tex/night_2k.jpg", "tex/night_4k.jpg"], [0, 0, 0, 255]),
             cloud: texture(["tex/clouds_4k.jpg"], [0, 0, 0, 255]), spec: texture(["tex/spec_2k.jpg"], [0, 0, 0, 255]) };
const quad = buf(new Float32Array([-1,-1, 1,-1, -1,1, 1,1]));

/* ---------- world state ---------- */
const GROUPS = {
  "stations":     ["Space stations", [1.0, 0.82, 0.4],  "Crewed space stations. People live and work on board, about 400 km up."],
  "starlink":     ["Starlink",       [0.62, 0.8, 1.0],  "SpaceX broadband internet. Thousands fly in shells roughly 340–570 km up, often in lines called trains."],
  "oneweb":       ["OneWeb",         [0.35, 0.95, 0.85],"Eutelsat OneWeb broadband internet, about 1,200 km up in near-polar orbits."],
  "gps-ops":      ["GPS",            [0.45, 1.0, 0.5],  "US navigation. The location on your phone starts with signals from satellites like this, about 20,200 km up."],
  "galileo":      ["Galileo",        [0.4, 0.7, 1.0],   "Europe's navigation system, about 23,200 km up."],
  "glo-ops":      ["GLONASS",        [1.0, 0.55, 0.45], "Russia's navigation system, about 19,100 km up."],
  "beidou":       ["BeiDou",         [1.0, 0.45, 0.35], "China's navigation system, in medium, inclined and geostationary orbits."],
  "iridium-NEXT": ["Iridium",        [0.8, 0.6, 1.0],   "Satellite phones and messaging from anywhere on Earth, about 780 km up."],
  "planet":       ["Planet",         [0.6, 1.0, 0.75],  "Small camera satellites that photograph all of Earth's land every day."],
  "weather":      ["Weather",        [0.5, 0.85, 1.0],  "Weather satellites watching clouds, storms and temperatures."],
  "resource":     ["Earth observation", [0.95, 0.75, 0.55], "Earth-observation satellites: imaging land, sea, ice and crops."],
  "geo":          ["Geostationary",  [1.0, 0.7, 0.85],  "One lap per day, so it hovers over one spot. Used for TV, weather and communications, 35,786 km up."],
};
const ALTS = [["Low orbit", 550], ["High orbit", 8000], ["GPS orbit", 20200], ["Geostationary", 35786]];
const sats = [];   // {name, norad, group, rec, pos[km], vel[km/s], t(ms), ok}
let posBuf, colBuf, litBuf, posArr, colArr, litArr;
let sky = null, starBuf, starColBuf, starSzBuf, starN = 0, lineBuf, lineKBuf, lineN = 0, conIds = [], cgrid = null;
const obs = { P: null, V: null, az: 0, el: -0.3, fov: 70 * D2R, altI: 0, tween: null, follow: null, dragT: -1e9, inShadow: null };
let now = new Date(), gmst = 0, sun = [1, 0, 0];
let W = 1, H = 1, dpr = 1, VP = null, VProt = null, fwd = [1, 0, 0], camUp = [0, 0, 1];

/* ---------- load ---------- */
function parseTLE(text) {
  const out = []; let group = "resource"; const L = text.split(/\r?\n/);
  for (let i = 0; i < L.length; i++) {
    const s = L[i]; if (s.startsWith("# GROUP ")) { group = s.slice(8).trim(); continue; }
    if (s.startsWith("1 ") && L[i + 1] && L[i + 1].startsWith("2 ")) {
      const name = (L[i - 1] && !L[i - 1].startsWith("2 ") && !L[i - 1].startsWith("#") ? L[i - 1] : "UNKNOWN").trim();
      out.push({ name, l1: s, l2: L[i + 1], group }); i++; }
  }
  return out;
}
async function getText(u) { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(u + " " + r.status); return r.text(); }
async function load() {
  const [skyJ, satT] = await Promise.all([
    fetch("game/sky.json").then(r => r.json()),
    getText("sats.txt").then(t => (t.match(/^1 /gm) || []).length > 100 ? t : Promise.reject()).catch(() => getText("tle.txt")),
  ]);
  sky = skyJ;
  const seen = new Set();
  for (const t of parseTLE(satT)) {
    const norad = parseInt(t.l1.slice(2, 7), 10); if (seen.has(norad)) continue; seen.add(norad);
    let rec; try { rec = SAT.twoline2satrec(t.l1, t.l2); } catch (e) { continue; }
    if (rec.error) continue;
    sats.push({ name: t.name, norad, group: GROUPS[t.group] ? t.group : "resource", rec, pos: [0, 0, 1e9], vel: [0, 0, 0], t: 0, ok: false });
  }
  buildStars(); buildSatBuffers();
  for (let i = 0; i < sats.length; i++) propagateOne(sats[i], Date.now());
}
function bvColor(bv) { const t = Math.max(-0.4, Math.min(2.0, bv));
  if (t < 0.0) return [0.66, 0.78, 1.0]; if (t < 0.4) return [0.85, 0.9, 1.0]; if (t < 0.8) return [1.0, 0.97, 0.9]; if (t < 1.4) return [1.0, 0.86, 0.66]; return [1.0, 0.72, 0.5]; }
function buildStars() {
  const P = [], C = [], S = [];
  for (const s of sky.stars) { P.push(...radec(s[0], s[1])); const b = Math.pow(10, -0.4 * (s[2] - 1.0)); C.push(...mulv(bvColor(s[3]), Math.min(1.25, 0.35 + b)));
    S.push(Math.max(0.9, 4.6 - 0.62 * s[2])); }
  starN = sky.stars.length; starBuf = buf(new Float32Array(P)); starColBuf = buf(new Float32Array(C)); starSzBuf = buf(new Float32Array(S));
  const LP = [], LK = []; conIds = Object.keys(sky.lines);
  conIds.forEach((id, k) => { for (const seg of sky.lines[id]) for (let i = 0; i + 1 < seg.length; i++) { LP.push(...radec(...seg[i]), ...radec(...seg[i + 1])); LK.push(k, k); } });
  lineN = LP.length / 3; lineBuf = buf(new Float32Array(LP)); lineKBuf = buf(new Float32Array(LK));
  const g = sky.cgrid; cgrid = { ids: g.ids, rows: g.rle.map(r => { const row = new Uint8Array(360); let x = 0; for (let i = 0; i < r.length; i += 2) { row.fill(r[i], x, x + r[i + 1]); x += r[i + 1]; } return row; }) };
}
function conAt(dir) { const ra = (Math.atan2(dir[1], dir[0]) * R2D + 360) % 360, dec = Math.asin(Math.max(-1, Math.min(1, dir[2]))) * R2D;
  const id = cgrid.ids[cgrid.rows[Math.min(179, Math.floor(90 - dec))][Math.floor(ra) % 360]]; return { id, name: sky.cons[id] ? sky.cons[id][0] : id }; }
function buildSatBuffers() { const n = sats.length; posArr = new Float32Array(n * 3); colArr = new Float32Array(n * 3); litArr = new Float32Array(n);
  sats.forEach((s, i) => colArr.set(GROUPS[s.group][1], i * 3));
  posBuf = buf(posArr, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW); colBuf = buf(colArr); litBuf = buf(litArr, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW); }
function propagateOne(s, tms) { const r = SAT.propagate(s.rec, new Date(tms));
  if (!r || !r.position || isNaN(r.position.x)) { s.ok = false; return; }
  s.pos = [r.position.x, r.position.y, r.position.z]; s.vel = [r.velocity.x, r.velocity.y, r.velocity.z]; s.t = tms; s.ok = len(s.pos) > RE + 80; }
const satAt = (s, tms) => add(s.pos, s.vel, (tms - s.t) / 1000);
let propCursor = 0;

/* ---------- observer ---------- */
function startObserver() {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || "");
  const lat = /^Europe/.test(tz) ? 51 : /^America/.test(tz) ? 40 : /^Asia/.test(tz) ? 30 : /^Australia/.test(tz) ? -30 : /^Africa/.test(tz) ? 5 : 35;
  const lon = -new Date().getTimezoneOffset() / 4;
  const r = RE + ALTS[0][1], th = lon * D2R + gmst, f = lat * D2R;
  const up = [Math.cos(f) * Math.cos(th), Math.cos(f) * Math.sin(th), Math.sin(f)];
  const east = norm(cross([0, 0, 1], up)), north = cross(up, east);
  const inc = 53 * D2R, az = Math.cos(inc) >= Math.cos(f) ? Math.PI / 2 : Math.asin(Math.cos(inc) / Math.cos(f));
  obs.P = mulv(up, r); obs.V = mulv(add(mulv(north, Math.cos(az)), east, Math.sin(az)), Math.sqrt(MU / r));
}
function localFrame() { const up = norm(obs.P); let ah = sub(obs.V, mulv(up, dot(obs.V, up))); ah = len(ah) < 1e-6 ? norm(cross([0, 0, 1], up)) : norm(ah); return { up, ah, left: cross(up, ah) }; }
function dirFromAngles(F, az, el) { const h = add(mulv(F.ah, Math.cos(az)), F.left, Math.sin(az)); return norm(add(mulv(h, Math.cos(el)), F.up, Math.sin(el))); }
function anglesFromDir(F, d) { return { az: Math.atan2(dot(d, F.left), dot(d, F.ah)), el: Math.asin(Math.max(-1, Math.min(1, dot(d, F.up)))) }; }
function setOrbit(i) { obs.follow = null; obs.altI = i; const r0 = len(obs.P), r1 = RE + ALTS[i][1];
  obs.tween = { r0, r1, t0: performance.now(), dur: 3500 }; $("#altName").textContent = ALTS[i][0]; toast("Moving to " + ALTS[i][0].toLowerCase() + " · " + ALTS[i][1].toLocaleString() + " km"); }
function circular(r) { const up = norm(obs.P), h = norm(cross(obs.P, obs.V)), dir = norm(cross(h, up)); obs.P = mulv(up, r); obs.V = mulv(dir, Math.sqrt(MU / r)); }
const keys = {};
let thrust = 0;
function stepObserver(dt, tms) {
  if (obs.follow) { const s = sats[obs.follow.i]; if (!s.ok) { obs.follow = null; return; }
    const p = satAt(s, tms), up = norm(p), ah = norm(s.vel), F = { up, ah, left: cross(up, ah) };
    obs.P = add(add(p, ah, -obs.follow.back), up, obs.follow.rise); obs.V = s.vel.slice();
    if (performance.now() - obs.dragT > 2500) { const a = anglesFromDir(localFrame(), norm(sub(p, obs.P))); obs.az += (a.az - obs.az) * Math.min(1, dt * 3); obs.el += (a.el - obs.el) * Math.min(1, dt * 3); }
    obs.follow.secs += dt; if (obs.follow.secs >= 60) goal("ride");
    return; }
  if (obs.tween) { const tw = obs.tween, u = Math.min(1, (performance.now() - tw.t0) / tw.dur), e = u * u * (3 - 2 * u);
    circular(tw.r0 + (tw.r1 - tw.r0) * e);
    const elGoal = tw.r1 > RE + 5000 ? -1.35 : -0.3; obs.el += (elGoal - obs.el) * Math.min(1, dt * 2);
    if (u >= 1) obs.tween = null; }
  const F = localFrame(), d = dirFromAngles(F, obs.az, obs.el);
  const t = thrust || (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
  const steps = Math.max(1, Math.ceil(dt / 0.02)), h = dt / steps;
  for (let k = 0; k < steps; k++) { const r = len(obs.P), g = mulv(obs.P, -MU / (r * r * r));
    const a = add(g, d, t * 0.06); obs.V = add(obs.V, a, h); obs.P = add(obs.P, obs.V, h); }
  const alt = len(obs.P) - RE;
  if (alt < 140) { toast("Too low — the air would slow you down. Back to a safe orbit."); circular(RE + 420); }
  if (alt > 60000) { toast("Too far out. Coming back."); circular(RE + 35786); }
}

/* ---------- input ---------- */
const pts = new Map(); let moved = 0, downAt = 0, pinch0 = null;
canvas.addEventListener("pointerdown", e => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); moved = 0; downAt = performance.now();
  if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), fov: obs.fov }; } });
canvas.addEventListener("pointermove", e => { if (!pts.has(e.pointerId)) return; const p = pts.get(e.pointerId), dx = e.clientX - p[0], dy = e.clientY - p[1];
  pts.set(e.pointerId, [e.clientX, e.clientY]); moved += Math.abs(dx) + Math.abs(dy);
  if (pts.size === 2 && pinch0) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); setFov(pinch0.fov * pinch0.d / Math.max(20, d)); return; }
  const k = obs.fov / Math.max(H / dpr, 1); obs.az += dx * k; obs.el = Math.max(-1.55, Math.min(1.55, obs.el + dy * k)); obs.dragT = performance.now(); });
const up = e => { const was = pts.has(e.pointerId); pts.delete(e.pointerId); if (pts.size < 2) pinch0 = null;
  if (was && moved < 8 && performance.now() - downAt < 700) pick(e.clientX, e.clientY); };
canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", e => { pts.delete(e.pointerId); pinch0 = null; });
canvas.addEventListener("wheel", e => { e.preventDefault(); setFov(obs.fov * Math.exp(e.deltaY * 0.0012)); }, { passive: false });
function setFov(f) { obs.fov = Math.max(2 * D2R, Math.min(95 * D2R, f)); }
addEventListener("keydown", e => { if (e.target.closest && e.target.closest("input,textarea")) return; const k = e.key.toLowerCase(); keys[k] = true;
  if (k === "o") setOrbit((obs.altI + 1) % ALTS.length); if (k === "h") lookAhead(); if (k === "+" || k === "=") setFov(obs.fov / 1.25); if (k === "-") setFov(obs.fov * 1.25);
  if (k === "escape") closeAll(); if ((k === "w" || k === "s") && obs.follow) stopFollow(); });
addEventListener("keyup", e => { keys[e.key.toLowerCase()] = false; });
function hold(id, v) { const b = $(id); const on = e => { e.preventDefault(); if (obs.follow) stopFollow(); thrust = v; b.classList.add("on"); }, offf = () => { thrust = 0; b.classList.remove("on"); };
  b.addEventListener("pointerdown", on); b.addEventListener("pointerup", offf); b.addEventListener("pointerleave", offf); b.addEventListener("pointercancel", offf); }
hold("#bFwd", 1); hold("#bBack", -1);
$("#bAlt").onclick = () => setOrbit((obs.altI + 1) % ALTS.length);
$("#bIn").onclick = () => setFov(obs.fov / 1.4); $("#bOut").onclick = () => setFov(obs.fov * 1.4);
$("#bHome").onclick = lookAhead;
function lookAhead() { obs.az = 0; obs.el = len(obs.P) - RE > 5000 ? -1.35 : -0.3; obs.dragT = performance.now(); }

/* ---------- picking + identification ---------- */
let sel = null;    // {kind:'sat', i} | {kind:'star', i} | {kind:'area', con}
function toScreen(rel) { const c = VP; const x = c[0]*rel[0]+c[4]*rel[1]+c[8]*rel[2]+c[12], y = c[1]*rel[0]+c[5]*rel[1]+c[9]*rel[2]+c[13], w = c[3]*rel[0]+c[7]*rel[1]+c[11]*rel[2]+c[15];
  if (w <= 0) return null; return [(x / w * 0.5 + 0.5) * W / dpr, (0.5 - y / w * 0.5) * H / dpr, w]; }
function hiddenByEarth(relKm) { // ray from observer to target, does it hit the Earth first?
  const P = obs.P, d = norm(relKm), L = len(relKm), b = dot(P, d), c = dot(P, P) - RE * RE, disc = b * b - c;
  if (disc < 0) return false; const t = -b - Math.sqrt(disc); return t > 0 && t < L; }
function pick(cx, cy) {
  const tms = now.getTime(); let best = null, bd = 26;
  for (let i = 0; i < sats.length; i++) { const s = sats[i]; if (!s.ok) continue; const rel = sub(satAt(s, tms), obs.P);
    if (dot(rel, fwd) <= 0) continue; const sp = toScreen(mulv(rel, 1 / U)); if (!sp) continue;
    const d = Math.hypot(sp[0] - cx, sp[1] - cy); if (d < bd && !hiddenByEarth(rel)) { bd = d; best = { kind: "sat", i }; } }
  if (!best) { bd = 20;
    for (let i = 0; i < sky.stars.length; i++) { const s = sky.stars[i]; if (s[2] > 4.8) continue; const dir = radec(s[0], s[1]); if (dot(dir, fwd) <= 0) continue;
      if (hiddenByEarth(mulv(dir, 1e6))) continue;
      const sp = toScreen(mulv(dir, 100)); if (!sp) continue; const d = Math.hypot(sp[0] - cx, sp[1] - cy) + s[2] * 1.5; if (d < bd) { bd = d; best = { kind: "star", i }; } } }
  if (!best) { const dir = unproject(cx, cy); if (hiddenByEarth(mulv(dir, 1e6))) { showEarthAt(dir); return; } best = { kind: "area", con: conAt(dir) }; }
  select(best);
}
function unproject(cx, cy) { const x = (cx / (W / dpr)) * 2 - 1, y = 1 - (cy / (H / dpr)) * 2, t = Math.tan(obs.fov / 2), asp = W / H;
  const right = norm(cross(fwd, camUp)); return norm(add(add(fwd, right, x * t * asp), camUp, y * t)); }
function showEarthAt(dir) { const P = obs.P, b = dot(P, dir), c = dot(P, P) - RE * RE, t = -b - Math.sqrt(b * b - c), hit = add(P, dir, t);
  const ecef = rotZ(hit, -gmst), lat = Math.asin(ecef[2] / RE) * R2D, lon = Math.atan2(ecef[1], ecef[0]) * R2D, lit = dot(norm(hit), sun) > 0;
  sel = null; openInfo(`<div class="eye">Earth below you</div><h3>${fmtLat(lat)}, ${fmtLon(lon)}</h3><p>${lit ? "In daylight right now." : "Night-time right now. The lights are cities."}</p><p class="fine">Tap a dot to identify a satellite, or the sky to name a constellation.</p>`); }
const rotZ = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]]; };
const fmtLat = v => Math.abs(v).toFixed(1) + "°" + (v >= 0 ? "N" : "S"), fmtLon = v => Math.abs(v).toFixed(1) + "°" + (v >= 0 ? "E" : "W");
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function colourWord(bv) { return bv < 0 ? "blue-white, a very hot star" : bv < 0.4 ? "white" : bv < 0.8 ? "yellow-white, like our Sun" : bv < 1.4 ? "orange, a cooler star" : "red-orange, a cool giant"; }
function select(s) {
  sel = s; const tms = now.getTime();
  if (s.kind === "sat") { const t = sats[s.i], p = satAt(t, tms), alt = len(p) - RE, sp = len(t.vel), dist = len(sub(p, obs.P)), per = 2 * Math.PI / t.rec.no, g = GROUPS[t.group];
    const dark = inShadow(p, sun), ecef = rotZ(p, -gmst), lat = Math.asin(ecef[2] / len(p)) * R2D, lon = Math.atan2(ecef[1], ecef[0]) * R2D;
    openInfo(`<div class="eye">${esc(g[0])} · NORAD ${t.norad}</div><h3>${esc(t.name)}</h3><p>${esc(g[2])}</p>
      <div class="kv"><span>Height</span><b>${Math.round(alt).toLocaleString()} km</b><span>Speed</span><b>${sp.toFixed(2)} km/s (${Math.round(sp * 3600).toLocaleString()} km/h)</b>
      <span>One lap</span><b>${per > 600 ? (per / 60).toFixed(1) + " hours" : Math.round(per) + " minutes"}</b><span>Tilt</span><b>${(t.rec.inclo * R2D).toFixed(1)}°</b>
      <span>Over</span><b>${fmtLat(lat)}, ${fmtLon(lon)}</b><span>From you</span><b>${Math.round(dist).toLocaleString()} km</b>
      <span>Light</span><b>${dark ? "In Earth's shadow" : "Lit by the Sun"}</b></div>
      <div class="row"><button class="act" id="bRide">Ride along</button></div>
      <p class="fine">Position calculated from public orbit data (CelesTrak) with SGP4. Accurate to a few km.</p>`);
    $("#bRide").onclick = () => startFollow(s.i); buildOrbit(t);
    log({ kind: "sat", id: t.norad, name: t.name, group: g[0], alt_km: Math.round(alt), dist_km: Math.round(dist), shadow: dark ? 1 : 0 });
    if (t.group === "stations" && /ISS|ZARYA/i.test(t.name)) goal("iss"); if (t.group === "starlink") goal("starlink");
    if (["gps-ops", "galileo", "glo-ops", "beidou"].includes(t.group)) goal("nav"); if (per > 1380 && per < 1500 && t.rec.inclo * R2D < 15) goal("geo");
    if (dark) goal("shadow"); }
  else if (s.kind === "star") { const st = sky.stars[s.i], dir = radec(st[0], st[1]), c = conAt(dir), nm = st[4] || "An unnamed star";
    orbit = null; hiCon = conIds.indexOf(c.id);
    openInfo(`<div class="eye">Star · in ${esc(c.name)}</div><h3>${esc(nm)}</h3>
      <div class="kv"><span>Brightness</span><b>magnitude ${st[2].toFixed(2)}${st[2] < 1 ? " (one of the brightest)" : ""}</b><span>Colour</span><b>${colourWord(st[3])}</b>
      <span>Constellation</span><b>${esc(c.name)}</b><span>Sky position</span><b>RA ${(st[0] / 15).toFixed(2)} h, Dec ${st[1].toFixed(1)}°</b></div>
      <p class="fine">Stars are so far away that moving around Earth doesn't change where they appear. Satellites, close by, slide across them.</p>`);
    log({ kind: "star", id: st[4] || ("RA" + Math.round(st[0] * 100) + "D" + Math.round(st[1] * 100)), name: nm, group: c.name, mag_x100: Math.round(st[2] * 100) });
    if (st[4] === "Polaris") goal("polaris"); if (c.id === "Ori") goal("orion"); }
  else { orbit = null; hiCon = conIds.indexOf(s.con.id);
    openInfo(`<div class="eye">Constellation</div><h3>${esc(s.con.name)}</h3><p>You're looking toward ${esc(s.con.name)}. Its figure is now lit up in gold. Tap a bright star in it to name the star.</p>`);
    log({ kind: "sky", id: s.con.id, name: s.con.name, group: "constellation" }); if (s.con.id === "Ori") goal("orion"); }
}
function startFollow(i) { const s = sats[i]; obs.tween = null; obs.follow = { i, back: 2.2, rise: 0.6, secs: 0 }; obs.dragT = -1e9;
  toast("Riding along with " + s.name + ". Drift to break away."); closeSheet("info"); }
function stopFollow() { if (!obs.follow) return; const s = sats[obs.follow.i]; obs.follow = null; toast("Left " + s.name + ". You're in your own orbit now."); }

/* ---------- selected orbit line ---------- */
let orbit = null, hiCon = -1;
function buildOrbit(s) { const per = 2 * Math.PI / s.rec.no * 60000, n = 240, P = [], F = [], t0 = now.getTime();
  for (let k = 0; k <= n; k++) { const r = SAT.propagate(s.rec, new Date(t0 + per * k / n)); if (!r.position) continue; P.push(r.position.x / U, r.position.y / U, r.position.z / U); F.push(1 - k / n); }
  orbit = { b: buf(new Float32Array(P)), f: buf(new Float32Array(F)), n: P.length / 3, col: GROUPS[s.group][1], at: t0 }; }

/* ---------- logbook + EDEN seal ---------- */
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
function canon(v) { if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  if (typeof v === "number" && !Number.isInteger(v)) throw new Error("floats are forbidden"); return JSON.stringify(v); }
async function sha(...ps) { const n = ps.reduce((a, p) => a + p.length, 0), b = new Uint8Array(n); let o = 0; for (const p of ps) { b.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b)); }
const leafHash = e => sha(new Uint8Array([0]), enc.encode(canon(e)));
async function mth(L) { if (L.length === 1) return L[0]; let k = 1; while (k * 2 < L.length) k *= 2; return sha(new Uint8Array([1]), await mth(L.slice(0, k)), await mth(L.slice(k))); }
const book = { log: "eden/observatory/" + hex(crypto.getRandomValues(new Uint8Array(6))), entries: [], leaves: [], seal: null, key: null, pub: null, lastId: {}, cheat: -1, ready: Promise.resolve() };
function obsWhere() { const e = rotZ(obs.P, -gmst), r = len(obs.P); return [Math.round(Math.asin(e[2] / r) * R2D * 1000), Math.round(Math.atan2(e[1], e[0]) * R2D * 1000), Math.round(r - RE)]; }
async function log(x) {
  if (!crypto.subtle) return;
  const key = x.kind + ":" + x.id, t = Date.now(); if (book.lastId[key] && t - book.lastId[key] < 30000) return; book.lastId[key] = t;
  if (book.seal) { book.seal = null; book.cheat = -1; status("New sighting added. Seal again to cover it."); }
  const e = Object.assign({ v: 1, log: book.log, i: book.entries.length, t_ms: t, at: obsWhere() }, x);
  book.entries.push(e); const i = e.i; renderLog();
  book.ready = book.ready.then(async () => { book.leaves[i] = await leafHash(e); }); await book.ready;
}
function describe(e) { return e.kind === "sat" ? `${e.name} <span class="fine">(${e.group}, ${e.dist_km.toLocaleString()} km away)</span>` : e.kind === "star" ? `★ ${e.name} <span class="fine">(${e.group})</span>` :
  e.kind === "sky" ? `${e.name} <span class="fine">(constellation)</span>` : e.kind === "event" ? `${e.name}` : e.kind === "goal" ? `✓ ${e.name}` : e.name; }
function renderLog() { $("#lN").textContent = book.entries.length;
  $("#logBody").innerHTML = book.entries.map((e, i) => `<tr class="${i === book.cheat ? "bad" : ""}"><td>${e.i}</td><td>${describe(e)}</td><td>${new Date(e.t_ms).toISOString().slice(11, 19)}</td></tr>`).join("");
  const has = book.entries.length > 0; $("#bSeal").disabled = !has; $("#bCheck").disabled = $("#bCheat").disabled = $("#bSave").disabled = !book.seal; }
function status(h, c = "") { const s = $("#logStatus"); s.className = "status " + c; s.innerHTML = h; }
const DOMAIN = "EDEN-EVIDENCE-SEAL-v1\0";
async function keyPair() { if (book.key !== null) return book.key;
  try { book.key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]); book.pub = hex(await crypto.subtle.exportKey("raw", book.key.publicKey)); } catch (e) { book.key = false; } return book.key; }
$("#bSeal").onclick = async () => {
  if (!crypto.subtle) { status("Sealing needs a secure (https) connection. Open this page over https to seal your logbook.", "bad"); return; }
  await book.ready; const root = hex(await mth(book.leaves)), s = { v: 1, type: "seal", log: book.log, n: book.entries.length, root, sealed_at: new Date().toISOString().slice(0, 19) + "Z" };
  const k = await keyPair(); let sig = null; if (k) sig = hex(await crypto.subtle.sign({ name: "Ed25519" }, k.privateKey, enc.encode(DOMAIN + canon(s))));
  book.seal = { seal: s, sig, pub: book.pub }; book.cheat = -1; renderLog();
  status(`<b>Sealed.</b> ${s.n} sightings → one fingerprint <code>${root.slice(0, 16)}…</code>${sig ? `<br>Signed with a key made on your device just now (Ed25519, public key <code>${book.pub.slice(0, 12)}…</code>).` : `<br>Your browser can't make Ed25519 signatures, so this seal is the fingerprint only. Edits are still caught.`}`, "ok");
  goal("seal");
};
async function verify(entries) { const leaves = []; for (const e of entries) leaves.push(await leafHash(e)); const root = hex(await mth(leaves));
  const s = book.seal.seal; let sigOk = null;
  if (book.seal.sig) { const pk = await crypto.subtle.importKey("raw", Uint8Array.from(book.seal.pub.match(/../g), h => parseInt(h, 16)), { name: "Ed25519" }, false, ["verify"]);
    sigOk = await crypto.subtle.verify({ name: "Ed25519" }, pk, Uint8Array.from(book.seal.sig.match(/../g), h => parseInt(h, 16)), enc.encode(DOMAIN + canon(s))); }
  return { root, rootOk: root === s.root && entries.length === s.n, sigOk }; }
$("#bCheck").onclick = async () => { book.cheat = -1; renderLog(); const r = await verify(book.entries);
  status(r.rootOk && r.sigOk !== false ? `<b>PASS.</b> Rebuilt the fingerprint from all ${book.entries.length} sightings: it matches the seal.${r.sigOk ? " The signature checks out too." : ""} Nothing was added, removed or changed.` :
    `<b>FAIL.</b> The logbook no longer matches its seal.`, r.rootOk ? "ok" : "bad"); };
$("#bCheat").onclick = async () => {
  const i = book.entries.findIndex(e => e.kind === "sat") >= 0 ? book.entries.findIndex(e => e.kind === "sat") : 0;
  const forged = book.entries.map(e => Object.assign({}, e)); const f = forged[i];
  let what; if (f.kind === "sat") { f.dist_km = 1; what = `claimed you got within <b>1 km</b> of ${esc(f.name)}`; } else { f.name = "Betelgeuse"; what = `renamed sighting ${i} to <b>Betelgeuse</b>`; }
  book.cheat = i; renderLog(); const r = await verify(forged);
  status(`<b>Caught.</b> We ${what}. The rebuilt fingerprint <code>${r.root.slice(0, 16)}…</code> doesn't match the sealed <code>${book.seal.seal.root.slice(0, 16)}…</code>, so anyone checking sees it was changed. The original is untouched.`, "bad"); };
$("#bSave").onclick = () => { const pack = { what: "EDEN Observatory logbook (EDEN Evidence: RFC 6962 Merkle tree over canonical JSON, Ed25519 seal, domain EDEN-EVIDENCE-SEAL-v1)", entries: book.entries, seal: book.seal };
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 1)], { type: "application/json" })); a.download = book.log.replace(/\//g, "-") + ".json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };

/* ---------- spotter's list ---------- */
const GOALS = [["iss", "Find the International Space Station", "Tip: open the list of things to ride with, or look for the gold ISS tag."],
  ["starlink", "Spot a Starlink satellite", "They're everywhere in low orbit, often in lines."],
  ["nav", "Find a navigation satellite", "GPS, Galileo, GLONASS or BeiDou. Try the GPS orbit."],
  ["geo", "See a geostationary satellite", "From high up, look for the ring above the equator."],
  ["shadow", "Spot a satellite in Earth's shadow", "Dim, reddish dots on the night side."],
  ["polaris", "Find Polaris, the North Star", "Look 'up' toward Earth's north pole, in Ursa Minor."],
  ["orion", "Find Orion", "Three stars in a row: the belt."],
  ["ride", "Ride along with a satellite for a minute", "Tap any satellite, then Ride along."],
  ["seal", "Seal your logbook", "Then try to cheat it."]];
const done = new Set();
function renderGoals() { $("#goalList").innerHTML = GOALS.map(([k, t, h]) => `<li class="${done.has(k) ? "done" : ""}"><i>${done.has(k) ? "✓" : ""}</i><div>${t}<small>${h}</small></div></li>`).join("");
  $("#gN").textContent = done.size + "/" + GOALS.length; }
function goal(k) { if (done.has(k)) return; done.add(k); const g = GOALS.find(x => x[0] === k); renderGoals(); toast("✓ " + g[1]);
  if (k !== "seal") log({ kind: "goal", id: k, name: g[1] }); if (done.size === GOALS.length) setTimeout(() => toast("Every target found. Seal it and you've got proof."), 2500); }
GOALS[0][2] = "Look for the gold ISS tag. Tap it, then Ride along.";

/* ---------- UI sheets ---------- */
function openInfo(html) { $("#infoBody").innerHTML = html; openSheet("info"); }
function openSheet(id) { for (const s of ["info", "goals", "log", "about"]) if (s !== id) closeSheet(s); $("#" + id).classList.add("open"); const c = { goals: "#cGoals", log: "#cLog", about: "#cAbout" }[id]; if (c) $(c).setAttribute("aria-pressed", "true"); }
function closeSheet(id) { $("#" + id).classList.remove("open"); const c = { goals: "#cGoals", log: "#cLog", about: "#cAbout" }[id]; if (c) $(c).setAttribute("aria-pressed", "false"); if (id === "info") { sel = null; orbit = null; hiCon = -1; } }
function closeAll() { for (const s of ["info", "goals", "log", "about"]) closeSheet(s); }
document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => closeSheet(b.dataset.close));
const tog = (id) => () => $("#" + id).classList.contains("open") ? closeSheet(id) : openSheet(id);
$("#cGoals").onclick = tog("goals"); $("#cLog").onclick = tog("log"); $("#cAbout").onclick = tog("about");
let toastT = 0; function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3200); }

/* ---------- labels ---------- */
const labWrap = $("#labels"); const labPool = [];
function labels(tms) {
  let n = 0; const put = (x, y, txt, cls) => { let el = labPool[n]; if (!el) { el = document.createElement("div"); labWrap.appendChild(el); labPool.push(el); }
    el.className = cls; el.textContent = txt; el.style.transform = cls.startsWith("ring") || cls.startsWith("arrow") ? `translate(${x}px,${y}px)` : `translate(${x + 10}px,${y}px) translateY(-50%)`; el.style.display = ""; n++; return el; };
  const vw = W / dpr, vh = H / dpr, onScr = sp => sp && sp[0] > -20 && sp[0] < vw + 20 && sp[1] > -20 && sp[1] < vh + 20;
  // the ISS, always tagged
  for (const i of issIdx) { const s = sats[i]; if (!s.ok) continue; const rel = sub(satAt(s, tms), obs.P); if (dot(rel, fwd) <= 0 || hiddenByEarth(rel)) continue;
    const sp = toScreen(mulv(rel, 1 / U)); if (onScr(sp)) put(sp[0], sp[1], s.name.includes("ISS") ? "ISS" : s.name.split(" ")[0], "lab iss"); }
  // bright named stars when zoomed in
  if (obs.fov < 40 * D2R) for (const s of sky.stars) { if (!s[4] || s[2] > 2.2) continue; const dir = radec(s[0], s[1]); if (dot(dir, fwd) < 0.2 || hiddenByEarth(mulv(dir, 1e6))) continue;
    const sp = toScreen(mulv(dir, 100)); if (onScr(sp)) put(sp[0], sp[1], s[4], "lab star"); }
  // selection ring (or an edge arrow pointing to it)
  let sp = null, txt = "";
  if (sel && sel.kind === "sat") { const s = sats[sel.i]; const rel = sub(satAt(s, tms), obs.P); txt = s.name + " · " + Math.round(len(rel)).toLocaleString() + " km"; sp = dot(rel, fwd) > 0 ? toScreen(mulv(rel, 1 / U)) : null;
    if (!onScr(sp)) { const r = norm(cross(fwd, camUp)), x = dot(rel, r), y = dot(rel, camUp), a = Math.atan2(-y, x), cx = vw / 2 + Math.cos(a) * (Math.min(vw, vh) / 2 - 40), cy = vh / 2 + Math.sin(a) * (Math.min(vw, vh) / 2 - 40);
      const el = put(cx, cy, "", "arrow"); el.style.transform = `translate(${cx}px,${cy}px) rotate(${a}rad)`; put(cx, cy + 18, txt, "lab"); sp = null; } }
  else if (sel && sel.kind === "star") { const s = sky.stars[sel.i], dir = radec(s[0], s[1]); txt = s[4] || ""; sp = dot(dir, fwd) > 0 ? toScreen(mulv(dir, 100)) : null; }
  if (onScr(sp)) { put(sp[0], sp[1], "", "ring"); if (txt) put(sp[0] + 14, sp[1], txt, "lab"); }
  for (let k = n; k < labPool.length; k++) labPool[k].style.display = "none";
}
let issIdx = [];

/* ---------- render ---------- */
function resize() { dpr = Math.min(2, devicePixelRatio || 1); W = Math.max(2, Math.round(innerWidth * dpr)); H = Math.max(2, Math.round(innerHeight * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; } }
addEventListener("resize", resize);
function draw(tms) {
  resize(); gl.viewport(0, 0, W, H); gl.clearColor(0.004, 0.008, 0.016, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const F = localFrame(); fwd = dirFromAngles(F, obs.az, obs.el); camUp = norm(sub(F.up, mulv(fwd, dot(F.up, fwd)))); if (len(camUp) < 1e-3) camUp = F.ah;
  const alt = len(obs.P) - RE, near = 0.0004, proj = M.persp(obs.fov, W / H, near, 200);
  VP = M.mul(proj, M.view(fwd, camUp)); VProt = VP;
  const pxK = dpr * Math.min(2.2, Math.max(0.8, Math.sqrt(70 * D2R / obs.fov)));
  // stars
  gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  gl.useProgram(PS.p); gl.uniformMatrix4fv(PS.u.uVP, false, VProt); gl.uniform1f(PS.u.uPx, pxK);
  attr(PS, "aP", starBuf, 3); attr(PS, "aC", starColBuf, 3); attr(PS, "aS", starSzBuf, 1); gl.drawArrays(gl.POINTS, 0, starN); off(PS);
  // constellation figures
  gl.useProgram(PL.p); gl.uniformMatrix4fv(PL.u.uVP, false, VProt); gl.uniform1f(PL.u.uHi, hiCon >= 0 ? hiCon : lookCon); gl.uniform1f(PL.u.uBase, 0.14); gl.uniform1f(PL.u.uHiA, hiCon >= 0 ? 0.8 : 0.4);
  attr(PL, "aP", lineBuf, 3); attr(PL, "aK", lineKBuf, 1); gl.drawArrays(gl.LINES, 0, lineN); off(PL);
  // the Sun
  gl.useProgram(PSun.p); gl.uniformMatrix4fv(PSun.u.uVP, false, VProt); gl.uniform3fv(PSun.u.uSun, sun); gl.uniform1f(PSun.u.uSz, 0.55 * Math.min(1.6, 70 * D2R / obs.fov) ** 0.5); gl.uniform1f(PSun.u.uAsp, W / H);
  attr(PSun, "aQ", quad, 2); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); off(PSun);
  // Earth (Earth-fixed mesh rotated by sidereal time, camera-relative)
  gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
  const Mw = M.mul(M.T(-obs.P[0] / U, -obs.P[1] / U, -obs.P[2] / U), M.RZ(gmst));
  gl.useProgram(PE.p); gl.uniformMatrix4fv(PE.u.uVP, false, VP); gl.uniformMatrix4fv(PE.u.uM, false, Mw); gl.uniform3fv(PE.u.uSun, sun); gl.uniform1f(PE.u.uCloudOff, (tms / 3.6e6 * 0.0008) % 1);
  [["uDay", TX.day], ["uNight", TX.night], ["uCloud", TX.cloud], ["uSpec", TX.spec]].forEach(([u, t], k) => { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(PE.u[u], k); });
  attr(PE, "aP", earth.p, 3); attr(PE, "aT", earth.t, 2); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, earth.i); gl.drawElements(gl.TRIANGLES, earth.n, gl.UNSIGNED_INT, 0); off(PE);
  // atmosphere shell
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
  gl.useProgram(PA.p); gl.uniformMatrix4fv(PA.u.uVP, false, VP); gl.uniformMatrix4fv(PA.u.uM, false, Mw); gl.uniform3fv(PA.u.uSun, sun);
  attr(PA, "aP", atmo.p, 3); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, atmo.i); gl.drawElements(gl.TRIANGLES, atmo.n, gl.UNSIGNED_INT, 0); off(PA);
  gl.disable(gl.CULL_FACE);
  // selected satellite's orbit
  if (orbit) { gl.useProgram(PO.p); gl.uniformMatrix4fv(PO.u.uVP, false, VP); gl.uniform3fv(PO.u.uCam, mulv(obs.P, 1 / U)); gl.uniform3fv(PO.u.uCol, orbit.col);
    attr(PO, "aP", orbit.b, 3); attr(PO, "aF", orbit.f, 1); gl.drawArrays(gl.LINE_STRIP, 0, orbit.n); off(PO); }
  // satellites (camera-relative positions, extrapolated between SGP4 updates)
  const n = sats.length;
  for (let i = 0; i < n; i++) { const s = sats[i]; if (!s.ok) { posArr[i*3] = 0; posArr[i*3+1] = 0; posArr[i*3+2] = -1e6; continue; }
    const dt = (tms - s.t) / 1000, x = s.pos[0] + s.vel[0] * dt, y = s.pos[1] + s.vel[1] * dt, z = s.pos[2] + s.vel[2] * dt;
    posArr[i*3] = (x - obs.P[0]) / U; posArr[i*3+1] = (y - obs.P[1]) / U; posArr[i*3+2] = (z - obs.P[2]) / U;
    const a = x * sun[0] + y * sun[1] + z * sun[2]; let lit = 1; if (a < 0) { const px = x - a * sun[0], py = y - a * sun[1], pz = z - a * sun[2]; if (px*px + py*py + pz*pz < RE * RE) lit = 0; } litArr[i] = lit; }
  gl.useProgram(PSat.p); gl.uniformMatrix4fv(PSat.u.uVP, false, VP); gl.uniform1f(PSat.u.uPx, dpr); gl.uniform1f(PSat.u.uFocal, (H / dpr) / (2 * Math.tan(obs.fov / 2)) / 1000);
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, posArr, gl.DYNAMIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, litBuf); gl.bufferData(gl.ARRAY_BUFFER, litArr, gl.DYNAMIC_DRAW);
  attr(PSat, "aP", posBuf, 3); attr(PSat, "aC", colBuf, 3); attr(PSat, "aL", litBuf, 1); gl.drawArrays(gl.POINTS, 0, n); off(PSat);
  gl.depthMask(true);
}

/* ---------- HUD ---------- */
let lookCon = -1, hudT = 0;
function hud(tms) {
  const c = conAt(fwd); lookCon = conIds.indexOf(c.id);
  if (tms - hudT < 250) return; hudT = tms;
  const e = rotZ(obs.P, -gmst), r = len(obs.P), lat = Math.asin(e[2] / r) * R2D, lon = Math.atan2(e[1], e[0]) * R2D, alt = r - RE;
  let near = 0, nearest = null, nd = 1e9; const tt = now.getTime();
  for (const s of sats) { if (!s.ok) continue; const d = len(sub(satAt(s, tt), obs.P)); if (d < 1000) near++; if (d < nd && d > 0.05) { nd = d; nearest = s; } }
  const shell = nearest && nd < 400 ? GROUPS[nearest.group][0] : null;
  $("#hud").innerHTML = `<b>${now.toISOString().slice(11, 19)} UTC</b> · over <b>${fmtLat(lat)} ${fmtLon(lon)}</b> · <b>${Math.round(alt).toLocaleString()} km</b> up · ${len(obs.V).toFixed(2)} km/s<br>
    Looking toward <span class="gold">${esc(c.name)}</span> · zoom ${(70 * D2R / obs.fov).toFixed(1)}×${obs.follow ? ` · riding with <span class="gold">${esc(sats[obs.follow.i].name)}</span>` : ""}<br>
    ${near} satellite${near === 1 ? "" : "s"} within 1,000 km${nearest ? ` · nearest <b>${esc(nearest.name)}</b> ${Math.round(nd).toLocaleString()} km${shell ? ` (you're in the ${esc(shell)} neighbourhood)` : ""}` : ""}`;
  const sh = inShadow(obs.P, sun);
  if (obs.inShadow !== null && sh !== obs.inShadow) { const nm = sh ? "Orbital sunset" : "Orbital sunrise"; toast(nm + ". " + (sh ? "You've passed into Earth's shadow." : "The Sun just came up over Earth's edge."));
    log({ kind: "event", id: nm.toLowerCase().replace(" ", "-") + "-" + Math.round(tms / 60000), name: nm }); }
  obs.inShadow = sh;
}

/* ---------- loop ---------- */
let last = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - last) / 1000); last = t; now = new Date(); const tms = now.getTime();
  gmst = SAT.gstime(now); sun = sunDir(now);
  const budget = Math.min(sats.length, Math.max(120, Math.ceil(sats.length / 30)));   // every satellite re-solved ~2×/s; straight-line in between (≈1 m error) for (let k = 0; k < budget; k++) { propagateOne(sats[propCursor], tms); propCursor = (propCursor + 1) % sats.length; }
  stepObserver(dt, tms);
  if (orbit && tms - orbit.at > 60000 && sel && sel.kind === "sat") buildOrbit(sats[sel.i]);
  draw(tms); hud(tms); labels(tms);
  requestAnimationFrame(frame);
}
(async () => {
  try { await load(); } catch (e) { $("#loadMsg").textContent = "Couldn't load the sky data. Please refresh."; console.error(e); return; }
  now = new Date(); gmst = SAT.gstime(now); sun = sunDir(now);
  issIdx = sats.map((s, i) => [s, i]).filter(([s]) => s.group === "stations" && /ISS \(ZARYA\)|CSS \(TIANHE\)|TIANGONG/i.test(s.name)).map(([, i]) => i);
  startObserver(); renderGoals(); renderLog();
  $("#loadMsg").textContent = sats.length.toLocaleString() + " satellites ready."; setTimeout(() => $("#loading").classList.add("gone"), 300);
  setTimeout(() => toast(`You're in orbit, ${ALTS[0][1]} km up, with ${sats.length.toLocaleString()} real satellites. Tap anything to identify it.`), 900);
  window.__eden = { sats, obs, book, done, select, setOrbit, startFollow, sky, conAt, fwd: () => fwd };
  requestAnimationFrame(frame);
})();
