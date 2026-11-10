// What the page tells a person before the long stages run: will this game start, and if not, why, in one sentence.
// Pure functions of what Detect and Profile recorded (the profile's address-space verdict from the runtime's layout
// rule, what main imports to draw with, the profile's `needs`, the patch kinds that were not converted) and of a
// dropped file's name and first bytes. Nothing here has run a game: "should start" is a prediction from settings.
import type { DetectOut, ProfileOut } from "./prepare.ts";
import type { FailReason } from "./wasm.ts";

export type VerdictLevel = "ok" | "maybe" | "no";
export interface Verdict {
  level: VerdictLevel;
  headline: string;        // "Should start" / "Might start" / "Can't run in a browser yet"
  reason: string;          // one sentence
  gaps: string[];          // things that will be missing or wrong, in plain words
  details: string[];       // the technical lines behind it
}
export const TAB_GB = 4;   // what a browser tab's 32-bit WebAssembly memory can address
const gb = (n: number) => { const v = n / 2 ** 30; return v >= 10 ? v.toFixed(0) : (Math.round(v * 10) / 10).toString(); };

// A profile need in plain words (the keys of tools/prepare/convert_profiles.py's class c)
const GAP: Record<string, string> = {
  fps_target: "It may run at the wrong speed: its frame-rate setting is not built yet.",
  fps_max: "It will not reach its 120 frames per second mode.",
  fps_hold: "It may run at the wrong speed: frame holding is not built yet.",
  present_interval: "Its picture may stutter: frame pacing is not built yet.",
  tex_dyn_slots: "Some pictures may be missing or wrong: a kind of texture array is not built yet.",
  gpu_timestamps: "Its own performance scaling may misbehave: GPU timing reports are not built yet.",
  screen_aspect: "The picture's shape may be wrong: its screen-shape patch is not built yet.",
  render_base: "The picture may be drawn at the wrong size: its render-scale patch is not built yet.",
  shader_key_skip: "Some effects may be missing: a shader lookup this game needs is not built yet.",
  snowdrop_pools: "It may run out of memory: this engine's memory pools are not adjusted yet.",
  stdalloc_cap: "It may run out of memory: a memory cap this game needs is not built yet.",
  ue_fps_cvar: "It may run at the wrong speed: its engine's frame-rate setting is not applied yet.",
  ue_texture_pool: "Textures may look blurry: its engine's texture pool setting is not applied yet.",
};
const BLOCKING: Record<string, string> = {
  programs: "This game is several programs that start each other. nxweb runs one program at a time.",
  program_of: "This is one program of a game made of several. nxweb runs one program at a time.",
};

