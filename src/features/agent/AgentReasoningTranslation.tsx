import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ViewActivityContext } from "@/components/ViewActivityContext";
import {
  agentApi,
  type AgentReasoningTranslationProvider,
} from "@/lib/api/agent";

const STORAGE_KEY = "lolicode:agent:reasoningTranslation";
const TARGET_LANGUAGE_KEY = "lolicode:agent:reasoningTranslationTarget";
const PREFERENCE_EVENT = "lolicode:reasoning-translation-preference";
const MAX_FRAGMENT_LENGTH = 4000;
const MAX_CACHED_FRAGMENTS = 64;
const targetLanguages = {
  "zh-CN": ["settings.languageOptionChinese", "简体中文"],
  "zh-TW": ["settings.languageOptionTraditionalChinese", "繁體中文"],
  en: ["settings.languageOptionEnglish", "English"],
  ja: ["settings.languageOptionJapanese", "日本語"],
} as const;
type TargetLanguage = "auto" | keyof typeof targetLanguages;
type TranslationPreference =
  `${AgentReasoningTranslationProvider}:${"enabled" | "disabled"}`;

function translationPreferenceSnapshot(): TranslationPreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    // The previous boolean opt-in applied only to Bing.
    if (value === "true") return "bing:enabled";
    if (
      value === "bing:enabled" ||
      value === "google:enabled" ||
      value === "google:disabled"
    ) {
      return value;
    }
  } catch {
    // A restricted storage context starts with translation disabled.
  }
  return "bing:disabled";
}

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === STORAGE_KEY ||
      event.key === TARGET_LANGUAGE_KEY ||
      event.key === null
    ) {
      callback();
    }
  };
  window.addEventListener(PREFERENCE_EVENT, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PREFERENCE_EVENT, callback);
    window.removeEventListener("storage", onStorage);
  };
}

function targetLanguageSnapshot(): TargetLanguage {
  try {
    const value = localStorage.getItem(TARGET_LANGUAGE_KEY);
    if (value && Object.hasOwn(targetLanguages, value))
      return value as keyof typeof targetLanguages;
  } catch {
    // A restricted storage context still follows the interface language.
  }
  return "auto";
}

function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(PREFERENCE_EVENT));
}

interface Fragment {
  text: string;
  separator: string;
  complete: boolean;
}

// Follow Harness reasoning translation's paragraph boundaries and UTF-16 limit.
function reasoningFragments(text: string, streaming: boolean): Fragment[] {
  const fragments: Fragment[] = [];
  const paragraphBreak = /\r?\n(?:[\t ]*\r?\n)+/g;
  let start = 0;
  for (const match of [...text.matchAll(paragraphBreak), null]) {
    let paragraph = text.slice(start, match?.index ?? text.length);
    while (paragraph.length > MAX_FRAGMENT_LENGTH) {
      let cut = MAX_FRAGMENT_LENGTH;
      if (/[\uD800-\uDBFF]/.test(paragraph.charAt(cut - 1))) cut -= 1;
      const whitespace = paragraph.slice(0, cut).search(/\s+\S*$/);
      if (whitespace > 0) cut = whitespace;
      const prefix = paragraph.slice(0, cut);
      paragraph = paragraph.slice(cut);
      const separator = paragraph.match(/^\s*/)?.[0] ?? "";
      paragraph = paragraph.slice(separator.length);
      fragments.push({ text: prefix, separator, complete: true });
    }
    const separator = match?.[0] ?? "";
    fragments.push({
      text: paragraph,
      separator,
      complete: !!match || !streaming,
    });
    if (match) start = match.index + separator.length;
  }
  return fragments;
}

export interface AgentReasoningTranslationCache {
  provider: AgentReasoningTranslationProvider;
  language: string;
  fragments: Map<string, string>;
}

interface PendingTranslation {
  id: string;
  result: Promise<string>;
  subscribers: number;
}

interface SharedReasoningTranslations {
  fragments: Map<string, string>;
  pending: Map<string, PendingTranslation>;
}

export type AgentReasoningSessionTranslations = Map<
  string,
  SharedReasoningTranslations
>;

export const AgentReasoningSessionCache = createContext<
  AgentReasoningSessionTranslations | undefined
>(undefined);

