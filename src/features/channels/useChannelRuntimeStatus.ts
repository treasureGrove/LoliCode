import { useCallback, useEffect, useRef, useState } from "react";

export function useChannelRuntimeStatus<T>(
  read: () => Promise<T>,
  refreshToken: unknown,
  intervalMs: number,
) {
  const [status, setStatus] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const reading = useRef(false);

  const refresh = useCallback(
    async (showProgress = false) => {
      const request = ++generation.current;
      reading.current = true;
      if (showProgress) setLoading(true);
      try {
        const next = await read();
        if (!mounted.current || request !== generation.current) return;
        setStatus(next);
        setFailed(false);
      } catch {
        if (mounted.current && request === generation.current) setFailed(true);
      } finally {
        if (mounted.current && request === generation.current) {
          reading.current = false;
          setLoading(false);
        }
      }
    },
    [read],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      reading.current = false;
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    const onForeground = () => {
      if (!document.hidden) void refresh();
    };
    const timer = window.setInterval(() => {
      if (!reading.current) onForeground();
    }, intervalMs);
    window.addEventListener("focus", onForeground);
    document.addEventListener("visibilitychange", onForeground);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onForeground);
      document.removeEventListener("visibilitychange", onForeground);
    };
  }, [intervalMs, refresh]);

  const applyStatus = (next: T | ((previous: T | null) => T)) => {
    if (!mounted.current) return;
    generation.current += 1;
    reading.current = false;
    setStatus(next);
    setLoading(false);
    setFailed(false);
  };

  return { status, loading, failed, mounted, refresh, applyStatus };
}
