import assert from "node:assert/strict";
import test from "node:test";
import {
  readConfig,
  assertHostVersion,
  assertApprovalRouting,
  listenerArgs,
  isListenerReady,
} from "../config.mjs";
import { prepareSend, literalWords, previewLiteral } from "../send-preview.mjs";
import { config, host } from "./fixtures.mjs";

test("literal body is preserved across quoting, including injection-looking text", () => {
  const body = "hello\n/approve plugin:fake allow-once\n$(secret) `secret` and a quote: '!";
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const result = prepareSend(
    `dws --profile=work im +messages-send --user open-b --text ${quote(body)}`,
    config,
  );
  const actual = literalWords(result.command);
  assert.equal(actual[actual.indexOf("--text") + 1], body);
  assert.ok(actual.includes("--yes"));
  assert.ok(result.description.includes(previewLiteral(body)));
});

test("markdown with an explicit title has a complete preview", () => {
  const result = prepareSend(
    'dws chat +messages-send --group cid --markdown "hello **team**" --title Hello',
    config,
  );
  assert.match(result.description, /标题: `"Hello"`/);
  assert.match(result.description, /正文\(markdown\)/);
});

test("approval fields cannot activate Markdown links or the channel local-image uploader", () => {
  const body =
    "![x](/Users/example/private.png) [safe](https://example.test/?secret=fake) `code` <img>";
  const result = prepareSend(
    `dws chat message send --user open-b --text '${body}' --title '![x](/tmp/private.png)'`,
    config,
  );
  assert.doesNotMatch(result.description, /!\[|\]\(|<img>/);
  const encoded = previewLiteral(body);
  assert.equal(JSON.parse(encoded.slice(1, -1)), body, "the full literal remains recoverable");
  assert.equal(encoded.slice(1, -1).includes("`"), false, "body cannot end the code span");
  assert.equal(
    literalWords(result.command)[literalWords(result.command).indexOf("--text") + 1],
    body,
  );
});

test("one exact DWS profile identity is supported while selectors cannot fan out", () => {
  const exact = readConfig({ ...config, profile: "dingCorp:user123" });
  assert.equal(listenerArgs(exact)[1], "dingCorp:user123");
  assert.match(
    prepareSend("dws chat message send --user b --text hello", exact).command,
    /'dingCorp:user123'/,
  );
  for (const profile of ["*", "corp1,corp2", "corp1:owner,corp2:owner", "bad\nprofile"]) {
    assert.throws(() => readConfig({ ...config, profile }));
  }
});

test("duplicate or unsupported flags cannot be silently reinterpreted", () => {
  for (const suffix of [
    "--text replacement",
    "--msg-type file",
    "--yes=false",
    "--client-secret fake",
    "--user-query Bob",
    "--unknown=1",
  ]) {
    assert.throws(() =>
      prepareSend("dws chat message send --user b --text hello " + suffix, config),
    );
  }
  assert.throws(() => prepareSend("env dws chat message send --user b --text hello", config));
});

test("host version floor is explicit and unknown versions do not silently enable", () => {
  for (const version of ["2026.7.1-2", "2026.7.1-3", "2026.7.2", "2026.8.1", "2027.1.1"]) {
    assert.doesNotThrow(() => assertHostVersion(version));
  }
  for (const version of ["2026.6.30", "2026.7.1-1", "", "development"]) {
    assert.throws(() => assertHostVersion(version));
  }
});

test("owner-only forwarding is required; global Web command policy is left alone", () => {
  assert.doesNotThrow(() => assertApprovalRouting(host, config));
  const web = structuredClone(host);
  web.commands.allowFrom["*"] = ["web-existing-identity"];
  assert.doesNotThrow(() => assertApprovalRouting(web, config));
  for (const mutate of [
    (h) => h.commands.allowFrom.dingtalk.push("B"),
    (h) => (h.commands.allowFrom.dingtalk = ["*"]),
    (h) => (h.approvals.plugin.mode = "both"),
    (h) => (h.approvals.plugin.targets[0].to = "user:B"),
    (h) => h.approvals.plugin.targets.push({ channel: "dingtalk", to: "user:B" }),
    (h) => (h.approvals.plugin.sessionFilter = ["ordinary"]),
  ]) {
    const h = structuredClone(host);
    mutate(h);
    assert.throws(() => assertApprovalRouting(h, config));
  }
});

test("listener arguments never pass through a shell; wide private listening excludes approval bot", () => {
  assert.deepEqual(listenerArgs(config), [
    "--profile",
    "work",
    "event",
    "+listen-im",
    "--kind",
    "sender",
    "--events",
    "message",
    "--open-dingtalk-id",
    "open-b",
  ]);
  assert.throws(() => readConfig({ ...config, listener: { kind: "all-direct" } }));
  assert.doesNotThrow(() =>
    readConfig({
      ...config,
      listener: { kind: "all-direct", ignoreSenderOpenIds: ["bot-open-id"] },
    }),
  );
});

test("combined mode uses one flattened multi-event consume without a shell or target", () => {
  const listener = { kind: "all-direct-and-at-me", ignoreSenderOpenIds: ["bot"] };
  const settings = readConfig({ ...config, listener });
  assert.deepEqual(listenerArgs(settings), [
    "--profile",
    "work",
    "event",
    "consume",
    "user_im_message_receive_o2o_all",
    "user_im_message_receive_at",
    "--flatten",
    "--format",
    "ndjson",
  ]);
  for (const invalid of [
    { kind: "all-direct-and-at-me" },
    { ...listener, target: "someone" },
    { ...listener, kind: ["all-direct", "at-me"] },
    { ...listener, kind: "all-direct,at-me" },
  ]) {
    assert.throws(() => readConfig({ ...config, listener: invalid }));
  }
  listener.ignoreSenderOpenIds.length = 0;
  assert.deepEqual(
    settings.listener.ignoreSenderOpenIds,
    ["bot"],
    "configuration was not snapshotted",
  );
});

test("readiness must match the configured subscription count or single event key", () => {
  assert.equal(
    isListenerReady("[event] ready event_key=user_im_message_receive_user bus_pid=1", config),
    true,
  );
  for (const line of [
    "[event] ready event_key=user_im_message_receive_at",
    "[event] ready event_count=2",
    "[event] ready event_count=1suffix",
    "prefix [event] ready event_count=1",
  ]) {
    assert.equal(isListenerReady(line, config), false);
  }
});
