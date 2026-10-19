/* phil's video, in salir: libmpv as a salir plugin (salir.h). A page puts
 * <salir-embed kind="mpv"> where the video goes; mpv draws into salir's GL
 * context there (decoding on the GPU, as it decides: hwdec=auto-safe), plays
 * its sound itself, and is driven by messages, JSON as libmpv's own nodes:
 *
 *   to it   {"command": ["loadfile", "/path", "replace"]}   any of mpv's commands
 *           {"set": {"pause": true, "volume": 50}}           properties
 *           {"observe": ["time-pos", "pause", ...]}          their changes sent back
 *   from it {"properties": {"time-pos": 12.5, ...}}          those changed (at most 20 times a second)
 *           {"event": "file-loaded" | "playback-restart" | "seek" | "end-file", "reason"?, "error"?}
 *           {"error": "...", "command": [...]}               a command that failed
 *
 * The element's attributes are mpv's options (<salir-embed kind="mpv" hwdec="no">).
 * Built by scripts/install.sh (cc ... -lmpv) into ~/.local/lib/phil/salir-mpv.so. */
#include "salir.h"
#include <math.h>
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define SEND_EVERY 0.05 /* properties sent at most this often, seconds */

struct player {
  const salir_host *host;
  mpv_handle *mpv;
  mpv_render_context *render;
  char *pending; /* properties changed, not yet sent: `"name": value, ...` */
  size_t len, cap;
  double sent_at;
};

/* ------------------------------------------------------------- text */

struct buf {
  char *s;
  size_t len, cap;
};

static void put(struct buf *b, const char *s, size_t n) {
  if (b->len + n + 1 > b->cap) {
    b->cap = (b->len + n + 1) * 2;
    b->s = realloc(b->s, b->cap);
  }
  memcpy(b->s + b->len, s, n);
  b->len += n;
  b->s[b->len] = 0;
}
static void puts_(struct buf *b, const char *s) { put(b, s, strlen(s)); }

static void put_string(struct buf *b, const char *s) {
  puts_(b, "\"");
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    char esc[8];
    if (*p == '"' || *p == '\\') esc[0] = '\\', esc[1] = *p, esc[2] = 0;
    else if (*p < 0x20) snprintf(esc, sizeof esc, "\\u%04x", *p);
    else esc[0] = *p, esc[1] = 0;
    puts_(b, esc);
  }
  puts_(b, "\"");
}

/* An mpv node as JSON. */
static void put_node(struct buf *b, const mpv_node *n) {
  char num[40];
  switch (n->format) {
  case MPV_FORMAT_STRING: put_string(b, n->u.string); break;
  case MPV_FORMAT_FLAG: puts_(b, n->u.flag ? "true" : "false"); break;
  case MPV_FORMAT_INT64: snprintf(num, sizeof num, "%lld", (long long)n->u.int64), puts_(b, num); break;
  case MPV_FORMAT_DOUBLE:
    if (isfinite(n->u.double_)) snprintf(num, sizeof num, "%.17g", n->u.double_), puts_(b, num);
    else puts_(b, "null");
    break;
  case MPV_FORMAT_NODE_ARRAY:
  case MPV_FORMAT_NODE_MAP: {
    const int map = n->format == MPV_FORMAT_NODE_MAP;
    puts_(b, map ? "{" : "[");
    for (int i = 0; i < n->u.list->num; i++) {
      if (i) puts_(b, ",");
      if (map) put_string(b, n->u.list->keys[i]), puts_(b, ":");
      put_node(b, &n->u.list->values[i]);
    }
    puts_(b, map ? "}" : "]");
    break;
  }
  default: puts_(b, "null");
  }
}

/* JSON as an mpv node (ours: freed by free_node, not mpv_free_node_contents). */
static const char *ws(const char *s) {
  while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r') s++;
  return s;
}

static void utf8(struct buf *b, unsigned c) {
  char o[4];
  int n = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  if (n == 1) o[0] = c;
  else if (n == 2) o[0] = 0xC0 | (c >> 6), o[1] = 0x80 | (c & 0x3F);
  else if (n == 3) o[0] = 0xE0 | (c >> 12), o[1] = 0x80 | ((c >> 6) & 0x3F), o[2] = 0x80 | (c & 0x3F);
  else o[0] = 0xF0 | (c >> 18), o[1] = 0x80 | ((c >> 12) & 0x3F), o[2] = 0x80 | ((c >> 6) & 0x3F), o[3] = 0x80 | (c & 0x3F);
  put(b, o, n);
}

