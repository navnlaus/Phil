//! cef-host: a native window drawn with wgpu (the particles of ../webgpu, the
//! same shaders), and over it a web page drawn by CEF off screen, handed over
//! as a GPU texture each frame (no copy through memory). The page is HTML like
//! any (hud.html); the mouse and keys go to it over its panels, to the
//! particles elsewhere.
//!
//!   ./run.sh [--url URL] [--count N] [--auto] [--frames N] [--no-shared-texture]
//!
//! --frames N: quits after N frames, saying how it went (for tests). --auto: the
//! pull goes round by itself. --no-shared-texture: CEF's frames through memory
//! instead, to compare.

mod browser;
mod gpu;
mod keys;

use browser::{Page, Shared};
use cef::*;
use gpu::{FrameParams, Gpu};
use std::{cell::RefCell, process::ExitCode, rc::Rc, sync::Arc, time::{Duration, Instant}};
use winit::{
    application::ApplicationHandler,
    dpi::LogicalSize,
    event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    keyboard::{Key, ModifiersState, NamedKey},
    platform::pump_events::{EventLoopExtPumpEvents, PumpStatus},
    window::{Window, WindowAttributes, WindowId},
};

struct Options {
    url: String,
    count: u32,
    auto: bool,
    frames: Option<u64>,
    shared_texture: bool,
    /// For tests: a click on one of the page's controls (by name) at a frame: --click more@60.
    clicks: Vec<(String, u64)>,
}

fn options() -> Options {
    let args: Vec<String> = std::env::args().collect();
    let value = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    Options {
        url: value("--url").unwrap_or_else(|| format!("file://{}/hud.html", env!("CARGO_MANIFEST_DIR"))),
        count: value("--count").and_then(|v| v.parse().ok()).unwrap_or(1 << 20),
        auto: args.iter().any(|a| a == "--auto"),
        frames: value("--frames").and_then(|v| v.parse().ok()),
        shared_texture: !args.iter().any(|a| a == "--no-shared-texture"),
        clicks: args.windows(2).filter(|w| w[0] == "--click").filter_map(|w| w[1].split_once('@').and_then(|(name, at)| Some((name.to_string(), at.parse().ok()?)))).collect(),
    }
}

struct Host {
    options: Options,
    window: Option<Arc<Window>>,
    shared: Option<Shared>,
    browser: Option<Browser>,
    // The pull: where (-1 to 1), which way, how hard; whether the page has the mouse.
    mouse: [f32; 2],
    cursor: (i32, i32),
    pull: f32,
    strength: f32,
    paused: bool,
    panels: Vec<[f32; 4]>,
    controls: serde_json::Map<String, serde_json::Value>,
    mouse_on_page: bool,
    modifiers: ModifiersState,
    buttons: u32,
    // How it's going.
    start: Instant,
    last: Instant,
    frames: u64,
    frame_times: Vec<f32>,
    counted_at: Instant,
    counted_frames: u64,
    closing: bool,
}

impl Host {
    fn new(options: Options) -> Host {
        let now = Instant::now();
        Host {
            options,
            window: None,
            shared: None,
            browser: None,
            mouse: [0.0, 0.0],
            cursor: (0, 0),
            pull: 0.0,
            strength: 1.0,
            paused: false,
            panels: vec![],
            controls: Default::default(),
            mouse_on_page: false,
            modifiers: ModifiersState::empty(),
            buttons: 0,
            start: now,
            last: now,
            frames: 0,
            frame_times: vec![],
            counted_at: now,
            counted_frames: 0,
            closing: false,
        }
    }

    fn host(&self) -> Option<BrowserHost> {
        self.browser.as_ref().and_then(|b| b.host())
    }

    fn close(&mut self) {
        if !self.closing {
            self.closing = true;
            match self.host() {
                Some(host) => host.close_browser(1),
                None => self.shared.as_ref().map_or((), |s| s.page.borrow_mut().closed = true),
            }
        }
    }

