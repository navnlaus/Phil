//! The window's drawing, with wgpu (Vulkan here; Direct3D 12 on Windows, Metal
//! on macOS): the particles (the same WGSL as ../webgpu's, Deno's and the
//! browser's), and over them the page CEF draws, from its texture.

use std::sync::Arc;
use winit::window::Window;

const COMMON: &str = include_str!("../../webgpu/common.wgsl");
const STEP: &str = include_str!("../../webgpu/step.wgsl");
const DRAW: &str = include_str!("../../webgpu/draw.wgsl");

// The page's texture drawn over the window (or into ours, below), a triangle that covers it.
const OVERLAY: &str = r#"
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) v: u32) -> Out {
  let uv = vec2f(f32((v << 1u) & 2u), f32(v & 2u));
  var out: Out;
  out.pos = vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
  out.uv = uv;
  return out;
}
@fragment fn fs(in: Out) -> @location(0) vec4f { return textureSample(tex, samp, in.uv); }
"#;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;

/// What a frame needs to know: where the pull is (-1 to 1), how hard, and how long since the last.
pub struct FrameParams {
    pub mouse: [f32; 2],
    pub pull: f32,
    pub dt: f32,
    pub time: f32,
    pub paused: bool,
}

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter_name: String,
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    // The particles.
    uniforms: wgpu::Buffer,
    step: wgpu::ComputePipeline,
    draw: wgpu::RenderPipeline,
    particles: Option<(wgpu::Buffer, wgpu::BindGroup, wgpu::BindGroup)>,
    pub count: u32,
    // The page: our copy of its last frame, drawn over every frame of ours.
    sampler: wgpu::Sampler,
    overlay_layout: wgpu::BindGroupLayout,
    over: wgpu::RenderPipeline,
    blit: wgpu::RenderPipeline,
    page: Option<(wgpu::Texture, wgpu::BindGroup)>,
}

