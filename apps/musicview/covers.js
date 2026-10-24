// Songs' covers, album-sized: made once from the picture in the song (phil's
// audio.js, then vips), kept in a folder by the song's path, size and time.
// musicview's, and the phone link's (phil's link.js: the app's music).
import { join } from "@std/path";
import { coverTo } from "../phil/audio.js";

const COVER_PX = 400;

/** The cover's file in `dir` (made now if need be), or null: the song has none. */
export async function coverFile(path, dir) {
  const stat = await Deno.stat(path);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${path}\0${stat.size}\0${stat.mtime?.getTime()}`)));
  const file = join(dir, Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("") + ".jpg");
  if (await Deno.stat(file).then(() => true, () => false)) return file;
  if (await Deno.stat(`${file}.fail`).then(() => true, () => false)) return null;
  await Deno.mkdir(dir, { recursive: true });
  const raw = `${file}.${crypto.randomUUID().slice(0, 8)}.raw.jpg`, part = `${file}.${crypto.randomUUID().slice(0, 8)}.part.jpg`;
  try {
    await coverTo(path, raw);
    const made = await new Deno.Command("vipsthumbnail", { args: [raw, "--size", `${COVER_PX}x${COVER_PX}`, "-o", `${part}[Q=85,strip]`], stdin: "null", stdout: "null", stderr: "null" }).output();
    if (!made.success) throw new Error("vips");
    await Deno.rename(part, file);
    return file;
  } catch {
    await Deno.writeFile(`${file}.fail`, new Uint8Array()).catch(() => {});
    return null;
  } finally {
    await Deno.remove(raw).catch(() => {});
    await Deno.remove(part).catch(() => {});
  }
}