    // What the page asked (its console messages, "hud:" + JSON).
    fn read_page(&mut self) {
        let Some(shared) = self.shared.clone() else { return };
        let messages = std::mem::take(&mut shared.page.borrow_mut().messages);
        for text in messages {
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            if let Some(controls) = msg.get("controls").and_then(|c| c.as_object()) {
                self.controls = controls.clone();
            }
            if let Some(rects) = msg.get("rects").and_then(|r| r.as_array()) {
                self.panels = rects.iter().filter_map(|r| serde_json::from_value::<[f32; 4]>(r.clone()).ok()).collect();
            }
            if let Some(strength) = msg.get("strength").and_then(|s| s.as_f64()) {
                self.strength = strength as f32;
            }
            if msg.get("ready").is_some() {
                println!("page: ready (WebGPU {}, WebGL {})", msg["webgpu"], msg["webgl"]);
                if std::env::var("CEF_DEBUG").is_ok() {
                    if let Some(frame) = self.browser.as_ref().and_then(|b| b.main_frame()) {
                        let js = "for (const t of ['pointermove','mousedown','mouseup','click','keydown','keypress','input','focus']) addEventListener(t, (e) => t !== 'pointermove' || !window._pm ? (console.log('dbg ' + t + ' ' + (e.clientX ?? '') + ',' + (e.clientY ?? '') + ' ' + (e.key ?? '') + ' ' + (e.target?.id || e.target?.tagName || '')), t === 'pointermove' && (window._pm = 1)) : 0, true); console.log('dbg hasFocus ' + document.hasFocus());";
                        frame.execute_java_script(Some(&js.into()), None, 0);
                    }
                }
            }
            if let Some(said) = msg.get("said") {
                println!("page: typed {said}");
            }
            let mut gpu = shared.gpu.borrow_mut();
            let count = gpu.count;
            match msg.get("cmd").and_then(|c| c.as_str()) {
                Some("pause") => self.paused = !self.paused,
                Some("reset") => gpu.seed(count),
                Some("more") => gpu.seed((count * 2).min(1 << 23)),
                Some("fewer") => gpu.seed((count / 2).max(1024)),
                _ => {}
            }
        }
    }

    // The page told how it's going, every half second.
    fn tell_page(&mut self, now: Instant) {
        let secs = (now - self.counted_at).as_secs_f32();
        if secs < 0.5 {
            return;
        }
        let Some(shared) = self.shared.clone() else { return };
        let (shared_paints, memory_paints, error) = {
            let mut page = shared.page.borrow_mut();
            let counts = (page.shared_paints, page.memory_paints, page.import_error.take());
            page.shared_paints = 0;
            page.memory_paints = 0;
            counts
        };
        if let Some(e) = error {
            eprintln!("A frame of the page's couldn't be shared: {e}");
        }
        let path = if shared_paints > 0 { "GPU texture" } else if memory_paints > 0 { "memory (copied)" } else { "–" };
        let gpu = shared.gpu.borrow();
        let stats = serde_json::json!({
            "fps": (self.frames - self.counted_frames) as f32 / secs,
            "paints": (shared_paints + memory_paints) as f32 / secs,
            "path": path,
            "count": gpu.count,
            "gpu": gpu.adapter_name,
            "paused": self.paused,
        });
        if let Some(frame) = self.browser.as_ref().and_then(|b| b.main_frame()) {
            frame.execute_java_script(Some(&format!("window.hud && hud.stats({stats})").as_str().into()), None, 0);
        }
        self.counted_at = now;
        self.counted_frames = self.frames;
    }

    fn frame(&mut self) {
        let Some(shared) = self.shared.clone() else { return };
        self.read_page();
        if let Some(host) = self.host() {
            host.send_external_begin_frame(); // (the page drawn now, in step with us)
        }
        let now = Instant::now();
        let dt = (now - self.last).as_secs_f32();
        self.frame_times.push(dt * 1000.0);
        self.last = now;
        let time = (now - self.start).as_secs_f32();
        let (mouse, pull) = if self.options.auto {
            ([(time * 0.7).cos() * 0.6, (time * 0.9).sin() * 0.6], if (time * 0.5).sin() > -0.3 { 1.0 } else { -1.0 })
        } else {
            (self.mouse, self.pull)
        };
        shared.gpu.borrow_mut().frame(&FrameParams { mouse, pull: pull * self.strength, dt: dt.min(1.0 / 30.0), time, paused: self.paused });
        self.frames += 1;
        self.tell_page(now);
        let due: Vec<String> = self.options.clicks.iter().filter(|(_, at)| *at == self.frames).map(|(name, _)| name.clone()).collect();
        for name in due {
            match self.controls.get(&name).and_then(|c| serde_json::from_value::<[f64; 2]>(c.clone()).ok()) {
                Some([x, y]) => {
                    println!("test: click on {name} at ({x:.0}, {y:.0})");
                    self.cursor_moved(x, y);
                    self.button(MouseButton::Left, true);
                    self.button(MouseButton::Left, false);
                }
                None => println!("test: no {name} to click"),
            }
        }
        if self.options.frames.is_some_and(|n| self.frames >= n) {
            self.close();
        }
    }

