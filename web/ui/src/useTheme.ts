import { useCallback, useEffect, useState } from "react";

import { applyTheme, readTheme, writeTheme, type Theme } from "./theme.js";

/**
 * Reads the stored theme once, keeps `document.body` in sync with it, and
 * mirrors changes made in other tabs so two open windows do not disagree.
 */
export function useTheme(): { theme: Theme; setTheme(next: Theme): void } {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    // `storage` only fires in *other* documents, so this never echoes the write
    // above back into a render loop.
    const sync = (event: StorageEvent): void => {
      if (event.key === null || event.key === "reaper.theme") setThemeState(readTheme());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    writeTheme(next);
    setThemeState(next);
  }, []);

  return { theme, setTheme };
}