function acquireTranslation(
  text: string,
  cache: AgentReasoningTranslationCache,
  pending: Map<string, PendingTranslation>,
  completed?: Map<string, string>,
): PendingTranslation {
  const existing = pending.get(text);
  if (existing) {
    existing.subscribers += 1;
    return existing;
  }

  const id = crypto.randomUUID();
  const result = agentApi.translateReasoning(
    text,
    cache.language,
    id,
    cache.provider,
  );
  const request = { id, result, subscribers: 1 };
  pending.set(text, request);

  const settle = (translation?: string) => {
    // A cancelled request may settle after a new request claims the same text.
    if (pending.get(text) !== request) return;
    pending.delete(text);
    if (!completed || typeof translation !== "string" || !translation.trim())
      return;
    if (completed.size >= MAX_CACHED_FRAGMENTS) {
      const oldest = completed.keys().next();
      if (!oldest.done) completed.delete(oldest.value);
    }
    completed.set(text, translation);
  };
  void result.then(settle, () => settle());
  return request;
}

interface TranslationView {
  provider: AgentReasoningTranslationProvider;
  language: string;
  source: string;
  text: string;
  translated: boolean;
  pending: boolean;
  failed: boolean;
}

function reasoningTranslation(
  cache: AgentReasoningTranslationCache,
  shared: SharedReasoningTranslations | undefined,
  publish: (view: TranslationView) => void,
) {
  let source = "";
  let fragments: Fragment[] = [];
  const pending = shared?.pending ?? new Map<string, PendingTranslation>();
  let current: { text: string; request: PendingTranslation } | undefined;
  let disposed = false;
  let failed = false;

  const emit = () => {
    if (disposed) return;
    let translated = false;
    const text = fragments
      .map((fragment) => {
        const result = fragment.complete
          ? cache.fragments.get(fragment.text)
          : undefined;
        if (result !== undefined && result !== fragment.text) translated = true;
        return (result ?? fragment.text) + fragment.separator;
      })
      .join("");
    publish({
      provider: cache.provider,
      language: cache.language,
      source,
      text,
      translated,
      pending: !!current,
      failed,
    });
  };
  const next = () =>
    fragments.find(
      (fragment) =>
        fragment.complete &&
        fragment.text.trim() &&
        !cache.fragments.has(fragment.text),
    );

  async function run() {
    if (disposed || failed || current) return;
    let fragment = next();
    try {
      while (fragment && !disposed) {
        let result = shared?.fragments.get(fragment.text);
        if (result === undefined) {
          // A different view can change consent before this effect is disposed.
          if (translationPreferenceSnapshot() !== `${cache.provider}:enabled`)
            return;
          const request = acquireTranslation(
            fragment.text,
            cache,
            pending,
            shared?.fragments,
          );
          current = { text: fragment.text, request };
          emit();
          result = await request.result;
          if (disposed) return;
          if (!result.trim()) throw new Error("Empty translation");
          current = undefined;
        }
        cache.fragments.set(fragment.text, result);
        fragment = next();
      }
    } catch {
      failed = true;
    } finally {
      current = undefined;
      emit();
    }
  }

  return {
    update(text: string, streaming: boolean) {
      source = text;
      fragments = reasoningFragments(text, streaming);
      emit();
      // Let a discarded render dispose before dispatching its first request.
      queueMicrotask(() => void run());
    },
    retry() {
      failed = false;
      void run();
    },
    dispose() {
      disposed = true;
      if (!current) return;
      const { text, request } = current;
      current = undefined;
      request.subscribers -= 1;
      if (request.subscribers !== 0 || pending.get(text) !== request) return;
      pending.delete(text);
      void agentApi.cancelReasoningTranslation(request.id).catch(() => {});
    },
  };
}

