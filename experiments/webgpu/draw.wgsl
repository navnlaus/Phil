// particles.js's (and ../cef's): draws them, a quad each. common.wgsl goes before it.
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

struct Out { @builtin(position) pos: vec4f, @location(0) corner: vec2f, @location(1) color: vec3f };

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let corner = vec2f(f32(v & 1u), f32(v >> 1u)) * 2.0 - 1.0; // (a strip of 4)
  let p = particles[i];
  var out: Out;
  out.pos = vec4f(p.pos + corner * u.size, 0.0, 1.0);
  out.corner = corner;
  let fast = clamp(length(p.vel) * 0.8, 0.0, 1.0);
  out.color = mix(vec3f(0.10, 0.30, 1.0), vec3f(1.0, 0.50, 0.15), fast);
  return out;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let a = max(0.0, 1.0 - dot(in.corner, in.corner));
  return vec4f(in.color * a * 0.25, 1.0);
}
