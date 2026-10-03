import { expect, test } from "bun:test";
import { makeRunner, type Invoke } from "../src/model.ts";
import { tmpDir } from "./helpers.ts";

const yes = () => true;

test("a failed call is retried once and the second reply is used", async () => {
  let calls = 0;
  const invoke: Invoke = async () => (++calls === 1 ? { ok: false, text: "", error: "exit 1" } : { ok: true, text: "fine" });
  const r = await makeRunner(invoke, { model: "m" })("p", yes);
  expect(r).toMatchObject({ ok: true, text: "fine", attempts: 2, cached: false });
  expect(calls).toBe(2);
});

test("an unusable reply is retried, and two unusable replies make the call fail", async () => {
  let calls = 0;
  const invoke: Invoke = async () => {
    calls++;
    return { ok: true, text: "garbage" };
  };
  const r = await makeRunner(invoke, { model: "m" })("p", (t) => t !== "garbage");
  expect(r.ok).toBe(false);
  expect(r.attempts).toBe(2);
  expect(calls).toBe(2);
  expect(r.error).toContain("unusable");
});

test("the same prompt and model hit the cache and are not sent again", async () => {
  let calls = 0;
  const invoke: Invoke = async () => {
    calls++;
    return { ok: true, text: "answer" };
  };
  const cacheDir = tmpDir();
  const run = makeRunner(invoke, { model: "m", cacheDir });
  await run("p", yes);
  const again = await run("p", yes);
  expect(again).toMatchObject({ ok: true, text: "answer", cached: true, attempts: 0 });
  expect(calls).toBe(1);
});

test("a different prompt or a different model does not hit the cache", async () => {
  let calls = 0;
  const invoke: Invoke = async () => {
    calls++;
    return { ok: true, text: "answer" };
  };
  const cacheDir = tmpDir();
  await makeRunner(invoke, { model: "m", cacheDir })("p", yes);
  await makeRunner(invoke, { model: "m", cacheDir })("p2", yes);
  await makeRunner(invoke, { model: "other", cacheDir })("p", yes);
  expect(calls).toBe(3);
});

test("failed and unusable replies are not cached", async () => {
  let calls = 0;
  const invoke: Invoke = async () => {
    calls++;
    return { ok: true, text: "garbage" };
  };
  const cacheDir = tmpDir();
  const run = makeRunner(invoke, { model: "m", cacheDir });
  await run("p", () => false);
  await run("p", () => false);
  expect(calls).toBe(4);
});