static const char *parse_string(const char *s, char **out) {
  struct buf b = {0};
  puts_(&b, "");
  for (s++; *s && *s != '"'; s++) {
    if (*s != '\\') {
      put(&b, s, 1);
      continue;
    }
    s++;
    switch (*s) {
    case 'n': put(&b, "\n", 1); break;
    case 't': put(&b, "\t", 1); break;
    case 'r': put(&b, "\r", 1); break;
    case 'b': put(&b, "\b", 1); break;
    case 'f': put(&b, "\f", 1); break;
    case 'u': {
      unsigned c = 0;
      if (sscanf(s + 1, "%4x", &c) != 1) return free(b.s), NULL;
      s += 4;
      if (c >= 0xD800 && c < 0xDC00 && s[1] == '\\' && s[2] == 'u') { /* a surrogate pair */
        unsigned lo = 0;
        if (sscanf(s + 3, "%4x", &lo) == 1 && lo >= 0xDC00 && lo < 0xE000) c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00), s += 6;
      }
      utf8(&b, c);
      break;
    }
    case 0: return free(b.s), NULL;
    default: put(&b, s, 1); /* " \ / */
    }
  }
  if (*s != '"') return free(b.s), NULL;
  *out = b.s;
  return s + 1;
}

static void free_node(mpv_node *n);

static const char *parse_value(const char *s, mpv_node *out) {
  s = ws(s);
  memset(out, 0, sizeof *out);
  if (*s == '"') {
    out->format = MPV_FORMAT_STRING;
    return parse_string(s, &out->u.string);
  }
  if (*s == '{' || *s == '[') {
    const int map = *s == '{';
    const char close = map ? '}' : ']';
    mpv_node_list *list = calloc(1, sizeof *list);
    out->format = map ? MPV_FORMAT_NODE_MAP : MPV_FORMAT_NODE_ARRAY;
    out->u.list = list;
    s = ws(s + 1);
    if (*s == close) return s + 1;
    for (;;) {
      list->values = realloc(list->values, (list->num + 1) * sizeof *list->values);
      if (map) {
        list->keys = realloc(list->keys, (list->num + 1) * sizeof *list->keys);
        list->keys[list->num] = NULL;
        s = ws(s);
        if (*s != '"' || !(s = parse_string(s, &list->keys[list->num]))) return NULL;
        s = ws(s);
        if (*s++ != ':') return list->num++, NULL;
      }
      if (!(s = parse_value(s, &list->values[list->num++]))) return NULL;
      s = ws(s);
      if (*s == ',') s++;
      else if (*s == close) return s + 1;
      else return NULL;
    }
  }
  if (!strncmp(s, "true", 4)) return out->format = MPV_FORMAT_FLAG, out->u.flag = 1, s + 4;
  if (!strncmp(s, "false", 5)) return out->format = MPV_FORMAT_FLAG, out->u.flag = 0, s + 5;
  if (!strncmp(s, "null", 4)) return out->format = MPV_FORMAT_NONE, s + 4;
  char *end;
  const double d = strtod(s, &end);
  if (end == s) return NULL;
  if (strpbrk(s, ".eE") && strpbrk(s, ".eE") < end) out->format = MPV_FORMAT_DOUBLE, out->u.double_ = d;
  else out->format = MPV_FORMAT_INT64, out->u.int64 = (int64_t)d;
  return end;
}

static void free_node(mpv_node *n) {
  if (n->format == MPV_FORMAT_STRING) free(n->u.string);
  if ((n->format == MPV_FORMAT_NODE_ARRAY || n->format == MPV_FORMAT_NODE_MAP) && n->u.list) {
    for (int i = 0; i < n->u.list->num; i++) {
      free_node(&n->u.list->values[i]);
      if (n->u.list->keys) free(n->u.list->keys[i]);
    }
    free(n->u.list->values);
    free(n->u.list->keys);
    free(n->u.list);
  }
  n->format = MPV_FORMAT_NONE;
}