    // The mouse moved to (x, y), in CSS pixels.
    fn cursor_moved(&mut self, x: f64, y: f64) {
        self.cursor = (x as i32, y as i32);
        if let Some(window) = &self.window {
            let size = window.inner_size().to_logical::<f64>(window.scale_factor());
            self.mouse = [((x / size.width) * 2.0 - 1.0) as f32, (1.0 - (y / size.height) * 2.0) as f32];
        }
        if let Some(host) = self.host() {
            host.send_mouse_move_event(Some(&self.mouse_event()), 0);
        }
    }

    fn button(&mut self, button: MouseButton, down: bool) {
        let (cef_button, flag, pull) = match button {
            MouseButton::Left => (MouseButtonType::LEFT, 16, 1.0),
            MouseButton::Right => (MouseButtonType::RIGHT, 64, -1.0),
            MouseButton::Middle => (MouseButtonType::MIDDLE, 32, 0.0),
            _ => return,
        };
        // Pressed over a panel: the page's till let go; elsewhere, the particles'.
        if down {
            self.mouse_on_page = self.over_panel(self.cursor.0, self.cursor.1);
        }
        if std::env::var("CEF_DEBUG").is_ok() {
            eprintln!("debug: button {button:?} down {down} at {:?}: on the page {} ({} panels)", self.cursor, self.mouse_on_page, self.panels.len());
        }
        if self.mouse_on_page {
            if down { self.buttons |= flag } else { self.buttons &= !flag }
            if let Some(host) = self.host() {
                host.send_mouse_click_event(Some(&self.mouse_event()), cef_button, (!down) as _, 1);
            }
        } else {
            self.pull = if down { pull } else { 0.0 };
        }
    }

    fn over_panel(&self, x: i32, y: i32) -> bool {
        let (x, y) = (x as f32, y as f32);
        self.panels.iter().any(|r| x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3])
    }

    fn mouse_event(&self) -> MouseEvent {
        MouseEvent { x: self.cursor.0, y: self.cursor.1, modifiers: self.flags() | self.buttons }
    }

    fn flags(&self) -> u32 {
        let mut f = 0;
        if self.modifiers.shift_key() { f |= 2 }
        if self.modifiers.control_key() { f |= 4 }
        if self.modifiers.alt_key() { f |= 8 }
        f
    }
}

impl ApplicationHandler for Host {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let window = Arc::new(event_loop.create_window(WindowAttributes::default().with_title("CEF over WebGPU").with_inner_size(LogicalSize::new(1280, 800))).unwrap());
        let mut gpu = Gpu::new(window.clone());
        gpu.seed(self.options.count);
        let scale = window.scale_factor() as f32;
        let size = window.inner_size().to_logical::<f64>(scale as f64);
        println!("window {}×{} px (×{scale}); {}", window.inner_size().width, window.inner_size().height, gpu.adapter_name);
        let shared = Shared {
            page: Rc::new(RefCell::new(Page { size: (size.width as i32, size.height as i32), scale, ..Default::default() })),
            gpu: Rc::new(RefCell::new(gpu)),
        };
        self.browser = browser::open(&shared, &self.options.url, self.options.shared_texture);
        if let Some(host) = self.host() {
            host.set_focus(1);
        }
        self.shared = Some(shared);
        self.window = Some(window);
    }

    fn window_event(&mut self, _event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let Some(window) = self.window.clone() else { return };
        let scale = window.scale_factor();
        match event {
            WindowEvent::CloseRequested => self.close(),
            WindowEvent::Resized(size) => {
                if let Some(shared) = &self.shared {
                    shared.gpu.borrow_mut().resize(size.width, size.height);
                    let logical = size.to_logical::<f64>(scale);
                    shared.page.borrow_mut().size = (logical.width as i32, logical.height as i32);
                    shared.resized();
                }
                if let Some(host) = self.host() {
                    host.was_resized();
                }
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                if let Some(shared) = &self.shared {
                    shared.page.borrow_mut().scale = scale_factor as f32;
                }
                if let Some(host) = self.host() {
                    host.notify_screen_info_changed();
                }
            }
            WindowEvent::ModifiersChanged(m) => self.modifiers = m.state(),
            WindowEvent::CursorMoved { position, .. } => {
                let logical = position.to_logical::<f64>(scale);
                self.cursor_moved(logical.x, logical.y);
            }
            WindowEvent::CursorLeft { .. } => {
                if let Some(host) = self.host() {
                    host.send_mouse_move_event(Some(&self.mouse_event()), 1);
                }
            }
            WindowEvent::MouseInput { state, button, .. } => self.button(button, state == ElementState::Pressed),
            WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y * 40.0,
                    MouseScrollDelta::PixelDelta(p) => p.y as f32,
                };
                if self.over_panel(self.cursor.0, self.cursor.1) {
                    if let Some(host) = self.host() {
                        host.send_mouse_wheel_event(Some(&self.mouse_event()), 0, dy as i32);
                    }
                } else {
                    self.strength = (self.strength * if dy > 0.0 { 1.25 } else { 0.8 }).clamp(0.125, 8.0);
                }
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if event.logical_key == Key::Named(NamedKey::Escape) && event.state == ElementState::Pressed {
                    return self.close();
                }
                if std::env::var("CEF_DEBUG").is_ok() {
                    eprintln!("debug: key {:?} {:?} text {:?}", event.physical_key, event.state, event.text);
                }
                let Some(host) = self.host() else { return };
                let mut key = KeyEvent {
                    size: std::mem::size_of::<KeyEvent>(),
                    modifiers: self.flags(),
                    windows_key_code: keys::windows_key_code(&event.logical_key, event.physical_key),
                    native_key_code: keys::native_key_code(event.physical_key),
                    ..Default::default()
                };
                if event.state == ElementState::Released {
                    key.type_ = KeyEventType::KEYUP;
                    return host.send_key_event(Some(&key));
                }
                key.type_ = KeyEventType::RAWKEYDOWN;
                host.send_key_event(Some(&key));
                // What it types, as text (CEF on Linux would make a key's character from its
                // Windows code, US style; this way any text comes through: é, þ, 字).
                if let Some(text) = event.text.filter(|t| !self.modifiers.control_key() && !self.modifiers.alt_key() && t.chars().all(|c| !c.is_control())) {
                    host.ime_commit_text(Some(&text.as_str().into()), Some(&Range { from: u32::MAX, to: u32::MAX }), 0);
                }
            }
            _ => {}
        }
    }
}

