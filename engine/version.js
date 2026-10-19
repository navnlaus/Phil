// Which phil this is: the git commit it's built from (shown in Preferences).
// The compiled engine's is in engine/ui/build.json, written by install.sh as it
// builds (and removed after); from the source, git says, as it is now.

let info = null;

/** {commit, branch, dirty (changes not committed), built (ISO time, compiled only)}; commit null: unknown. */
export function buildInfo() {
  return (info ??= (async () => {
    try {
      return JSON.parse(await Deno.readTextFile(new URL("./ui/build.json", import.meta.url)));
    } catch { /* from the source */ }
    const dir = new URL("..", import.meta.url).pathname;
    const git = async (...args) => {
      const out = await new Deno.Command("git", { args: ["-C", dir, ...args], stdin: "null", stdout: "piped", stderr: "null" }).output().catch(() => null);
      return out?.success ? new TextDecoder().decode(out.stdout).trim() : null;
    };
    const [commit, branch, status] = await Promise.all([git("rev-parse", "--short", "HEAD"), git("rev-parse", "--abbrev-ref", "HEAD"), git("status", "--porcelain", "--untracked-files=no")]);
    return { commit, branch, dirty: !!status, built: null };
  })());
}
