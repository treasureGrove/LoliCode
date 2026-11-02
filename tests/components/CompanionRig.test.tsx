import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionRig } from "@/features/agent/CompanionRig";

const props = {
  source: "original-art",
  eyesClosed: "eye-overlay",
  fallback: "original-poster",
  alt: "小伙伴",
  motion: "idle" as const,
};
const frames = new Map<number, FrameRequestCallback>();
const loads: { resolve: () => void; reject: (error: Error) => void }[] = [];
let frameId = 0;
let reduced = false;
let hidden = false;
let preferenceChanged: (() => void) | null = null;
let resourceId = 0;
const gl = {
  MAX_TEXTURE_SIZE: 1,
  VERTEX_SHADER: 2,
  FRAGMENT_SHADER: 3,
  COMPILE_STATUS: 4,
  LINK_STATUS: 5,
  BLEND: 6,
  ONE: 7,
  ONE_MINUS_SRC_ALPHA: 8,
  TEXTURE0: 20,
  TEXTURE_2D: 21,
  TEXTURE_WRAP_S: 22,
  TEXTURE_WRAP_T: 23,
  CLAMP_TO_EDGE: 24,
  TEXTURE_MIN_FILTER: 25,
  TEXTURE_MAG_FILTER: 26,
  LINEAR: 27,
  RGBA: 28,
  UNSIGNED_BYTE: 29,
  ARRAY_BUFFER: 30,
  DYNAMIC_DRAW: 31,
  FLOAT: 32,
  STATIC_DRAW: 33,
  ELEMENT_ARRAY_BUFFER: 34,
  COLOR_BUFFER_BIT: 35,
  TRIANGLES: 36,
  UNSIGNED_SHORT: 37,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 38,
  createProgram: vi.fn(() => ({ id: ++resourceId })),
  createShader: vi.fn(() => ({ id: ++resourceId })),
  createTexture: vi.fn(() => ({ id: ++resourceId })),
  createBuffer: vi.fn(() => ({ id: ++resourceId })),
  getShaderParameter: vi.fn(() => true),
  getProgramParameter: vi.fn(() => true),
  getParameter: vi.fn(() => 4096),
  getUniformLocation: vi.fn(() => ({})),
  getAttribLocation: vi.fn((_program: unknown, name: string) =>
    name === "a_position" ? 0 : 1,
  ),
  shaderSource: vi.fn(),
  compileShader: vi.fn(),
  attachShader: vi.fn(),
  linkProgram: vi.fn(),
  deleteShader: vi.fn(),
  deleteProgram: vi.fn(),
  deleteTexture: vi.fn(),
  deleteBuffer: vi.fn(),
  useProgram: vi.fn(),
  clearColor: vi.fn(),
  enable: vi.fn(),
  blendFunc: vi.fn(),
  pixelStorei: vi.fn(),
  activeTexture: vi.fn(),
  bindTexture: vi.fn(),
  texParameteri: vi.fn(),
  texImage2D: vi.fn(),
  uniform1i: vi.fn(),
  bindBuffer: vi.fn(),
  bufferData: vi.fn(),
  enableVertexAttribArray: vi.fn(),
  vertexAttribPointer: vi.fn(),
  viewport: vi.fn(),
  bufferSubData: vi.fn(),
  uniform1f: vi.fn(),
  clear: vi.fn(),
  drawElements: vi.fn(),
};