static const mpv_node *get(const mpv_node *map, const char *key) {
  if (map->format != MPV_FORMAT_NODE_MAP) return NULL;
  for (int i = 0; i < map->u.list->num; i++)
    if (!strcmp(map->u.list->keys[i], key)) return &map->u.list->values[i];
  return NULL;
}

/* ------------------------------------------------------------- to the page */

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}

static void send_json(struct player *p, struct buf *b) {
  p->host->send(p->host->ctx, b->s);
  free(b->s);
}

static void send_event(struct player *p, const char *event, const char *reason, const char *error) {
  struct buf b = {0};
  puts_(&b, "{\"event\":");
  put_string(&b, event);
  if (reason) puts_(&b, ",\"reason\":"), put_string(&b, reason);
  if (error) puts_(&b, ",\"error\":"), put_string(&b, error);
  puts_(&b, "}");
  send_json(p, &b);
}

/* A property changed: kept to send (with the others since), its latest value. */
static void changed(struct player *p, const mpv_event_property *prop) {
  struct buf b = {p->pending, p->len, p->cap};
  if (b.len) puts_(&b, ",");
  put_string(&b, prop->name);
  puts_(&b, ":");
  if (prop->format == MPV_FORMAT_NODE) put_node(&b, prop->data);
  else puts_(&b, "null");
  p->pending = b.s, p->len = b.len, p->cap = b.cap;
}

static void flush(struct player *p) {
  if (!p->len) return;
  struct buf b = {0};
  puts_(&b, "{\"properties\":{");
  puts_(&b, p->pending);
  puts_(&b, "}}");
  p->len = 0;
  p->sent_at = now();
  send_json(p, &b);
}

static const char *end_reason(int r) {
  switch (r) {
  case MPV_END_FILE_REASON_EOF: return "eof";
  case MPV_END_FILE_REASON_STOP: return "stop";
  case MPV_END_FILE_REASON_QUIT: return "quit";
  case MPV_END_FILE_REASON_ERROR: return "error";
  case MPV_END_FILE_REASON_REDIRECT: return "redirect";
  default: return "unknown";
  }
}

static void events(struct player *p) {
  for (;;) {
    mpv_event *e = mpv_wait_event(p->mpv, 0);
    if (e->event_id == MPV_EVENT_NONE) break;
    switch (e->event_id) {
    case MPV_EVENT_PROPERTY_CHANGE: changed(p, e->data); break;
    case MPV_EVENT_FILE_LOADED: flush(p), send_event(p, "file-loaded", NULL, NULL); break;
    case MPV_EVENT_PLAYBACK_RESTART: flush(p), send_event(p, "playback-restart", NULL, NULL); break;
    case MPV_EVENT_SEEK: send_event(p, "seek", NULL, NULL); break;
    case MPV_EVENT_END_FILE: {
      const mpv_event_end_file *end = e->data;
      flush(p);
      send_event(p, "end-file", end_reason(end->reason), end->error < 0 ? mpv_error_string(end->error) : NULL);
      break;
    }
    default: break;
    }
  }
  if (p->len && now() - p->sent_at >= SEND_EVERY) flush(p);
  else if (p->len) p->host->request_frame(p->host->ctx); /* (sent at a later frame) */
}

/* ------------------------------------------------------------- salir's calls */

static void *proc_address(void *ctx, const char *name) {
  const struct player *p = ctx;
  return p->host->get_proc_address(p->host->ctx, name);
}

/* mpv has something: a frame, an event (any of its threads). */
static void wake(void *ctx) {
  const struct player *p = ctx;
  p->host->request_frame(p->host->ctx);
}

