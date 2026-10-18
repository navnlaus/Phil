// index.html, particles.js and its shaders over http, for a browser (modules aren't loaded from file://):
//   deno run --allow-net --allow-read experiments/webgpu/serve.js [port]
const dir = new URL(".", import.meta.url);
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", wgsl: "text/wgsl; charset=utf-8" };
const port = Number(Deno.args[0]) || 8137;

Deno.serve({ hostname: "127.0.0.1", port }, async (req) => {
  const name = new URL(req.url).pathname.slice(1) || "index.html";
  if (!["index.html", "particles.js", "common.wgsl", "step.wgsl", "draw.wgsl"].includes(name)) return new Response("Not here", { status: 404 });
  return new Response(await Deno.readFile(new URL(name, dir)), { headers: { "content-type": TYPES[name.split(".").pop()] } });
});
