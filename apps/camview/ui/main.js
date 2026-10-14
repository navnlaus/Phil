// camview's page: the wall of every camera (?wall=1, wall.js), or one camera (app.js).
await import(new URLSearchParams(location.search).has("wall") ? "./wall.js" : "./app.js");
