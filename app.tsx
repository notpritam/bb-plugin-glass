// bb-plugin-glass — frontend entry ("Transparency").
//
// Gives the whole bb app a glassy, translucent look with an ambient backdrop
// glowing through from behind. Backdrops come in two flavors:
//  • Shader styles (flow / aurora / nebula / waves) — a real WebGL fragment
//    shader animating fbm noise fields, tinted from the live theme accent.
//  • CSS styles (glow / image) — gradient or wallpaper layers.
// An animated film-grain overlay and a readability scrim sit on top, and the
// "Transparency" panel controls everything live.
//
// Honest limitation: true see-through-to-desktop needs the native window to be
// created transparent (an Electron flag bb owns) — this simulates the look.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { cn } from "@/lib/utils";

type Style = "flow" | "aurora" | "nebula" | "waves" | "glow" | "image" | "none";
const SHADER_STYLES: Style[] = ["flow", "aurora", "nebula", "waves"];
interface Config {
  enabled: boolean;
  opacity: number;
  blur: number;
  style: Style;
  imageUrl: string;
  animate: boolean;
  dim: number;
  grain: number;
  speed: number;
  sidebarOpacity: number;
  sidebarBlur: number;
  composerBlur: number;
  composerFrost: boolean;
  modalFrost: boolean;
  modalBlur: number;
}
const DEFAULTS: Config = {
  enabled: false,
  opacity: 82,
  blur: 44,
  style: "flow",
  imageUrl: "",
  animate: true,
  dim: 30,
  grain: 12,
  speed: 100,
  sidebarOpacity: 94,
  sidebarBlur: 18,
  composerBlur: 24,
  composerFrost: true,
  modalFrost: true,
  modalBlur: 20,
};