fn main() -> ExitCode {
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let args = args::Args::new();
    let Some(cmd) = args.as_cmd_line() else { return ExitCode::FAILURE };
    // This program is CEF's other processes too (the page's, the GPU's...): those end here.
    let is_browser = cmd.has_switch(Some(&"type".into())) != 1;
    let mut app = browser::app();
    let code = execute_process(Some(args.as_main_args()), Some(&mut app), std::ptr::null_mut());
    if !is_browser {
        return ExitCode::from(code.clamp(0, 255) as u8);
    }

    let cache = std::env::var("XDG_CACHE_HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cache")).join("phil-cef-host");
    let settings = Settings {
        windowless_rendering_enabled: 1,
        external_message_pump: 1,
        no_sandbox: 1,
        root_cache_path: cache.to_string_lossy().as_ref().into(),
        log_severity: LogSeverity::ERROR,
        ..Default::default()
    };
    if initialize(Some(args.as_main_args()), Some(&settings), Some(&mut app), std::ptr::null_mut()) != 1 {
        eprintln!("CEF didn't start");
        return ExitCode::FAILURE;
    }

    let mut event_loop = EventLoop::new().unwrap();
    event_loop.set_control_flow(ControlFlow::Poll);
    let options = options();
    let timed = options.frames.is_some();
    let mut host = Host::new(options);
    loop {
        do_message_loop_work();
        if let PumpStatus::Exit(_) = event_loop.pump_app_events(Some(Duration::ZERO), &mut host) {
            break;
        }
        if host.shared.as_ref().is_some_and(|s| s.page.borrow().closed) {
            break;
        }
        if host.closing {
            do_message_loop_work();
            std::thread::sleep(Duration::from_millis(5)); // (closing: no more frames, CEF let finish)
            continue;
        }
        host.frame(); // (waits for the screen: vsync)
    }

    if timed {
        let mut times = host.frame_times.split_off(10.min(host.frame_times.len()));
        times.sort_by(|a, b| a.total_cmp(b));
        let q = |f: f32| times.get(((times.len() as f32 * f) as usize).min(times.len().saturating_sub(1))).copied().unwrap_or(0.0);
        let secs = (Instant::now() - host.start).as_secs_f32();
        println!("{} frames in {secs:.2} s ({:.1} fps); frame time median {:.2} ms, 99th percentile {:.2} ms; {} particles", host.frames, host.frames as f32 / secs, q(0.5), q(0.99), host.shared.as_ref().map_or(0, |s| s.gpu.borrow().count));
    }
    if let Some(shared) = &host.shared {
        let (shared_paints, memory_paints, imported) = shared.page.borrow().totals;
        println!("page frames: {shared_paints} as GPU textures ({imported} imported), {memory_paints} through memory; {} particles, {}", shared.gpu.borrow().count, if host.paused { "paused" } else { "going" });
    }
    host.browser = None;
    host.shared = None;
    shutdown();
    ExitCode::SUCCESS
}
