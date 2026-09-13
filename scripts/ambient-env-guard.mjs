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

/** Marks a property key that cannot be resolved statically (`{ [key]: e }`). */
const DYNAMIC_PROPERTY_NAME = Symbol("dynamic property name");

/**
 * Static name of a property key, or `DYNAMIC_PROPERTY_NAME` for computed keys.
 *
 * Covers the spellings a binding pattern or assignment target can use:
 * `{ env }`, `{ env: e }`, `{ "env": e }`, `{ ["env"]: e }`, `{ [key]: e }`.
 */
function staticPropertyName(node) {
  if (!node) {
    return undefined;
  }
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
    return node.text;
  }
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    const expression = node.expression;
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
    return DYNAMIC_PROPERTY_NAME;
  }
  return DYNAMIC_PROPERTY_NAME;
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

  /**
   * Reports a pattern element or assignment target that reads (or may read) `env`
   * off the process global.
   *
   * An object-rest target always resolves: in Node `process.env` is an enumerable
   * property, so `const { ...proc } = process` really does hand the environment to
   * `proc`. Computed keys that are not string literals are reported too, because
   * the name cannot be proven safe statically.
   */
  const checkDestructuredName = (node, propertyName, isRest) => {
    if (isRest) {
      report(node, "object-rest destructuring of the process global");
      return;
    }
    const name = staticPropertyName(propertyName);
    if (name === "env") {
      report(node, "destructured ambient environment");
    } else if (name === DYNAMIC_PROPERTY_NAME) {
      report(node, "dynamic destructured name from the process global");
    }
  };

  /** `const { env } = process`, `const { ...proc } = process`. */
  const checkObjectPatternFromProcess = (pattern, processNode) => {
    for (const element of pattern.elements) {
      const propertyName =
        element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
      checkDestructuredName(processNode, propertyName, Boolean(element.dotDotDotToken));
    }
  };

  /** `({ env } = process)`, `({ ...proc } = process)`. */
  const checkObjectLiteralFromProcess = (target, processNode) => {
    for (const property of target.properties) {
      if (ts.isSpreadAssignment(property)) {
        checkDestructuredName(processNode, undefined, true);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property)) {
        checkDestructuredName(processNode, property.name, false);
      }
    }
  };

  /**
   * `import process from "node:process"`, `import { env } from "node:process"`,
   * `require("node:process")`, `import("node:process")`.
   */
  const checkProcessModuleAccess = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (!PROCESS_MODULE_SPECIFIERS.has(stringLiteralText(node.moduleSpecifier) ?? "")) {
        return;
      }
      const clause = node.importClause;
      if (!clause) {
        // Side-effect-only imports cannot read the environment.
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
      return;
    }
    if (!ts.isCallExpression(node) || node.arguments.length !== 1) {
      return;
    }
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
    const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    if (!isRequire && !isDynamicImport) {
      return;
    }
    if (PROCESS_MODULE_SPECIFIERS.has(stringLiteralText(node.arguments[0]) ?? "")) {
      report(node, "ambient environment module access");
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

    // Dynamic keys (`process[key]`, `process["en" + "v"]`) cannot be proven safe, so
    // they fail closed instead of relying on constant folding.
    if (
      ts.isElementAccessExpression(node) &&
      stringLiteralText(node.argumentExpression) === undefined &&
      isProcessGlobalReference(node.expression)
    ) {
      report(node, "dynamic property access on the process global");
    }

    // `const { env } = process` / `const { ...proc } = process` / `({ env } = process)`.
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name) &&
      isProcessGlobalReference(node.initializer)
    ) {
      checkObjectPatternFromProcess(node.name, node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isProcessGlobalReference(node.right)
    ) {
      const target = skipParentheses(node.left);
      if (ts.isObjectLiteralExpression(target)) {
        checkObjectLiteralFromProcess(target, node.right);
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

    checkProcessModuleAccess(node);
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...violations];
}
