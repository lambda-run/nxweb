// The stub runtime of a module built by tools/asc64 (it takes the place of std/assembly/rt/stub.ts, so its imports
// are relative to std/assembly/rt): AssemblyScript's bump allocator that never frees, without memory.size /
// memory.grow. The compiler types those
// two as i32, a 64-bit memory returns i64, so the stock stub does not validate on wasm64; and a module of the one
// shared linear memory must not grow it anyway: it lives in a fixed range and the glue owns the memory's size.
// The heap runs from __heap_base (the end of the static data) with no end checked, until the module calls
// __set_heap(start, end): then it is that range, anywhere in the 64-bit memory (start 0: stay where it is; end 0:
// no end checked), and an allocation beyond the end traps.
import { AL_MASK, OBJECT, OBJECT_OVERHEAD, BLOCK_MAXSIZE, BLOCK_OVERHEAD, BLOCK, OBJECT_MAXSIZE } from "./common";
import { E_ALLOCATION_TOO_LARGE } from "../util/error";

// @ts-ignore: decorator
@lazy let startOffset: usize = ((__heap_base + BLOCK_OVERHEAD + AL_MASK) & ~AL_MASK) - BLOCK_OVERHEAD;
// @ts-ignore: decorator
@lazy let offset: usize = startOffset;
// @ts-ignore: decorator
@lazy let limit: usize = 0;

// @ts-ignore: decorator
@unsafe @global
export function __set_heap(start: usize, end: usize): void {
  if (start != 0) offset = ((start + BLOCK_OVERHEAD + AL_MASK) & ~AL_MASK) - BLOCK_OVERHEAD;
  limit = end;
}
// @ts-ignore: decorator
@unsafe @global
export function __heap_offset(): usize { return offset; }

function bump(newOffset: usize): void {
  if (limit != 0 && newOffset > limit) unreachable();   // out of the module's range
  offset = newOffset;
}

// @ts-ignore: decorator
@inline function computeSize(size: usize): usize {
  return ((size + BLOCK_OVERHEAD + AL_MASK) & ~AL_MASK) - BLOCK_OVERHEAD;
}

// @ts-ignore: decorator
@unsafe @global
export function __alloc(size: usize): usize {
  if (size > BLOCK_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
  let block = changetype<BLOCK>(offset);
  let ptr = offset + BLOCK_OVERHEAD;
  let payloadSize = computeSize(size);
  bump(ptr + payloadSize);
  block.mmInfo = payloadSize;
  return ptr;
}

// @ts-ignore: decorator
@unsafe @global
export function __realloc(ptr: usize, size: usize): usize {
  assert(ptr != 0 && !(ptr & AL_MASK)); // must exist and be aligned
  let block = changetype<BLOCK>(ptr - BLOCK_OVERHEAD);
  let actualSize = block.mmInfo;
  let isLast = ptr + actualSize == offset;
  let payloadSize = computeSize(size);
  if (size > actualSize) {
    if (isLast) { // last block: grow
      if (size > BLOCK_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
      bump(ptr + payloadSize);
      block.mmInfo = payloadSize;
    } else { // copy to new block at least double the size
      let newPtr = __alloc(max<usize>(payloadSize, actualSize << 1));
      memory.copy(newPtr, ptr, actualSize);
      block = changetype<BLOCK>((ptr = newPtr) - BLOCK_OVERHEAD);
    }
  } else if (isLast) { // last block: shrink
    offset = ptr + payloadSize;
    block.mmInfo = payloadSize;
  }
  return ptr;
}

// @ts-ignore: decorator
@unsafe @global
export function __free(ptr: usize): void {
  assert(ptr != 0 && !(ptr & AL_MASK)); // must exist and be aligned
  let block = changetype<BLOCK>(ptr - BLOCK_OVERHEAD);
  if (ptr + block.mmInfo == offset) { // last block: discard
    offset = changetype<usize>(block);
  }
}

// @ts-ignore: decorator
@unsafe @global
export function __reset(): void { // special
  offset = startOffset;
}

// @ts-ignore: decorator
@unsafe @global
export function __new(size: usize, id: u32): usize {
  if (size > OBJECT_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
  let ptr = __alloc(OBJECT_OVERHEAD + size);
  let object = changetype<OBJECT>(ptr - BLOCK_OVERHEAD);
  object.gcInfo = 0;
  object.gcInfo2 = 0;
  object.rtId = id;
  object.rtSize = <u32>size;
  return ptr + OBJECT_OVERHEAD;
}

// @ts-ignore: decorator
@unsafe @global
export function __renew(oldPtr: usize, size: usize): usize {
  if (size > OBJECT_MAXSIZE) throw new Error(E_ALLOCATION_TOO_LARGE);
  let newPtr = __realloc(oldPtr - OBJECT_OVERHEAD, OBJECT_OVERHEAD + size);
  changetype<OBJECT>(newPtr - BLOCK_OVERHEAD).rtSize = <u32>size;
  return newPtr + OBJECT_OVERHEAD;
}

// @ts-ignore: decorator
@global @unsafe
export function __link(parentPtr: usize, childPtr: usize, expectMultiple: bool): void {
  // nop
}

// @ts-ignore: decorator
@global @unsafe
export function __pin(ptr: usize): usize {
  return ptr;
}

// @ts-ignore: decorator
@global @unsafe
export function __unpin(ptr: usize): void {
  // nop
}

// @ts-ignore: decorator
@global @unsafe
function __visit(ptr: usize, cookie: u32): void { // eslint-disable-line @typescript-eslint/no-unused-vars
  // nop
}

// @ts-ignore: decorator
@global @unsafe
export function __collect(): void {
  // nop
}