async function decodeAll() {
  await act(async () => {
    for (const load of loads) load.resolve();
  });
}
function step(time: number) {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(time);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  reduced = false;
  hidden = false;
  preferenceChanged = null;
  frameId = 0;
  resourceId = 0;
  frames.clear();
  loads.length = 0;
  gl.getShaderParameter.mockReturnValue(true);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    gl as unknown as WebGLRenderingContext,
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return reduced;
      },
      addEventListener: (_event: string, listener: () => void) => {
        preferenceChanged = listener;
      },
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1215;
      naturalHeight = 1295;
      src = "";
      decoding = "";
      onload = null;
      onerror = null;
      decode() {
        return new Promise<void>((resolve, reject) => {
          loads.push({ resolve, reject });
        });
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local companion rig", () => {
  it("exposes exactly one image only after both textures are decoded and frees resources", async () => {
    const { container, unmount } = render(<CompanionRig {...props} />);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img").tagName).toBe("IMG");
    await decodeAll();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img").tagName).toBe("CANVAS");
    expect(container.querySelector("[data-rig-ready=true]")).not.toBeNull();
    expect(gl.drawElements).toHaveBeenCalled();
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(2);
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(3);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  });

  it("keeps the original poster if WebGL or shader compilation is unavailable", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
    const first = render(<CompanionRig {...props} />);
    await decodeAll();
    expect(screen.getByRole("img").getAttribute("src")).toBe(props.fallback);
    expect(frames.size).toBe(0);
    first.unmount();
    gl.getShaderParameter.mockReturnValue(false);
    render(<CompanionRig {...props} />);
    await decodeAll();
    expect(screen.getByRole("img").tagName).toBe("IMG");
    expect(frames.size).toBe(0);
    expect(gl.deleteShader).toHaveBeenCalled();
  });

  it("never displays stale art while a replacement is loading or fails", async () => {
    const { rerender } = render(<CompanionRig {...props} />);
    await decodeAll();
    rerender(
      <CompanionRig {...props} source="new-art" fallback="new-poster" />,
    );
    expect(screen.getByRole("img").getAttribute("src")).toBe("new-poster");
    await act(async () => {
      loads[2].reject(new Error("decode failed"));
    });
    expect(screen.getByRole("img").getAttribute("src")).toBe("new-poster");
    expect(frames.size).toBe(0);
  });

  it("pauses hidden pages and resumes without leaping through feeding", async () => {
    const { container } = render(<CompanionRig {...props} motion="feed" />);
    await decodeAll();
    step(0);
    step(50);
    step(100);
    step(150);
    step(200);
    const fish = container.querySelector<SVGSVGElement>(
      ".lc-companion-rig-fish",
    )!;
    expect(fish.style.visibility).toBe("visible");
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    step(100000);
    expect(fish.style.visibility).toBe("visible");
    expect(container.querySelector("clipPath rect")?.getAttribute("x")).toBe(
      "0",
    );
  });

  it("uses the original still for reduced motion and waits for a fresh paint when restored", async () => {
    reduced = true;
    render(<CompanionRig {...props} />);
    expect(loads).toHaveLength(0);
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
    act(() => {
      reduced = false;
      preferenceChanged?.();
    });
    expect(screen.getByRole("img").tagName).toBe("IMG");
    await decodeAll();
    expect(screen.getByRole("img").tagName).toBe("CANVAS");
    act(() => {
      reduced = true;
      preferenceChanged?.();
    });
    expect(screen.getByRole("img").tagName).toBe("IMG");
    expect(frames.size).toBe(0);
    act(() => {
      reduced = false;
      preferenceChanged?.();
    });
    expect(screen.getByRole("img").tagName).toBe("IMG");
    await decodeAll();
    expect(screen.getByRole("img").tagName).toBe("CANVAS");
  });

  it("replays the same feeding action without decoding the textures again", async () => {
    const { container, rerender } = render(
      <CompanionRig {...props} motion="feed" playbackKey={1} />,
    );
    await decodeAll();
    for (let time = 0; time <= 1200; time += 40) step(time);
    expect(
      Number(container.querySelector("clipPath rect")?.getAttribute("x")),
    ).toBeGreaterThan(30);
    rerender(<CompanionRig {...props} motion="feed" playbackKey={2} />);
    step(1240);
    expect(
      container.querySelector<SVGSVGElement>(".lc-companion-rig-fish")!.style
        .visibility,
    ).toBe("hidden");
    expect(loads).toHaveLength(2);
    expect(gl.texImage2D).toHaveBeenCalledTimes(2);
  });

  it("falls back immediately after a lost graphics context", async () => {
    const { container } = render(<CompanionRig {...props} />);
    await decodeAll();
    fireEvent(
      container.querySelector("canvas")!,
      new Event("webglcontextlost", { cancelable: true }),
    );
    expect(screen.getByRole("img").tagName).toBe("IMG");
    expect(frames.size).toBe(0);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(2);
  });
});
