// Storage images of a translated shader, as the replayer needs them (src/glue/gfx_host.ts). Plain TypeScript, no Node or browser API.
// WGSL names a storage texture's texel format in its type, and WebGPU wants the bind group layout and the bound view to have exactly that format; the game's
// shader names none for an image it only stores to (src/shaders/spv.ts placeImage: `bound`), and a format it does name may differ from the bound texture's within
// its class. So the module's text is made over for the formats bound: only the format in the declaration changes, which is all a store, a load or a size
// query depends on as long as the component class (float, sint, uint) stays.

// The component class of a WebGPU texel format, as a storage texture's texel value has it (vec4<f32>, vec4<i32>, vec4<u32>)
export function formatClass(format: string): "float" | "sint" | "uint" { return format.endsWith("sint") ? "sint" : format.endsWith("uint") ? "uint" : "float"; }

// `wgsl` with the storage texture at @group(group) @binding(binding) declared with `format`; undefined when the text has no such declaration (as naga writes it:
// `@group(1) @binding(273) var name: texture_storage_2d<rgba8unorm,write>;`, white space free)
export function imageVariant(wgsl: string, group: number, binding: number, format: string): string | undefined {
  const re = new RegExp(`(@group\\(\\s*${group}\\s*\\)\\s*@binding\\(\\s*${binding}\\s*\\)\\s*var\\s+\\w+\\s*:\\s*texture_storage_\\w+\\s*<\\s*)[a-z0-9]+(\\s*,)`);
  return re.test(wgsl) ? wgsl.replace(re, `$1${format}$2`) : undefined;
}
