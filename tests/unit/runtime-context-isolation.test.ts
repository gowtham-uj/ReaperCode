import test from "node:test";
import assert from "node:assert/strict";

import {
  getBashTunables,
  runWithConfigTunables,
} from "../../src/config/config-tunables.js";
import { parseReaperConfig } from "../../src/config/model-config.js";
import { buildStarterConfig } from "../../src/config/starter-config.js";
import {
  currentModelCallLogContext,
  runWithModelCallLogContext,
} from "../../src/logging/model-call-log.js";
import {
  getActiveModelCallContext,
  runWithModelCallContext,
} from "../../src/model/observability.js";
import {
  getRegisteredCleanupCount,
  registerCleanup,
  runWithCleanupScope,
} from "../../src/runtime/cleanup-registry.js";
import {
  getActiveQueryGuard,
  runWithQueryGuard,
} from "../../src/runtime/query-guard.js";
import {
  isReaperDevMode,
  runWithReaperDevMode,
} from "../../src/runtime/dev-mode.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function configWithIdleTimeout(idleTimeoutMs: number) {
  const config = parseReaperConfig(buildStarterConfig());
  config.runtimeTunables.bashIdleTimeoutMs = idleTimeoutMs;
  return config;
}

test("config tunables stay isolated across concurrent async runs", async () => {
  const release = deferred();
  const entered = deferred();
  let count = 0;
  const run = (value: number) => runWithConfigTunables(configWithIdleTimeout(value), async () => {
    count += 1;
    if (count === 2) entered.resolve();
    await release.promise;
    await Promise.resolve();
    return getBashTunables().idleTimeoutMs;
  });

  const first = run(111);
  const second = run(222);
  await entered.promise;
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [111, 222]);
});

test("model contexts and log destinations stay isolated across concurrent runs", async () => {
  const release = deferred();
  const entered = deferred();
  let count = 0;
  const run = (runId: string) => runWithModelCallLogContext(
    { workspaceRoot: `/tmp/${runId}`, runId },
    () => runWithModelCallContext(
      {
        workspaceRoot: `/tmp/${runId}`,
        runId,
        source: "test",
        callId: `${runId}-call`,
        promptPreview: runId,
      },
      async () => {
        count += 1;
        if (count === 2) entered.resolve();
        await release.promise;
        await Promise.resolve();
        return {
          observed: getActiveModelCallContext()?.runId,
          logged: currentModelCallLogContext()?.runId,
        };
      },
    ),
  );

  const first = run("run-a");
  const second = run("run-b");
  await entered.promise;
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [
    { observed: "run-a", logged: "run-a" },
    { observed: "run-b", logged: "run-b" },
  ]);
});

test("cleanup scopes drain only their own registrations", async () => {
  const release = deferred();
  const entered = deferred();
  const cleaned: string[] = [];
  let count = 0;
  const run = (name: string) => runWithCleanupScope(undefined, async () => {
    registerCleanup(async () => {
      cleaned.push(name);
    });
    assert.equal(getRegisteredCleanupCount(), 1);
    count += 1;
    if (count === 2) entered.resolve();
    await release.promise;
    assert.equal(getRegisteredCleanupCount(), 1);
  });

  const first = run("first");
  const second = run("second");
  await entered.promise;
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(cleaned.sort(), ["first", "second"]);
});

test("query guards are shared inside one run and distinct across runs", async () => {
  const release = deferred();
  const entered = deferred();
  let count = 0;
  const run = () => runWithQueryGuard(async () => {
    const guard = getActiveQueryGuard();
    const generation = guard.start();
    guard.markRunning(generation);
    count += 1;
    if (count === 2) entered.resolve();
    await release.promise;
    assert.equal(getActiveQueryGuard(), guard);
    guard.finish(generation);
    return guard.getState();
  });

  const first = run();
  const second = run();
  await entered.promise;
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["idle", "idle"]);
});

test("managed dev mode stays async-local without mutating the environment", async () => {
  const before = process.env.REAPER_DEV;
  const environmentEnabled = before === "1" || before === "true";
  const [enabled, inherited] = await Promise.all([
    runWithReaperDevMode(true, async () => {
      await Promise.resolve();
      return isReaperDevMode();
    }),
    runWithReaperDevMode(undefined, async () => {
      await Promise.resolve();
      return isReaperDevMode();
    }),
  ]);
  assert.equal(enabled, true);
  assert.equal(inherited, environmentEnabled);
  assert.equal(process.env.REAPER_DEV, before);
});
