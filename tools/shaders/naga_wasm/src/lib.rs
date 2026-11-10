//! SPIR-V -> WGSL through naga, as a WebAssembly module with a C ABI.
//!   nx_alloc(len) -> ptr, nx_free(ptr, len)
//!   nx_spv_to_wgsl(ptr, len, flags) -> ptr of a result block { u32 status, u32 len, bytes[len] }, freed with nx_free(ptr, 8 + len)
//!     status 0: bytes = WGSL; 1: bytes = the parse error; 2: bytes = the validation error (naga's text)
//!     flags bit 0: adjust_coordinate_space (naga flips gl_Position.y and the y of gl_FragCoord-independent maths as for Vulkan -> WebGPU; off by default:
//!     the chain decides the origin itself, tools/shaders/README.md)
use std::alloc::{alloc, dealloc, Layout};

#[no_mangle]
pub extern "C" fn nx_alloc(len: usize) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align(len.max(1), 8).unwrap()) }
}

#[no_mangle]
pub unsafe extern "C" fn nx_free(ptr: *mut u8, len: usize) {
    dealloc(ptr, Layout::from_size_align(len.max(1), 8).unwrap())
}

fn result(status: u32, text: &str) -> *mut u8 {
    let p = nx_alloc(8 + text.len());
    unsafe {
        (p as *mut u32).write_unaligned(status);
        (p.add(4) as *mut u32).write_unaligned(text.len() as u32);
        std::ptr::copy_nonoverlapping(text.as_ptr(), p.add(8), text.len());
    }
    p
}

#[no_mangle]
pub unsafe extern "C" fn nx_spv_to_wgsl(ptr: *const u8, len: usize, flags: u32) -> *mut u8 {
    let bytes = std::slice::from_raw_parts(ptr, len);
    let options = naga::front::spv::Options {
        adjust_coordinate_space: flags & 1 != 0,
        strict_capabilities: false,
        block_ctx_dump_prefix: None,
    };
    let module = match naga::front::spv::parse_u8_slice(bytes, &options) {
        Ok(m) => m,
        Err(e) => return result(1, &format!("{e}")),
    };
    let info = match naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all()).validate(&module) {
        Ok(i) => i,
        Err(e) => return result(2, &format!("{:?}", e)),
    };
    match naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty()) {
        Ok(s) => result(0, &s),
        Err(e) => result(2, &format!("{e}")),
    }
}
