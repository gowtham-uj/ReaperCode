/**
 * OnboardingView — a 3-step modal that runs before the main TUI
 * mounts on first launch (or whenever the user types `/provider`).
 *
 * Step 1 — Provider picker
 *   Lists the SUPPORTED_PROVIDERS; ↑/↓ moves highlight, Enter selects.
 *
 * Step 2 — API key prompt (masked)
 *   Each keystroke echoes a `*`; Enter submits (non-empty), Esc
 *   returns to Step 1. Backspace deletes the previous character.
 *
 * Step 3 — Model picker
 *   Lists `provider.models`; ↑/↓ + Enter.
 *
 * On commit, calls `onComplete({provider, envVar, apiKey, model})`
 * which the parent uses to seed `process.env[envVar]` and persist to
 * `~/.reaper/onboarding.json`.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";
import {
  SUPPORTED_PROVIDERS,
  type OnboardingState,
  type SupportedProvider,
  type SupportedProviderId,
} from "../provider-onboarding.js";

export interface OnboardingViewProps {
  /** Called once the user completes all 3 steps. */
  onComplete: (state: Omit<OnboardingState, "savedAt">) => void;
  /** Called if the user presses Ctrl-C twice to abort onboarding. */
  onAbort: () => void;
}

type Step = "provider" | "key" | "model";

export function OnboardingView({ onComplete, onAbort }: OnboardingViewProps): React.ReactElement {
  const [step, setStep] = React.useState<Step>("provider");
  const [providerIdx, setProviderIdx] = React.useState(0);
  const [modelIdx, setModelIdx] = React.useState(0);
  const [apiKey, setApiKey] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [lastCtrlC, setLastCtrlC] = React.useState<number>(0);

  const provider: SupportedProvider = SUPPORTED_PROVIDERS[providerIdx]!;

  useInput(
    (input, key) => {
      // Double Ctrl-C to abort onboarding entirely.
      if (key.ctrl && input === "c") {
        const now = Date.now();
        if (now - lastCtrlC < 1500) {
          onAbort();
          return;
        }
        setLastCtrlC(now);
        return;
      }

      if (step === "provider") {
        if (key.upArrow) {
          setProviderIdx((i) => Math.max(0, i - 1));
          setError(null);
          return;
        }
        if (key.downArrow) {
          setProviderIdx((i) => Math.min(SUPPORTED_PROVIDERS.length - 1, i + 1));
          setError(null);
          return;
        }
        if (key.return) {
          setStep("key");
          setApiKey("");
          setError(null);
        }
        return;
      }

      if (step === "key") {
        if (key.escape) {
          setStep("provider");
          setApiKey("");
          setError(null);
          return;
        }
        if (key.return) {
          if (apiKey.trim().length === 0) {
            setError("API key cannot be empty");
            return;
          }
          setStep("model");
          setModelIdx(0);
          setError(null);
          return;
        }
        if (key.backspace) {
          setApiKey((k) => k.slice(0, -1));
          setError(null);
          return;
        }
        // Printable character → append (skip control chars).
        if (
          input &&
          input.length > 0 &&
          !key.ctrl &&
          !key.meta &&
          !key.upArrow &&
          !key.downArrow &&
          !key.leftArrow &&
          !key.rightArrow &&
          !key.escape &&
          !key.tab &&
          !key.return &&
          !key.backspace &&
          !key.delete
        ) {
          if (input.charCodeAt(0) >= 0x20) {
            setApiKey((k) => k + input);
            setError(null);
          }
        }
        return;
      }

      if (step === "model") {
        if (key.escape) {
          setStep("key");
          setError(null);
          return;
        }
        if (key.upArrow) {
          setModelIdx((i) => Math.max(0, i - 1));
          setError(null);
          return;
        }
        if (key.downArrow) {
          setModelIdx((i) => Math.min(provider.models.length - 1, i + 1));
          setError(null);
          return;
        }
        if (key.return) {
          const model = provider.models[modelIdx] ?? provider.models[0]!;
          onComplete({
            provider: provider.id as SupportedProviderId,
            envVar: provider.envVar,
            apiKey,
            model,
          });
        }
        return;
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} paddingY={0}>
      <Box marginBottom={1}>
        <Text>{theme.accent("⚙  First-run setup")}</Text>
      </Box>
      <Text>{theme.muted("Pick a model provider, paste its API key, then choose a model. Saved to ~/.reaper/onboarding.json (0600).")}</Text>
      <Box marginTop={1}>
        <StepDots step={step} />
      </Box>

      {step === "provider" && (
        <ProviderStep idx={providerIdx} />
      )}
      {step === "key" && (
        <KeyStep provider={provider} apiKey={apiKey} error={error} />
      )}
      {step === "model" && (
        <ModelStep provider={provider} idx={modelIdx} />
      )}

      <Box marginTop={1}>
        <Text>{theme.muted(hintForStep(step))}</Text>
      </Box>
    </Box>
  );
}

function StepDots({ step }: { step: Step }): React.ReactElement {
  const labels: Record<Step, string> = {
    provider: "1. provider",
    key: "2. api key",
    model: "3. model",
  };
  const order: Step[] = ["provider", "key", "model"];
  return (
    <Box>
      {order.map((s, i) => {
        const active = s === step;
        const past = order.indexOf(step) > i;
        const color = active ? theme.accent : past ? theme.success : theme.muted;
        return (
          <Box key={s} marginRight={2}>
            <Text>{color(labels[s]! + (active ? " ◀" : ""))}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ProviderStep({ idx }: { idx: number }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      {SUPPORTED_PROVIDERS.map((p, i) => {
        const active = i === idx;
        const pointer = active ? "▶ " : "  ";
        return (
          <Box key={p.id}>
            <Text>{theme.accent(pointer)}</Text>
            <Text {...(active ? { color: "cyan" as const } : {})}>{p.label.padEnd(28)}</Text>
            <Text>{theme.muted(`models: ${p.models.join(", ")}`)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function KeyStep({
  provider,
  apiKey,
  error,
}: {
  provider: SupportedProvider;
  apiKey: string;
  error: string | null;
}): React.ReactElement {
  const masked = apiKey.length === 0 ? "" : "•".repeat(apiKey.length);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text>{theme.accent(`${provider.label}  →  `)}</Text>
        <Text>{theme.muted(provider.envVar)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{theme.muted(provider.keyHint)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{theme.accent("key: ")}</Text>
        <Text>{masked || theme.muted("(paste your API key)")}</Text>
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text>{theme.error(error)}</Text>
        </Box>
      )}
    </Box>
  );
}

function ModelStep({
  provider,
  idx,
}: {
  provider: SupportedProvider;
  idx: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text>{theme.accent(`${provider.label} — pick a model:`)}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {provider.models.map((m, i) => {
          const active = i === idx;
          const pointer = active ? "▶ " : "  ";
          return (
            <Box key={m}>
              <Text>{theme.accent(pointer)}</Text>
              <Text {...(active ? { color: "cyan" as const } : {})}>{m}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function hintForStep(step: Step): string {
  switch (step) {
    case "provider": return "↑/↓ to move · Enter to select";
    case "key":      return "type or paste your API key · Enter to continue · Esc to go back";
    case "model":    return "↑/↓ to move · Enter to confirm · Esc to go back";
  }
}