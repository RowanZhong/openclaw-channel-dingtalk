// Static command matching only. This never evaluates shell input or opens files.
// Script bodies, dynamic executable names and shell expansion are not resolved.

// DWS v1.0.58 root flags and flags of the two selected leaves that take a value.
const VALUE_FLAGS = new Set([
  "client-id",
  "client-secret",
  "fields",
  "format",
  "jq",
  "output",
  "profile",
  "timeout",
  "token",
  "identity",
  "as",
  "group",
  "chat-id",
  "groups",
  "groups-file",
  "chat-query",
  "user",
  "user-query",
  "open-dingtalk-id",
  "users",
  "open-dingtalk-ids",
  "robot-code",
  "webhook-token",
  "msg-type",
  "text",
  "title",
  "markdown",
  "file",
  "file-path",
  "media-id",
  "at-mobiles",
  "at-open-dingtalk-ids",
  "at-user-ids",
  "uuid",
  "idempotency-key",
  "contact-id",
  "latitude",
  "longitude",
  "location-name",
  "map-thumbnail-url",
]);
const BOOLEAN_FLAGS = new Set([
  "debug",
  "dry-run",
  "mock",
  "verbose",
  "yes",
  "help",
  "version",
  "ai-tag",
  "at-all",
]);

/** Split ordinary shell command lists while retaining quoted arguments as words. */
function splitCommands(source) {
  const commands = [];
  let words = [];
  let word = "";
  let started = false;
  let quote = "";
  let plainWord = true;
  let redirectTarget = false;
  const finishWord = () => {
    if (started) {
      if (!redirectTarget) {
        words.push(word);
      }
      redirectTarget = false;
    }
    word = "";
    started = false;
    plainWord = true;
  };
  const finishCommand = () => {
    finishWord();
    if (words.length) {
      commands.push(words);
    }
    words = [];
    redirectTarget = false;
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") {
        quote = "";
      } else {
        word += char;
      }
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = source[i + 1];
      if (next === undefined) {
        return commands;
      }
      if (!quote || ["$", "`", '"', "\\", "\n"].includes(next)) {
        i++;
        if (next !== "\n") {
          word += next;
          started = true;
          plainWord = false;
        }
        continue;
      }
    }
    if (quote === '"') {
      if (char === '"') {
        quote = "";
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      plainWord = false;
    } else if (char === "#" && !started) {
      while (i < source.length && source[i] !== "\n") {
        i++;
      }
      finishCommand();
    } else if (char === "<" || char === ">" || (char === "&" && source[i + 1] === ">")) {
      // Remove shell-owned redirection syntax, not quoted message data.
      if (plainWord && /^\d+$/.test(word)) {
        word = "";
        started = false;
      }
      finishWord();
      if (char === "&") {
        i++;
      }
      if (source[i + 1] === source[i] || ["&", "|"].includes(source[i + 1])) {
        i++;
      }
      redirectTarget = true;
    } else if (";|&()\n".includes(char)) {
      finishCommand();
    } else if (/\s/.test(char)) {
      finishWord();
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) {
    return commands;
  }
  finishCommand();
  return commands;
}

function basename(value) {
  return value.slice(value.lastIndexOf("/") + 1);
}

function normalizeFlag(flag) {
  return flag
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_.\s-]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function isBooleanValue(value) {
  return /^(true|false|yes|no|on|off|1|0|t|f|y|n)$/i.test((value ?? "").trim());
}

function skipPrefixes(words) {
  let i = 0;
  const skipAssignments = () => {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) {
      i++;
    }
  };
  skipAssignments();
  // These simple literal wrappers are supported; shell -c/eval are not evaluated.
  while (["env", "command", "exec", "nohup", "!", "time"].includes(basename(words[i] ?? ""))) {
    const wrapper = basename(words[i++]);
    if (wrapper === "time") {
      while ((words[i] ?? "").startsWith("-") && words[i] !== "--") {
        const option = words[i++];
        if (["-f", "--format", "-o", "--output"].includes(option)) {
          i++;
        }
      }
    }
    if (wrapper === "command" && words[i] === "-p") {
      i++;
    }
    if (wrapper === "env" && ["-i", "--ignore-environment"].includes(words[i])) {
      i++;
    }
    if (words[i] === "--") {
      i++;
    }
    skipAssignments();
  }
  return i;
}

function matchInvocation(words, configuredPath) {
  let i = skipPrefixes(words);
  const executable = words[i++];
  const names = ["dws", "dws.exe"];
  if (configuredPath) {
    names.push(basename(configuredPath));
  }
  if (!names.includes(basename(executable ?? ""))) {
    return;
  }
  const path = [];
  let flagsEnded = false;
  for (; i < words.length; i++) {
    const word = words[i];
    if (!flagsEnded && word === "--") {
      flagsEnded = true;
      continue;
    }
    if (!flagsEnded && word.startsWith("--")) {
      const equal = word.indexOf("=");
      const flag = normalizeFlag(word.slice(2, equal < 0 ? undefined : equal));
      if (VALUE_FLAGS.has(flag)) {
        let value = equal < 0 ? words[i + 1] : word.slice(equal + 1);
        if (equal < 0) {
          i++;
        }
        // The CLI joins space-separated --profile CSV fragments before parsing.
        while (
          flag === "profile" &&
          value?.trim().endsWith(",") &&
          words[i + 1]?.trim() &&
          !words[i + 1].trim().startsWith("-")
        ) {
          value = words[++i];
        }
      } else if (!BOOLEAN_FLAGS.has(flag)) {
        // DWS repairs attached values and misspelled options. Do not silently
        // exempt a visible selected command because an option is unfamiliar.
        // Ambiguous options can cause conservative extra approval prompts.
        const expected =
          path.length === 0
            ? ["chat", "im"]
            : path.length === 1
              ? ["message", "+messages-send"]
              : ["send"];
        if (
          equal < 0 &&
          words[i + 1] &&
          !words[i + 1].startsWith("-") &&
          !expected.includes(words[i + 1])
        ) {
          i++;
          while (words[i]?.trim().endsWith(",") && words[i + 1] && !words[i + 1].startsWith("-")) {
            i++;
          }
        }
      } else if (equal < 0 && isBooleanValue(words[i + 1])) {
        i++;
      }
      continue;
    }
    if (!flagsEnded && word.startsWith("-")) {
      let hasValue = false;
      for (let j = 1; j < word.length; j++) {
        if ("fo".includes(word[j])) {
          if (j === word.length - 1) {
            i++;
          }
          hasValue = true;
          break;
        }
        if (!"vyh".includes(word[j])) {
          return;
        }
        if (word[j + 1] === "=") {
          hasValue = true;
          break;
        }
      }
      if (!hasValue && word.length === 2 && isBooleanValue(words[i + 1])) {
        i++;
      }
      continue;
    }
    path.push(word);
    // `im` is the actual v1.0.58 alias of `chat`, not an additional operation.
    if (path.length === 1 && !["chat", "im"].includes(word)) {
      return;
    }
    if (path.length === 2) {
      if (word === "+messages-send") {
        return "chat +messages-send";
      }
      if (word !== "message") {
        return;
      }
    }
    if (path.length === 3) {
      return word === "send" ? "chat message send" : undefined;
    }
  }
}

/** Return only the canonical operation name; never retain message contents. */
export function findDwsSendCommand(command, configuredPath) {
  if (typeof command !== "string") {
    return;
  }
  for (const words of splitCommands(command)) {
    const matched = matchInvocation(words, configuredPath);
    if (matched) {
      return matched;
    }
  }
}
