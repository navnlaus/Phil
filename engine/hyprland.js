// Windows attached to others, on Hyprland (where it's the desktop): an app's
// window opened from another's page (videoplayer's or camview's, from phil or
// mediaview) goes into that window's tile, as a Hyprland group of the two, with
// no tab bar, border or shadow: it looks as if it were inside it. Hyprland's
// own keys and layouts move, resize and tile the two as one (to another
// workspace, to the master area...). Closed, the window it came from is as it
// was. Moved out of the group (Super+Alt+G on Omarchy: Hyprland's "move out of
// group"), it's let go: it floats, a window like any. Elsewhere, windows open as
// the desktop puts them.
//
// It runs in Hyprland itself, as Lua (hyprctl eval), put there by the first
// window placed (again after Hyprland reloads its config, or a newer phil's):
// the new window's first title (salir's initial_title) tells it which window it
// goes with; as it opens (window.open_early, before it's tiled), that window is
// made a group (unless it's in one already), which Hyprland puts it in (it's the
// focused window: group.auto_group; else it's added once open). A timer looks
// at the pairs while there are any: the window gone, the group's undone; the
// window it came from gone, it's closed too; out of the group, let go.

export const available = !!Deno.env.get("HYPRLAND_INSTANCE_SIGNATURE");

const VERSION = "1"; // (a newer one replaces what an older phil put in Hyprland)

async function hyprctl(...args) {
  try {
    const out = await new Deno.Command("hyprctl", { args, stdin: "null", stdout: "piped", stderr: "null" }).output();
    return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
  } catch {
    return null;
  }
}
const json = async (what) => JSON.parse((await hyprctl("-j", what)) ?? "null");
const luaString = (s) => JSON.stringify(String(s)); // (JSON's string literals are Lua's, for these: ASCII)

// What's put in Hyprland (exported for tests; global phil_attach: pending, the windows to come by
// first title; attached, child address -> { parent, made: whether the group's ours }).
export const SETUP = `
phil_attach = phil_attach or { pending = {}, attached = {} }
local A = phil_attach
if A.version ~= ${luaString(VERSION)} then
  for _, s in ipairs(A.subs or {}) do s:remove() end
  for _, r in ipairs(A.rules or {}) do r:set_enabled(false) end
  if A.timer then A.timer:set_enabled(false) end
  A.version = ${luaString(VERSION)}
  local function sel(address) return "address:" .. address end
  local function win(address) return address and hl.get_window(sel(address)) end
  local function tag(address, t) hl.dispatch(hl.dsp.window.tag({ tag = t, window = sel(address) })) end
  -- The pair: no tab bar, border or shadow (decorations); the video opaque (as Omarchy's video apps).
  A.rules = {
    hl.window_rule({ name = "phil-attached", match = { tag = "phil-attached" }, decorate = false }),
    hl.window_rule({ name = "phil-over", match = { initial_title = "^phil-over-.*$" }, tag = "-default-opacity", opacity = "1 1" }),
  }
  local function release(child, a)
    A.attached[child] = nil
    if win(child) then tag(child, "-phil-attached") end
    local p = win(a.parent)
    if not p then return end
    local still = false
    for _, b in pairs(A.attached) do still = still or b.parent == a.parent end
    if not still then tag(a.parent, "-phil-attached") end
    if a.made and not still and p.group and p.group.size == 1 then hl.dispatch(hl.dsp.group.toggle({ window = sel(a.parent) })) end
  end
  local function look()
    for child, a in pairs(A.attached) do
      local c, p = win(child), win(a.parent)
      if not c then
        release(child, a)
      elseif not p then
        hl.dispatch(hl.dsp.window.close({ window = sel(child) }))
      elseif not c.group or not p.group or c.group ~= p.group then
        release(child, a)
        hl.dispatch(hl.dsp.window.float({ action = "enable", window = sel(child) }))
      end
    end
    if next(A.attached) == nil then A.timer:set_enabled(false) end
  end
  -- (An error here would be Hyprland's to show, every time: none, it stops.)
  A.timer = hl.timer(function() if not pcall(look) then A.timer:set_enabled(false) end end, { timeout = 300, type = "repeat" })
  A.timer:set_enabled(false)
  A.subs = {
    -- Before it's tiled: the window it goes with made a group, for Hyprland to put it in.
    hl.on("window.open_early", function(w) pcall(function()
      local p = A.pending[w.initial_title]
      if not p then return end
      A.pending[w.initial_title] = nil
      local parent = win(p.parent)
      if not parent then return end
      tag(p.parent, "+phil-attached")
      tag(w.address, "+phil-attached")
      local made = not parent.group
      if made then hl.dispatch(hl.dsp.group.toggle({ window = sel(p.parent) })) end
      A.attached[w.address] = { parent = p.parent, made = made }
      A.timer:set_enabled(true)
    end) end),
    -- Open: in it (if Hyprland didn't put it there: auto_group off, or another window focused).
    hl.on("window.open", function(w) pcall(function()
      local a = A.attached[w.address]
      local parent = a and win(a.parent)
      if parent and parent.group and w.group ~= parent.group then parent.group:add(w) end
    end) end),
  }
end
`;

/** Attaches windows to others' tiles: attach() before the window opens. */
export function createPlacer({ trace = () => {} } = {}) {
  return {
    /**
     * A window about to open in the tile of the active one (the window a page asked from: it
     * has the keyboard; of class `parentClass`). Resolves to the title it's to open with, or
     * null (not Hyprland, or no such window): opened as any.
     */
    async attach({ parentClass } = {}) {
      if (!available) return null;
      const parent = await json("activewindow");
      if (!parent?.address || (parentClass && parent.class !== parentClass)) return null;
      const title = `phil-over-${crypto.randomUUID().slice(0, 8)}`;
      const out = await hyprctl("eval", `${SETUP}\nphil_attach.pending[${luaString(title)}] = { parent = ${luaString(parent.address)} }`);
      if (out !== "ok") {
        trace(`hyprland: couldn't attach (${out ?? "no hyprctl"})`);
        return null;
      }
      trace(`attaching a window to ${parent.class} (${parent.address})`);
      return title;
    },
  };
}
