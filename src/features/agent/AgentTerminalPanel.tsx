import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Play, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import {
  agentTerminalApi,
  type AgentTerminalOutput,
} from "@/lib/api/agent-terminal";
import "./agent-workspace-panels.css";

type TerminalPanelProps = {
  sessionId: string;
  terminalId: string;
  projectPath: string;
  visible: boolean;
  onClose: () => void;
};

export function AgentTerminalPanel({
  sessionId,
  terminalId,
  projectPath,
  visible,
  onClose,
}: TerminalPanelProps) {
  const container = useRef<HTMLDivElement>(null);
  const connection = useRef<{
    start: () => Promise<void>;
    fit: () => void;
  } | null>(null);
  const visibleRef = useRef(visible);
  const [attached, setAttached] = useState(false);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    visibleRef.current = visible;
    if (visible) connection.current?.fit();
  }, [visible]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    setAttached(false);
    setRunning(false);
    setExitCode(null);
    setError(undefined);
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      scrollback: 4_000,
      theme: {
        background: "#14161b",
        foreground: "#e5e7eb",
        cursor: "#e5e7eb",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    let active = true;
    let live = false;
    let instance: string | null = null;
    let cursor = 0;
    let pending: AgentTerminalOutput[] | null = [];
    const showError = (reason: unknown) => {
      if (active) setError(String(reason));
    };
    const apply = (event: AgentTerminalOutput) => {
      if (event.instance !== instance || event.cursor <= cursor) return;
      cursor = event.cursor;
      if (event.data) terminal.write(event.data);
      if (event.exitCode !== null) {
        live = false;
        setRunning(false);
        setExitCode(event.exitCode);
      }
    };
    const sync = async () => {
      const snapshot = await agentTerminalApi.snapshot(sessionId, terminalId);
      if (!active) return;
      if (snapshot.instance !== instance) terminal.reset();
      instance = snapshot.instance;
      cursor = snapshot.cursor;
      live = snapshot.running;
      setRunning(live);
      setExitCode(snapshot.exitCode);
      if (snapshot.data) terminal.write(snapshot.data);
      pending?.forEach(apply);
      pending = null;
    };
    const listener = agentTerminalApi.listen((event) => {
      if (
        !active ||
        event.sessionId !== sessionId ||
        event.terminalId !== terminalId
      )
        return;
      if (pending) pending.push(event);
      else apply(event);
    });
    const ready = listener.then(sync);
    void ready
      .then(() => {
        if (active) setAttached(true);
      })
      .catch(showError);
    const fitVisible = () => {
      if (
        visibleRef.current &&
        element.clientWidth > 16 &&
        element.clientHeight > 16
      )
        fit.fit();
    };
    const resize = new ResizeObserver(fitVisible);
    resize.observe(element);
    const resized = terminal.onResize(({ cols, rows }) => {
      if (live && cols >= 2 && rows >= 2) {
        void agentTerminalApi
          .resize(
            sessionId,
            terminalId,
            Math.min(512, cols),
            Math.min(256, rows),
          )
          .catch(showError);
      }
    });
    const input = terminal.onData((data) => {
      if (live)
        void agentTerminalApi
          .write(sessionId, terminalId, data)
          .catch(showError);
    });
    connection.current = {
      fit: fitVisible,
      start: async () => {
        await ready;
        if (!active) return;
        fitVisible();
        pending = [];
        try {
          await agentTerminalApi.start(
            sessionId,
            terminalId,
            Math.max(2, Math.min(512, terminal.cols)),
            Math.max(2, Math.min(256, terminal.rows)),
          );
          await sync();
          if (active && visibleRef.current) terminal.focus();
        } finally {
          pending = null;
        }
      },
    };
    fitVisible();
    return () => {
      active = false;
      connection.current = null;
      void listener.then((unlisten) => unlisten()).catch(() => {});
      resize.disconnect();
      resized.dispose();
      input.dispose();
      terminal.dispose();
    };
  }, [sessionId, terminalId, projectPath]);

  return (
    <section className="agent-workspace-panel" aria-label="交互终端">
      <header className="agent-workspace-toolbar">
        <span title={projectPath}>交互终端</span>
        {!running && (
          <button
            type="button"
            disabled={!attached || starting}
            onClick={async () => {
              setStarting(true);
              setError(undefined);
              try {
                await connection.current?.start();
              } catch (reason) {
                setError(String(reason));
              } finally {
                setStarting(false);
              }
            }}
          >
            <Play size={14} />
            {starting
              ? "启动中…"
              : exitCode === null
                ? "启动终端"
                : "重新启动终端"}
          </button>
        )}
        <button
          type="button"
          aria-label="关闭交互终端"
          title="关闭交互终端"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {error && (
        <div className="agent-workspace-note" role="alert">
          {error}
        </div>
      )}
      {exitCode !== null && !running && (
        <div className="agent-workspace-note">终端已退出（{exitCode}）</div>
      )}
      <div className="agent-workspace-xterm" ref={container} />
    </section>
  );
}
