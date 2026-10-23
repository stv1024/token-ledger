// Paseo 0.12 hides agents in background workspaces from agents.list,
// workspaces.list and their agent_update streams unless the request opts in.
// Typed as {} so SDK pins that predate the field still accept it; older hosts
// have no background workspaces and drop the unknown field.
const INCLUDE_BACKGROUND: {} = { includeBackground: true };

// A 0.12+ client SDK rejects the filter before sending it to a host that does
// not advertise background workspaces.
function isUnsupported(error: unknown): boolean {
  return error instanceof Error && /use background workspaces/i.test(error.message);
}

/** Lists with background workspaces included, or unfiltered on hosts that lack them. */
export async function includingBackground<T>(call: (filter: {}) => Promise<T>): Promise<T> {
  try {
    return await call(INCLUDE_BACKGROUND);
  } catch (error) {
    if (!isUnsupported(error)) throw error;
    return call({});
  }
}