export function AgentReasoningTranslation({
  text,
  streaming,
  cache,
  original,
}: {
  text: string;
  streaming: boolean;
  cache: MutableRefObject<AgentReasoningTranslationCache | undefined>;
  original: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const preference = useSyncExternalStore(
    subscribe,
    translationPreferenceSnapshot,
    (): TranslationPreference => "bing:disabled",
  );
  const provider = preference.startsWith("google:") ? "google" : "bing";
  const enabled = preference.endsWith(":enabled");
  const targetLanguage = useSyncExternalStore(
    subscribe,
    targetLanguageSnapshot,
    (): TargetLanguage => "auto",
  );
  const active = useContext(ViewActivityContext);
  const sessionCache = useContext(AgentReasoningSessionCache);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const localeLanguage =
    locale === "zh-TW"
      ? "zh-TW"
      : locale === "ja" || locale === "en"
        ? locale
        : "zh-CN";
  const language = targetLanguage === "auto" ? localeLanguage : targetLanguage;
  const consentId = useId();
  const [view, setView] = useState<TranslationView>();
  const [showOriginal, setShowOriginal] = useState(false);
  const translation = useRef<ReturnType<typeof reasoningTranslation>>();

  useEffect(() => {
    if (!enabled || !active) return;
    if (
      cache.current?.provider !== provider ||
      cache.current.language !== language
    )
      cache.current = { provider, language, fragments: new Map() };
    const cacheKey = `${provider}:${language}`;
    let shared = sessionCache?.get(cacheKey);
    if (sessionCache && !shared) {
      shared = { fragments: new Map(), pending: new Map() };
      sessionCache.set(cacheKey, shared);
    }
    const controller = reasoningTranslation(cache.current, shared, setView);
    translation.current = controller;
    return () => {
      controller.dispose();
      translation.current = undefined;
    };
  }, [active, cache, enabled, language, provider, sessionCache]);

  useEffect(() => {
    translation.current?.update(text, streaming);
  }, [active, enabled, language, provider, sessionCache, streaming, text]);

  const current =
    enabled &&
    view?.provider === provider &&
    view.language === language &&
    view.source === text
      ? view
      : undefined;
  const translated = current?.translated && !current.failed && !showOriginal;
  const actionClassName = "shrink-0 text-action-text hover:underline";
  const selectClassName =
    "max-w-full rounded border border-border bg-surface px-1 text-fg-2";
  const googleName = t("agentReasoningTranslation.google", {
    defaultValue: "Google 翻译",
  });
  return (
    <>
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-3">
        <label className="inline-flex items-center gap-1">
          {t("agentReasoningTranslation.provider", {
            defaultValue: "翻译服务",
          })}
          <select
            className={selectClassName}
            value={provider}
            onChange={(event) =>
              savePreference(
                STORAGE_KEY,
                `${event.currentTarget.value}:disabled`,
              )
            }
          >
            <option value="bing">Microsoft Bing</option>
            <option value="google">{googleName}</option>
          </select>
        </label>
        <label className="inline-flex items-center gap-1">
          {t("agentReasoningTranslation.targetLanguage", {
            defaultValue: "翻译成",
          })}
          <select
            className={selectClassName}
            value={targetLanguage}
            onChange={(event) =>
              savePreference(TARGET_LANGUAGE_KEY, event.currentTarget.value)
            }
          >
            <option value="auto">
              {t("agentReasoningTranslation.followInterfaceLanguage", {
                defaultValue: "跟随界面语言",
              })}
            </option>
            {Object.entries(targetLanguages).map(
              ([value, [label, fallback]]) => (
                <option key={value} value={value}>
                  {t(label, { defaultValue: fallback })}
                </option>
              ),
            )}
          </select>
        </label>
        {enabled ? (
          <>
            {current?.translated && !current.failed && (
              <button
                type="button"
                className={actionClassName}
                onClick={() => setShowOriginal(!showOriginal)}
              >
                {translated
                  ? t("agentReasoningTranslation.original", {
                      defaultValue: "显示原文",
                    })
                  : t("agentReasoningTranslation.translated", {
                      defaultValue: "显示译文",
                    })}
              </button>
            )}
            {current?.pending && (
              <span role="status">
                {t("agentReasoningTranslation.pending", {
                  defaultValue: "正在翻译…",
                })}
              </span>
            )}
            {current?.failed && (
              <>
                <span role="status">
                  {t("agentReasoningTranslation.failed", {
                    defaultValue: "翻译失败，已显示原文",
                  })}
                </span>
                <button
                  type="button"
                  className={actionClassName}
                  onClick={() => translation.current?.retry()}
                >
                  {t("agentReasoningTranslation.retry", {
                    defaultValue: "重试翻译",
                  })}
                </button>
              </>
            )}
            <button
              type="button"
              className="shrink-0 hover:underline"
              onClick={() =>
                savePreference(STORAGE_KEY, `${provider}:disabled`)
              }
            >
              {t("agentReasoningTranslation.disable", {
                defaultValue: "关闭自动翻译",
              })}
            </button>
          </>
        ) : (
          <>
            <span id={consentId}>
              {t("agentReasoningTranslation.consent", {
                defaultValue: "开启后，展开的思考内容会发送至 {{provider}}。",
                provider: provider === "bing" ? "Microsoft Bing" : googleName,
              })}
            </span>
            <button
              type="button"
              className={actionClassName}
              aria-describedby={consentId}
              onClick={() => savePreference(STORAGE_KEY, `${provider}:enabled`)}
            >
              {t("agentReasoningTranslation.enable", {
                defaultValue: "开启自动翻译",
              })}
            </button>
          </>
        )}
      </div>
      {translated ? (
        <p
          lang={language}
          className="whitespace-pre-wrap break-words text-caption text-fg-2"
        >
          {current.text}
        </p>
      ) : (
        original
      )}
    </>
  );
}
