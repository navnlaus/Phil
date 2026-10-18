// libcef.so is looked for beside the program (run.sh puts CEF's files there).
fn main() {
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN");
}
