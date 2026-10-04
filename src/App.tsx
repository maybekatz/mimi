import { getCurrentWindow } from "@tauri-apps/api/window";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { effectiveUiLanguage, subscribeUiLanguage } from "./lib/i18n";
import { appIsUiTest, appUiTestFrontendReady, isTauri, testProfileConnection } from "./lib/ipc";
import { selectSessionStatusKind, useStore } from "./lib/store";
import { useDesktopShortcuts } from "./lib/useDesktopShortcuts";

const OverlayWindow = lazy(() =>
  import("./windows/overlay/OverlayWindow").then((module) => ({
    default: module.OverlayWindow,
  })),
);
const OverlayControlWindow = lazy(() =>
  import("./windows/overlay-control/OverlayControlWindow").then((module) => ({
    default: module.OverlayControlWindow,
  })),
);
const SettingsView = lazy(() =>
  import("./windows/settings/SettingsView").then((module) => ({
    default: module.SettingsView,
  })),
);
const TrayPanel = lazy(() =>
  import("./windows/tray-panel/TrayPanel").then((module) => ({
    default: module.TrayPanel,
  })),
);
const TranscribeWindow = lazy(() =>
  import("./windows/transcribe/TranscribeWindow").then((module) => ({
    default: module.TranscribeWindow,
  })),
);

type WindowLabel = "overlay" | "overlay-control" | "tray-panel" | "settings" | "transcribe";

/**
 * Every window loads the shared entry, then lazily loads only the component
 * matching its label. Voice V1 adds `transcribe` (single-window
 * microphone transcription) alongside the original mimi windows.
 * Outside Tauri a `?window=` query parameter selects the preview
 * (defaults to "transcribe" for Voice V1).
 */
export default function App() {
  const uiLanguage = useSyncExternalStore(subscribeUiLanguage, effectiveUiLanguage);
  const [label] = useState<WindowLabel>(resolveInitialLabel);
  const init = useStore((state) => state.init);

  useLayoutEffect(() => {
    document.documentElement.lang = uiLanguage === "zh" ? "zh-CN" : uiLanguage;
  }, [uiLanguage]);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    document.body.classList.toggle("settings-body", label === "settings");
  }, [label]);

  let windowContent;
  if (label === "overlay") windowContent = <OverlayWindow />;
  else if (label === "overlay-control") windowContent = <OverlayControlWindow />;
  else if (label === "tray-panel") windowContent = <TrayPanel />;
  else if (label === "transcribe") windowContent = <TranscribeWindow />;
  else windowContent = <SettingsView />;

  return (
    <Suspense fallback={null}>
      {windowContent}
      <FrontendReadySignal label={label} />
    </Suspense>
  );
}

/** Mount inside Suspense so a failed lazy import cannot pass native smoke. */
function FrontendReadySignal({ label }: { label: WindowLabel }) {
  const { commands: desktopShortcuts } = useDesktopShortcuts();
  const status = useStore(selectSessionStatusKind);
  const reported = useRef(false);

  useEffect(() => {
    if (
      !isTauri ||
      reported.current ||
      desktopShortcuts === undefined ||
      status !== "listening" ||
      (label !== "settings" && label !== "overlay" && label !== "transcribe")
    ) {
      return;
    }

    // Wait for the committed window to paint with the native session snapshot.
    // Shortcut hydration must succeed too, so missing IPC capabilities fail
    // installed-app smoke instead of silently hiding all shortcut hints.
    // The backend writes a content-free marker only in explicit UI-test mode.
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        // Native package smoke exercises the real IPC registration, window
        // capability and response shape. Production never probes a provider here.
        const diagnostics = label === "settings"
          ? appIsUiTest().then(async (enabled) => {
              if (!enabled) return;
              const result = await testProfileConnection(useStore.getState().settings.activeProfileId);
              if (result.credential !== "present" || result.service !== "notTested" || result.reason !== null) {
                throw new Error("connection_diagnostic_smoke_failed");
              }
            })
          : Promise.resolve();
        void diagnostics.then(() => appUiTestFrontendReady())
          .then(() => {
            reported.current = true;
          })
          .catch(() => {});
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [label, status, desktopShortcuts]);

  return null;
}

function resolveInitialLabel(): WindowLabel {
  if (isTauri) {
    return getCurrentWindow().label as WindowLabel;
  }
  const param = new URLSearchParams(window.location.search).get("window");
  return param === "overlay" ||
    param === "overlay-control" ||
    param === "tray-panel" ||
    param === "settings" ||
    param === "transcribe"
    ? param
    : "transcribe";
}
