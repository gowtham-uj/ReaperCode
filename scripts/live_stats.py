#!/usr/bin/env python3
import json
import re
from collections import defaultdict
from pathlib import Path

LEGACY_PROFILE_ALIASES = {
    "secondary_model": "strong_model",
    "fast_reasoner": "fast_model",
}


def get_latest_run() -> str | None:
    run_root = Path("/workspace/reaper_eval/run_logs/initial-task-1/")
    if not run_root.exists():
        return None
    runs = sorted(path.name for path in run_root.iterdir() if path.is_dir())
    return runs[-1] if runs else None


def read_jsonl_events(path: Path) -> list[dict]:
    if not path.exists():
        return []
    events: list[dict] = []
    for line in path.read_text(errors="ignore").splitlines():
        if not line.strip().startswith("{"):
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            events.append(payload)
    return events


def infer_source(metadata: dict) -> str:
    for key in ("source", "callSiteSource"):
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "unknown_source"


def infer_profile_and_legacy_role(metadata: dict) -> tuple[str, str | None]:
    profile = metadata.get("profile")
    legacy = metadata.get("legacyRole")
    if isinstance(profile, str) and profile.strip():
        return profile.strip(), legacy if isinstance(legacy, str) and legacy.strip() else None

    role = metadata.get("role")
    if isinstance(role, str) and role.strip():
        normalized_role = role.strip()
        return LEGACY_PROFILE_ALIASES.get(normalized_role, normalized_role), (
            normalized_role if normalized_role in LEGACY_PROFILE_ALIASES else None
        )

    return "unknown_profile", None


def maybe_number(value) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None


def print_model_request_breakdown(model_requests: list[dict]) -> None:
    grouped: dict[str, dict[tuple[str, str | None, str, str], dict[str, float]]] = defaultdict(
        lambda: defaultdict(lambda: {"calls": 0.0, "promptChars": 0.0, "durationSum": 0.0, "durationCount": 0.0})
    )

    for event in model_requests:
        metadata = event.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        source = infer_source(metadata)
        profile, legacy_role = infer_profile_and_legacy_role(metadata)
        provider = str(metadata.get("provider") or "unknown_provider")
        model = str(metadata.get("model") or "unknown_model")

        bucket = grouped[source][(profile, legacy_role, provider, model)]
        bucket["calls"] += 1
        prompt_chars = maybe_number(metadata.get("promptChars"))
        if prompt_chars is not None:
            bucket["promptChars"] += prompt_chars
        duration_ms = maybe_number(metadata.get("durationMs"))
        if duration_ms is not None:
            bucket["durationSum"] += duration_ms
            bucket["durationCount"] += 1

    print("model_request breakdown (source-first):")
    source_items = sorted(
        grouped.items(),
        key=lambda item: (-sum(detail["calls"] for detail in item[1].values()), item[0]),
    )
    for source, variants in source_items:
        source_calls = int(sum(detail["calls"] for detail in variants.values()))
        print(f"  source={source} calls={source_calls}")
        variant_items = sorted(
            variants.items(),
            key=lambda item: (-item[1]["calls"], item[0][0], item[0][2], item[0][3]),
        )
        for (profile, legacy_role, provider, model), detail in variant_items:
            calls = int(detail["calls"])
            prompt_chars = int(detail["promptChars"])
            duration_count = detail["durationCount"]
            avg_duration = detail["durationSum"] / duration_count if duration_count > 0 else None
            legacy_text = f" legacyRole={legacy_role}" if legacy_role else ""
            avg_text = f" avgMs={avg_duration:.1f}" if avg_duration is not None else ""
            print(
                f"    profile={profile}{legacy_text} provider={provider} model={model} "
                f"calls={calls} promptChars={prompt_chars}{avg_text}"
            )


def main() -> None:
    run = get_latest_run()
    if run is None:
        print("run=<none>")
        return

    ws = Path(f"/workspace/reaper_eval/workspaces/initial-task-1/{run}")
    print(f"run={run}")

    plan = ws / ".reaper" / "PLAN.md"
    if plan.exists():
        text = plan.read_text(errors="ignore")
        completed = re.findall(r"\[x\] \d+\.", text)
        current = re.findall(r"\[>\] \d+\.", text)
        pending = re.findall(r"\[ \] \d+\.", text)
        print(f"PLAN.md: completed={len(completed)} current={len(current)} pending={len(pending)}")

    log = ws / ".reaper" / "logs" / "langfuse-events.jsonl"
    events = read_jsonl_events(log)
    model_requests = [event for event in events if event.get("name") == "reaper.model_request"]
    tool_calls = [event for event in events if event.get("name") == "reaper.tool_call"]
    print(f"model_request={len(model_requests)} tool_call={len(tool_calls)}")
    if model_requests:
        print_model_request_breakdown(model_requests)

    summary = Path(f"/workspace/reaper_eval/run_logs/initial-task-1/{run}/summary.json")
    print(f"summary exists={summary.exists()}")


if __name__ == "__main__":
    main()
