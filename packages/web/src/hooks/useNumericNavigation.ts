import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { auth } from "../lib/api-client.js";
import { isNavigationDigit } from "../lib/navigation.js";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return (
    target.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  );
}

export function useNumericNavigation(): void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const chordPrefix = useRef(false);
  const chordTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    function clearChord(): void {
      chordPrefix.current = false;
      if (chordTimer.current !== undefined) {
        window.clearTimeout(chordTimer.current);
        chordTimer.current = undefined;
      }
    }

    function dialDigit(digit: string): void {
      switch (digit) {
        case "1":
          void navigate({ to: "/status" });
          break;
        case "2":
          void navigate({ to: "/messages" });
          break;
        case "3":
          void navigate({ to: "/questions" });
          break;
        case "4":
          void navigate({ to: "/tokens" });
          break;
        case "5":
          void navigate({ to: "/settings" });
          break;
        case "6":
          void navigate({ to: "/about" });
          break;
        case "7":
          void auth.logout().finally(() => {
            queryClient.clear();
            void navigate({ to: "/login", replace: true });
          });
          break;
        case "9":
          void navigate({ to: "/debug" });
          break;
        case "0":
          void navigate({ to: "/" });
          break;
        default:
          break;
      }
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (chordPrefix.current) {
        if (key === "s") {
          event.preventDefault();
          clearChord();
          void navigate({ to: "/status" });
          return;
        }
        if (key === "q") {
          event.preventDefault();
          clearChord();
          void navigate({ to: "/questions" });
          return;
        }
        if (key === "d") {
          event.preventDefault();
          clearChord();
          void navigate({ to: "/debug" });
          return;
        }
        clearChord();
      }

      if (key === "g") {
        chordPrefix.current = true;
        chordTimer.current = window.setTimeout(clearChord, 900);
        return;
      }

      if (isNavigationDigit(key)) {
        event.preventDefault();
        dialDigit(key);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      clearChord();
    };
  }, [navigate, queryClient]);
}