export function verdictFor(det: DetectOut, prof: ProfileOut): Verdict {
  const details: string[] = [], gaps: string[] = [], blockers: string[] = [];
  const g = prof.graphics ?? { api: "unknown", names: [] };
  if (g.api === "gl" || g.api === "vulkan") {
    const api = g.api === "gl" ? "OpenGL" : "Vulkan";
    blockers.push(`This game uses ${api}; nxweb only draws NVN, the graphics interface most games use.`);
    details.push(`main imports ${g.names.join(", ")} and not nvnBootstrapLoader`);
  } else if (g.api === "nvn") details.push("graphics: NVN (main imports nvnBootstrapLoader)");
  if (prof.layout?.fit === "short") {
    const pool = prof.pool ?? 0, regions = prof.space ? prof.space.heap_region + prof.space.alias_region + prof.space.stack_region : 0;
    blockers.push(pool > TAB_GB * 2 ** 30 ? `This game needs about ${gb(pool)} GB of memory. A browser tab can give it ${TAB_GB} GB.`
      : `This game sets aside about ${gb(regions)} GB of address space. A browser tab can give it ${TAB_GB} GB.`);
    details.push(`memory: ${prof.layout.note}`);
  } else if (prof.layout) details.push(`memory: ${prof.layout.fit === "profile" ? "fits as the profile reserves it" : "fits what the game can commit"}${prof.layout.note ? ` (${prof.layout.note})` : ""}`);
  for (const n of prof.needs) {
    if (n.key === "address_space") continue;
    if (BLOCKING[n.key]) blockers.push(BLOCKING[n.key]);
    else { const s = GAP[n.key] ?? `Something this game needs is not built yet (${n.key}).`; if (!gaps.includes(s)) gaps.push(s); }
    details.push(`${n.key} = ${n.value}: ${n.what}`);
  }
  const kinds = [...new Set(prof.unconverted.map(u => u.kind))];
  if (kinds.some(k => /FRAME_STEP/.test(k))) { const s = "It may run at the wrong speed or picture shape: its frame-step patch is not converted yet."; if (!gaps.includes(s)) gaps.push(s); }
  if (kinds.some(k => k === "PATCH_FILE")) gaps.push("Its fixes could not be converted: it runs without them.");
  if (kinds.length) details.push(`patches of nxnative not converted for this game: ${kinds.join(", ")}`);
  if (prof.found && !prof.registered) details.push("this build of the game is not one its settings were made on: the per-build fixes do not reach it");
  for (const w of prof.warnings) details.push(w);
  details.push(`title ID ${det.titleId}, version ${det.version}${prof.display ? ` (${prof.display})` : ""}; profile ${prof.id ?? "none"}${prof.by === "build" ? " (found by main's build ID)" : ""}`);
  if (blockers.length) return { level: "no", headline: "Can't run in a browser yet", reason: blockers[0], gaps: [...blockers.slice(1), ...gaps], details };
  if (!prof.found) return { level: "maybe", headline: "Might start", reason: "There is no profile for this game, so it runs with default settings.", gaps, details };
  return { level: "ok", headline: "Should start", reason: gaps.length ? "nxweb has settings for this game, but some things it uses are not built yet."
    : prof.registered ? "nxweb has settings for this game." : "nxweb has settings for this game, made on another version of it.", gaps, details };
}

