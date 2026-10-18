// particles.js's (and ../cef's): moves them on, a compute shader. common.wgsl goes before it.
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

@compute @workgroup_size(256)
fn step(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&particles)) { return; }
  var p = particles[i];
  // Toward the mouse (or away), in units that are the same both ways on screen.
  var d = (u.mouse - p.pos) * vec2f(u.aspect, 1.0);
  let r2 = dot(d, d) + 0.003;
  var a = d * (u.pull / (r2 * sqrt(r2))) * 0.05;
  // A slow swirl about the middle, so they're never still.
  a += vec2f(-p.pos.y, p.pos.x * u.aspect) * 0.15;
  p.vel = (p.vel + (a / vec2f(u.aspect, 1.0)) * u.dt) * exp(-0.9 * u.dt);
  let speed = length(p.vel);
  if (speed > 4.0) { p.vel *= 4.0 / speed; }
  p.pos += p.vel * u.dt;
  // Bounced off the edges.
  if (abs(p.pos.x) > 1.0) { p.pos.x = clamp(p.pos.x, -1.0, 1.0); p.vel.x = -p.vel.x * 0.5; }
  if (abs(p.pos.y) > 1.0) { p.pos.y = clamp(p.pos.y, -1.0, 1.0); p.vel.y = -p.vel.y * 0.5; }
  particles[i] = p;
}