static void *create(const salir_host *host, const char *options) {
  struct player *p = calloc(1, sizeof *p);
  p->host = host;
  p->mpv = mpv_create();
  if (!p->mpv) return free(p), NULL;
  /* A player inside a page: no window, keys, config or terminal of its own. */
  const char *defaults[][2] = {
    {"vo", "libmpv"}, {"hwdec", "auto-safe"}, {"config", "no"}, {"terminal", "no"}, {"input-default-bindings", "no"},
    {"input-vo-keyboard", "no"}, {"osc", "no"}, {"idle", "yes"}, {"keep-open", "yes"}, {"ytdl", "no"},
  };
  for (size_t i = 0; i < sizeof defaults / sizeof *defaults; i++) mpv_set_option_string(p->mpv, defaults[i][0], defaults[i][1]);
  /* The element's attributes (options): mpv's options (but salir's own: input, lock). */
  mpv_node opts;
  if (parse_value(options, &opts) && opts.format == MPV_FORMAT_NODE_MAP) {
    for (int i = 0; i < opts.u.list->num; i++) {
      const char *key = opts.u.list->keys[i];
      if (!strcmp(key, "input") || !strcmp(key, "lock")) continue;
      mpv_node *v = &opts.u.list->values[i];
      if (v->format == MPV_FORMAT_STRING) mpv_set_option_string(p->mpv, key, v->u.string);
      else mpv_set_option(p->mpv, key, MPV_FORMAT_NODE, v);
    }
  }
  free_node(&opts);
  if (mpv_initialize(p->mpv) < 0) return mpv_terminate_destroy(p->mpv), free(p), NULL;
  mpv_opengl_init_params gl = {.get_proc_address = proc_address, .get_proc_address_ctx = p};
  mpv_render_param params[] = {
    {MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
    {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
    {0},
  };
  if (mpv_render_context_create(&p->render, p->mpv, params) < 0) return mpv_terminate_destroy(p->mpv), free(p), NULL;
  mpv_render_context_set_update_callback(p->render, wake, p);
  mpv_set_wakeup_callback(p->mpv, wake, p);
  return p;
}

static void render(void *embed, uint32_t fbo, int width, int height) {
  struct player *p = embed;
  events(p);
  mpv_render_context_update(p->render);
  mpv_opengl_fbo target = {.fbo = (int)fbo, .w = width, .h = height};
  int flip = 1; /* (salir shows the framebuffer as a window shows GL's) */
  mpv_render_param params[] = {{MPV_RENDER_PARAM_OPENGL_FBO, &target}, {MPV_RENDER_PARAM_FLIP_Y, &flip}, {0}};
  mpv_render_context_render(p->render, params);
}

static void message(void *embed, const char *json) {
  struct player *p = embed;
  mpv_node m;
  if (!parse_value(json, &m) || m.format != MPV_FORMAT_NODE_MAP) {
    free_node(&m);
    return;
  }
  const mpv_node *n;
  if ((n = get(&m, "command")) && n->format == MPV_FORMAT_NODE_ARRAY) {
    mpv_node result;
    const int r = mpv_command_node(p->mpv, (mpv_node *)n, &result);
    if (r < 0) {
      struct buf b = {0};
      puts_(&b, "{\"error\":");
      put_string(&b, mpv_error_string(r));
      puts_(&b, ",\"command\":");
      put_node(&b, n);
      puts_(&b, "}");
      send_json(p, &b);
    } else mpv_free_node_contents(&result);
  }
  if ((n = get(&m, "set")) && n->format == MPV_FORMAT_NODE_MAP)
    for (int i = 0; i < n->u.list->num; i++) mpv_set_property(p->mpv, n->u.list->keys[i], MPV_FORMAT_NODE, &n->u.list->values[i]);
  if ((n = get(&m, "observe")) && n->format == MPV_FORMAT_NODE_ARRAY)
    for (int i = 0; i < n->u.list->num; i++)
      if (n->u.list->values[i].format == MPV_FORMAT_STRING) mpv_observe_property(p->mpv, 0, n->u.list->values[i].u.string, MPV_FORMAT_NODE);
  free_node(&m);
  p->host->request_frame(p->host->ctx); /* (its answers, and a frame of what changed) */
}

static void destroy(void *embed) {
  struct player *p = embed;
  mpv_render_context_free(p->render); /* (salir's GL context current) */
  mpv_terminate_destroy(p->mpv);
  free(p->pending);
  free(p);
}

static const salir_plugin PLUGIN = {SALIR_ABI, create, render, message, destroy};

const salir_plugin *salir_plugin_v1(void) { return &PLUGIN; }
