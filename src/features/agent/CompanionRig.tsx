import { useEffect, useId, useRef, useState } from "react";
import type { CompanionMotion } from "./CompanionActor";
import {
  advanceRigBlend,
  deformCompanionRigPoint,
  EMPTY_RIG_BLEND,
  rigFrameDelta,
  sampleCompanionRigPose,
  sampleRigFeeding,
} from "./companionRigMotion";
import "./companion-rig.css";

export interface CompanionRigProps {
  source: string;
  /** Transparent eye-region artwork aligned to the original source canvas. */
  eyesClosed: string;
  fallback: string;
  alt: string;
  motion: CompanionMotion;
  playbackKey?: number | string;
}

const VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_art;
uniform sampler2D u_eyes;
uniform float u_close;
void main() {
  vec4 art = texture2D(u_art, v_uv);
  vec4 eyes = texture2D(u_eyes, v_uv);
  float eyeAlpha = eyes.a * u_close;
  float alpha = eyeAlpha + art.a * (1.0 - eyeAlpha);
  vec3 premultiplied = eyes.rgb * u_close + art.rgb * (1.0 - eyeAlpha);
  gl_FragColor = vec4(premultiplied, alpha);
}`;

function decodeImage(source: string) {
  const image = new Image();
  image.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Companion artwork failed to load"));
  });
  image.src = source;
  const decoded = typeof image.decode === "function" ? image.decode() : loaded;
  void loaded.catch(() => {});
  return decoded.then(() => {
    image.onload = null;
    image.onerror = null;
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error("Companion artwork is empty");
    return image;
  });
}

function createProgram(gl: WebGLRenderingContext) {
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  try {
    if (!program) throw new Error("No companion shader program");
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERTEX_SHADER],
      [gl.FRAGMENT_SHADER, FRAGMENT_SHADER],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("No companion shader");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Companion shader compilation failed");
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error("Companion shader link failed");
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

/** Continuous local animation using one unchanged illustration and eye overlay. */
export function CompanionRig({
  source,
  eyesClosed,
  fallback,
  alt,
  motion,
  playbackKey,
}: CompanionRigProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fishRef = useRef<SVGSVGElement>(null);
  const fishMaskRef = useRef<SVGRectElement>(null);
  const crumbsRef = useRef<(HTMLElement | null)[]>([]);
  const current = useRef({ motion, playbackKey });
  current.current = { motion, playbackKey };
  const maskId = `lc-pet-fish-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [painted, setPainted] = useState<{
    source: string;
    eyesClosed: string;
  } | null>(null);
  const [reduced, setReduced] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const changed = () => {
      const next = Boolean(preference?.matches);
      if (next !== reducedRef.current) {
        reducedRef.current = next;
        setPainted(null);
        setReduced(next);
      }
    };
    changed();
    preference?.addEventListener?.("change", changed);
    return () => preference?.removeEventListener?.("change", changed);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source || !eyesClosed || reduced) return;
    let active = true;
    let handle: number | null = null;
    let lastTime: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let gl: WebGLRenderingContext | null = null;
    let program: WebGLProgram | null = null;
    const textures: WebGLTexture[] = [];
    const buffers: WebGLBuffer[] = [];
    let draw: ((time: number) => void) | null = null;
    let resize: (() => void) | null = null;
    const releaseResources = () => {
      for (const texture of textures) gl?.deleteTexture(texture);
      for (const buffer of buffers) gl?.deleteBuffer(buffer);
      textures.length = 0;
      buffers.length = 0;
      if (program) gl?.deleteProgram(program);
      program = null;
      gl?.clear(gl.COLOR_BUFFER_BIT);
    };
    const stop = () => {
      if (handle !== null) cancelAnimationFrame(handle);
      handle = null;
      lastTime = null;
    };
    const schedule = () => {
      if (active && draw && !document.hidden && handle === null)
        handle = requestAnimationFrame(tick);
    };
    function tick(time: number) {
      handle = null;
      if (!active || document.hidden) {
        lastTime = null;
        return;
      }
      draw?.(time);
      schedule();
    }
    const visibility = () => {
      stop();
      schedule();
    };
    const failed = () => {
      stop();
      draw = null;
      releaseResources();
      if (active) setPainted(null);
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      failed();
    };
    canvas.addEventListener("webglcontextlost", contextLost);
    document.addEventListener("visibilitychange", visibility);

    void Promise.all([decodeImage(source), decodeImage(eyesClosed)])
      .then(([art, eyes]) => {
        if (!active) return;
        if (
          art.naturalWidth !== eyes.naturalWidth ||
          art.naturalHeight !== eyes.naturalHeight
        )
          throw new Error("Companion eye layer has different dimensions");
        gl = canvas.getContext("webgl", {
          alpha: true,
          antialias: true,
          premultipliedAlpha: true,
          depth: false,
          stencil: false,
          powerPreference: "low-power",
        });
        if (!gl) throw new Error("Companion WebGL is unavailable");
        const context = gl;
        if (
          Math.max(art.naturalWidth, art.naturalHeight) >
          context.getParameter(context.MAX_TEXTURE_SIZE)
        )
          throw new Error("Companion texture exceeds this device's limit");
        program = createProgram(context);
        context.useProgram(program);
        context.clearColor(0, 0, 0, 0);
        context.enable(context.BLEND);
        // Premultiply before filtering to avoid dark/bright fringes around
        // translucent hair. The canvas compositor also expects premultiplied RGB.
        context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA);
        for (const [index, image, uniform] of [
          [0, art, "u_art"],
          [1, eyes, "u_eyes"],
        ] as const) {
          const texture = context.createTexture();
          if (!texture) throw new Error("Companion texture allocation failed");
          textures.push(texture);
          context.activeTexture(context.TEXTURE0 + index);
          context.bindTexture(context.TEXTURE_2D, texture);
          context.texParameteri(
            context.TEXTURE_2D,
            context.TEXTURE_WRAP_S,
            context.CLAMP_TO_EDGE,
          );
          context.texParameteri(
            context.TEXTURE_2D,
            context.TEXTURE_WRAP_T,
            context.CLAMP_TO_EDGE,
          );
          context.texParameteri(
            context.TEXTURE_2D,
            context.TEXTURE_MIN_FILTER,
            context.LINEAR,
          );
          context.texParameteri(
            context.TEXTURE_2D,
            context.TEXTURE_MAG_FILTER,
            context.LINEAR,
          );
          context.texImage2D(
            context.TEXTURE_2D,
            0,
            context.RGBA,
            context.RGBA,
            context.UNSIGNED_BYTE,
            image,
          );
          context.uniform1i(
            context.getUniformLocation(program, uniform),
            index,
          );
        }
        const columns = 12;
        const rows = 16;
        const uv = new Float32Array((columns + 1) * (rows + 1) * 2);
        const positions = new Float32Array(uv.length);
        const indices = new Uint16Array(columns * rows * 6);
        for (let y = 0; y <= rows; y++)
          for (let x = 0; x <= columns; x++) {
            const offset = (y * (columns + 1) + x) * 2;
            uv[offset] = x / columns;
            uv[offset + 1] = y / rows;
          }
        let index = 0;
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < columns; x++) {
            const top = y * (columns + 1) + x;
            indices.set(
              [
                top,
                top + columns + 1,
                top + 1,
                top + 1,
                top + columns + 1,
                top + columns + 2,
              ],
              index,
            );
            index += 6;
          }
        const newBuffer = () => {
          const buffer = context.createBuffer();
          if (!buffer) throw new Error("Companion buffer allocation failed");
          buffers.push(buffer);
          return buffer;
        };
        const positionBuffer = newBuffer();
        context.bindBuffer(context.ARRAY_BUFFER, positionBuffer);
        context.bufferData(
          context.ARRAY_BUFFER,
          positions.byteLength,
          context.DYNAMIC_DRAW,
        );
        const positionLocation = context.getAttribLocation(
          program,
          "a_position",
        );
        context.enableVertexAttribArray(positionLocation);
        context.vertexAttribPointer(
          positionLocation,
          2,
          context.FLOAT,
          false,
          0,
          0,
        );
        context.bindBuffer(context.ARRAY_BUFFER, newBuffer());
        context.bufferData(context.ARRAY_BUFFER, uv, context.STATIC_DRAW);
        const uvLocation = context.getAttribLocation(program, "a_uv");
        context.enableVertexAttribArray(uvLocation);
        context.vertexAttribPointer(uvLocation, 2, context.FLOAT, false, 0, 0);
        context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, newBuffer());
        context.bufferData(
          context.ELEMENT_ARRAY_BUFFER,
          indices,
          context.STATIC_DRAW,
        );
        const closeLocation = context.getUniformLocation(program, "u_close");
        let width = 192;
        let height = 192;
        let scale = 1;
        resize = () => {
          const rect = canvas.getBoundingClientRect();
          width = Math.max(1, rect.width || 192);
          height = Math.max(1, rect.height || 192);
          const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
          canvas.width = Math.round(width * ratio);
          canvas.height = Math.round(height * ratio);
          context.viewport(0, 0, canvas.width, canvas.height);
          scale =
            Math.min(width / art.naturalWidth, height / art.naturalHeight) *
            0.94;
        };
        resize();
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => resize?.());
          resizeObserver.observe(canvas);
        }
        window.addEventListener("resize", resize);
        let elapsed = 0;
        let actionStarted = 0;
        let settleStarted = -Infinity;
        let previous = current.current;
        let blend = { ...EMPTY_RIG_BLEND };
        draw = (time: number) => {
          const delta = rigFrameDelta(time, lastTime);
          lastTime = time;
          elapsed += delta;
          const request = current.current;
          if (
            request.motion !== previous.motion ||
            request.playbackKey !== previous.playbackKey
          ) {
            if (previous.motion === "drag" && request.motion !== "drag")
              settleStarted = elapsed;
            actionStarted = elapsed;
            previous = request;
          }
          const age = elapsed - actionStarted;
          blend = advanceRigBlend(blend, request.motion, delta);
          const pose = sampleCompanionRigPose(
            elapsed,
            age,
            request.motion,
            blend,
            elapsed - settleStarted,
          );
          for (let offset = 0; offset < uv.length; offset += 2) {
            const [x, y] = deformCompanionRigPoint(
              uv[offset],
              uv[offset + 1],
              pose,
            );
            positions[offset] =
              ((x - 0.5) * art.naturalWidth * scale * 2) / width;
            positions[offset + 1] =
              -((y - 0.5) * art.naturalHeight * scale * 2) / height;
          }
          context.bindBuffer(context.ARRAY_BUFFER, positionBuffer);
          context.bufferSubData(context.ARRAY_BUFFER, 0, positions);
          context.uniform1f(closeLocation, pose.eyeClosed);
          canvas.dataset.blink = pose.eyeClosed.toFixed(3);
          context.clear(context.COLOR_BUFFER_BIT);
          context.drawElements(
            context.TRIANGLES,
            indices.length,
            context.UNSIGNED_SHORT,
            0,
          );
          const [mx, my] = deformCompanionRigPoint(
            610 / 1214,
            495 / 1295,
            pose,
          );
          const mouthX = width / 2 + (mx - 0.5) * art.naturalWidth * scale;
          const mouthY = height / 2 + (my - 0.5) * art.naturalHeight * scale;
          const feeding = sampleRigFeeding(age);
          const fish = fishRef.current;
          const showFood = request.motion === "feed" && feeding.visible;
          if (fish) {
            fish.style.visibility = showFood ? "visible" : "hidden";
            if (showFood) {
              const fishWidth = height * 0.145;
              const startX = width * 0.73;
              const startY = height * 0.74;
              const x =
                startX +
                (mouthX - startX) * feeding.approach -
                fishWidth * (0.17 + 0.7 * feeding.bite);
              const y =
                startY + (mouthY - startY) * feeding.approach - fishWidth * 0.2;
              fish.style.width = `${fishWidth}px`;
              fish.style.height = `${fishWidth * 0.4}px`;
              fish.style.opacity = String(feeding.opacity);
              fish.style.transform = `translate3d(${x}px,${y}px,0) rotate(12deg)`;
              fishMaskRef.current?.setAttribute(
                "x",
                String(feeding.bite * 100),
              );
              fishMaskRef.current?.setAttribute(
                "width",
                String(100 - feeding.bite * 100),
              );
            }
          }
          crumbsRef.current.forEach((crumb, n) => {
            if (!crumb) return;
            const progress = feeding.crumbProgress;
            const visible = request.motion === "feed" && progress >= 0;
            crumb.style.opacity = visible ? String((1 - progress) * 0.9) : "0";
            if (visible) {
              const x = mouthX + (n - 1) * progress * 13;
              const y =
                mouthY + progress * 11 + progress * progress * 9 - (n % 2) * 4;
              crumb.style.transform = `translate3d(${x}px,${y}px,0) rotate(${n * 30}deg)`;
            }
          });
        };
        draw(0);
        setPainted({ source, eyesClosed });
        schedule();
      })
      .catch(failed);

    return () => {
      active = false;
      stop();
      draw = null;
      resizeObserver?.disconnect();
      if (resize) window.removeEventListener("resize", resize);
      canvas.removeEventListener("webglcontextlost", contextLost);
      document.removeEventListener("visibilitychange", visibility);
      releaseResources();
    };
  }, [source, eyesClosed, reduced]);

  const ready =
    !reduced && painted?.source === source && painted.eyesClosed === eyesClosed;
  return (
    <span
      className="lc-companion-rig"
      data-motion={motion}
      data-ready={ready}
      data-rig-ready={ready}
    >
      <canvas
        ref={canvasRef}
        className="lc-companion-rig-canvas"
        role="img"
        aria-label={alt}
        aria-hidden={!ready}
        hidden={!ready}
        data-motion={motion}
      />
      {!ready && (
        <img
          className="lc-companion-rig-fallback"
          src={fallback}
          alt={alt}
          draggable={false}
          decoding="async"
        />
      )}
      <svg
        ref={fishRef}
        className="lc-companion-rig-fish"
        viewBox="0 0 100 40"
        aria-hidden="true"
      >
        <defs>
          <clipPath id={maskId}>
            <rect ref={fishMaskRef} x="0" y="0" width="100" height="40" />
          </clipPath>
        </defs>
        <g
          clipPath={`url(#${maskId})`}
          stroke="#86552e"
          strokeWidth="2"
          strokeLinejoin="round"
        >
          <path d="M76 13 96 5 92 20 97 35 76 28Z" fill="#b77939" />
          <path d="m45 9 9-7 6 10-7 5Z" fill="#cf9a4a" />
          <path
            d="M8 20C13 7 35 7 51 9c15 1 27 5 32 11-5 8-17 12-33 13C31 35 14 31 8 20Z"
            fill="#dfad5b"
          />
          <path
            d="M15 21c18 6 40 7 60 0"
            fill="none"
            stroke="#f1d391"
            strokeWidth="3"
          />
          <path
            d="m34 14 7 6-7 6m14-12 7 6-7 6m14-11 6 5-6 5"
            fill="none"
            stroke="#bb8640"
            strokeWidth="1.5"
          />
          <circle cx="21" cy="18" r="2.8" fill="#684329" stroke="none" />
          <circle cx="20.3" cy="17.2" r="0.9" fill="#fff0c5" stroke="none" />
          <path d="m26 12 7-1" stroke="#ffdf9c" strokeWidth="2" />
        </g>
      </svg>
      {[0, 1, 2].map((n) => (
        <i
          key={n}
          ref={(node) => {
            crumbsRef.current[n] = node;
          }}
          className="lc-companion-rig-crumb"
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
