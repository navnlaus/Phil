// Root access, the one way phil gets it (as the editors' saves, engine/files.js):
// sudo, which remembers a password for a while (its timestamp timeout, 5
// minutes unless set otherwise, for this process: everything phil runs with
// sudo shares it). When it doesn't, a 401 asks the page for the password (the
// password box), which comes back through POST /api/sudo, and the page tries
// again.
import { httpError } from "../../engine/http.js";

const decode = (bytes) => new TextDecoder().decode(bytes);

/** Whether sudo goes without a password now. */
export async function sudoReady() {
  const out = await new Deno.Command("sudo", { args: ["-n", "true"], stdin: "null", stdout: "null", stderr: "null" }).output();
  return out.success;
}

/** Throws a 401 when sudo wants the password: `why` says what for, in the password box. */
export async function requireSudo(why) {
  if (!(await sudoReady())) throw httpError(401, `${why}\nPassword for sudo:`);
}

/** Gives sudo the password (sudo -v); false if it's wrong. It isn't kept anywhere. */
export async function sudoPassword(password) {
  const child = new Deno.Command("sudo", { args: ["-S", "-p", "", "-v"], stdin: "piped", stdout: "null", stderr: "null" }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(String(password) + "\n"));
  await writer.close();
  return (await child.status).success;
}

/** Runs `args` as root (sudo -n: the password given already): {ok, code, stdout, stderr}. */
export async function sudo(args, { ms = 60_000 } = {}) {
  const out = await new Deno.Command("sudo", {
    args: ["-n", "--", ...args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(ms),
  }).output();
  return { ok: out.success, code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr) };
}

/** Whether a command's output says its sudo wanted a password (it has no terminal to ask in). */
export const sudoWanted = (output) => /sudo: (a terminal is required|a password is required|no tty present)/.test(output);
