import assert from "node:assert/strict";
import test from "node:test";
import { findDwsSendCommand as match } from "../command-policy.mjs";

test("both selected operations match without confirmation or identity flags", () => {
  assert.equal(match("dws chat message send --user fake --text hello"), "chat message send");
  assert.equal(
    match("dws chat +messages-send --open-dingtalk-id fake --text hello"),
    "chat +messages-send",
  );
});

test("confirmation, preview and identity do not exempt selected operations", () => {
  for (const flags of [
    "--yes",
    "-y",
    "--yes=false",
    "--dry-run",
    "--dry-run=false",
    "--as user",
    "--as bot",
    "--identity webhook",
  ]) {
    assert.equal(match(`dws chat +messages-send ${flags} --text fake`), "chat +messages-send");
  }
});

test("root flags can precede or separate command words", () => {
  for (const command of [
    "dws --profile fake chat message send",
    "dws --profile=fake chat --yes message --format json send",
    "dws -f json chat +messages-send",
    "dws -fjson -vy chat message send",
    "dws -vfjson chat message send",
    "dws --text 'not a command' chat message send",
    "dws chat --user fake message --text payload send",
    "dws --YES chat --clientId fake message send",
    "dws --client_id fake chat message send",
    "dws --yes true chat --verbose false message send",
    "dws -y true chat message send",
    "dws --yes y chat --verbose n message send",
    "dws --timeout30 chat message send",
    "dws --yestrue chat +messages-send",
    "dws --formatjson chat message send",
    "dws --asuser chat +messages-send",
    "dws --timout 30 chat message send",
    "dws --yess chat +messages-send",
  ]) {
    assert.ok(match(command), command);
  }
});

test("absolute executable paths, quotes and shell escapes are normalized", () => {
  for (const command of [
    "/opt/bin/dws chat message send",
    "'/opt/my tools/dws' chat message send",
    "d'w's \"chat\" message s\\end",
    "dws\tchat\tmessage\tsend",
    "dws \\\nchat message send",
  ]) {
    assert.equal(match(command), "chat message send", command);
  }
});

test("the existing im alias is treated as the same selected operation", () => {
  assert.equal(match("dws im message send"), "chat message send");
  assert.equal(match("dws im +messages-send"), "chat +messages-send");
});

test("simple assignment and executable wrappers are recognized", () => {
  for (const prefix of [
    "X=fake",
    "env X=fake",
    "/usr/bin/env -i X=fake",
    "command --",
    "command -p",
    "exec",
    "nohup",
    "env command",
  ]) {
    assert.equal(match(`${prefix} dws chat message send`), "chat message send", prefix);
  }
});

test("ordinary command lists, pipes and subshells still intercept the send", () => {
  for (const command of [
    "pwd && dws chat message send",
    "false || dws chat message send",
    "pwd; dws chat +messages-send",
    "pwd\ndws chat message send",
    "printf yes | dws chat message send",
    "(dws chat message send)",
    "dws chat message send > /tmp/example-output",
  ]) {
    assert.ok(match(command), command);
  }
});

test("mentioning the command as quoted data does not intercept unrelated commands", () => {
  for (const command of [
    "echo 'dws chat message send'",
    "printf '%s' 'dws chat +messages-send'",
    "dws chat message list --text 'dws chat message send'",
    "dws --profile 'chat message send' contact +me",
    "dws --profile chat message send --help",
    "echo 'a; dws chat message send'",
    'echo "a \\\" dws chat message send"',
    "echo foo\\;dws chat message send",
  ]) {
    assert.equal(match(command), undefined, command);
  }
});

test("comments are not commands, but subsequent lines are inspected", () => {
  assert.equal(match("# dws chat message send\npwd"), undefined);
  assert.equal(match("pwd # dws chat message send"), undefined);
  assert.equal(match("pwd # comment\ndws chat message send"), "chat message send");
  assert.equal(match("dws chat message send --text '# hello'"), "chat message send");
});

test("other DWS operations and other executables remain unaffected", () => {
  for (const command of [
    "dws chat message list",
    "dws chat message reply",
    "dws chat +messages-reply",
    "dws chat +messages-forward",
    "dws chat message send-card",
    "dws chat +dm",
    "dws event listen",
    "dws schema 'chat message send'",
    "dws help chat message send",
    "notdws chat message send",
    "dws chat +messages-send-extra",
    "git status",
  ]) {
    assert.equal(match(command), undefined, command);
  }
});

test("missing or malformed shell command data is not executed by the matcher", () => {
  for (const value of [
    undefined,
    null,
    {},
    "",
    "dws chat",
    "dws chat message 'send",
    "dws chat message send\\",
  ]) {
    assert.equal(match(value), undefined);
  }
});

test("known scope limits remain explicit: script bodies and dynamic names are not inspected", () => {
  for (const command of [
    "bash script.sh",
    "python script.py",
    "sh -c 'dws chat message send'",
    "$DWS chat message send",
  ]) {
    assert.equal(match(command), undefined);
  }
});

test("DWS end-of-flags routing and profile CSV normalization preserve selected paths", () => {
  for (const command of [
    "dws --help -- chat message send",
    "dws chat --help -- +messages-send",
    "dws --profile fake1, fake2 chat message send",
    "dws --profile=fake1, fake2, fake3 chat +messages-send",
  ]) {
    assert.ok(match(command), command);
  }
});

test("shell redirection before or within a direct command does not hide it", () => {
  for (const command of [
    ">/tmp/fake dws chat message send",
    "dws 2>/dev/null chat message send",
    "dws </dev/null chat message send",
    "dws 2>&1 chat message send",
    "dws &>/tmp/fake chat message send",
    "dws chat message >>/tmp/fake send",
  ]) {
    assert.equal(match(command), "chat message send", command);
  }
  assert.equal(match("echo '>dws chat message send'"), undefined);
  assert.equal(match("echo >'dws chat message send' hello"), undefined);
});

test("a later malformed line cannot erase an already complete command", () => {
  assert.equal(match('dws chat message send\nprintf "'), "chat message send");
  assert.equal(match("dws chat message send\nprintf \\"), "chat message send");
});
