import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../lib/store";
import { fileTranscribe } from "../../lib/ipc";
import { isTauri } from "../../lib/ipc";
import type { AudioInput } from "../../lib/types";

type SourceTab = AudioInput;

const SOURCE_TABS: { value: SourceTab; label: string; hint: string }[] = [
  { value: "microphone", label: "麦克风", hint: "对着麦克风说话" },
  { value: "system", label: "系统音频", hint: "视频/会议声音" },
  { value: "both", label: "双路", hint: "麦克风 + 系统同时" },
];

export function TranscribeWindow() {
  const session = useStore((s) => s.session);
  const settings = useStore((s) => s.settings);
  const start = useStore((s) => s.start);
  const stop = useStore((s) => s.stop);
  const clearSubtitles = useStore((s) => s.clearSubtitles);
  const showSettings = useStore((s) => s.showSettings);
  const switchAudioInput = useStore((s) => s.switchAudioInput);

  const activeProvider = settings.profiles.find((p) => p.id === settings.activeProfileId);
  const credentialReady = activeProvider?.credentialState === "present";
  const isActive = session.isActive || session.status.kind === "connecting" || session.status.kind === "listening";
  const statusKind = session.status.kind;
  const errorMsg =
    statusKind === "error" && "message" in session.status
      ? (session.status as { kind: "error"; message: string }).message
      : null;

  const audioInput: SourceTab = (settings.audioInput as SourceTab) ?? "microphone";

  // Finals: prefer per-source tracks when dual, else aggregate history.
  const { finals, draft, draftSource } = useMemo(() => {
    const tracks = session.subtitles.tracks;
    if (tracks && tracks.length > 0) {
      const finals: { text: string; source: "system" | "microphone" }[] = [];
      for (const t of tracks) {
        for (const h of t.history) if (h.source.trim()) finals.push({ text: h.source, source: t.audioSource as "system" | "microphone" });
        const cur = t.source;
        if (cur.isFinal && cur.text.trim()) finals.push({ text: cur.text, source: t.audioSource as "system" | "microphone" });
      }
      // Sort finals by appearance order is already chronological via history; keep as is.
      const curDraftTrack = tracks.find((t) => !t.source.isFinal && t.source.text.trim());
      return {
        finals,
        draft: curDraftTrack?.source.text ?? (tracks.find((t) => !t.source.isFinal)?.source.text ?? ""),
        draftSource: (curDraftTrack?.audioSource as "system" | "microphone" | undefined) ?? undefined,
      };
    }
    const hist = session.subtitles.history.map((h) => ({ text: h.source, source: (h.audioSource ?? "system") as "system" | "microphone" })).filter((x) => x.text.trim());
    const cur = session.subtitles.source;
    if (cur.isFinal && cur.text.trim() && !hist.some((x) => x.text === cur.text)) hist.push({ text: cur.text, source: "system" });
    return { finals: hist, draft: !cur.isFinal ? cur.text : "", draftSource: undefined as "system" | "microphone" | undefined };
  }, [session.subtitles.history, session.subtitles.source, session.subtitles.tracks]);

  const fullText = useMemo(() => finals.map((f) => f.text).join("\n"), [finals]);

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) setEditText(fullText);
  }, [editing, fullText]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!editing && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [finals.length, draft, editing]);

  const shortcutHint = navigator.platform.toLowerCase().includes("mac") ? "⌘⇧S" : "Ctrl+Shift+S";

  const toggle = async () => {
    if (statusKind === "connecting" || statusKind === "stopping") return;
    if (session.isActive) {
      await stop();
      setToast("已停止");
    } else {
      if (!credentialReady) {
        setToast("请先在设置中填入 DashScope API Key（sk-…）");
        void showSettings();
        return;
      }
      if (audioInput === "system" && !isTauri) {
        setToast("系统音频仅在桌面 App 中可用");
        return;
      }
      try {
        await start();
        setToast(audioInput === "system" ? "开始收录系统声音…" : audioInput === "both" ? "双路录音中…" : "开始录音…");
      } catch (e) {
        setToast(e instanceof Error ? e.message : "启动失败，请检查麦克风/系统录制权限与 API Key");
      }
    }
  };

  const switchSource = async (input: SourceTab) => {
    if (input === audioInput) return;
    if (isActive) {
      setToast("请先停止录音再切换音频源");
      return;
    }
    try {
      await switchAudioInput(input);
      setToast(`已切换到${SOURCE_TABS.find((t) => t.value === input)?.label}`);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "切换失败");
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
  }, [session.isActive, credentialReady, statusKind, audioInput]);

  const copyAll = async () => {
    const text = editing ? editText : fullText || draft;
    if (!text.trim()) {
      setToast("暂无可复制的文字");
      return;
    }
    if (isTauri) {
      try {
        const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
        await writeText(text);
        setToast("已复制到剪贴板");
        return;
      } catch {}
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
    if (isTauri) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        const filePath = await save({
          defaultPath: `voice-${new Date().toISOString().slice(0, 10)}.txt`,
          filters: [{ name: "Text", extensions: ["txt"] }],
        });
        if (!filePath) return;
        await writeTextFile(filePath, text);
        setToast("已导出 TXT");
        return;
      } catch {}
    }
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setToast("已导出 TXT");
  };

  const importFile = async () => {
    if (!isTauri) {
      // Browser fallback: pick file and show that desktop import is preferred.
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".wav,.mp3,.m4a,.aac,.flac,.ogg,.mp4,.mov,.webm,audio/*,video/*";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.name.toLowerCase().endsWith(".wav")) {
          setToast("浏览器暂不支持直接解码。请在桌面 App 中导入 WAV，或用桌面 App 的 系统音频 实时转写。");
        } else {
          setToast("请在桌面 App 中导入，或先导出为 WAV (PCM 16-bit)。");
        }
      };
      input.click();
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "Audio/Video", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "wma", "mp4", "mov", "webm"] }],
      });
      const filePath = Array.isArray(path) ? path[0] : path;
      if (!filePath) return;
      setImporting(true);
      setToast("正在转写文件…");
      const result = await fileTranscribe(filePath as string);
      setToast(`转写完成 · ${result.text.length} 字`);
      // Result is also injected into history; scroll to bottom.
      setEditing(false);
      // If result text was injected, it already appears in `finals`.
      void result;
    } catch (e) {
      setToast(e instanceof Error ? e.message : typeof e === "string" ? e : "导入失败");
    } finally {
      setImporting(false);
    }
  };

  const isListening = statusKind === "listening";
  const currentSourceLabel = SOURCE_TABS.find((t) => t.value === audioInput)?.label ?? audioInput;

  return (
    <div className="min-h-screen w-full bg-[#0f1115] text-zinc-100 flex flex-col">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex h-2.5 w-2.5 rounded-full ${isActive ? "bg-red-500 animate-pulse shadow-[0_0_12px_rgba(239,68,68,0.6)]" : "bg-zinc-600"}`}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-none tracking-wide flex items-center gap-2">
              <span>{isListening ? `● 录音中 · ${currentSourceLabel}` : statusKind === "connecting" ? "连接中…" : statusKind === "stopping" ? "停止中…" : session.isPaused ? "已暂停" : `就绪 · ${currentSourceLabel}`}</span>
              {!isActive && !credentialReady && <span className="text-amber-400 font-normal">未配置 API Key</span>}
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
              onClick={() => void importFile()}
              disabled={importing}
              className="rounded-full border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700 disabled:opacity-50"
            >
              {importing ? "转写中…" : "导入文件"}
            </button>
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
              {isActive ? "停止" : "开始"}
            </button>
            {!isTauri && <span className="text-xs text-zinc-500">(浏览器预览)</span>}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {SOURCE_TABS.map((tab) => {
            const active = tab.value === audioInput;
            return (
              <button
                key={tab.value}
                type="button"
                onClick={() => void switchSource(tab.value)}
                disabled={isActive}
                title={tab.hint}
                className={`rounded-full px-3 py-1.5 text-xs font-medium border transition ${active ? "bg-white text-zinc-900 border-white" : "bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700"} ${isActive ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                {tab.label}
              </button>
            );
          })}
          <span className="ml-2 text-xs text-zinc-500">
            {audioInput === "system" ? "需授权“屏幕录制/系统音频”" : audioInput === "both" ? "系统 + 麦克风 双路独立字幕" : "需麦克风权限"}
          </span>
        </div>
      </header>

      <main className="flex-1 flex flex-col min-h-0">
        <div ref={scrollRef} className="flex-1 overflow-auto px-4 py-4">
          {finals.length === 0 && !draft ? (
            <div className="h-full grid place-items-center py-12">
              <div className="text-center max-w-lg">
                <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-zinc-800 border border-zinc-700">🎙️</div>
                <p className="text-sm text-zinc-200">
                  {audioInput === "system" ? "播放视频或加入会议，系统声音会实时转成文字" : audioInput === "both" ? "双路模式：麦克风与系统声音分别转写，互不混流" : "对着麦克风说话，文字会实时显示在这里"}
                </p>
                <p className="mt-1.5 text-xs leading-5 text-zinc-500">
                  仅转写（Original，不走翻译）。去
                  <button type="button" onClick={() => void showSettings()} className="mx-1 underline decoration-dotted underline-offset-2">
                    设置
                  </button>
                  填入 DashScope <code className="px-1 py-0.5 rounded bg-zinc-800 border border-zinc-700">sk-…</code> 后
                  {audioInput === "system" ? "播放任意视频/会议即可" : "即可开始"}。也可
                  <button type="button" onClick={() => void importFile()} className="mx-1 underline decoration-dotted underline-offset-2">
                    导入录音文件
                  </button>
                  （WAV PCM16）。
                </p>
                {!isActive && (
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => void toggle()}
                      className="rounded-full bg-white px-4 py-2 text-sm font-medium text-zinc-900"
                    >
                      开始
                    </button>
                    <button
                      type="button"
                      onClick={() => void importFile()}
                      className="rounded-full border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm"
                    >
                      导入文件
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : editing ? (
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              placeholder="可在结束后修改文字…"
              className="min-h-[360px] w-full resize-y rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-[15px] leading-7 outline-none focus:border-zinc-700"
            />
          ) : (
            <div className="mx-auto max-w-3xl">
              <article className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 leading-7 space-y-2">
                {finals.map((item, i) => (
                  <p
                    key={`${i}-${item.text.slice(0, 16)}`}
                    className={`whitespace-pre-wrap text-[15px] ${item.source === "microphone" ? "text-amber-100" : "text-zinc-100"}`}
                  >
                    <span className={`mr-2 inline-flex rounded-full px-2 py-0.5 text-[10px] leading-none border ${item.source === "microphone" ? "bg-amber-500/20 text-amber-300 border-amber-500/30" : "bg-zinc-700 text-zinc-300 border-zinc-600"}`}>
                      {item.source === "microphone" ? "麦克风" : "系统"}
                    </span>
                    {item.text}
                  </p>
                ))}
                {draft && (
                  <p className="whitespace-pre-wrap text-[15px] text-zinc-400 italic">
                    {draftSource === "microphone" ? <span className="mr-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-300">麦克风</span> : null}
                    …{draft}
                  </p>
                )}
              </article>
              <p className="mt-2 text-xs text-zinc-500">灰色斜体为实时草稿，黑色为已确认终稿 · 双路时按来源分色显示。</p>
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800 bg-zinc-900/60 px-4 py-3 flex flex-wrap items-center gap-2 justify-end">
          <button type="button" onClick={() => void importFile()} disabled={importing} className="rounded-full border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700 disabled:opacity-50">
            导入文件
          </button>
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
        <div className="pointer-events-none fixed bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-zinc-900 border border-zinc-700 px-4 py-2 text-sm shadow-lg max-w-[80vw] text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
