// textedit's command line and window URL (engine/apps.js).
import { resolve } from "@std/path";

export const appId = "textedit";

const HELP = `textedit — a text editor

Usage: textedit [file]

Edits text with syntax highlighting (detected from the file's name or first
line). Markdown can also be edited as it reads, rendered. Without a file it
starts a new one (saved with Ctrl+S, which asks where). Runs on phil-engine,
like phil; see \`phil-engine --help\` for the engine options (--browser,
--standalone, --quit, --retire).
`;

export function parse(args, { cwd }) {
  if (args.some((a) => a === "-h" || a === "--help")) return { help: HELP };
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) throw new Error(`Unknown option ${unknown}`);
  if (args.length > 1) throw new Error("one file at a time");
  return { open: { file: args[0] ? resolve(cwd, args[0]) : null } };
}

export function windowUrl(base, { file }) {
  if (file) base.searchParams.set("file", file);
  return base;
}
