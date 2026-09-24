import assert from "node:assert/strict";
import test from "node:test";
import { runtimeBinding } from "../runtime-binding.mjs";

test("runtime registrations share only an active identical configuration", () => {
  const a = runtimeBinding({ owner: "A", profile: "corp:A", nested: { b: 2, a: 1 } });
  const b = runtimeBinding({ nested: { a: 1, b: 2 }, profile: "corp:A", owner: "A" });
  const other = runtimeBinding({ owner: "B", profile: "corp:B" });
  const live = { service: {} };
  assert.throws(() => b.require(), /尚未就绪/);
  try {
    a.publish(live);
    assert.equal(b.require(), live);
    assert.throws(() => other.require(), /尚未就绪/);
    assert.throws(() => b.publish({}), /重复启动/);
    b.remove({});
    assert.equal(a.require(), live);
  } finally {
    a.remove(live);
  }
  assert.throws(() => b.require(), /尚未就绪/);
});
