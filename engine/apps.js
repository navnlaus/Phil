// The apps the engine runs. Each is a folder in apps/ with:
//
//   launch.js  Runs in the command that opens a window (`phil-engine <app> ...`)
//              and in the engine's main thread, so it must load fast. Exports:
//                appId       Wayland app id / window class of its windows
//                parse(args, { cwd })
//                            the app's command line: { help: text },
//                            { run: async () => {} } for something that isn't a
//                            window, or { open, profile }: `open` is passed to
//                            windowUrl, `profile` (optional) picks the engine
//                            instance (see instance.js). Also optional: `app`,
//                            another app to open the window of (phil-editor
//                            picks an editor), and `send: { socket, message }`,
//                            a request to make first: if the engine there
//                            answers { ok: true }, that's all.
//                windowUrl(base, open)
//                            the page URL for a window: `base` is the app's
//                            server URL (a URL object) to add a query or hash to
//                cleanUp(profile)  optional, when the engine exits
//   server.js  Runs in the engine's server worker (an app may have none, like
//              phil-editor). Exports UI_DIR (its ui/ folder, served at / and
//              /ui/) and createServer({ profile, quit, controlSocket }),
//              resolving to { handle(req, url) => Response | null, port?,
//              control? }. The engine has checked the session (and a
//              WebSocket's origin) before handle() sees a request.
//              control(message) answers control socket requests addressed to
//              the app ({ to: name, ... }).
//
// String literals in the imports so `deno compile` bundles them.
export const APPS = {
  phil: {
    launch: () => import("../apps/phil/launch.js"),
    server: () => import("../apps/phil/server.js"),
  },
  jsonedit: {
    launch: () => import("../apps/jsonedit/launch.js"),
    server: () => import("../apps/jsonedit/server.js"),
  },
  textedit: {
    launch: () => import("../apps/textedit/launch.js"),
    server: () => import("../apps/textedit/server.js"),
  },
  imageview: {
    launch: () => import("../apps/imageview/launch.js"),
    server: () => import("../apps/imageview/server.js"),
  },
  "phil-editor": {
    launch: () => import("../apps/phil-editor/launch.js"),
  },
};
