// What of AssemblyScript's language and standard library holds on wasm64 (tools/asc64): each export exercises one
// area. test/a64/asc64/run.mts compiles this file for wasm32 (asc) and for wasm64 (asc64), runs both and the two
// must agree; the wasm64 one runs with its heap, and the raw pointers it is given, above 4 GB.
class Node { next: Node | null = null; constructor(public v: i64) {} }
class Pair<A, B> { constructor(public a: A, public b: B) {} }
function twice(x: i32): i32 { return x * 2; }
function thrice(x: i32): i32 { return x * 3; }
const fns: StaticArray<(x: i32) => i32> = [twice, thrice];
const names: string[] = ["zero", "one", "two"];
let head: Node | null = null;

export function ptrBits(): i32 { return sizeof<usize>() * 8; }
export function classesAndLists(n: i32): i64 {
  head = null;
  for (let i = 0; i < n; i++) { let x = new Node(i); x.next = head; head = x; }
  let s: i64 = 0;
  let p = head;
  while (p !== null) { s += p.v; p = p.next; }
  return s;
}
export function arrays(n: i32): i32 {
  let a = new Array<i32>();
  for (let i = 0; i < n; i++) a.push(n - i);
  a.sort((x, y) => x - y);
  let t = new Uint32Array(n);
  for (let i = 0; i < n; i++) t[i] = a[i] * 2;
  let s = 0;
  for (let i = 0; i < t.length; i++) s += t[i];
  return s + a.indexOf(3) + a.slice(1, 3).length;
}
export function strings(n: i32): i32 {
  let s = "";
  for (let i = 0; i < n; i++) s += names[i % 3] + i.toString() + ",";
  let parts = s.split(",");
  return s.length * 1000 + parts.length + (s.includes("two2") ? 100000 : 0) + <i32>parseInt("123") + <i32>s.charCodeAt(1);
}
export function maps(n: i32): i32 {
  let m = new Map<i32, string>(), set = new Set<u64>();
  for (let i = 0; i < n; i++) { m.set(i * 7, i.toString()); set.add(<u64>i << 33); }
  let s = 0;
  let keys = m.keys();
  for (let i = 0; i < keys.length; i++) s += m.get(keys[i]).length;
  return s + m.size + set.size + (m.has(14) ? 1000 : 0) + (set.has(<u64>3 << 33) ? 10000 : 0);
}
export function funcRefs(x: i32): i32 { let f = fns[x & 1]; return f(x) + fns[1 - (x & 1)](x); }
export function generics(x: i32): f64 { let p = new Pair<i32, f64>(x, 1.5); let q = new Pair<string, Node>("k", new Node(x)); return p.a * p.b + <f64>q.b.v + q.a.length; }
export function math(x: f64): f64 { return Math.sqrt(x) + Math.floor(Math.sin(x) * 1000) + Math.pow(x, 1.5) + <f64>(<i64>x).toString().length + parseFloat("2.5"); }
export function nullable(k: i32): i32 {
  let a: Node | null = k > 0 ? new Node(k) : null;
  let r = 0;
  if (a) r += 1;
  if (!a) r += 2;
  if (a !== null && a.v == 5) r += 4;
  let b = a ? a : new Node(9);
  r += <i32>b.v * 10;
  return r;
}
export function nonNull(k: i32): i64 { let a: Node | null = k > 0 ? new Node(k) : null; let b = a || new Node(40); return a!.v + assert(b).v; }
export function rawMemory(p: usize, n: usize): u64 {
  memory.fill(p, 0x11, n); memory.copy(p + n, p, n);
  store<u64>(p + 2 * n, 0x0123456789ABCDEF);
  return load<u64>(p + 2 * n) + load<u8>(p + 2 * n - 1) + <u64>(memory.compare(p, p + n, n) == 0 ? 1 : 0);
}
export function pointerRound(p: usize): usize { let x = changetype<Node>(p); x.v = 77; return changetype<usize>(x) - p + offsetof<Node>("v") + <usize>load<i64>(p + offsetof<Node>("v")); }
export function staticData(): usize { return memory.data(8) - memory.data(64) + <usize>load<u8>(memory.data<u8>([1, 2, 3]) + 2); }
export function growMemory(pages: i32): i32 { let before = memory.size(); let r = memory.grow(pages); return (r == before ? 1 : 0) + (memory.size() - before) * 10; }
// wasm64 only (tools/asc64/rt.ts): where the heap is; the wasm32 build keeps the stock stub runtime
export function setHeap(start: usize, end: usize): void { if (isDefined(__set_heap)) __set_heap(start, end); }
export function heapAt(): usize { return isDefined(__heap_offset) ? __heap_offset() : 0; }
export function addressOf(n: i32): usize { return changetype<usize>(new Node(n)); }
