import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { Source } from "@/features/chat-demo/services/chat/view";
import { useSettings as useChatDemoSettings } from "@/features/chat-demo/services/settings";
import {
  stopReadAloud as stopChatDemoReadAloud,
  toggleReadAloud as toggleChatDemoReadAloud,
  useReadAloud as useChatDemoReadAloud,
} from "@/features/chat-demo/services/speech/readAloud";
import {
  startRecording,
  type Recording,
} from "@/features/chat-demo/services/speech/recorder";
import { transcribe } from "@/features/chat-demo/services/api/speech";
import type {
  TavernCharacter,
  TavernMessage,
  TavernStory,
} from "@/lib/api/tavern";

export interface TavernDraftAttachment {
  id: string;
  name: string;
  kind: "image" | "text";
  size: number;
  content: string;
  dataUrl?: string;
}

export interface ParsedTavernMessage {
  thinking: string | null;
  thinkingComplete: boolean;
  content: string;
  attachments: Array<{
    name: string;
    kind: "image" | "text";
    dataUrl?: string;
  }>;
  sources: Source[];
  isRichMarkdown: boolean;
}

const ATTACHMENT_HEADER_RE =
  /^<!--\s*tavern-attachments:([A-Za-z0-9+/=]+)\s*-->\n?/;
const SOURCES_FOOTER_RE = /\n?<!--\s*tavern-sources:([A-Za-z0-9+/=]+)\s*-->$/;
const THINK_BLOCK_RE = /^<think>([\s\S]*?)(?:<\/think>\s*|$)/i;

const RICH_MARKDOWN_RE =
  /```|`[^`\n]+`|\$\$|\$[^\s$][^$\n]*\$|^#{1,6}\s+|^\s*[-*+]\s+|^\s*\d+\.\s+|^>\s+|\|[^\n]+\||\*\*[^*\n]+\*\*|\[[^\]]+\]\([^)]+\)|\[citation:\d+\]/m;

function encodeBase64Utf8(json: string): string {
  try {
    const bytes = strToU8(json);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch {
    return "";
  }
}

function decodeBase64Utf8<T>(encoded: string): T | null {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return JSON.parse(strFromU8(bytes)) as T;
  } catch {
    return null;
  }
}

export function formatOutgoingTavernMessage({
  text,
  attachments,
  deepThink,
  webSearch,
}: {
  text: string;
  attachments: TavernDraftAttachment[];
  deepThink: boolean;
  webSearch: boolean;
}): string {
  let body = text.trim();

  if (attachments.length > 0) {
    const meta = attachments.map((item) => ({
      name: item.name,
      kind: item.kind,
      ...(item.dataUrl ? { dataUrl: item.dataUrl } : {}),
    }));
    const encoded = encodeBase64Utf8(JSON.stringify(meta));
    const textSnippets = attachments
      .filter((item) => item.kind === "text" && item.content.trim())
      .map(
        (item) =>
          `\n\n[参考附件《${item.name}》内容]：\n\`\`\`\n${item.content.slice(0, 6000)}\n\`\`\``,
      )
      .join("");
    body = `${encoded ? `<!-- tavern-attachments:${encoded} -->\n` : ""}${body}${textSnippets}`;
  }

  const hints: string[] = [];
  if (deepThink) {
    hints.push(
      "（请先在 <think>...</think> 标签内简短推演当前情境与角色的内心活动，随后在标签外给出符合角色口吻的正式回应。）",
    );
  }
  if (webSearch) {
    hints.push(
      "（请结合相关背景知识与上下文信息作答；若引用了外部来源或网页链接，可使用 Markdown 链接或 [citation:1] 标注出处。）",
    );
  }
  if (hints.length > 0) {
    body = `${body}\n\n${hints.join("")}`;
  }

  return body;
}

const MODE_HINTS_STRIP_RE =
  /\n\n（请(?:先在 <think>[\s\S]*?）|结合相关背景知识[\s\S]*?）)+$/;

export function parseTavernRichMessage(rawText: string): ParsedTavernMessage {
  let working = rawText ?? "";
  let attachments: Array<{
    name: string;
    kind: "image" | "text";
    dataUrl?: string;
  }> = [];
  let sources: Source[] = [];

  const attachMatch = working.match(ATTACHMENT_HEADER_RE);
  if (attachMatch) {
    const parsed = decodeBase64Utf8<
      Array<{ name: string; kind: "image" | "text"; dataUrl?: string }>
    >(attachMatch[1]);
    if (Array.isArray(parsed)) {
      attachments = parsed;
    }
    working = working.slice(attachMatch[0].length);
  }

  const sourcesMatch = working.match(SOURCES_FOOTER_RE);
  if (sourcesMatch) {
    const parsed = decodeBase64Utf8<Source[]>(sourcesMatch[1]);
    if (Array.isArray(parsed)) {
      sources = parsed;
    }
    working = working.slice(0, working.length - sourcesMatch[0].length);
  }

  // Strip internal mode hints from user bubble display while keeping clean text
  working = working.replace(MODE_HINTS_STRIP_RE, "");

  let thinking: string | null = null;
  let thinkingComplete = true;

  const trimmedStart = working.trimStart();
  const thinkMatch = trimmedStart.match(THINK_BLOCK_RE);
  if (thinkMatch) {
    thinking = thinkMatch[1].trim();
    thinkingComplete = /<\/think>/i.test(thinkMatch[0]);
    working = trimmedStart.slice(thinkMatch[0].length);
  }

  // Extract inline markdown links as reference sources if none were explicitly attached
  if (sources.length === 0 && /\[citation:\d+\]/.test(working)) {
    const linkMatches = Array.from(
      working.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g),
    );
    sources = linkMatches.map((match, idx) => ({
      index: idx + 1,
      title: match[1],
      url: match[2],
      publishedAt: null,
      snippet: "",
      siteIcon: "",
      siteName: (() => {
        try {
          return new URL(match[2]).hostname;
        } catch {
          return "Web";
        }
      })(),
    }));
  }

  const content = working || (thinking ? "" : rawText);
  const isRichMarkdown =
    sources.length > 0 || RICH_MARKDOWN_RE.test(content);

  return {
    thinking,
    thinkingComplete,
    content,
    attachments,
    sources,
    isRichMarkdown,
  };
}

