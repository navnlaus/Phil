//! CEF's side: a browser drawing off screen (no window of its own), its frames
//! handed over as GPU textures (dmabufs here, D3D11 or IOSurfaces elsewhere)
//! and drawn into ours (gpu.rs); what its page says on the console; and when
//! it's gone.

use crate::gpu::Gpu;
use cef::{osr_texture_import::SharedTextureHandle, *};
use std::{cell::RefCell, collections::HashMap, rc::Rc};

/// What the browser and the window share (all on the one thread: CEF's work is
/// done in the window's loop, do_message_loop_work()).
#[derive(Default)]
pub struct Page {
    /// The page's size, in CSS pixels, and pixels to one of those.
    pub size: (i32, i32),
    pub scale: f32,
    /// What the page said for the host ("hud:" + JSON), not yet seen to.
    pub messages: Vec<String>,
    /// Frames handed over each way since last counted.
    pub shared_paints: u32,
    pub memory_paints: u32,
    /// And since it started: (shared, through memory, imported).
    pub totals: (u64, u64, u64),
    /// Why a texture couldn't be shared, once.
    pub import_error: Option<String>,
    pub closed: bool,
    /// The textures CEF draws into, as imported: by the dmabuf's inode (it draws into
    /// a few, in turn). Kept: importing one each frame leaks it (cef's importer
    /// never frees the Vulkan memory it makes for one).
    pub(crate) imported: HashMap<u64, wgpu::BindGroup>,
}

#[derive(Clone)]
pub struct Shared {
    pub page: Rc<RefCell<Page>>,
    pub gpu: Rc<RefCell<Gpu>>,
}

wrap_app! {
    pub struct HostApp;

    impl App {
        fn on_before_command_line_processing(&self, _process_type: Option<&CefStringUtf16>, command_line: Option<&mut CommandLine>) {
            let Some(command_line) = command_line else { return };
            command_line.append_switch(Some(&"no-startup-window".into()));
            command_line.append_switch(Some(&"noerrdialogs".into()));
            command_line.append_switch(Some(&"hide-crash-restore-bubble".into()));
            // CEF_SWITCHES="name=value name": Chromium's switches, for trying.
            for switch in std::env::var("CEF_SWITCHES").unwrap_or_default().split_whitespace() {
                match switch.split_once('=') {
                    Some((name, value)) => command_line.append_switch_with_value(Some(&name.into()), Some(&value.into())),
                    None => command_line.append_switch(Some(&switch.into())),
                }
            }
            if let Ok(ozone) = std::env::var("CEF_OZONE") {
                command_line.append_switch_with_value(Some(&"ozone-platform".into()), Some(&ozone.as_str().into()));
            }
        }
    }
}

pub fn app() -> cef::App {
    HostApp::new()
}

