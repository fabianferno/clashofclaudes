// Clash of Claudes status plugin for OpenCode. Loaded from OPENCODE_CONFIG_DIR/plugins.
// Forwards four event types to the app's localhost hook server. It never sends message
// contents, tool arguments or file contents, and it never throws into OpenCode.
const FORWARD = new Set(["session.idle", "permission.asked", "tool.execute.after", "session.error"]);

function short(v) {
  return typeof v === "string" ? v.slice(0, 80) : undefined;
}

async function post(type, properties) {
  try {
    const url = process.env.COC_HOOK_URL;
    if (!url || !FORWARD.has(type)) return;
    const payload = { type };
    if (properties !== undefined) payload.properties = properties;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    });
  } catch (_) {
    // Ignore every error: a status hook must never disturb OpenCode.
  }
}

export const CocStatusPlugin = async () => {
  return {
    event: async (arg) => {
      try {
        const event = arg && arg.event;
        const type = event && event.type;
        if (type === "permission.asked") {
          const p = (event && event.properties) || {};
          const props = {};
          const title = short(p.title);
          const kind = short(p.type);
          if (title !== undefined) props.title = title;
          if (kind !== undefined) props.type = kind;
          await post(type, props);
        } else {
          await post(type);
        }
      } catch (_) {}
    },
    "tool.execute.after": async () => {
      await post("tool.execute.after");
    },
  };
};