// ─── Message Branching (Version Switcher) Store ─────────────────────────────

const BRANCH_STORAGE_KEY = "lolicode_tavern_branches_v1";

export interface TavernMessageBranchState {
  versions: Record<string, string[]>;
  activeIndex: Record<string, number>;
  addVersion: (key: string, initialText: string, newText: string) => void;
  selectVersion: (key: string, index: number) => void;
}

function loadStoredBranches(): {
  versions: Record<string, string[]>;
  activeIndex: Record<string, number>;
} {
  try {
    const raw = localStorage.getItem(BRANCH_STORAGE_KEY);
    if (!raw) return { versions: {}, activeIndex: {} };
    const parsed = JSON.parse(raw) as {
      versions?: Record<string, string[]>;
      activeIndex?: Record<string, number>;
    };
    return {
      versions: parsed.versions ?? {},
      activeIndex: parsed.activeIndex ?? {},
    };
  } catch {
    return { versions: {}, activeIndex: {} };
  }
}

function saveStoredBranches(
  versions: Record<string, string[]>,
  activeIndex: Record<string, number>,
) {
  try {
    localStorage.setItem(
      BRANCH_STORAGE_KEY,
      JSON.stringify({ versions, activeIndex }),
    );
  } catch {
    // Ignore storage quota errors
  }
}

