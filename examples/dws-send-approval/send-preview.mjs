// Deliberately narrower than detection: approval must describe every send operand.
// Never run a shell, resolve names, expand variables or read files to make a preview.
export function literalWords(source) {
  const words = [];
  let word = "",
    quote = "",
    started = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\0" || /[\u202a-\u202e\u2066-\u2069]/.test(c)) {
      throw new Error("unsupported control character");
    }
    if (quote === "'") {
      if (c === "'") {
        quote = "";
      } else {
        word += c;
      }
    } else if (c === "\\") {
      const next = source[++i];
      if (!next || next === "\n") {
        throw new Error("unsupported escape");
      }
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) {
        word += "\\";
      }
      word += next;
      started = true;
    } else if (quote === '"') {
      if (c === '"') {
        quote = "";
      } else if (c === "$" || c === "`") {
        throw new Error("shell expansion cannot be previewed");
      } else {
        word += c;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === " " || c === "\t") {
      if (started) {
        words.push(word);
      }
      word = "";
      started = false;
    } else if (/[\r\n;|&<>()[\]{}*?!~$`#]/.test(c)) {
      throw new Error("only one literal DWS invocation can be previewed");
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) {
    throw new Error("unterminated quote");
  }
  if (started) {
    words.push(word);
  }
  return words;
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// The channel scans local-image Markdown even inside code spans/fences.
// Remove its delimiters before forwarding; JSON escapes remain reversible.
export function previewLiteral(value) {
  const literal = JSON.stringify(value).replace(
    /[<>&[\]`]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `\`${literal}\``;
}

export function prepareSend(command, config) {
  const words = literalWords(command);
  const executable = words.shift();
  if (executable !== "dws" && executable !== config.dwsPath) {
    throw new Error("use dws or the configured dwsPath directly");
  }
  const values = new Map();
  const path = [];
  const valueFlags = new Set([
    "profile",
    "as",
    "user",
    "open-dingtalk-id",
    "group",
    "chat-id",
    "msg-type",
    "text",
    "markdown",
    "title",
  ]);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (["--yes", "-y"].includes(word)) {
      continue;
    }
    if (!word.startsWith("-")) {
      path.push(word);
      continue;
    }
    const match = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(word);
    if (!match || !valueFlags.has(match[1]) || values.has(match[1])) {
      throw new Error("unsupported or duplicate option");
    }
    const value = match[2] ?? words[++i];
    if (value === undefined) {
      throw new Error("missing option value");
    }
    values.set(match[1], value);
  }
  if (path[0] === "im") {
    path[0] = "chat";
  }
  if (!["chat message send", "chat +messages-send"].includes(path.join(" "))) {
    throw new Error("unsupported command structure");
  }
  if (values.has("profile") && values.get("profile") !== config.profile) {
    throw new Error("profile must match the listener");
  }
  if (values.has("as") && values.get("as") !== "user") {
    throw new Error("listener text approvals support only --as user");
  }
  const targets = ["user", "open-dingtalk-id", "group", "chat-id"].filter((key) => values.has(key));
  if (targets.length !== 1) {
    throw new Error("exactly one stable recipient ID is required");
  }
  const target = values.get(targets[0]);
  if (!target || target.length > 128 || /[\s,\p{Cc}]/u.test(target)) {
    throw new Error("invalid recipient ID");
  }
  const bodyKeys = ["text", "markdown"].filter((key) => values.has(key));
  if (bodyKeys.length !== 1 || !values.get(bodyKeys[0])) {
    throw new Error("one literal text or markdown body is required");
  }
  const kind = bodyKeys[0];
  if (values.has("msg-type") && values.get("msg-type") !== kind) {
    throw new Error("msg-type and body do not agree");
  }
  // DWS 1.0.58 sends user text through a Markdown message envelope too.
  // Bind the title rather than rely on CLI-derived (possibly truncated) titles.
  const title = values.get("title") || "消息";
  values.set("title", title);
  const description = [
    `DWS监听任务；以当前用户身份发送；profile=${previewLiteral(config.profile)}`,
    `接收对象(${targets[0]}): ${previewLiteral(target)}`,
    `标题: ${previewLiteral(title)}`,
    `正文(${kind}): ${previewLiteral(values.get(kind))}`,
    "仅批准本次；拒绝或超时不发送。",
  ].join("\n");
  if (description.length > 512) {
    throw new Error("full preview exceeds 512 characters; shorten the message");
  }
  // Bind executable, profile, identity and CLI confirmation before host approval.
  const argv = [config.dwsPath, "--profile", config.profile, ...path];
  if (path[1] === "+messages-send") {
    argv.push("--as", "user", "--yes");
  }
  for (const [key, value] of values) {
    if (!["as", "profile"].includes(key)) {
      argv.push(`--${key}`, value);
    }
  }
  return {
    command: argv.map(shellQuote).join(" "),
    description,
    targetFlag: targets[0],
    target,
    body: values.get(kind),
    kind,
    title,
  };
}