wrap_render_handler! {
    struct Renderer {
        shared: Shared,
    }

    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(rect) = rect {
                let (w, h) = self.shared.page.borrow().size;
                rect.width = w.max(1);
                rect.height = h.max(1);
            }
        }

        fn screen_info(&self, _browser: Option<&mut Browser>, screen_info: Option<&mut ScreenInfo>) -> ::std::os::raw::c_int {
            let Some(screen_info) = screen_info else { return 0 };
            screen_info.device_scale_factor = self.shared.page.borrow().scale;
            1
        }

        fn on_accelerated_paint(&self, _browser: Option<&mut Browser>, type_: PaintElementType, _dirty_rects: Option<&[Rect]>, info: Option<&AcceleratedPaintInfo>) {
            let Some(info) = info else { return };
            if type_ != PaintElementType::default() {
                return; // (a <select>'s list: not drawn here)
            }
            let (width, height) = (info.extra.coded_size.width as u32, info.extra.coded_size.height as u32);
            let mut page = self.shared.page.borrow_mut();
            let mut gpu = self.shared.gpu.borrow_mut();
            let key = texture_key(info);
            if !page.imported.contains_key(&key) {
                match SharedTextureHandle::new(info).import_texture(&gpu.device) {
                    Ok(texture) => {
                        let group = gpu.bind_page(&texture);
                        page.imported.insert(key, group);
                        page.totals.2 += 1;
                    }
                    Err(e) => {
                        page.import_error.get_or_insert_with(|| e.to_string());
                        return;
                    }
                }
            }
            gpu.take_page_from_gpu(&page.imported[&key], width, height);
            if std::env::var("CEF_DEBUG").is_ok() {
                let planes: Vec<_> = info.planes[..info.plane_count as usize].iter().map(|p| (p.stride, p.offset, p.size)).collect();
                // A linear one can be read as it is: what CEF drew, before we touch it.
                let in_buffer = if info.modifier == 0 {
                    let size = info.planes[0].size as usize;
                    let p = unsafe { libc::mmap(std::ptr::null_mut(), size, libc::PROT_READ, libc::MAP_SHARED, info.planes[0].fd, 0) };
                    if p == libc::MAP_FAILED { -1 } else {
                        let bytes = unsafe { std::slice::from_raw_parts(p as *const u8, size) };
                        let n = bytes.chunks_exact(4).filter(|px| px[3] > 0).count() as i64;
                        unsafe { libc::munmap(p, size) };
                        n
                    }
                } else { -1 };
                eprintln!("debug: shared {width}x{height} format {:?} modifier {:#x} planes {planes:?} key {key}: {in_buffer} pixels not see-through in CEF's buffer, {} in our copy", info.format, info.modifier, gpu.visible_pixels());
            }
            page.shared_paints += 1;
            page.totals.0 += 1;
        }

        fn on_paint(&self, _browser: Option<&mut Browser>, type_: PaintElementType, _dirty_rects: Option<&[Rect]>, buffer: *const u8, width: ::std::os::raw::c_int, height: ::std::os::raw::c_int) {
            if type_ != PaintElementType::default() || buffer.is_null() || width <= 0 || height <= 0 {
                return;
            }
            let bgra = unsafe { std::slice::from_raw_parts(buffer, (width * height * 4) as usize) };
            if std::env::var("CEF_DEBUG").is_ok() {
                let opaque = bgra.chunks_exact(4).filter(|p| p[3] > 0).count();
                eprintln!("debug: paint {width}x{height}, {opaque} pixels not see-through");
            }
            self.shared.gpu.borrow_mut().take_page_from_memory(bgra, width as u32, height as u32);
            let mut page = self.shared.page.borrow_mut();
            page.memory_paints += 1;
            page.totals.1 += 1;
        }
    }
}

// Which of CEF's textures this is: its dmabuf's inode (the file descriptor is new each time).
#[cfg(target_os = "linux")]
fn texture_key(info: &AcceleratedPaintInfo) -> u64 {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(info.planes[0].fd, &mut st) } == 0 { st.st_ino } else { u64::MAX }
}
#[cfg(not(target_os = "linux"))]
fn texture_key(info: &AcceleratedPaintInfo) -> u64 {
    info.shared_texture_handle as u64
}

impl Shared {
    /// The page's size changed (the window's did): what was imported is for the old one.
    pub fn resized(&self) {
        self.page.borrow_mut().imported.clear();
    }
}

wrap_display_handler! {
    struct Display {
        shared: Shared,
    }

    impl DisplayHandler {
        fn on_console_message(&self, _browser: Option<&mut Browser>, _level: LogSeverity, message: Option<&CefString>, _source: Option<&CefString>, _line: ::std::os::raw::c_int) -> ::std::os::raw::c_int {
            let text = message.map(|m| m.to_string()).unwrap_or_default();
            match text.strip_prefix("hud:") {
                Some(json) => self.shared.page.borrow_mut().messages.push(json.to_string()),
                None => println!("page: {text}"),
            }
            1 // (not CEF's own log too)
        }
    }
}

wrap_life_span_handler! {
    struct LifeSpan {
        shared: Shared,
    }

    impl LifeSpanHandler {
        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            self.shared.page.borrow_mut().closed = true;
        }
    }
}

wrap_client! {
    struct HostClient {
        renderer: RenderHandler,
        display: DisplayHandler,
        life_span: LifeSpanHandler,
    }

    impl Client {
        fn render_handler(&self) -> Option<RenderHandler> {
            Some(self.renderer.clone())
        }
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(self.display.clone())
        }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(self.life_span.clone())
        }
    }
}

/// A browser at `url`, drawn off screen, its frames shared on the GPU when it can
/// (`shared_texture`), each drawn when we ask (send_external_begin_frame).
pub fn open(shared: &Shared, url: &str, shared_texture: bool) -> Option<Browser> {
    let window_info = WindowInfo {
        windowless_rendering_enabled: 1,
        shared_texture_enabled: shared_texture as _,
        external_begin_frame_enabled: 1,
        ..Default::default()
    };
    let browser_settings = BrowserSettings {
        windowless_frame_rate: 60,
        background_color: 0, // (see-through where the page is)
        ..Default::default()
    };
    let mut client = HostClient::new(Renderer::new(shared.clone()), Display::new(shared.clone()), LifeSpan::new(shared.clone()));
    browser_host_create_browser_sync(Some(&window_info), Some(&mut client), Some(&url.into()), Some(&browser_settings), None, None)
}