export const useTavernBranches = create<TavernMessageBranchState>((set) => {
  const initial = loadStoredBranches();
  return {
    versions: initial.versions,
    activeIndex: initial.activeIndex,
    addVersion: (key, initialText, newText) =>
      set((state) => {
        const existing = state.versions[key] ?? [initialText];
        const nextList = existing.includes(newText)
          ? existing
          : [...existing, newText];
        const nextIdx = nextList.length - 1;
        const versions = { ...state.versions, [key]: nextList };
        const activeIndex = { ...state.activeIndex, [key]: nextIdx };
        saveStoredBranches(versions, activeIndex);
        return { versions, activeIndex };
      }),
    selectVersion: (key, index) =>
      set((state) => {
        const activeIndex = { ...state.activeIndex, [key]: index };
        saveStoredBranches(state.versions, activeIndex);
        return { activeIndex };
      }),
  };
});

// ─── Dual-Engine Read Aloud (DeepSeek PCM TTS + Native SpeechSynthesis) ────

interface LocalSpeechState {
  messageId: string | null;
  status: "idle" | "playing";
}

const useLocalSpeech = create<LocalSpeechState>(() => ({
  messageId: null,
  status: "idle",
}));

export function stopTavernReadAloud() {
  stopChatDemoReadAloud();
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore synthesis cancellation errors
    }
  }
  useLocalSpeech.setState({ messageId: null, status: "idle" });
}

export function toggleTavernReadAloud(
  messageId: string,
  rawText: string,
  onError?: (message: string) => void,
) {
  const parsed = parseTavernRichMessage(rawText);
  const cleanText = parsed.content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
  if (!cleanText) return;

  const apiKey = useChatDemoSettings.getState().apiKey?.trim();
  if (apiKey) {
    toggleChatDemoReadAloud(messageId, cleanText, () => {
      fallbackWebSpeech(messageId, cleanText, onError);
    });
    return;
  }

  fallbackWebSpeech(messageId, cleanText, onError);
}

function fallbackWebSpeech(
  messageId: string,
  text: string,
  onError?: (message: string) => void,
) {
  const currentId = useLocalSpeech.getState().messageId;
  stopTavernReadAloud();
  if (currentId === messageId) return;

  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    onError?.("当前环境不支持语音朗读");
    return;
  }

  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = /[\u4e00-\u9fa5]/.test(text) ? "zh-CN" : "en-US";
    utterance.rate = 1.02;
    utterance.onend = () => {
      if (useLocalSpeech.getState().messageId === messageId) {
        useLocalSpeech.setState({ messageId: null, status: "idle" });
      }
    };
    utterance.onerror = () => {
      if (useLocalSpeech.getState().messageId === messageId) {
        useLocalSpeech.setState({ messageId: null, status: "idle" });
      }
    };
    useLocalSpeech.setState({ messageId, status: "playing" });
    window.speechSynthesis.speak(utterance);
  } catch {
    useLocalSpeech.setState({ messageId: null, status: "idle" });
    onError?.("语音朗读启动失败");
  }
}

export function useTavernReadAloudStatus(messageId: string): "idle" | "loading" | "playing" {
  const dsStatus = useChatDemoReadAloud((state) =>
    state.messageId === messageId ? state.status : "idle",
  );
  const localStatus = useLocalSpeech((state) =>
    state.messageId === messageId ? state.status : "idle",
  );
  if (dsStatus !== "idle") return dsStatus;
  return localStatus;
}

// ─── Dual-Engine Voice Input with Real-Time Audio Spectrum ─────────────────

interface BrowserSpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function createBrowserSpeechRecognition(): BrowserSpeechRecognitionInstance | null {
  if (typeof window === "undefined") return null;
  const ctor =
    (window as unknown as Record<string, unknown>).SpeechRecognition ??
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  if (typeof ctor !== "function") return null;
  try {
    const instance = new (ctor as new () => BrowserSpeechRecognitionInstance)();
    instance.lang = "zh-CN";
    instance.continuous = true;
    instance.interimResults = false;
    return instance;
  } catch {
    return null;
  }
}

