// What the particles' shaders share (step.wgsl, draw.wgsl go after it).
struct Particle { pos: vec2f, vel: vec2f };
struct Uniforms { mouse: vec2f, pull: f32, dt: f32, size: vec2f, aspect: f32, time: f32 };
@group(0) @binding(0) var<uniform> u: Uniforms;
