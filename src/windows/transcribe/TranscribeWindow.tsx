import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/ipc";

/**
 * Voice V1 — minimal transcribe window (fork simplification).
 * Reuses the existing session/subtitle state; no new Rust IPC needed.
 * Tauri path uses clipboard-manager + save dialog when available, with
 * browser fallbacks so `vite dev` preview still works.
 */
export function TranscribeWindow() {
  const session = useStore((s) => s.session);
  const settings = useStore((s) => s.settings);
  const start = useStore((s) => s.start);
  const stop = useStore((s) => s.stop);
  const clearSubtitles = useStore((s) => s.clearSubtitles);
  const showSettings = useStore((s) => s.showSettings);

  const activeProvider = settings.profiles.find((p) => p.id === settings.activeProfileId);
  const credentialReady = activeProvider?.credentialState === "present";
  const isActive = session.isActive || session.status.kind === "connecting" || session.status.kind === "listening";
  const statusKind = session.status.kind;
  const errorMsg =
    statusKind === "error" && "message" in session.status
      ? (session.status as { kind: "error"; message: string }).message
      : null;

  const finals = useMemo(() => {
    const hist = session.subtitles.history.map((h) => h.source).filter(Boolean);
    const cur = session.subtitles.source;
    if (cur.isFinal && cur.text.trim() && !hist.includes(cur.text)) hist.push(cur.text);
    return hist;
  }, [session.subtitles.history, session.subtitles.source]);
  const draft = !session.subtitles.source.isFinal ? session.subtitles.source.text : "";
  const fullText = useMemo(() => finals.join("\n"), [finals]);

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) setEditText(fullText);
  }, [editing, fullText]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Auto-scroll live text to bottom
  useEffect(() => {
    if (!editing && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [finals.length, draft, editing]);

  const shortcutHint = navigator.platform.toLowerCase().includes("mac") ? "⌘⇧S" : "Ctrl+Shift+S";

  const toggle = async () => {
    if (statusKind === "connecting" || statusKind === "stopping") return;
    if (session.isActive) {
      await stop();
      setToast("已停止录音");
    } else {
      if (!credentialReady) {
        setToast("请先在设置中填入 DashScope API Key（sk-…）");
        void showSettings();
        return;
      }
      try {
        await start();
        setToast("开始录音… 对着麦克风说话");
      } catch (e) {
        setToast(e instanceof Error ? e.message : "启动失败，请检查麦克风权限与 API Key");
      }
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = navigator.platform.toLowerCase().includes("mac") ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void toggle();
      }
      if (e.key === "Escape" && session.isActive) void stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.isActive, credentialReady, statusKind]);

  const copyAll = async () => {
    const text = editing ? editText : fullText || draft;
    if (!text.trim()) {
      setToast("暂无可复制的文字");
      return;
    }
    // Prefer Tauri clipboard-manager when running as App
    if (isTauri) {
      try {
        const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
        await writeText(text);
        setToast("已复制到剪贴板");
        return;
      } catch {
        // fall through to browser clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setToast("已复制到剪贴板");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      setToast("已复制到剪贴板");
    }
  };

  const exportTxt = async () => {
    const text = editing ? editText : fullText || draft;
    if (!text.trim()) {
      setToast("暂无可导出的文字");
      return;
    }
    // Tauri: use save dialog + FS write if available
    if (isTauri) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        const filePath = await save({
          defaultPath: `mimi-transcribe-${new Date().toISOString().slice(0, 10)}.txt`,
          filters: [{ name: "Text", extensions: ["txt"] }],
        });
        if (!filePath) return;
        await writeTextFile(filePath, text);
        setToast("已导出 TXT");
        return;
      } catch {
        // fall through to browser download
      }
    }
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mimi-transcribe-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setToast("已导出 TXT");
  };

  const isListening = statusKind === "listening";

  return (
    <div className="min-h-screen w-full bg-[#0f1115] text-zinc-100 flex flex-col">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur px-4 py-3 flex items-center gap-3">
        <span
          className={`inline-flex h-2.5 w-2.5 rounded-full ${isActive ? "bg-red-500 animate-pulse shadow-[0_0_12px_rgba(239,68,68,0.6)]" : "bg-zinc-600"}`}
          aria-hidden
        />
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-none tracking-wide">
            {isListening
              ? "● 录音中"
              : statusKind === "connecting"
                ? "连接中…"
                : statusKind === "stopping"
                  ? "停止中…"
                  : session.isPaused
                    ? "已暂停"
                    : "就绪"}
            {!isActive && !credentialReady && <span className="ml-2 text-amber-400 font-normal">未配置 API Key</span>}
          </div>
          <div className="text-xs text-zinc-400">
            快捷键{" "}
            <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] border border-zinc-700">{shortcutHint}</kbd> 开始/停止 · Esc
            停止{errorMsg && <span className="ml-2 text-red-400">· {errorMsg}</span>}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void showSettings()}
            className="rounded-full border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700"
          >
            设置
          </button>
          <button
            type="button"
            onClick={() => void toggle()}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${isActive ? "bg-zinc-800 hover:bg-zinc-700 border border-zinc-700" : "bg-white text-zinc-900 hover:bg-zinc-100"}`}
          >
            {isActive ? "停止录音" : "开始录音"}
          </button>
          {!isTauri && <span className="text-xs text-zinc-500">(浏览器预览)</span>}
        </div>
      </header>

      <main className="flex-1 flex flex-col min-h-0">
        <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-4">
          {finals.length === 0 && !draft ? (
            <div className="h-full grid place-items-center py-16">
              <div className="text-center max-w-md">
                <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-zinc-800 border border-zinc-700">🎙️</div>
                <p className="text-sm text-zinc-300">对着麦克风说话，文字会实时显示在这里</p>
                <p className="mt-1 text-xs text-zinc-500">
                  已设为仅转写模式（Target = Original，不走翻译）。去
                  <button type="button" onClick={() => void showSettings()} className="mx-1 underline decoration-dotted underline-offset-2">
                    设置
                  </button>
                  填入 DashScope 的 <code className="px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700">sk-…</code> 后即可开始。
                </p>
                {!isActive && (
                  <button
                    type="button"
                    onClick={() => void toggle()}
                    className="mt-4 rounded-full bg-white px-4 py-2 text-sm font-medium text-zinc-900"
                  >
                    开始录音
                  </button>
                )}
              </div>
            </div>
          ) : editing ? (
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              placeholder="可在录音结束后修改文字…"
              className="min-h-[360px] w-full resize-y rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-[15px] leading-7 outline-none focus:border-zinc-700"
            />
          ) : (
            <div className="mx-auto max-w-3xl">
              <article className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 leading-7">
                {finals.map((line, i) => (
                  <p key={`${i}-${line.slice(0, 16)}`} className="whitespace-pre-wrap text-[15px] text-zinc-100">
                    {line}
                  </p>
                ))}
                {draft && <p className="whitespace-pre-wrap text-[15px] text-zinc-400 italic">…{draft}</p>}
              </article>
              <p className="mt-2 text-xs text-zinc-500">灰色斜体为实时草稿，黑色为已确认的最终结果。</p>
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800 bg-zinc-900/60 px-4 py-3 flex flex-wrap items-center gap-2 justify-end">
          <button
            type="button"
            onClick={() => {
              if (editing) {
                setEditing(false);
                setToast("已保存修改（本会话）");
              } else {
                setEditing(true);
                setToast("进入编辑模式");
              }
            }}
            className="rounded-full border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
          >
            {editing ? "保存修改" : "修改"}
          </button>
          <button
            type="button"
            onClick={() => void copyAll()}
            className="rounded-full bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100"
          >
            一键复制
          </button>
          <button
            type="button"
            onClick={() => void exportTxt()}
            className="rounded-full border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
          >
            导出 TXT
          </button>
          <button
            type="button"
            onClick={() => void clearSubtitles()}
            className="rounded-full px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200"
          >
            清空
          </button>
        </div>
      </main>

      {toast && (
        <div className="pointer-events-none fixed bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-zinc-900 border border-zinc-700 px-4 py-2 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
