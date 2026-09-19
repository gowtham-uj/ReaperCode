import { test } from "node:test";
import assert from "node:assert/strict";

import { RecoveryController } from "../../../../src/browser/runtime/recovery-controller.js";

/** A controller whose probe says the page is fine, so only the policy is tested. */
const healthy = (): RecoveryController =>
  new RecoveryController({
    probeInput: async () => ({ delivered: true, note: "" }),
    recover: async () => undefined,
  });

test("a detached element is retried once and then reported", async () => {
  const controller = healthy();
  let calls = 0;
  const outcome = await controller.attempt(
    async () => {
      calls += 1;
      throw new Error("Element is not attached to the DOM");
    },
    { page: {}, actionKey: "click #del", revision: 1 },
  );
  assert.equal(calls, 2, "DETACHED gets exactly one retry");
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.failure?.kind, "DETACHED");
});

test("a missing element is never retried, because time does not put it there", async () => {
  const controller = healthy();
  let calls = 0;
  const outcome = await controller.attempt(
    async () => {
      calls += 1;
      throw new Error("locator.click: Timeout 4000ms exceeded.\nCall log:\n  - waiting for locator('button')");
    },
    { page: {}, actionKey: "click button", revision: 1 },
  );
  assert.equal(calls, 1);
  assert.equal(outcome.failure?.kind, "LOCATOR_NOT_FOUND");
});

test("the same action in the same page state is refused the second time", async () => {
  /*
   * The loop this exists to stop: a measured mission re-ran an identical click
   * thirteen consecutive times, each time believing the failure was transient.
   * Nothing told it the previous twelve had been the same call.
   */
  const controller = healthy();
  await controller.attempt(
    async () => {
      throw new Error("locator.click: Timeout 4000ms exceeded.\nCall log:\n  - waiting for locator('button')");
    },
    { page: {}, actionKey: "click button", revision: 7 },
  );
  let ran = false;
  const second = await controller.attempt(
    async () => {
      ran = true;
      return "ok";
    },
    { page: {}, actionKey: "click button", revision: 7 },
  );
  assert.equal(ran, false, "the action must not run again");
  assert.equal(second.attempts, 0);
  assert.ok(second.blocked !== undefined);
  assert.match(second.blocked.diagnostic, /already failed in this page state/);
});

test("the same action at a different revision is a different attempt", async () => {
  /*
   * A second attempt after the page moved is legitimate: the element may have
   * arrived, the modal may have gone. Refusing it would be the runtime overruling
   * a correct retry.
   */
  const controller = healthy();
  await controller.attempt(
    async () => {
      throw new Error("locator.click: Timeout 4000ms exceeded.\nCall log:\n  - waiting for locator('button')");
    },
    { page: {}, actionKey: "click button", revision: 7 },
  );
  let ran = false;
  await controller.attempt(
    async () => {
      ran = true;
      return "ok";
    },
    { page: {}, actionKey: "click button", revision: 8 },
  );
  assert.equal(ran, true);
});

test("a retryable failure is not remembered, because a correct retry may work later", async () => {
  const controller = healthy();
  await controller.attempt(
    async () => {
      throw new Error("Element is not attached to the DOM");
    },
    { page: {}, actionKey: "click #del", revision: 1 },
  );
  assert.equal(controller.blockedCount(), 0);
});

test("a page that has stopped accepting input is recovered before the retry", async () => {
  const calls: string[] = [];
  const controller = new RecoveryController({
    probeInput: async () => {
      calls.push("probe");
      return { delivered: false, note: "the page is not accepting input" };
    },
    recover: async () => {
      calls.push("recover");
    },
  });
  const outcome = await controller.attempt(
    async () => {
      calls.push("action");
      throw new Error("element is not receiving pointer events");
    },
    { page: {}, actionKey: "click x", revision: 1 },
  );
  assert.deepEqual(calls, ["action", "probe", "recover", "action"]);
  assert.equal(outcome.recovered, true);
});

test("a page that is fine is not recovered, only probed", async () => {
  const calls: string[] = [];
  const controller = new RecoveryController({
    probeInput: async () => {
      calls.push("probe");
      return { delivered: true, note: "" };
    },
    recover: async () => {
      calls.push("recover");
    },
  });
  await controller.attempt(
    async () => {
      calls.push("action");
      throw new Error("element is not receiving pointer events");
    },
    { page: {}, actionKey: "click x", revision: 1 },
  );
  assert.deepEqual(calls, ["action", "probe", "action"]);
});

test("a success on the first attempt records nothing and costs nothing", async () => {
  const controller = healthy();
  const outcome = await controller.attempt(async () => 42, { page: {}, actionKey: "read title", revision: 1 });
  assert.equal(outcome.value, 42);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.failure, undefined);
});