export function useTavernVoiceInput(
  onTranscript: (text: string) => void,
  onError?: (message: string) => void,
) {
  const [status, setStatus] = useState<"idle" | "recording" | "transcribing">(
    "idle",
  );
  const [seconds, setSeconds] = useState(0);
  const recordingRef = useRef<Recording | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognitionInstance | null>(null);
  const speechBufferRef = useRef<string>("");
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const cleanup = useCallback(() => {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    try {
      recognitionRef.current?.abort();
    } catch {
      // Ignore abort errors
    }
    recognitionRef.current = null;
  }, []);

  const stopAndTranscribe = useCallback(async () => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    try {
      recognition?.stop();
    } catch {
      // Ignore stop errors
    }

    if (!recording) {
      setStatus("idle");
      return;
    }

    setStatus("transcribing");
    try {
      let audio: Blob | null = null;
      try {
        audio = await recording.stop();
      } finally {
        recording.cancel();
      }

      if (speechBufferRef.current.trim()) {
        onTranscriptRef.current(speechBufferRef.current.trim());
        speechBufferRef.current = "";
        setStatus("idle");
        return;
      }

      const apiKey = useChatDemoSettings.getState().apiKey?.trim();
      if (apiKey && audio) {
        const controller = new AbortController();
        const text = await transcribe(apiKey, audio, controller.signal);
        if (text.trim()) {
          onTranscriptRef.current(text.trim());
        } else {
          onErrorRef.current?.("未识别到清晰语音，请重试");
        }
      } else {
        onErrorRef.current?.(
          "未检测到语音内容（可检查麦克风权限或在设置中配置语音转写服务）",
        );
      }
    } catch {
      onErrorRef.current?.("语音转写失败，请检查麦克风或网络设置");
    } finally {
      setStatus("idle");
    }
  }, []);

  const toggle = useCallback(async () => {
    if (status === "recording") {
      await stopAndTranscribe();
      return;
    }
    if (status === "transcribing") {
      cleanup();
      setStatus("idle");
      return;
    }

    speechBufferRef.current = "";
    setStatus("recording");
    try {
      const recognition = createBrowserSpeechRecognition();
      if (recognition) {
        recognition.onresult = (event) => {
          const chunks: string[] = [];
          for (let i = 0; i < event.results.length; i += 1) {
            const item = event.results[i]?.[0]?.transcript;
            if (item) chunks.push(item);
          }
          speechBufferRef.current = chunks.join("");
        };
        try {
          recognition.start();
          recognitionRef.current = recognition;
        } catch {
          // Ignore browser speech recognition start errors
        }
      }

      const recording = await startRecording(() => {
        void stopAndTranscribe();
      });
      recordingRef.current = recording;
    } catch {
      cleanup();
      setStatus("idle");
      onErrorRef.current?.("无法访问麦克风，请检查系统录音权限");
    }
  }, [cleanup, status, stopAndTranscribe]);

  useEffect(() => {
    if (status !== "recording") return;
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => cleanup, [cleanup]);

  const getAnalyser = useCallback(
    () => recordingRef.current?.analyser ?? null,
    [],
  );

  return {
    status,
    seconds,
    getAnalyser,
    toggle,
    cancel: cleanup,
  };
}

// ─── ZIP Conversation Archive Export / Import (Coupled with Tavern) ────────

export interface TavernArchivePayload {
  format: "tavern-chat-archive-v1";
  exportedAt: number;
  character: TavernCharacter;
  stories: TavernStory[];
  branches?: {
    versions: Record<string, string[]>;
    activeIndex: Record<string, number>;
  };
}

