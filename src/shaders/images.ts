// Storage images of a translated shader, as the replayer needs them (src/glue/gfx_host.ts). Plain TypeScript, no Node or browser API.
// WGSL names a storage texture's texel format in its type, and WebGPU wants the bind group layout and the bound view to have exactly that format; the game's
// shader names none for an image it only stores to (src/shaders/spv.ts placeImage: `bound`), and a format it does name may differ from the bound texture's within
// its class. So the module's text is made over for the formats bound: only the format in the declaration changes, which is all a store, a load or a size
// query depends on as long as the component class (float, sint, uint) stays; across classes the stores and loads of that image hand the bits over.

// The component class of a WebGPU texel format, as a storage texture's texel value has it (vec4<f32>, vec4<i32>, vec4<u32>)
export function formatClass(format: string): "float" | "sint" | "uint" { return format.endsWith("sint") ? "sint" : format.endsWith("uint") ? "uint" : "float"; }

// `wgsl` with the storage texture at @group(group) @binding(binding) declared with `format`; undefined when the text has no such declaration (as naga writes it:
// `@group(1) @binding(273) var name: texture_storage_2d<rgba8unorm,write>;`, white space free)
// A format of another class than the declared one (a shader that names no format is declared float, src/shaders/spv.ts placeImage, and a game may bind an
// integer texture there): the register's bits are what the console's GPU stores, so every textureStore to that image hands over bitcast<vec4<class>>(value)
// and every textureLoad of it comes back as bitcast<vec4<declared class>>(texel); undefined when a call on the image cannot be read
const WORD = { float: "f32", sint: "i32", uint: "u32" };
export function imageVariant(wgsl: string, group: number, binding: number, format: string): string | undefined {
  const re = new RegExp(`(@group\\(\\s*${group}\\s*\\)\\s*@binding\\(\\s*${binding}\\s*\\)\\s*var\\s+(\\w+)\\s*:\\s*texture_storage_\\w+\\s*<\\s*)([a-z0-9]+)(\\s*,)`), m = re.exec(wgsl);
  if (!m) return undefined;
  const from = formatClass(m[3]), to = formatClass(format), out = wgsl.replace(re, `$1${format}$4`);
  return from === to ? out : castCalls(out, m[2], WORD[from], WORD[to]);
}
// The arguments of the call whose "(" is at `open`: [start, end) of each, and the index of its ")"; undefined when it does not close
function callArgs(text: string, open: number): { args: [number, number][]; close: number } | undefined {
  const args: [number, number][] = [];
  let depth = 0, from = open + 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") { if (--depth === 0) { args.push([from, i]); return { args, close: i }; } }
    else if (ch === "," && depth === 1) { args.push([from, i]); from = i + 1; }
  }
  return undefined;
}
function castCalls(text: string, name: string, from: string, to: string): string | undefined {
  for (let at = 0; ;) {
    const m = /\btexture(Store|Load)\s*\(/g; m.lastIndex = at;
    const hit = m.exec(text);
    if (!hit) return text;
    const open = hit.index + hit[0].length - 1, c = callArgs(text, open);
    if (!c) return undefined;
    at = open + 1;
    if (text.slice(c.args[0][0], c.args[0][1]).trim() !== name) continue;
    if (hit[1] === "Store") { const [a, b] = c.args[c.args.length - 1]; text = text.slice(0, a) + ` bitcast<vec4<${to}>>(vec4<${from}>(${text.slice(a, b).trim()}))` + text.slice(b); }
    else { const pre = `bitcast<vec4<${from}>>(`; text = text.slice(0, hit.index) + pre + text.slice(hit.index, c.close + 1) + ")" + text.slice(c.close + 1); at += pre.length; }
  }
}
