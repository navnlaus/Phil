// Windows placed over others, on Hyprland (where it's the desktop): an app's
// window opened from another's page (videoplayer's, from phil or mediaview)
// floats exactly over the area the page gives, as if it were inside it, and
// follows that window as it moves, resizes or changes workspace, till it's
// moved or resized itself (then it's let go: a window like any). Elsewhere,
// windows open as the desktop puts them.
//
// Through hyprctl: a window rule (Lua, hyprctl eval) matching the new window's
// first title (salir's initial_title), so it opens there rather than tiled first;
// then dispatchers to follow (hyprctl dispatch).

export const available = !!Deno.env.get("HYPRLAND_INSTANCE_SIGNATURE");

const FOLLOW_MS = 300; // how often the windows are looked at while one follows another

async function hyprctl(...args) {
  try {
    const out = await new Deno.Command("hyprctl", { args, stdin: "null", stdout: "piped", stderr: "null" }).output();
    return out.success ? new TextDecoder().decode(out.stdout) : null;
  } catch {
    return null;
  }
}
const json = async (what) => JSON.parse((await hyprctl("-j", what)) ?? "null");
const lua = (code) => hyprctl("eval", code);
const dispatch = (expr) => hyprctl("dispatch", expr);
const luaString = (s) => JSON.stringify(String(s)); // (JSON's string literals are Lua's)

/**
 * Follows windows placed over others. place() before the window opens (it's
 * given the title to open with); onParentGone(placed) when the window one's
 * over is closed (placed: place()'s `data`), to close it too.
 */
export function createPlacer({ trace = () => {}, onParentGone = () => {} } = {}) {
  const placed = new Map(); // token -> { title, parent (address), rect, child?, expect?, ruleOff }
  let timer = 0;

  async function geometryOf(parent, rect) {
    const monitors = (await json("monitors")) ?? [];
    const mon = monitors.find((m) => m.id === parent.monitor) ?? { x: 0, y: 0 };
    const [x, y, w, h] = rect;
    return {
      at: [Math.round(parent.at[0] + x), Math.round(parent.at[1] + y)], // (global)
      local: [Math.round(parent.at[0] + x - mon.x), Math.round(parent.at[1] + y - mon.y)], // (the monitor's: a rule's move)
      size: [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))],
    };
  }

  async function follow() {
    timer = 0;
    if (!placed.size) return;
    const clients = (await json("clients")) ?? [];
    for (const [token, p] of placed) {
      const parent = clients.find((c) => c.address === p.parent);
      const child = p.child ? clients.find((c) => c.address === p.child) : clients.find((c) => c.initialTitle === p.title);
      if (!child) {
        if (p.child) placed.delete(token); // (closed)
        continue;
      }
      if (!p.child) {
        // It's open: the rule's done its work.
        p.child = child.address;
        p.expect = { at: child.at, size: child.size, workspace: child.workspace?.id };
        lua(`if phil_place and phil_place[${luaString(token)}] then phil_place[${luaString(token)}]:set_enabled(false); phil_place[${luaString(token)}] = nil end`);
        trace(`placed ${child.class} over ${parent?.class ?? "?"}`);
        continue;
      }
      if (!parent) {
        placed.delete(token);
        onParentGone(p);
        continue;
      }
      // Moved or resized by hand (or not floating any more): let go.
      const moved = Math.abs(child.at[0] - p.expect.at[0]) > 2 || Math.abs(child.at[1] - p.expect.at[1]) > 2;
      const resized = Math.abs(child.size[0] - p.expect.size[0]) > 2 || Math.abs(child.size[1] - p.expect.size[1]) > 2;
      if (!child.floating || moved || resized) {
        placed.delete(token);
        trace(`${child.class} let go`);
        continue;
      }
      // Its window moved, resized or went to another workspace: after it.
      const g = await geometryOf(parent, p.rect);
      const w = `window = ${luaString(`address:${p.child}`)}`;
      if (parent.workspace?.id !== child.workspace?.id) await dispatch(`hl.dsp.window.move({ workspace = ${luaString(parent.workspace.id)}, follow = false, ${w} })`);
      if (g.at[0] !== child.at[0] || g.at[1] !== child.at[1]) await dispatch(`hl.dsp.window.move({ x = ${g.at[0]}, y = ${g.at[1]}, ${w} })`);
      if (g.size[0] !== child.size[0] || g.size[1] !== child.size[1]) await dispatch(`hl.dsp.window.resize({ x = ${g.size[0]}, y = ${g.size[1]}, ${w} })`);
      p.expect = { at: g.at, size: g.size, workspace: parent.workspace?.id };
    }
    if (placed.size) timer = setTimeout(follow, FOLLOW_MS);
  }
  const keepFollowing = () => timer || (timer = setTimeout(follow, FOLLOW_MS));

  return {
    /**
     * A window about to open over the active one (the window a page asked from: it has the
     * keyboard), at `rect` there (CSS pixels: x, y, width, height). Resolves to the title it's
     * to open with, or null (not Hyprland, or no such window): opened as any.
     */
    async place(rect, { parentClass, data = {} } = {}) {
      if (!available) return null;
      const parent = await json("activewindow");
      if (!parent?.address || (parentClass && parent.class !== parentClass)) return null;
      const token = crypto.randomUUID().slice(0, 8);
      const title = `phil-over-${token}`;
      const g = await geometryOf(parent, rect);
      const rule = `phil_place = phil_place or {}; phil_place[${luaString(token)}] = hl.window_rule({ name = ${luaString(title)}, match = { initial_title = ${luaString(`^${title}$`)} }, ` +
        `float = true, size = { ${g.size[0]}, ${g.size[1]} }, move = { ${g.local[0]}, ${g.local[1]} }, ` +
        `border_size = 0, rounding = 0, no_anim = true, opacity = "1 1", tag = "-default-opacity" })`;
      if ((await lua(rule)) === null) return null;
      placed.set(token, { title, parent: parent.address, rect, ...data });
      keepFollowing();
      return title;
    },

    /** The area it's over changed (the page's layout): followed from now on. */
    move(match, rect) {
      for (const p of placed.values()) if (match(p)) p.rect = rect;
    },
  };
}
