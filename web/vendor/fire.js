/* ============================================================
   FERNO.fun — interactive pixel fire
   GPU fluid solver (advection + buoyancy + vorticity + pressure
   projection) rendered to a low-res target and blitted with
   nearest-neighbour sampling for a hard pixel-art look.
   Mouse movement injects heat and stirs the flow.
   ============================================================ */

(function () {
  "use strict";

  const canvas = document.getElementById("fire");
  if (!canvas) return;

  // The simulation grid is deliberately decoupled from the screen aspect:
  // its HEIGHT is fixed, so a flame always covers the same fraction of the
  // viewport no matter how tall or wide the window is. The width follows the
  // aspect ratio, and the whole grid is upscaled with nearest-neighbour
  // sampling, which is what gives the pixel-art look.
  const SIM_H = 260;        // fixed vertical resolution of the sim
  const SIM_W_MIN = 90;
  const SIM_W_MAX = 900;
  const DENSITY_DISSIPATION = 0.85;
  const VELOCITY_DISSIPATION = 0.25;
  const CURL = 30;
  const SPLAT_RADIUS = 0.0042;
  const EXPOSURE = 0.32;

  // FLAME_SCALE controls how tall the flames climb. Tuned empirically with
  // tools/scale-sweep.mjs so the fire occupies roughly the bottom quarter to
  // third of the viewport at every aspect ratio. Override with ?scale=N.
  const FLAME_SCALE = Number(new URLSearchParams(location.search).get("scale")) || 0.09;
  const BUOYANCY = 60 * FLAME_SCALE;
  const RISE = 90 * FLAME_SCALE;

  const DEBUG = new URLSearchParams(location.search).has("debug");
  const DEBUG_VIEW = new URLSearchParams(location.search).get("view") === "dye";
  // keep the drawing buffer around so it can be read back / captured
  const PRESERVE = DEBUG || new URLSearchParams(location.search).has("pdb");

  const gl = canvas.getContext("webgl2", {
    alpha: false,
    depth: false,
    stencil: false,
    antialias: false,
    preserveDrawingBuffer: PRESERVE,
    powerPreference: "high-performance"
  });

  if (!gl) {
    fallbackFire();
    return;
  }

  const extColorFloat = gl.getExtension("EXT_color_buffer_float");
  if (!extColorFloat) {
    fallbackFire();
    return;
  }

  /* ── shader plumbing ──────────────────────────────────────────── */

  const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
uniform vec2 uTexelSize;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(uTexelSize.x, 0.0);
  vR = vUv + vec2(uTexelSize.x, 0.0);
  vT = vUv + vec2(0.0, uTexelSize.y);
  vB = vUv - vec2(0.0, uTexelSize.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const FRAG_COPY = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 fragColor;
void main() { fragColor = texture(uTexture, vUv); }`;

  const FRAG_CLEAR = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uValue;
out vec4 fragColor;
void main() { fragColor = uValue * texture(uTexture, vUv); }`;

  const FRAG_SPLAT = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uTarget;
uniform float uAspectRatio;
uniform vec3 uColor;
uniform vec2 uPoint;
uniform float uRadius;
out vec4 fragColor;
void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspectRatio;
  vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
  vec3 base = texture(uTarget, vUv).xyz;
  fragColor = vec4(base + splat, 1.0);
}`;

  const FRAG_ADVECT = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexelSize;
uniform float uDt;
uniform float uDissipation;
out vec4 fragColor;
void main() {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexelSize;
  vec4 result = texture(uSource, coord);
  float decay = 1.0 + uDissipation * uDt;
  fragColor = result / decay;
}`;

  const FRAG_DIVERGENCE = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
uniform sampler2D uVelocity;
out vec4 fragColor;
void main() {
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y;
  if (vB.y < 0.0) B = -C.y;
  float div = 0.5 * (R - L + T - B);
  fragColor = vec4(div, 0.0, 0.0, 1.0);
}`;

  const FRAG_CURL = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
uniform sampler2D uVelocity;
out vec4 fragColor;
void main() {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  float vorticity = R - L - T + B;
  fragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}`;

  const FRAG_VORTICITY = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uCurlStrength;
uniform float uDt;
out vec4 fragColor;
void main() {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= uCurlStrength * C;
  force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  vel = clamp(vel, -1200.0, 1200.0);
  fragColor = vec4(vel, 0.0, 1.0);
}`;

  const FRAG_PRESSURE = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
out vec4 fragColor;
void main() {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float divergence = texture(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  fragColor = vec4(pressure, 0.0, 0.0, 1.0);
}`;

  const FRAG_GRADIENT = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
out vec4 fragColor;
void main() {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 vel = texture(uVelocity, vUv).xy;
  vel -= vec2(R - L, T - B);
  fragColor = vec4(vel, 0.0, 1.0);
}`;

  const FRAG_BUOYANCY = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uDye;
uniform float uDt;
uniform float uBuoyancy;
out vec4 fragColor;
void main() {
  float density = texture(uDye, vUv).x;
  vec2 vel = texture(uVelocity, vUv).xy;
  // positive vUv.y is up the screen, so buoyancy must ADD to vel.y
  vel.y += density * uBuoyancy * uDt;
  fragColor = vec4(vel, 0.0, 1.0);
}`;

  /* display pass: inferno ramp with a blue cold edge, quantised for pixels */
  const FRAG_DISPLAY = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uDye;
uniform float uTime;
uniform float uExposure;
uniform float uDebug;
out vec4 fragColor;

vec3 ramp(float t) {
  // blue -> violet -> ember -> gold -> white
  vec3 c0 = vec3(0.016, 0.047, 0.129);
  vec3 c1 = vec3(0.078, 0.314, 0.722);
  vec3 c2 = vec3(0.545, 0.145, 0.392);
  vec3 c3 = vec3(0.949, 0.325, 0.039);
  vec3 c4 = vec3(1.000, 0.608, 0.184);
  vec3 c5 = vec3(1.000, 0.820, 0.400);
  vec3 c6 = vec3(1.000, 0.980, 0.870);

  vec3 col = c0;
  col = mix(col, c1, smoothstep(0.00, 0.14, t));
  col = mix(col, c2, smoothstep(0.12, 0.30, t));
  col = mix(col, c3, smoothstep(0.28, 0.52, t));
  col = mix(col, c4, smoothstep(0.50, 0.72, t));
  col = mix(col, c5, smoothstep(0.70, 0.88, t));
  col = mix(col, c6, smoothstep(0.86, 1.00, t));
  return col;
}

void main() {
  vec4 raw = texture(uDye, vUv);

  if (uDebug > 0.5) {
    // raw dye channels, no palette
    fragColor = vec4(abs(raw.r), abs(raw.g), abs(raw.b), 1.0);
    return;
  }

  float d = raw.x * uExposure;
  d = clamp(d, 0.0, 1.0);

  // posterise into pixel-art bands
  float bands = 7.0;
  float dq = floor(d * bands + 0.5) / bands;

  vec3 col = ramp(dq);
  float alpha = smoothstep(0.015, 0.16, d);

  // cool blue halo bleeding into the low-density edge
  float cool = smoothstep(0.02, 0.20, d) * (1.0 - smoothstep(0.20, 0.46, d));
  col = mix(col, vec3(0.10, 0.42, 0.95), cool * 0.55);

  // subtle vertical shimmer so the fire never looks frozen
  float shimmer = 0.97 + 0.03 * sin(vUv.y * 90.0 - uTime * 6.0);
  col *= shimmer;

  // the void behind the fire: navy at the top, warm ember haze at the base
  vec3 base = mix(vec3(0.035, 0.055, 0.110), vec3(0.012, 0.020, 0.047), smoothstep(0.0, 0.75, vUv.y));
  float topGlow = smoothstep(0.55, 1.0, vUv.y);
  base = mix(base, vec3(0.055, 0.170, 0.420), topGlow * 0.55);
  float floorGlow = smoothstep(0.34, 0.0, vUv.y);
  base = mix(base, vec3(0.420, 0.140, 0.030), floorGlow * 0.42);

  fragColor = vec4(mix(base, col, alpha), 1.0);
}`;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error("fire shader:", gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function program(fragSrc) {
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error("fire program:", gl.getProgramInfoLog(p));
      return null;
    }
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      uniforms[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { program: p, uniforms };
  }

  const programs = {
    copy: program(FRAG_COPY),
    clear: program(FRAG_CLEAR),
    splat: program(FRAG_SPLAT),
    advect: program(FRAG_ADVECT),
    divergence: program(FRAG_DIVERGENCE),
    curl: program(FRAG_CURL),
    vorticity: program(FRAG_VORTICITY),
    pressure: program(FRAG_PRESSURE),
    gradient: program(FRAG_GRADIENT),
    buoyancy: program(FRAG_BUOYANCY),
    display: program(FRAG_DISPLAY)
  };

  if (Object.values(programs).some((p) => !p)) {
    fallbackFire();
    return;
  }

  /* ── geometry ─────────────────────────────────────────────────── */

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  function createFBO(w, h, internalFormat, format, type, filter) {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture,
      fbo,
      width: w,
      height: h,
      texelSizeX: 1 / w,
      texelSizeY: 1 / h,
      attach(id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      }
    };
  }

  function createDoubleFBO(w, h, internalFormat, format, type, filter) {
    let a = createFBO(w, h, internalFormat, format, type, filter);
    let b = createFBO(w, h, internalFormat, format, type, filter);
    return {
      width: w,
      height: h,
      texelSizeX: 1 / w,
      texelSizeY: 1 / h,
      get read() { return a; },
      set read(v) { a = v; },
      get write() { return b; },
      set write(v) { b = v; },
      swap() { const t = a; a = b; b = t; }
    };
  }

  const FMT = {
    rgba: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT],
    rg: [gl.RG16F, gl.RG, gl.HALF_FLOAT],
    r: [gl.R16F, gl.RED, gl.HALF_FLOAT]
  };

  let dye, velocity, divergence, curl, pressure;

  function initFramebuffers(width, height) {
    // width/height here are the SIM grid dimensions
    dye = createDoubleFBO(width, height, ...FMT.rgba, gl.LINEAR);
    velocity = createDoubleFBO(width, height, ...FMT.rg, gl.LINEAR);
    divergence = createFBO(width, height, ...FMT.r, gl.NEAREST);
    curl = createFBO(width, height, ...FMT.r, gl.NEAREST);
    pressure = createDoubleFBO(width, height, ...FMT.r, gl.NEAREST);
  }

  /* ── sizing ───────────────────────────────────────────────────── */

  let renderW = 0;
  let renderH = 0;
  let simW = 0;
  let simH = 0;

  function resize() {
    const cssW = Math.max(320, window.innerWidth);
    const cssH = Math.max(320, window.innerHeight);
    const aspect = cssW / cssH;

    // fixed vertical sim resolution -> flames occupy a constant fraction
    // of the viewport height regardless of device or window shape
    const h = SIM_H;
    const w = Math.round(Math.min(SIM_W_MAX, Math.max(SIM_W_MIN, h * aspect)));

    if (w === simW && h === simH) return;

    simW = w;
    simH = h;
    renderW = w;
    renderH = h;

    canvas.width = w;
    canvas.height = h;
    canvas.style.imageRendering = "pixelated";

    initFramebuffers(w, h);

    // seed a bed of embers so the first frame isn't empty
    for (let i = 0; i < 26; i++) {
      const x = Math.random();
      const y = 0.02 + Math.random() * 0.1;
      splat(x, y, 0, RISE * 0.7, 0.9, 0.4, 0.08);
    }
  }

  /* ── passes ───────────────────────────────────────────────────── */

  function blit(target) {
    if (target == null) {
      gl.viewport(0, 0, renderW, renderH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function use(p, target) {
    gl.useProgram(p.program);
    if (target) {
      gl.uniform2f(p.uniforms.uTexelSize, target.texelSizeX, target.texelSizeY);
    }
  }

  // `radius` is optional and defaults to SPLAT_RADIUS. Passing a bigger one
  // makes the blob physically wider, which is how a detonation differs from
  // an ordinary click: a blast has to flood a chunk of the frame, not stamp
  // a coin-sized spot on it.
  function splat(x, y, dx, dy, r, g, b, radius) {
    const p = programs.splat;
    gl.useProgram(p.program);
    gl.uniform1i(p.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(p.uniforms.uAspectRatio, simW / simH);
    gl.uniform2f(p.uniforms.uPoint, x, y);
    gl.uniform3f(p.uniforms.uColor, dx, dy, 0);
    gl.uniform1f(p.uniforms.uRadius, radius || SPLAT_RADIUS);
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(p.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(p.uniforms.uColor, r, g, b);
    blit(dye.write);
    dye.swap();
  }

  /* ── detonation: the ENTER inferno ───────────────────────────── */

  // Three staged things, so a burst reads as a blast rather than a smear:
  //   1. a white-hot core wide enough to blow out the middle of the frame,
  //   2. a ring of jets thrown outward, which is what makes a round burst
  //      read as an explosion instead of a smudge,
  //   3. ~0.9s of feed afterwards (see flare in frame()), so the flash turns
  //      into an inferno that climbs the screen instead of popping and dying.
  // The UI passes the button's own screen position, so the fire erupts
  // exactly where the caret was.
  let flare = 0;      // seconds of sustained feed left
  let flareX = 0.5;   // sim-x of the blast, so the plume stays under it

  function detonate(clientX, clientY, opts) {
    const o = opts || {};
    const power = o.power == null ? 1 : o.power;
    const p = toSim(clientX, clientY);
    // Velocity is advected in texels/s, so x has to be scaled by the grid
    // aspect or the ring of jets comes out of the solver as an oval.
    const aspect = simW / simH;
    const core = SPLAT_RADIUS * 8;
    const wide = SPLAT_RADIUS * 3;
    const up = RISE * 14 * power;

    // 1. core — stacked white / orange / ember punches with real volume
    splat(p.x, p.y, 0, up,          3.0 * power, 1.5, 0.6,  core * 1.6);
    splat(p.x, p.y, 0, up * 0.55,   1.9 * power, 0.9, 0.3,  core);
    splat(p.x, p.y, 0, up * 0.3,    1.3 * power, 0.5, 0.14, wide);

    // 2. shock ring — jets thrown outward in every direction
    const JETS = 16;
    const ringR = 0.055 * power;
    const jetV = RISE * 9 * power;
    for (let i = 0; i < JETS; i++) {
      const a = (i / JETS) * Math.PI * 2 + 0.2;
      const jx = p.x + Math.cos(a) * ringR;
      const jy = p.y + Math.sin(a) * ringR;
      if (jx < 0 || jx > 1 || jy < 0 || jy > 1) continue;
      splat(
        jx, jy,
        Math.cos(a) * jetV * aspect, Math.sin(a) * jetV,
        1.4 * power, 0.6, 0.16, wide
      );
    }

    // 3. hand over to the sustained feed in frame()
    flare = 0.9;
    flareX = p.x;
  }

  // Public handle the UI drives. The CPU fallback publishes its own.
  window.FERNO_FIRE = Object.assign(window.FERNO_FIRE || {}, { detonate });

  function step(dt) {
    gl.disable(gl.BLEND);

    // curl
    let p = programs.curl;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.uTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    // vorticity confinement
    p = programs.vorticity;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.uTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(p.uniforms.uCurlStrength, CURL);
    gl.uniform1f(p.uniforms.uDt, dt);
    blit(velocity.write);
    velocity.swap();

    // divergence
    p = programs.divergence;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.uTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    // pressure decay
    p = programs.clear;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.uTexelSize, pressure.texelSizeX, pressure.texelSizeY);
    gl.uniform1i(p.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(p.uniforms.uValue, 0.8);
    blit(pressure.write);
    pressure.swap();

    // jacobi pressure solve
    p = programs.pressure;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.uTexelSize, pressure.texelSizeX, pressure.texelSizeY);
    gl.uniform1i(p.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < 18; i++) {
      gl.uniform1i(p.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    // subtract pressure gradient
    p = programs.gradient;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.uTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    // buoyancy from dye density
    p = programs.buoyancy;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.uTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uDye, dye.read.attach(1));
    gl.uniform1f(p.uniforms.uDt, dt);
    gl.uniform1f(p.uniforms.uBuoyancy, BUOYANCY);
    blit(velocity.write);
    velocity.swap();

    // advect velocity
    p = programs.advect;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.uTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(p.uniforms.uDt, dt);
    gl.uniform1f(p.uniforms.uDissipation, VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    // advect dye
    gl.uniform1i(p.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(p.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(p.uniforms.uDissipation, DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
  }

  function render(time) {
    const p = programs.display;
    gl.useProgram(p.program);
    gl.uniform1i(p.uniforms.uDye, dye.read.attach(0));
    gl.uniform1f(p.uniforms.uTime, time);
    gl.uniform1f(p.uniforms.uExposure, EXPOSURE);
    gl.uniform1f(p.uniforms.uDebug, DEBUG_VIEW ? 1 : 0);
    blit(null);
  }

  /* ── input ────────────────────────────────────────────────────── */

  // The fire is click-driven only. Cursor movement deliberately does NOT
  // touch the simulation unless the button is held: tracking the pointer
  // made the flames appear to follow the mouse and occasionally glitched
  // when the pointer left the window mid-drag.
  let pointerDown = false;
  let pointerSplats = 0;   // counts splats caused by the pointer, for testing

  // Where the pointer is, and how far it has travelled since the last frame.
  // The drag delta is accumulated in the move handler rather than sampled
  // from the previous position: pointermove fires more often than the render
  // loop, so sampling would miss most of the movement.
  const pointer = { x: 0.5, y: 0.5, has: false, dx: 0, dy: 0 };

  function toSim(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = 1 - (clientY - rect.top) / rect.height; // GL origin bottom-left
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  window.addEventListener("pointermove", (e) => {
    const p = toSim(e.clientX, e.clientY);
    if (pointer.has) {
      pointer.dx += p.x - pointer.x;
      pointer.dy += p.y - pointer.y;
    }
    pointer.x = p.x;
    pointer.y = p.y;
    pointer.has = true;
  }, { passive: true });

  window.addEventListener("pointerdown", (e) => {
    pointerDown = true;
    const p = toSim(e.clientX, e.clientY);
    pointer.x = p.x;
    pointer.y = p.y;
    pointer.dx = 0;
    pointer.dy = 0;
    pointer.has = true;
    // NOTE: deliberately no setPointerCapture here. The fire canvas covers
    // the whole viewport, so capturing the pointer would route every later
    // click to the canvas and swallow clicks on the page UI underneath.
    // Instead the drag is tracked from window-level pointermove events,
    // which keep firing even when the cursor leaves the canvas.
    // a hard upward blast plus a wide heat burst: this is the "explode" feel
    splat(p.x, p.y, 0, RISE * 4, 1.1, 0.5, 0.12);
    splat(p.x, p.y, 0, RISE * 2, 0.85, 0.38, 0.08);
    splat(p.x, p.y, 0, RISE * 1, 0.6, 0.26, 0.05);
    pointerSplats += 3;
  }, { passive: true });

  function releasePointer() {
    pointerDown = false;
    pointer.has = false;
    pointer.dx = 0;
    pointer.dy = 0;
  }
  window.addEventListener("pointerup", releasePointer, { passive: true });
  window.addEventListener("pointercancel", releasePointer, { passive: true });
  window.addEventListener("blur", releasePointer);

  /* ── loop ─────────────────────────────────────────────────────── */

  let last = performance.now();
  let time = 0;
  let emberTimer = 0;

  function frame(now) {
    const dt = Math.min(0.016, (now - last) / 1000);
    last = now;
    time += dt;

    // heat bed along the bottom
    emberTimer += dt;
    if (emberTimer > 0.05) {
      emberTimer = 0;
      // scale the number of embers with the width of the grid so the heat
      // density stays constant on tall/narrow viewports
      const n = Math.max(2, Math.round(simW / 90));
      for (let i = 0; i < n; i++) {
        const x = Math.random();
        const y = Math.random() * 0.02;
        const heat = 0.5 + Math.random() * 0.5;
        splat(x, y, (Math.random() - 0.5) * 40, RISE * (1 + Math.random()), heat, heat * 0.34, heat * 0.06);
      }
      // a continuous low ridge so the fire never fully dies out
      const ridgeX = Math.random();
      splat(ridgeX, 0.004, 0, RISE * 0.7, 0.4, 0.14, 0.03);
    }

    // While the pointer is held, the flame follows it: heat is injected at
    // the current position and the drag velocity pushes the flow sideways,
    // so dragging sweeps the fire around and leaves a trail.
    if (pointerDown && pointer.has) {
      const dx = pointer.dx * 900;
      const dy = pointer.dy * 900;
      const speed = Math.min(1, Math.hypot(dx, dy) / 500);
      const heat = 0.45 + speed * 0.55;
      splat(pointer.x, pointer.y, dx, dy, heat, heat * 0.36, heat * 0.06);
      // a steady updraft so the flame keeps climbing while held
      splat(pointer.x, pointer.y, 0, RISE * 1.4, 0.5, 0.22, 0.04);
      pointerSplats += 2;
    }

    // After a detonation the fire keeps burning hot on its own: a sheet of
    // heat along the floor reaching across the whole width, plus a plume
    // stacked under the blast. Both fade over the ~0.9s of flare, so the
    // flash settles back into the normal ember bed instead of dying.
    if (flare > 0) {
      flare -= dt;
      const fade = Math.max(0, Math.min(1, flare));
      const n = Math.max(4, Math.round(simW / 55));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const x = Math.min(1, Math.max(0,
          flareX + (t - 0.5) * 1.1 + (Math.random() - 0.5) * 0.05));
        const heat = (0.9 + Math.random() * 0.6) * (0.45 + 0.55 * fade);
        splat(x, Math.random() * 0.03,
              (Math.random() - 0.5) * 70, RISE * (4 + Math.random() * 8),
              heat, heat * 0.34, heat * 0.06);
      }
      for (let i = 0; i < 4; i++) {
        const heat = 1.6 * fade;
        const y = Math.random() * Math.random() * 0.28;
        splat(flareX + (Math.random() - 0.5) * 0.06, y,
              (Math.random() - 0.5) * 60, RISE * (5 + Math.random() * 8),
              heat, heat * 0.34, heat * 0.06, SPLAT_RADIUS * 2.5);
      }
    }

    pointer.dx = 0;
    pointer.dy = 0;

    step(dt);
    render(time);
    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(frame);

  /* debug probe: ?debug=1 logs renderer info and captures frames to the
     dev server so the render can be inspected as an image */
  if (DEBUG) {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    console.log("FIRE_DEBUG renderer=" + (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)));
    console.log("FIRE_DEBUG size=" + renderW + "x" + renderH + " sim=" + simW + "x" + simH);

    window.__captureFire = function (name) {
      render(time);
      const url = canvas.toDataURL("image/png");
      return fetch("/__shot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataUrl: url, name: name || "fire" })
      }).then((r) => r.json());
    };

    // Total dye energy in the simulation. Unlike a canvas readback this is
    // deterministic and not affected by the ambient ember bed, so it can be
    // used to prove that pointer movement does not drive the simulation.
    window.__dyeEnergy = function () {
      const px = new Uint8Array(renderW * renderH * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, renderW, renderH, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let s = 0;
      for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2];
      return s;
    };

    // how many splats the pointer has caused
    window.__pointerSplats = function () {
      return pointerSplats;
    };

    setTimeout(() => window.__captureFire("landing"), 2500);
    setTimeout(() => window.__captureFire("landing-late"), 7000);
  }

  // The pointer-splat counter is always exposed: it is the only deterministic
  // way to prove that cursor movement does not drive the simulation.
  window.__pointerSplats = function () {
    return pointerSplats;
  };

  // Force a fresh render of the current simulation state. Used by the
  // capture tools so a snapshot reflects the instant it was taken.
  window.__renderNow = function () {
    render(time);
  };

  /* ── fallback: CPU pixel fire ─────────────────────────────────── */

  function fallbackFire() {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let cells = [];
    let img = null;

    const palette = [
      "#03050c", "#06112b", "#0a2a63", "#1450b8", "#7c1d5e",
      "#b8390a", "#ef6a12", "#ff9b2f", "#ffd166", "#fff3c4"
    ];

    function build() {
      w = Math.max(60, Math.floor(window.innerWidth / 6));
      h = Math.max(40, Math.floor(window.innerHeight / 6));
      cells = new Float32Array(w * h);
      img = ctx.createImageData(w, h);
      canvas.width = w;
      canvas.height = h;
      ctx.imageSmoothingEnabled = false;
    }

    function heatAt(cx, cy) {
      const x = Math.floor(cx * w);
      const y = Math.floor((1 - cy) * h);
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = y * w + x;
      cells[i] = Math.min(1, cells[i] + 0.55);
    }
    // Same contract as the GPU build: a blast at a screen point. There is no
    // solver behind this renderer, so the explosion is the blob itself — a
    // wide disc of heat stamped at the click, the whole floor lit, and the
    // first generous frames letting it spread toward the top of the screen.
    function detonate(clientX, clientY) {
      const cx = Math.round((clientX / window.innerWidth) * w);
      const cy = Math.round((clientY / window.innerHeight) * h);
      const R = Math.max(5, Math.round(Math.min(w, h) * 0.18));
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const d = Math.hypot(dx, dy);
          if (d > R) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = y * w + x;
          cells[i] = Math.min(1, cells[i] + Math.max(0, 1 - d / R));
        }
      }
      // the floor the blast sets alight along the bottom edge
      for (let x = 0; x < w; x++) {
        const bi = (h - 1) * w + x;
        cells[bi] = Math.min(1, cells[bi] + 0.35 + Math.random() * 0.65);
      }

    }

    // Publish from here, not from inside detonate: the UI probes for
    // window.FERNO_FIRE as soon as the button is pressed.
    window.FERNO_FIRE = Object.assign(window.FERNO_FIRE || {}, { detonate });

    window.addEventListener("pointermove", (e) => {
      heatAt(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
    }, { passive: true });

    function tick() {
      for (let y = 0; y < h - 1; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const decay = cells[i] * 0.955;
          const j = (y + 1) * w + x;
          const spread = (cells[j] + cells[j - (x > 0 ? 1 : 0)] + cells[j + (x < w - 1 ? 1 : 0)]) / 3;
          cells[i] = decay * 0.82 + spread * 0.18;
        }
      }
      for (let x = 0; x < w; x++) {
        const base = (h - 1) * w + x;
        cells[base] = Math.min(1, cells[base] + Math.random() * 0.55);
      }
      for (let i = 0; i < w * h; i++) {
        const v = cells[i];
        const idx = Math.min(palette.length - 1, Math.floor(v * palette.length));
        const c = palette[idx];
        const o = i * 4;
        img.data[o] = parseInt(c.slice(1, 3), 16);
        img.data[o + 1] = parseInt(c.slice(3, 5), 16);
        img.data[o + 2] = parseInt(c.slice(5, 7), 16);
        img.data[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, canvas.clientWidth, canvas.clientHeight);
      requestAnimationFrame(tick);
    }

    build();
    window.addEventListener("resize", build);
    tick();
  }
})();
