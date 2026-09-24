import assert from "node:assert/strict";
import test from "node:test";
import { cardFormFields } from "../assistant-card-protocol.mjs";

test("DingTalk defaults include matching indexes and values without mutating saved view fields", () => {
  const options = [
    { value: "off", text: "Off" },
    { value: "all", text: "All" },
  ];
  const fields = [
    { name: "dmMode", type: "SELECT", options, defaultValue: "all" },
    { name: "users", type: "MULTI_SELECT", options, defaultValue: ["all", "missing"] },
    { name: "unknown", type: "SELECT", options, defaultValue: "missing" },
    { name: "text", type: "TEXT_AREA", defaultValue: "exact body" },
  ];
  const rendered = cardFormFields(fields);
  assert.deepEqual(rendered[0].defaultValue, { index: 1, value: "all" });
  assert.deepEqual(rendered[1].defaultValue, { index: [1], value: ["all"] });
  assert.equal(Object.hasOwn(rendered[2], "defaultValue"), false);
  assert.equal(rendered[3].defaultValue, "exact body");
  assert.equal(fields[0].defaultValue, "all");
  assert.deepEqual(fields[1].defaultValue, ["all", "missing"]);
});

test("inline choice groups use plain string/array defaults as required by the real client", () => {
  const fields = [
    { type: "CHECKBOX_GROUP", options: [{ value: "all", text: "All" }], defaultValue: "all" },
    { type: "MULTI_CHECKBOX_GROUP", options: [{ value: "a", text: "A" }], defaultValue: ["a"] },
  ];
  assert.deepEqual(cardFormFields(fields), fields);
});
