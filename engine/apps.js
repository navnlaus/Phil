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
//                            instance (see instance.js)
//                windowUrl(base, open)
//                            the page URL for a window: `base` is the app's
//                            server URL (a URL object) to add a query or hash to
//                cleanUp(profile)  optional, when the engine exits
//   server.js  Runs in the engine's server worker. Exports UI_DIR (its ui/
//              folder, served at / and /ui/) and createServer({ profile, quit }),
//              resolving to { handle(req, url) => Response | null, port? }.
//              The engine has checked the session (and a WebSocket's origin)
//              before handle() sees a request.
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
};