impl Gpu {
    pub fn new(window: Arc<Window>) -> Gpu {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            #[cfg(target_os = "linux")]
            backends: wgpu::Backends::VULKAN, // (CEF's textures come in through Vulkan here)
            #[cfg(target_os = "windows")]
            backends: wgpu::Backends::DX12,
            #[cfg(target_os = "macos")]
            backends: wgpu::Backends::METAL,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let surface = instance.create_surface(window.clone()).expect("a surface for the window");
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            ..Default::default()
        }))
        .expect("a GPU");
        let adapter_name = adapter.get_info().name;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("a device");
        device.on_uncaptured_error(Arc::new(|e| eprintln!("wgpu: {e}")));

        let size = window.inner_size();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: FORMAT,
            color_space: wgpu::SurfaceColorSpace::Auto,
            view_formats: vec![],
            alpha_mode: wgpu::CompositeAlphaMode::Auto,
            width: size.width.max(1),
            height: size.height.max(1),
            desired_maximum_frame_latency: 2,
            present_mode: wgpu::PresentMode::AutoVsync,
        };
        surface.configure(&device, &config);

        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("uniforms"),
            size: 32,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let module = |label, code: String| device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source: wgpu::ShaderSource::Wgsl(code.into()) });
        let step_module = module("step", format!("{COMMON}{STEP}"));
        let draw_module = module("draw", format!("{COMMON}{DRAW}"));
        let step = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("step"),
            layout: None,
            module: &step_module,
            entry_point: Some("step"),
            compilation_options: Default::default(),
            cache: None,
        });
        let add = wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add };
        let draw = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("draw"),
            layout: None,
            vertex: wgpu::VertexState { module: &draw_module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &draw_module,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState { format: FORMAT, blend: Some(wgpu::BlendState { color: add, alpha: add }), write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor::default()); // (nearest: the page's pixels are the window's)
        let overlay_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("page"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { multisampled: false, view_dimension: wgpu::TextureViewDimension::D2, sample_type: wgpu::TextureSampleType::Float { filterable: true } },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let overlay_module = module("overlay", OVERLAY.to_string());
        let overlay_pipeline = |label, blend| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(label), bind_group_layouts: &[Some(&overlay_layout)], immediate_size: 0 })),
                vertex: wgpu::VertexState { module: &overlay_module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
                fragment: Some(wgpu::FragmentState {
                    module: &overlay_module,
                    entry_point: Some("fs"),
                    targets: &[Some(wgpu::ColorTargetState { format: FORMAT, blend, write_mask: wgpu::ColorWrites::ALL })],
                    compilation_options: Default::default(),
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        // The page's pixels come premultiplied (its colours already times its alpha).
        let over = overlay_pipeline("over", Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING));
        let blit = overlay_pipeline("blit", None);

        Gpu { device, queue, adapter_name, window, surface, config, uniforms, step, draw, particles: None, count: 0, sampler, overlay_layout, over, blit, page: None }
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
        }
    }

    /// Starts again with `count` particles, in a disc.
    pub fn seed(&mut self, count: u32) {
        let mut rng = 0x2545_f491_4f6c_dd1du64;
        let mut random = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            (rng >> 40) as f32 / (1u64 << 24) as f32
        };
        let mut data = vec![0f32; count as usize * 4];
        for p in data.chunks_exact_mut(4) {
            let (r, t) = (random().sqrt() * 0.9, random() * std::f32::consts::TAU);
            p[0] = t.cos() * r;
            p[1] = t.sin() * r;
        }
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("particles"),
            size: (data.len() * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.queue.write_buffer(&buffer, 0, bytemuck::cast_slice(&data));
        let group = |pipeline_layout: wgpu::BindGroupLayout| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipeline_layout,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: self.uniforms.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: buffer.as_entire_binding() }],
            })
        };
        let (step_group, draw_group) = (group(self.step.get_bind_group_layout(0)), group(self.draw.get_bind_group_layout(0)));
        self.particles = Some((buffer, step_group, draw_group));
        self.count = count;
    }

    /// A bind group for drawing `texture` (one of the page's) with the overlay pipelines.
    pub fn bind_page(&self, texture: &wgpu::Texture) -> wgpu::BindGroup {
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("page"),
            layout: &self.overlay_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&texture.create_view(&Default::default())) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        })
    }

    // Our copy of the page's frame, `width`×`height` (made again when that changes).
    fn page_texture(&mut self, width: u32, height: u32) -> &wgpu::Texture {
        if self.page.as_ref().is_none_or(|(t, _)| t.width() != width || t.height() != height) {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("page"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: FORMAT,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let group = self.bind_page(&texture);
            self.page = Some((texture, group));
        }
        &self.page.as_ref().unwrap().0
    }

    /// The page's new frame, from its texture on the GPU (`source`: bind_page()'s), drawn
    /// into our copy; waited for, as CEF may draw its next one there once we return.
    pub fn take_page_from_gpu(&mut self, source: &wgpu::BindGroup, width: u32, height: u32) {
        let view = self.page_texture(width, height).create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, resolve_target: None, depth_slice: None, ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
                ..Default::default()
            });
            pass.set_pipeline(&self.blit);
            pass.set_bind_group(0, source, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
    }

    /// (Debugging: how many of our copy's pixels aren't see-through, read back.)
    pub fn visible_pixels(&self) -> usize {
        let Some((texture, _)) = &self.page else { return 0 };
        let (w, h) = (texture.width(), texture.height());
        let row = (w * 4).div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (row * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.queue.submit([encoder.finish()]);
        buffer.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        let Ok(data) = buffer.slice(..).get_mapped_range() else { return 0 };
        (0..h).map(|y| data[(y * row) as usize..(y * row + w * 4) as usize].chunks_exact(4).filter(|p| p[3] > 0).count()).sum()
    }

    /// The page's new frame, from memory (CEF's slower way, when it can't share a texture).
    pub fn take_page_from_memory(&mut self, bgra: &[u8], width: u32, height: u32) {
        let texture = self.page_texture(width, height).clone();
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            bgra,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * width), rows_per_image: Some(height) },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
    }

    /// One frame: the particles moved on and drawn, the page over them, shown (waits for vsync).
    pub fn frame(&mut self, p: &FrameParams) {
        let Some((_, step_group, draw_group)) = &self.particles else { return };
        let surface_texture = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t) => t,
            wgpu::CurrentSurfaceTexture::Suboptimal(t) => {
                self.surface.configure(&self.device, &self.config);
                t
            }
            _ => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
        };
        let (w, h) = (self.config.width as f32, self.config.height as f32);
        let u = [p.mouse[0], p.mouse[1], p.pull, if p.paused { 0.0 } else { p.dt }, 3.0 / w, 3.0 / h, w / h, p.time];
        self.queue.write_buffer(&self.uniforms, 0, bytemuck::cast_slice(&u));

        let view = surface_texture.texture.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        if !p.paused {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.step);
            pass.set_bind_group(0, step_group, &[]);
            pass.dispatch_workgroups(self.count.div_ceil(256), 1, 1);
        }
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.01, g: 0.01, b: 0.02, a: 1.0 }), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.draw);
            pass.set_bind_group(0, draw_group, &[]);
            pass.draw(0..4, 0..self.count);
            if let Some((_, page_group)) = &self.page {
                pass.set_pipeline(&self.over);
                pass.set_bind_group(0, page_group, &[]);
                pass.draw(0..3, 0..1);
            }
        }
        self.queue.submit([encoder.finish()]);
        self.window.pre_present_notify();
        self.queue.present(surface_texture);
    }
}