export function exportTavernCharacterZip({
  character,
  stories,
}: {
  character: TavernCharacter;
  stories: TavernStory[];
}): void {
  const branchState = useTavernBranches.getState();
  const payload: TavernArchivePayload = {
    format: "tavern-chat-archive-v1",
    exportedAt: Date.now(),
    character,
    stories,
    branches: {
      versions: branchState.versions,
      activeIndex: branchState.activeIndex,
    },
  };

  // Also include chat-demo compatible sessions.json so the ZIP can be inspected or cross-imported
  const chatDemoSessions = stories.map((story) => ({
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    characterName: character.name,
    messages: story.messages.map((msg) => ({
      id: msg.id,
      role: msg.role,
      content: msg.text,
      createdAt: msg.createdAt,
    })),
  }));

  const zipped = zipSync({
    "tavern-archive.json": strToU8(JSON.stringify(payload, null, 2)),
    "character.json": strToU8(JSON.stringify(character, null, 2)),
    "sessions.json": strToU8(JSON.stringify(chatDemoSessions, null, 2)),
  });

  const blob = new Blob([zipped as unknown as BlobPart], {
    type: "application/zip",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeName = character.name.replace(/[\\/:*?"<>|]/g, "_") || "character";
  anchor.href = url;
  anchor.download = `tavern-${safeName}-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function parseTavernImportArchive(
  file: File,
  characterId: string,
  characterName: string,
): Promise<TavernStory[]> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let rawJsonText = "";

  if (file.name.toLowerCase().endsWith(".json")) {
    rawJsonText = strFromU8(buffer);
  } else {
    const files = unzipSync(buffer);
    const archiveEntry =
      files["tavern-archive.json"] ??
      files["sessions.json"] ??
      files["history.json"] ??
      Object.values(files)[0];
    if (!archiveEntry) {
      throw new Error("归档压缩包中没有找到有效的对话记录文件");
    }
    rawJsonText = strFromU8(archiveEntry);
  }

  const parsed = JSON.parse(rawJsonText) as Record<string, unknown> | unknown[];

  // Case 1: Native Tavern Archive
  if (
    !Array.isArray(parsed) &&
    parsed.format === "tavern-chat-archive-v1" &&
    Array.isArray(parsed.stories)
  ) {
    if (
      parsed.branches &&
      typeof parsed.branches === "object" &&
      parsed.branches !== null
    ) {
      const b = parsed.branches as {
        versions?: Record<string, string[]>;
        activeIndex?: Record<string, number>;
      };
      useTavernBranches.setState((current) => ({
        versions: { ...current.versions, ...(b.versions ?? {}) },
        activeIndex: { ...current.activeIndex, ...(b.activeIndex ?? {}) },
      }));
    }
    return (parsed.stories as TavernStory[]).map((story) => ({
      ...story,
      characterId,
      isGenerating: false,
    }));
  }

  // Case 2: deepseek-ai/chat-demo sessions array or history.json
  const sessionArray = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { sessions?: unknown[] }).sessions)
      ? ((parsed as { sessions: unknown[] }).sessions ?? [])
      : [];

  if (sessionArray.length === 0) {
    throw new Error("未能识别归档中的对话结构");
  }

  const now = Date.now();
  return sessionArray.map((item, idx) => {
    const raw = item as Record<string, unknown>;
    const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
    const messages: TavernMessage[] = rawMessages
      .map((m, mIdx) => {
        const msg = m as Record<string, unknown>;
        const role: "user" | "assistant" =
          msg.role === "user" ? "user" : "assistant";
        let text = "";
        if (typeof msg.text === "string") {
          text = msg.text;
        } else if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.fragments)) {
          text = (msg.fragments as Array<Record<string, unknown>>)
            .map((f) => (typeof f.content === "string" ? f.content : ""))
            .join("\n");
        }
        if (typeof msg.thinking === "string" && msg.thinking.trim()) {
          text = `<think>\n${msg.thinking.trim()}\n</think>\n\n${text}`;
        }
        return {
          id:
            typeof msg.id === "string"
              ? msg.id
              : `imported-msg-${now}-${idx}-${mIdx}`,
          role,
          text,
          createdAt:
            typeof msg.createdAt === "number" ? msg.createdAt : now + mIdx,
          failed: false,
        };
      })
      .filter((m) => m.text.trim().length > 0);

    return {
      id:
        typeof raw.id === "string" ? raw.id : `imported-story-${now}-${idx}`,
      characterId,
      title:
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim()
          : `与${characterName}的导入故事 ${idx + 1}`,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
      isGenerating: false,
      messages,
    };
  });
}
