import ts from "typescript";

/**
 * Syntax-aware guard for statically written ambient environment access.
 *
 * ClawHub's `suspicious.env_credential_access` rule ("environment variable access
 * combined with network send") stayed open on the single-key read that used to
 * resolve an `env` SecretInput. That read now happens inside the host SDK
 * (`openclaw/plugin-sdk/secret-ref-readonly`), so this guard keeps a direct ambient
 * read from silently reappearing in the published artifact.
 *
 * It walks the real syntax tree instead of matching text, because equivalent
 * spellings are trivial to write and invisible to a `process.env` regex:
 * `process?.env.X`, `process["env"].X`, `globalThis.process.env.X`,
 * `const { env } = process`, `const p = process`, and
 * `import { env } from "node:process"` are all reported.
 *
 * Only the documented non-credential card template id override is allowed; see
 * `docs/user/reference/security-policies.md` (环境变量读取范围). Like any shape
 * guard this is a tripwire, not a sandbox: runtime string construction
 * (`globalThis["pro" + "cess"]`) and `Function`-built accessors stay out of scope
 * by design, while every statically written environment read fails the check.
 */

/** Environment keys a bundle may read directly; the only entry is non-credential. */
export const ALLOWED_ENV_KEYS = new Set(["DINGTALK_CARD_TEMPLATE_ID"]);

const GLOBAL_OBJECT_NAMES = new Set(["globalThis", "global", "self", "window"]);
const PROCESS_MODULE_SPECIFIERS = new Set(["process", "node:process"]);

function stringLiteralText(node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return undefined;
}

/** Property read by `a.b` / `a["b"]`, or `undefined` for any other node. */
function accessedPropertyName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    return stringLiteralText(node.argumentExpression);
  }
  return undefined;
}

function isGlobalObjectIdentifier(node) {
  return ts.isIdentifier(node) && GLOBAL_OBJECT_NAMES.has(node.text);
}

/** Matches `process`, `globalThis.process`, `global.process`, `globalThis["process"]`. */
function isProcessGlobalReference(node) {
  if (!node) {
    return false;
  }
  if (ts.isIdentifier(node)) {
    return node.text === "process" && isValueReference(node);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "process" && isGlobalObjectIdentifier(node.expression);
  }
  if (ts.isElementAccessExpression(node)) {
    return (
      stringLiteralText(node.argumentExpression) === "process" &&
      isGlobalObjectIdentifier(node.expression)
    );
  }
  return false;
}

/** Excludes identifiers that are names (declarations, imports, property keys). */
function isValueReference(node) {
  const parent = node.parent;
  if (!parent || parent.name !== node) {
    return true;
  }
  return !(
    ts.isPropertyAccessExpression(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isBindingElement(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent)
  );
}

function skipParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Names bound by an object pattern element, covering `{ env }` and `{ env: e }`. */
function boundPatternNames(pattern) {
  const names = [];
  for (const element of pattern.elements) {
    const name = element.propertyName ?? element.name;
    if (ts.isIdentifier(name)) {
      names.push(name);
    }
  }
  return names;
}

/** True when the reference is the base of `process.x` / `process[x]` / `typeof process`. */
function isProcessGlobalAccessBase(node) {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (ts.isTypeOfExpression(parent)) {
    return true;
  }
  return (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

/** True when the reference is only the source of a destructuring pattern. */
function isDestructuringSource(node) {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (ts.isVariableDeclaration(parent)) {
    return parent.initializer === node && ts.isObjectBindingPattern(parent.name);
  }
  return ts.isBinaryExpression(parent) && parent.right === node;
}

/**
 * Collects every statically written ambient environment access in `source`.
 *
 * Returns human-readable locations so a failing check names the offending node.
 * Pass `scriptKind: ts.ScriptKind.TS` when scanning TypeScript sources.
 */
export function findAmbientEnvAccess(source, options = {}) {
  const {
    allowedEnvKeys = ALLOWED_ENV_KEYS,
    fileName = "runtime.js",
    scriptKind = ts.ScriptKind.JS,
  } = options;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const violations = new Set();

  const report = (node, kind) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const snippet = node.getText(sourceFile).replace(/\s+/gu, " ").slice(0, 80);
    violations.add(`${kind} at line ${line + 1}: ${snippet}`);
  };

  /** `const { env } = process` and `({ env } = process)`. */
  const checkDestructuringFromProcess = (pattern, processNode) => {
    for (const name of boundPatternNames(pattern)) {
      if (name.text === "env") {
        report(processNode, "destructured ambient environment");
      }
    }
  };

  /** `import process from "node:process"` / `import { env } from "node:process"`. */
  const checkProcessModuleImport = (node) => {
    if (!ts.isImportDeclaration(node)) {
      return;
    }
    if (!PROCESS_MODULE_SPECIFIERS.has(stringLiteralText(node.moduleSpecifier) ?? "")) {
      return;
    }
    const clause = node.importClause;
    if (!clause) {
      return;
    }
    const bindings = clause.namedBindings;
    const importsWholeModule =
      Boolean(clause.name) || (bindings !== undefined && ts.isNamespaceImport(bindings));
    const importsEnv =
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => (element.propertyName ?? element.name).text === "env");
    if (importsWholeModule || importsEnv) {
      report(node, "ambient environment import");
    }
  };

  const visit = (node) => {
    // `process.env` in every equivalent spelling, matched through the syntax tree.
    if (accessedPropertyName(node) === "env" && isProcessGlobalReference(node.expression)) {
      const parent = node.parent;
      const readsAllowedKey =
        parent !== undefined &&
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node &&
        allowedEnvKeys.has(accessedPropertyName(parent));
      if (!readsAllowedKey) {
        report(node, "ambient environment read");
      }
    }

    // `const { env } = process` / `({ env } = process)`.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name) &&
      isProcessGlobalReference(node.initializer)
    ) {
      checkDestructuringFromProcess(node.name, node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isProcessGlobalReference(node.right)
    ) {
      const target = skipParentheses(node.left);
      if (ts.isObjectLiteralExpression(target)) {
        for (const property of target.properties) {
          const name = ts.isShorthandPropertyAssignment(property)
            ? property.name
            : ts.isPropertyAssignment(property)
              ? property.name
              : undefined;
          if (name !== undefined && ts.isIdentifier(name) && name.text === "env") {
            report(node.right, "destructured ambient environment");
          }
        }
      }
    }

    // Aliasing or handing the global itself around (`const p = process`), which is
    // how an indirect read would be built. Access bases such as `process.env.X`,
    // `process.cwd()` and destructuring sources stay allowed.
    if (
      isProcessGlobalReference(node) &&
      !isProcessGlobalAccessBase(node) &&
      !isDestructuringSource(node)
    ) {
      report(node, "process global alias");
    }

    checkProcessModuleImport(node);
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...violations];
}
