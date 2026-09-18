import { useEffect, useRef, type ReactNode } from "react";

/**
 * Reaper protocol adapter for DeepSeek Harness's InputBar visual component.
 *
 * The DOM hierarchy and geometry intentionally follow the upstream MIT-licensed
 * `ui-conversation/.../InputBar.tsx` component: root → card → draft scroll/grow
 * → bottom row → tools/modes and trailing/model/context/primary action. Reaper
 * supplies a controlled textarea instead of DeepSeek's Cordis/Lexical machine.
 */
export function DeepSeekComposer({
  value,
  placeholder,
  running,
  disabled,
  modelControl,
  effortControl,
  contextControl,
  sendModeControl,
  onChange,
  onSubmit,
  onStop,
}: {
  value: string;
  placeholder: string;
  running: boolean;
  disabled: boolean;
  modelControl?: ReactNode;
  effortControl?: ReactNode;
  contextControl?: ReactNode;
  /**
   * How the message about to be sent should be delivered, while the agent is
   * working. It sits against the primary button rather than in the tools row
   * because it modifies the send, not the model or its reasoning.
   */
  sendModeControl?: ReactNode;
  onChange(value: string): void;
  onSubmit(): void;
  onStop(): void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const empty = value.trim() === "";
  const primaryStops = running && empty;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 336)}px`;
  }, [value]);

  const primary = (): void => {
    if (primaryStops) onStop();
    else if (!empty) onSubmit();
  };

  return (
    <div className="dsh-inputbar-root">
      <div className="dsh-inputbar-card" data-composer-card>
        <div className="dsh-inputbar-scroll" data-input-scroll>
          <div className="dsh-inputbar-grow">
            <textarea
              ref={inputRef}
              className="dsh-inputbar-input"
              value={value}
              rows={1}
              aria-label={placeholder}
              placeholder={placeholder}
              disabled={disabled}
              onChange={(event) => onChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (!empty) onSubmit();
                }
              }}
            />
          </div>
        </div>
        <div className="dsh-inputbar-row">
          <div className="dsh-inputbar-tools">
            {modelControl}
            {effortControl}
          </div>
          <div className="dsh-inputbar-trailing">
            {contextControl}
            {sendModeControl}
            <button
              type="button"
              className="dsh-inputbar-primary"
              aria-label={primaryStops ? "Stop" : running ? "Queue message" : "Send message"}
              disabled={primaryStops ? disabled : disabled || empty}
              onClick={primary}
            >
              {primaryStops ? (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M8.3125.98c.355.073.666.224.95.452.225.181.468.426.717.675l4.728 4.728-1.414 1.414L9 3.956v11.086H7V3.956L2.707 8.25 1.293 6.835 6.02 2.107c.25-.249.493-.494.717-.675.24-.192.547-.388.95-.452.21-.033.416-.025.625 0Z" fill="currentColor" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
