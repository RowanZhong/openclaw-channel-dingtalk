// Load only when drafting: host SDK discovery must not slow plugin/Gateway startup.
let scopeTask;
async function hostScope() {
  scopeTask ??= (async () => {
    let scope,
      ambient = false;
    try {
      scope = await import("openclaw/plugin-sdk/agent-scope-runtime");
      ambient = typeof scope.resolveSessionAgentIdsStrict === "function";
    } catch (error) {
      if (!["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND"].includes(error.code))
        throw error;
      scope = await import("openclaw/plugin-sdk/agent-runtime");
    }
    const { normalizeAgentId } = await import("openclaw/plugin-sdk/routing");
    return { scope, ambient, normalizeAgentId };
  })();
  return scopeTask;
}
const failure = (code) => Object.assign(new Error(code), { code });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export async function completionAgent(api, config) {
  // The completion runtime reads current config too. A registration snapshot can
  // be stale after a host config reload or $include expansion.
  const { scope, ambient, normalizeAgentId } = await hostScope();
  const current = api.runtime?.config?.current;
  const cfg = typeof current === "function" ? current() : api.config;
  if (!object(cfg)) throw failure("LLM_DRAFT_CONFIG_UNAVAILABLE");
  const agents = cfg.agents ?? {};
  const entries = ambient && Object.hasOwn(agents, "entries") && agents.entries !== undefined;
  const roster = entries ? agents.entries : agents.list;
  if (roster !== undefined && (entries ? !object(roster) : !Array.isArray(roster)))
    throw failure("LLM_DRAFT_CONFIG_UNAVAILABLE");
  const target = normalizeAgentId(config.agentId);
  if (!scope.listAgentIds(cfg).includes(target)) throw failure("LLM_DRAFT_AGENT_NOT_CONFIGURED");
  let owner;
  try {
    if (ambient) {
      // New hosts honor systemAgent before the retained/legacy default owner.
      const system = agents.defaults?.systemAgent?.agentId;
      owner =
        typeof system === "string" && system.trim()
          ? normalizeAgentId(system)
          : scope.resolveSessionAgentIds({ config: cfg }).sessionAgentId;
    } else {
      // Old hosts use default:true, then the first entry, then implicit main.
      owner = scope.resolveDefaultAgentId(cfg);
    }
  } catch (error) {
    if (error.code !== "AGENT_SELECTION_REQUIRED") throw failure("LLM_DRAFT_CONFIG_UNAVAILABLE");
    // No ambient owner: keep the explicit target and let host policy authorize it.
  }
  // Omit only when it resolves to the configured target. Never retry another agent
  // or switch to an agent run after an authorization error.
  return owner === target ? {} : { agentId: target };
}