async function callRpc<T>(
  pluginId: string,
  method: string,
  input: unknown,
): Promise<T | null> {
  try {
    const res = await fetch(`/api/v1/plugins/${pluginId}/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(input),
    });
    const json = (await res.json()) as { ok: boolean; result?: T };
    return json.ok && json.result !== undefined ? json.result : null;
  } catch {
    return null;
  }
}

// Converts any CSS colour the browser understands into sRGB bytes.
//
// bb's theme is authored in oklch (`--canvas: oklch(19.5% 0 0)`), and modern
// Chrome reports `getComputedStyle().color` back in the *same* colour space
// rather than normalising to rgb(). Scraping digits out of that string reads
// lightness/chroma/hue as if they were R/G/B — oklch(0.195 0 0) becomes
// rgb(195,0,0), a bright red, which is why every surface turned red regardless
// of the theme picked (neutral themes are all `oklch(L 0 0)`).
//
// Painting the colour onto a 1x1 canvas and reading the pixel back delegates
// the conversion to the browser, so it stays correct for oklch, color(),
// hsl(), named colours and whatever ships next.
let colourProbe: CanvasRenderingContext2D | null | undefined;

function cssColourToRgb(value: string): [number, number, number] | null {
  if (!value) return null;

  // Fast path: legacy rgb()/rgba(), still what most browsers return.
  const legacy = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (legacy) {
    return [Math.round(+legacy[1]), Math.round(+legacy[2]), Math.round(+legacy[3])];
  }

  try {
    if (colourProbe === undefined) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      colourProbe = canvas.getContext("2d", { willReadFrequently: true });
    }
    const ctx = colourProbe;
    if (!ctx) return null;

    // An invalid assignment leaves fillStyle untouched, so seed a known value
    // and treat "unchanged" as a parse failure.
    ctx.fillStyle = "#000000";
    ctx.fillStyle = value;
    const parsed =
      ctx.fillStyle !== "#000000" || /^(#0{3,8}|black|rgba?\(0[\s,]+0[\s,]+0)/i.test(value.trim());
    if (!parsed) return null;

    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a === 0) return null; // fully transparent tells us nothing useful
    return [r, g, b];
  } catch {
    return null; // canvas unavailable or tainted
  }
}

function rgbOf(varName: string, fallback: [number, number, number]) {
  const el = document.createElement("span");
  el.style.position = "absolute";
  el.style.visibility = "hidden";
  el.style.color = `var(${varName})`;
  document.body.appendChild(el);
  const computed = getComputedStyle(el).color;
  el.remove();
  return (cssColourToRgb(computed) ?? fallback) as readonly [number, number, number];
}

// ── shader ─────────────────────────────────────────────────────────────────
const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uStyle; // 0 flow, 1 aurora, 2 nebula, 3 waves
uniform vec3 uC0; // theme accent
uniform vec3 uC1; // sky
uniform vec3 uC2; // violet
uniform vec3 uBase;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), u.x),
             mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0);
  float t = uTime;
  vec3 col = uBase;

  if (uStyle < 0.5) {
    // FLOW — moving mesh gradient
    float n1 = fbm(p * 1.4 + vec2(t * 0.06, -t * 0.045));
    float n2 = fbm(p * 2.1 + vec2(-t * 0.05, t * 0.07) + 4.7);
    float n3 = fbm(p * 1.1 + vec2(t * 0.03, t * 0.02) + 9.2);
    col = mix(uBase, uC0, smoothstep(0.25, 0.85, n1));
    col = mix(col, uC1, smoothstep(0.45, 0.95, n2) * 0.75);
    col = mix(col, uC2, smoothstep(0.55, 1.0, n3) * 0.6);
  } else if (uStyle < 1.5) {
    // AURORA — flowing curtains
    float w1 = fbm(vec2(p.x * 1.6 + t * 0.1, t * 0.05));
    float w2 = fbm(vec2(p.x * 2.3 - t * 0.08, 7.0 + t * 0.04));
    float y1 = 0.62 + 0.18 * (w1 - 0.5) * 2.0;
    float y2 = 0.42 + 0.22 * (w2 - 0.5) * 2.0;
    float b1 = exp(-pow((uv.y - y1) * 4.4, 2.0));
    float b2 = exp(-pow((uv.y - y2) * 3.6, 2.0));
    col += uC0 * b1 * (0.55 + 0.45 * w1);
    col += mix(uC1, uC2, w2) * b2 * 0.5;
    col += uC2 * exp(-pow((uv.y - 0.85) * 5.0, 2.0)) * 0.25 * w1;
  } else if (uStyle < 2.5) {
    // NEBULA — swirling clouds
    vec2 c = p - vec2(0.5 * uRes.x / uRes.y, 0.5);
    float ang = fbm(p * 1.5 + t * 0.02) * 6.2831;
    vec2 q = c + 0.28 * vec2(cos(ang), sin(ang));
    float d1 = fbm(q * 2.0 + t * 0.03);
    float d2 = fbm(q * 3.4 - t * 0.02 + 5.0);
    col = mix(uBase, uC2, smoothstep(0.3, 0.9, d1));
    col = mix(col, uC0, smoothstep(0.5, 1.0, d2) * 0.7);
    col = mix(col, uC1, smoothstep(0.62, 1.0, fbm(q * 5.0 + 11.0)) * 0.4);
  } else {
    // WAVES — layered sine bands
    float s1 = sin(p.x * 4.0 + t * 0.35 + sin(t * 0.11) * 2.0);
    float s2 = sin(p.x * 6.5 - t * 0.28 + 1.7);
    float y1 = 0.55 + 0.1 * s1;
    float y2 = 0.35 + 0.08 * s2;
    col = mix(uBase, uC0 * 0.85, smoothstep(y1 + 0.25, y1 - 0.3, uv.y));
    col = mix(col, uC1 * 0.8, smoothstep(y2 + 0.2, y2 - 0.28, uv.y) * 0.8);
    col += uC2 * 0.14 * (0.5 + 0.5 * sin(p.x * 2.0 + t * 0.2 + 3.0));
  }

  gl_FragColor = vec4(col, 1.0);
}`;

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

interface ShaderRig {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  uniforms: Record<string, WebGLUniformLocation | null>;
  raf: number | null;
  start: number;
}

function makeShader(container: HTMLElement): ShaderRig | null {
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
  } satisfies Partial<CSSStyleDeclaration>);
  const gl = canvas.getContext("webgl", {
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uniforms: ShaderRig["uniforms"] = {};
  for (const n of ["uRes", "uTime", "uStyle", "uC0", "uC1", "uC2", "uBase"])
    uniforms[n] = gl.getUniformLocation(prog, n);
  container.appendChild(canvas);
  return { canvas, gl, uniforms, raf: null, start: performance.now() };
}

// Animated film grain (SVG turbulence tile, jittered via steps()).
const GRAIN_URI = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`;

function mountGlass({
  pluginId,
  signal,
}: {
  pluginId: string;
  signal: AbortSignal;
}): () => void {
  // Layer root: backdrop (shader canvas OR css layer) → grain → scrim.
  const rootLayer = document.createElement("div");
  rootLayer.setAttribute("data-glass-backdrop", "");
  Object.assign(rootLayer.style, {
    position: "fixed",
    inset: "0",
    zIndex: "-1",
    pointerEvents: "none",
    display: "none",
    overflow: "hidden",
  } satisfies Partial<CSSStyleDeclaration>);

  const shaderWrap = document.createElement("div");
  Object.assign(shaderWrap.style, {
    position: "absolute",
    inset: "-6%",
    display: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  const cssLayer = document.createElement("div");
  Object.assign(cssLayer.style, {
    position: "absolute",
    inset: "-10%",
    display: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  const grainLayer = document.createElement("div");
  Object.assign(grainLayer.style, {
    position: "absolute",
    inset: "-16px",
    backgroundImage: GRAIN_URI,
    mixBlendMode: "overlay",
    opacity: "0",
    animation: "glass-grain 0.9s steps(4) infinite",
  } satisfies Partial<CSSStyleDeclaration>);

  const scrim = document.createElement("div");
  Object.assign(scrim.style, {
    position: "absolute",
    inset: "0",
    background: "rgba(0,0,0,0.3)",
  } satisfies Partial<CSSStyleDeclaration>);

  rootLayer.append(shaderWrap, cssLayer, grainLayer, scrim);
  document.body.appendChild(rootLayer);

  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-glass", "");
  document.head.appendChild(styleEl);

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let rig: ShaderRig | null = null;
  let cfg: Config | null = null;
  let lastTokenCss = "";
  // Theme accent, cached per apply() — never probe the DOM per frame.
  let accent: readonly [number, number, number] = [124, 134, 232];

  const styleIndex = (s: Style) => SHADER_STYLES.indexOf(s);

  function sizeShader() {
    if (!rig) return;
    // Render at reduced resolution — the backdrop is soft anyway, and this
    // keeps the fragment cost trivial even fullscreen.
    const scale = 0.35;
    const w = Math.max(64, Math.floor(shaderWrap.clientWidth * scale));
    const h = Math.max(64, Math.floor(shaderWrap.clientHeight * scale));
    if (rig.canvas.width !== w || rig.canvas.height !== h) {
      rig.canvas.width = w;
      rig.canvas.height = h;
      rig.gl.viewport(0, 0, w, h);
    }
  }

  function renderFrame(now: number) {
    if (!rig || !cfg) return;
    const { gl, uniforms } = rig;
    sizeShader();
    const animate = cfg.animate && !reducedMotion.matches;
    const t = animate ? ((now - rig.start) / 1000) * (cfg.speed / 100) : 13.7;
    gl.uniform2f(uniforms.uRes, rig.canvas.width, rig.canvas.height);
    gl.uniform1f(uniforms.uTime, t);
    gl.uniform1f(uniforms.uStyle, Math.max(0, styleIndex(cfg.style)));
    gl.uniform3f(uniforms.uC0, accent[0] / 255, accent[1] / 255, accent[2] / 255);
    gl.uniform3f(uniforms.uC1, 0.22, 0.68, 0.94);
    gl.uniform3f(uniforms.uC2, 0.72, 0.55, 0.96);
    gl.uniform3f(uniforms.uBase, 0.016, 0.02, 0.045);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (animate && !signal.aborted) {
      rig.raf = requestAnimationFrame(renderFrame);
    } else {
      rig.raf = null;
    }
  }

  function stopShader() {
    if (rig?.raf) cancelAnimationFrame(rig.raf);
    if (rig) rig.raf = null;
  }
  function startShader() {
    if (!rig) rig = makeShader(shaderWrap);
    if (!rig) return; // no WebGL — cssLayer fallback handles it
    if (rig.raf === null) rig.raf = requestAnimationFrame(renderFrame);
  }

  function cssBackdrop(c: Config): string {
    const p = rgbOf("--primary", [124, 134, 232]).join(",");
    if (c.style === "glow")
      return `radial-gradient(65% 55% at 50% 108%, rgba(${p},.55), transparent 72%), radial-gradient(40% 30% at 12% -8%, rgba(${p},.25), transparent 70%), #04050a`;
    if (c.style === "image" && c.imageUrl)
      return `url("${c.imageUrl.replace(/"/g, "%22")}") center / cover no-repeat, #000`;
    return "#05060a";
  }

  function apply(next: Config) {
    cfg = next;
    if (!next.enabled) {
      rootLayer.style.display = "none";
      stopShader();
      if (styleEl.textContent) styleEl.textContent = "";
      lastTokenCss = "";
      return;
    }
    rootLayer.style.display = "block";
    accent = rgbOf("--primary", [124, 134, 232]);

    // token translucency
    const canvas = rgbOf("--canvas", [11, 12, 14]);
    const a = next.opacity / 100;
    const rgba = (alpha: number) =>
      `rgba(${canvas[0]},${canvas[1]},${canvas[2]},${Math.min(1, alpha).toFixed(3)})`;
    const sbA = next.sidebarOpacity / 100;
    const tokenCss = `
html, body { background: transparent !important; }
:root:root, :root:root.dark, :root:root.light {
  --canvas: ${rgba(a)};
  --background: ${rgba(a)};
  --card: ${rgba(a + 0.05)};
  --sidebar: ${rgba(sbA)};
  --popover: ${rgba(next.modalFrost ? Math.max(0.85, a) : Math.max(0.96, a))};
}
${
  next.modalFrost
    ? `
/* Frost modals, popups, dropdown menus, tooltips, and drawers: their surfaces
   go slightly translucent (--popover above) and blur what's behind them. */
:root:root [role="dialog"],
:root:root [role="alertdialog"],
:root:root [data-radix-popper-content-wrapper] > *,
:root:root [role="menu"],
:root:root [role="listbox"],
:root:root [data-sonner-toast] {
  backdrop-filter: blur(${next.modalBlur}px) saturate(1.1);
  -webkit-backdrop-filter: blur(${next.modalBlur}px) saturate(1.1);
}`
    : ""
}
/* Frost the sidebar itself so its UI stays crisp over the backdrop. */
:root:root [data-sidebar="sidebar"] {
  backdrop-filter: blur(${next.sidebarBlur}px) saturate(1.15);
  -webkit-backdrop-filter: blur(${next.sidebarBlur}px) saturate(1.15);
}
/* Frost the chat input as ONE overall region, hosted on BB's own sticky
   bottom wrapper (the element actually docked to the window edge). One
   pseudo = one blur layer (no inner text-area layer), it reaches the very
   bottom when docked (no gap), and the tiny extension adds no meaningful
   scroll overflow — so the composer stays put instead of bobbing. */
${
  next.composerFrost
    ? `
/* Progressive gradient blur: a light layer starts high with a long fade, a
   strong layer ramps in below — barely-there at the top, full frost at the
   bottom. Top-only extensions add no scrollable overflow, so the docked
   composer never drifts; the wrapper itself already touches the window edge. */
:root:root .sticky.bottom-0:has([data-follow-up-composer])::before {
  content: "";
  position: absolute;
  inset: -44px 0 0 0;
  z-index: -1;
  pointer-events: none;
  backdrop-filter: blur(${Math.max(2, Math.round(next.composerBlur / 3))}px) saturate(1.05);
  -webkit-backdrop-filter: blur(${Math.max(2, Math.round(next.composerBlur / 3))}px) saturate(1.05);
  mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.45) 38%, #000 72%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.45) 38%, #000 72%);
}
:root:root .sticky.bottom-0:has([data-follow-up-composer])::after {
  content: "";
  position: absolute;
  inset: -14px 0 0 0;
  z-index: -1;
  pointer-events: none;
  backdrop-filter: blur(${next.composerBlur}px) saturate(1.1);
  -webkit-backdrop-filter: blur(${next.composerBlur}px) saturate(1.1);
  mask-image: linear-gradient(to bottom, transparent 8%, rgba(0,0,0,.55) 52%, #000 88%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 8%, rgba(0,0,0,.55) 52%, #000 88%);
}`
    : ""
}
@keyframes glass-grain {
  0% { transform: translate(0,0); } 25% { transform: translate(-6px,4px); }
  50% { transform: translate(4px,-6px); } 75% { transform: translate(-3px,-4px); }
  100% { transform: translate(0,0); }
}
@media (prefers-reduced-motion: reduce) {
  [data-glass-backdrop] * { animation: none !important; }
}`;
    if (tokenCss !== lastTokenCss) {
      lastTokenCss = tokenCss;
      styleEl.textContent = tokenCss;
    }

    // layers
    const isShader = styleIndex(next.style) >= 0;
    shaderWrap.style.display = isShader ? "block" : "none";
    cssLayer.style.display = isShader ? "none" : "block";
    const blur = `blur(${next.blur}px) saturate(1.2)`;
    if (isShader) {
      shaderWrap.style.filter = `blur(${Math.round(next.blur / 3)}px) saturate(1.2)`;
      startShader();
      if (rig?.raf === null) renderFrame(performance.now()); // static single frame
    } else {
      stopShader();
      cssLayer.style.background = cssBackdrop(next);
      cssLayer.style.filter = next.style === "image" ? "none" : blur;
    }
    grainLayer.style.opacity = String(next.grain / 100);
    grainLayer.style.animationPlayState =
      next.animate && !reducedMotion.matches ? "running" : "paused";
    scrim.style.background = `rgba(0,0,0,${(next.dim / 100).toFixed(2)})`;
  }

  const tick = async () => {
    if (signal.aborted) return;
    const next = await callRpc<Config>(pluginId, "getConfig", null);
    if (signal.aborted || !next) return;
    apply(next);
  };
  void tick();
  const timer = setInterval(() => void tick(), 1200);
  const onResize = () => sizeShader();
  window.addEventListener("resize", onResize);

  return () => {
    clearInterval(timer);
    window.removeEventListener("resize", onResize);
    stopShader();
    styleEl.remove();
    rootLayer.remove();
  };
}

// ── control panel ──────────────────────────────────────────────────────────

function Slider({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-foreground">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--primary)]"
      />
    </label>
  );
}

const STYLE_OPTIONS: { id: Style; label: string; hint: string }[] = [
  { id: "flow", label: "Flow", hint: "Moving mesh gradient · shader" },
  { id: "aurora", label: "Aurora", hint: "Flowing curtains · shader" },
  { id: "nebula", label: "Nebula", hint: "Swirling clouds · shader" },
  { id: "waves", label: "Waves", hint: "Layered sine bands · shader" },
  { id: "glow", label: "Glow", hint: "Accent light from below" },
  { id: "image", label: "Image", hint: "Your own wallpaper URL" },
  { id: "none", label: "None", hint: "Transparency only" },
];

function GlassPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [cfg, setCfg] = useState<Config>(DEFAULTS);

  const refetch = useCallback(() => {
    void rpcRef.current
      .call("getConfig")
      .then((c) => setCfg(c as Config))
      .catch(() => {});
  }, []);
  useEffect(() => refetch(), [refetch]);
  useRealtime("glass", refetch);

  const update = useCallback((patch: Partial<Config>) => {
    setCfg((c) => ({ ...c, ...patch }));
    void rpcRef.current.call("setConfig", patch).catch(() => {});
  }, []);
  const reset = useCallback(() => {
    void rpcRef.current
      .call("resetConfig")
      .then((c) => setCfg(c as Config))
      .catch(() => {});
  }, []);

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="mx-auto w-full max-w-xl space-y-5">
        <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
          <div>
            <div className="text-sm font-semibold text-foreground">
              Transparency
            </div>
            <div className="text-xs text-muted-foreground">
              Translucent surfaces over an ambient backdrop
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={cfg.enabled}
            onClick={() => update({ enabled: !cfg.enabled })}
            className={cn(
              "relative h-6 w-11 rounded-full transition-colors",
              cfg.enabled ? "bg-primary" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-5 rounded-full bg-background shadow transition-all",
                cfg.enabled ? "left-[22px]" : "left-0.5",
              )}
            />
          </button>
        </div>

        <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
          <div className="mb-3 text-sm font-semibold text-foreground">
            Backdrop
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {STYLE_OPTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => update({ style: s.id })}
                className={cn(
                  "rounded-xl border p-3 text-left transition-all",
                  cfg.style === s.id
                    ? "border-primary/50 bg-primary/10 ring-1 ring-primary/30"
                    : "border-border/60 hover:border-border",
                )}
              >
                <div className="text-xs font-semibold text-foreground">
                  {s.label}
                </div>
                <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                  {s.hint}
                </div>
              </button>
            ))}
          </div>
          {cfg.style === "image" && (
            <input
              value={cfg.imageUrl}
              placeholder="https://… wallpaper URL"
              onChange={(e) => update({ imageUrl: e.target.value })}
              className="mt-3 w-full rounded-lg border border-border/60 bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/40"
            />
          )}
        </div>

        <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
          <Slider
            label="Surface opacity (lower = more glass)"
            value={cfg.opacity}
            min={55}
            max={100}
            unit="%"
            onChange={(v) => update({ opacity: v })}
          />
          <Slider
            label="Backdrop blur"
            value={cfg.blur}
            min={0}
            max={80}
            unit="px"
            onChange={(v) => update({ blur: v })}
          />
          <Slider
            label="Grain (film texture)"
            value={cfg.grain}
            min={0}
            max={40}
            unit="%"
            onChange={(v) => update({ grain: v })}
          />
          <Slider
            label="Motion speed"
            value={cfg.speed}
            min={10}
            max={300}
            unit="%"
            onChange={(v) => update({ speed: v })}
          />
          <Slider
            label="Dim (readability)"
            value={cfg.dim}
            min={0}
            max={70}
            unit="%"
            onChange={(v) => update({ dim: v })}
          />
          <label className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Ambient motion
            </span>
            <input
              type="checkbox"
              checked={cfg.animate}
              onChange={(e) => update({ animate: e.target.checked })}
              className="size-4 accent-[var(--primary)]"
            />
          </label>
        </div>

        {/* sidebar readability */}
        <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
          <div>
            <div className="text-sm font-semibold text-foreground">Sidebar</div>
            <div className="text-xs text-muted-foreground">
              Kept less transparent + frosted so its UI never breaks
            </div>
          </div>
          <Slider
            label="Sidebar opacity"
            value={cfg.sidebarOpacity}
            min={60}
            max={100}
            unit="%"
            onChange={(v) => update({ sidebarOpacity: v })}
          />
          <Slider
            label="Sidebar frost (backdrop blur)"
            value={cfg.sidebarBlur}
            min={0}
            max={40}
            unit="px"
            onChange={(v) => update({ sidebarBlur: v })}
          />
          <label className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Chat input frost (off = stock composer)
            </span>
            <input
              type="checkbox"
              checked={cfg.composerFrost}
              onChange={(e) => update({ composerFrost: e.target.checked })}
              className="size-4 accent-[var(--primary)]"
            />
          </label>
          {cfg.composerFrost && (
            <Slider
              label="Chat input blur (gradient, max at bottom)"
              value={cfg.composerBlur}
              min={0}
              max={40}
              unit="px"
              onChange={(v) => update({ composerBlur: v })}
            />
          )}
        </div>

        {/* modals, popups, menus */}
        <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
          <div>
            <div className="text-sm font-semibold text-foreground">
              Modals &amp; popups
            </div>
            <div className="text-xs text-muted-foreground">
              Dialogs, dropdown menus, popovers, tooltips, toasts
            </div>
          </div>
          <label className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Frost modals &amp; popups (off = solid surfaces)
            </span>
            <input
              type="checkbox"
              checked={cfg.modalFrost}
              onChange={(e) => update({ modalFrost: e.target.checked })}
              className="size-4 accent-[var(--primary)]"
            />
          </label>
          {cfg.modalFrost && (
            <Slider
              label="Modal blur level"
              value={cfg.modalBlur}
              min={0}
              max={40}
              unit="px"
              onChange={(v) => update({ modalBlur: v })}
            />
          )}
        </div>

        <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
          <div>
            <div className="text-sm font-semibold text-foreground">Reset</div>
            <div className="text-xs text-muted-foreground">
              Back to defaults (transparency off)
            </div>
          </div>
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive"
          >
            Reset settings
          </button>
        </div>

        <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
          Note: a plugin can’t make the native window see-through to the
          desktop (that’s an app-level window flag) — Transparency simulates
          the look with a shader layer behind translucent UI. Changes apply
          live within a second.
        </p>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "glass", mount: mountGlass });
  app.slots.navPanel({
    id: "glass",
    title: "Transparency",
    icon: "Layers",
    path: "glass",
    component: GlassPanel,
  });
});