// A failed prepare in one sentence (the machine's reason); the technical line is the error itself
export function failureSentence(reason: FailReason | "" | undefined, error = ""): string {
  switch (reason) {
    case "layout": return /NUP containers? \(/.test(error) ? "This folder holds .nup files. Choose one of them instead of the folder." : /packages/.test(error) ? "This folder holds game packages, not unpacked game files." : /not a NUP|NUP header|NUP format/.test(error) ? "This is not a .nup file nxweb can read." : "nxweb did not find a game in here.";
    case "npdm": return "The game's description file (main.npdm) can't be read, or it belongs to another game.";
    case "arch": return "This is a 32-bit game. nxweb only runs 64-bit games.";
    case "version": return "That version of the game is not complete in here.";
    case "dlc": return "An add-on (DLC) in here does not belong to this game.";
    case "module": return "One of the game's code files is damaged or still packed.";
    case "romfs": return "The game's data files can't be indexed.";
    case "profile": return "The settings nxweb has for this game don't fit these files.";
    case "cut": return "A fix nxweb has for this game doesn't match its code.";
    case "read": return /damaged file|SHA-256|header says/.test(error) ? "The file is damaged or incomplete. Copy or download it again." : "A file could not be read. It may have moved, or the browser lost access to it.";
    case "storage": return "The browser's storage for this site is full or blocked.";
    default: return "Something went wrong inside nxweb while preparing the game.";
  }
}

// ---- a file someone dropped or chose: what it is, and what to do with it ----
export type FileKind = "nup" | "package" | "nca" | "nso" | "nro" | "zip" | "archive" | "nxnative-romfs" | "romfs" | "shaderlib" | "empty" | "unknown";
export interface FileExplained { kind: FileKind; title: string; text: string; developer?: string }
const magic = (h: Uint8Array, at: number, s: string) => h.length >= at + s.length && [...s].every((c, i) => h[at + i] === c.charCodeAt(0));
const size = (n: number) => n >= 2 ** 30 ? (n / 2 ** 30).toFixed(1) + " GB" : n >= 2 ** 20 ? (n / 2 ** 20).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(0) + " KB" : n + " bytes";
// head: the file's first 0x200 bytes (or fewer)
export function explainFile(name: string, head: Uint8Array, bytes: number): FileExplained {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? "").toLowerCase(), base = name.replace(/^.*[\\/]/, "");
  const convert = "Convert it to a .nup or an extracted folder with the tool you dumped it with.";
  if (!bytes) return { kind: "empty", title: "This file is empty", text: `${base} has no content. If it was copied or downloaded, that did not finish.` };
  if (magic(head, 0, "NUP")) return { kind: "nup", title: "A NUP game container", text: "" };
  if (magic(head, 0, "PFS0") || magic(head, 0x100, "HEAD") || ["nsp", "xci", "nsz", "xcz"].includes(ext))
    return { kind: "package", title: "This is an encrypted game package", text: `nxweb can't open those yet. ${convert}` };
  if (ext === "nca" || magic(head, 0x200, "NCA3")) return { kind: "nca", title: "This is an encrypted piece of a game package", text: `nxweb has no keys and can't open it. ${convert}` };
  if (ext === "nup") return { kind: "unknown", title: "This is not a .nup file nxweb can read", text: `${base} is named like a NUP container but does not begin like one. It may be damaged, or only partly copied or downloaded.` };
  if (magic(head, 0, "NSO0")) return { kind: "nso", title: "This is one code file of a game, not the whole game", text: "A game is its code files and its data together. Choose the .nup file, or the folder that holds exefs/ and romfs/.",
    developer: "Developers: single NSO modules load under “Details for developers”." };
  if (magic(head, 0x10, "NRO0") || ext === "nro") return { kind: "nro", title: "This is a homebrew program (.nro)", text: "nxweb starts games from a .nup file or an extracted folder; it does not start .nro files on their own yet.",
    developer: "Developers: an NSO built from the same code loads under “Details for developers”." };
  if (magic(head, 0, "PK\u0003\u0004") || ext === "zip") return { kind: "zip", title: "This is a zip archive", text: "Unpack it first (double-click it, or right-click and choose Extract). Then choose the .nup file or the game folder that comes out." };
  if (magic(head, 0, "7z¼¯") || magic(head, 0, "Rar!") || ["7z", "rar", "gz", "tar", "xz", "zst"].includes(ext)) return { kind: "archive", title: "This is a compressed archive", text: "Unpack it first with the program that made it. Then choose the .nup file or the game folder that comes out." };
  if (magic(head, 0, "DMROMFS1")) return { kind: "nxnative-romfs", title: "This is a data image made by nxnative (RomFS.img)", text: "It holds a game's data but not its code, so it can't start on its own. Choose the .nup file it was made from, or a folder with exefs/ and romfs/." };
  if (["romfs", "istorage", "img"].includes(ext)) return { kind: "romfs", title: "This is a game's data image, without its code", text: "It can't start on its own. Choose the .nup file, or the folder that holds exefs/ and romfs/.",
    developer: "Developers: a RomFS image can be attached to NSO files under “Details for developers”." };
  if (ext === "nxsl") return { kind: "shaderlib", title: "This is a shader library", text: "It is not a game.", developer: "Developers: it loads under “Details for developers”." };
  if (base === "main" || base === "main.npdm" || base === "sdk" || /^subsdk\d+$/.test(base) || base === "rtld")
    return { kind: "nso", title: "This is one file from a game's exefs folder", text: "Choose the folder above it, the one that holds exefs/ and romfs/, not a file inside." };
  return { kind: "unknown", title: "nxweb doesn't know this kind of file", text: `${base} (${size(bytes)}) is not something nxweb can open. It opens .nup files and folders of extracted game files.` };
}
