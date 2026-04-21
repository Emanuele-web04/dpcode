import { useEffect, useState } from "react";
import { LuCopy, LuMinus, LuSquare, LuX } from "react-icons/lu";

import { cn } from "~/lib/utils";
import {
  DEFAULT_DESKTOP_WINDOW_STATE,
  readDesktopBridge,
  supportsCustomDesktopTitleBar,
} from "~/lib/desktopWindow";

export function DesktopWindowControls({ className }: { className?: string }) {
  const [windowState, setWindowState] = useState(DEFAULT_DESKTOP_WINDOW_STATE);
  const usesCustomDesktopTitleBar = supportsCustomDesktopTitleBar();

  useEffect(() => {
    if (!usesCustomDesktopTitleBar) {
      return;
    }

    const bridge = readDesktopBridge();
    if (!bridge) {
      return;
    }

    let active = true;
    void bridge.window
      .getState()
      .then((state) => {
        if (active) {
          setWindowState(state);
        }
      })
      .catch(() => {});

    const unsubscribe = bridge.window.onState((state) => {
      if (active) {
        setWindowState(state);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [usesCustomDesktopTitleBar]);

  const bridge = readDesktopBridge();
  if (!usesCustomDesktopTitleBar || !bridge) {
    return null;
  }

  const controlButtonClassName =
    "inline-flex h-full w-[46px] items-center justify-center text-muted-foreground/72 transition-colors hover:bg-accent/75 hover:text-foreground";

  return (
    <div
      className={cn(
        "flex h-full shrink-0 self-stretch items-stretch border-l border-border/70 [-webkit-app-region:no-drag]",
        className,
      )}
    >
      <button
        type="button"
        className={controlButtonClassName}
        aria-label="Minimize window"
        onClick={() => {
          void bridge.window.minimize();
        }}
      >
        <LuMinus className="size-3.5 stroke-[1.85]" />
      </button>
      <button
        type="button"
        className={controlButtonClassName}
        aria-label={windowState.isMaximized ? "Restore window" : "Maximize window"}
        onClick={() => {
          void bridge.window
            .toggleMaximize()
            .then((state) => {
              setWindowState(state);
            })
            .catch(() => {});
        }}
      >
        {windowState.isMaximized ? (
          <LuCopy className="size-3.5 stroke-[1.85]" />
        ) : (
          <LuSquare className="size-[13px] stroke-[1.85]" />
        )}
      </button>
      <button
        type="button"
        className={cn(
          controlButtonClassName,
          "hover:bg-red-500 hover:text-white dark:hover:bg-red-600",
        )}
        aria-label="Close window"
        onClick={() => {
          void bridge.window.close();
        }}
      >
        <LuX className="size-3.5 stroke-[1.85]" />
      </button>
    </div>
  );
}
