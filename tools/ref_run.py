#!/usr/bin/env python3
"""Reference runner for nxweb test guests (docs/CONTRACT.md, "Test guest ABI").

Runs a flat ARM64 image on Unicorn with the contract's initial state and the
three test SVCs, and prints the guest's stdout and exit code.

    tools/ref_run.py test/guests/out/hello.O2.json
    tools/ref_run.py image.bin --stack-top 0x8200000 --count --trace

Process exit status: 0 if the guest ended normally (whatever its exit code),
2 if it faulted (unmapped access, undefined instruction, timeout, ...).
"""
import argparse
import json
import os
import sys

import capstone
from unicorn import (UC_ARCH_ARM64, UC_HOOK_BLOCK, UC_HOOK_CODE, UC_HOOK_INTR,
                     UC_HOOK_MEM_FETCH_UNMAPPED, UC_HOOK_MEM_READ_UNMAPPED,
                     UC_HOOK_MEM_WRITE_UNMAPPED, UC_MODE_ARM, Uc, UcError)
from unicorn import arm64_const as A

BASE = 0x0800_0000
RETURN_TO_HOST = 0xFFFF_FFF0
DEFAULT_STACK = 0x10_0000
PAGE = 0x1000
EXCP_UDEF = 1   # QEMU exception numbers as passed to UC_HOOK_INTR
EXCP_SWI = 2
SVC_EXIT = 0x07
SVC_TICK = 0x1E
SVC_OUTPUT = 0x27
TICK_STEP = 1000
XREGS = [getattr(A, "UC_ARM64_REG_X%d" % i) for i in range(29)] + [
    A.UC_ARM64_REG_X29, A.UC_ARM64_REG_X30]

_md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_ARM)


class GuestFault(Exception):
    pass


class Result:
    def __init__(self):
        self.stdout = b""
        self.exit_code = None
        self.insn_count = None      # set when count=True
        self.blocks = None          # {(addr, size): executions} when count=True
        self.exited_by = None       # "svc" or "return"


def disasm_one(word_bytes, addr):
    for insn in _md.disasm(word_bytes, addr):
        return "%s %s" % (insn.mnemonic, insn.op_str)
    return ".word 0x%08x" % int.from_bytes(word_bytes, "little")


def _context(uc, pc, mem_lo, mem_hi):
    lines = []
    for a in range(pc - 16, pc + 12, 4):
        if mem_lo <= a < mem_hi - 3:
            w = bytes(uc.mem_read(a, 4))
            lines.append("%s %08x: %08x  %s" % ("=>" if a == pc else "  ", a,
                                               int.from_bytes(w, "little"), disasm_one(w, a)))
    regs = ["x%-2d=%016x" % (i, uc.reg_read(r)) for i, r in enumerate(XREGS)]
    regs.append("sp =%016x" % uc.reg_read(A.UC_ARM64_REG_SP))
    for i in range(0, len(regs), 4):
        lines.append("   " + " ".join(regs[i:i + 4]))
    return "\n".join(lines)


def run(image, stack_top=None, base=BASE, entry=None, count=False, trace=None,
        exact=False, timeout_s=300, cpu=None):
    """Run `image` (bytes). Returns Result; raises GuestFault on any fault.

    count:  count executed instructions and collect per-block execution counts
            (block hook; every translated block is straight-line code).
    exact:  count with a per-instruction code hook instead (slow; cross-check).
    trace:  file object; the pc of each executed block is written to it.
    cpu:    None = Cortex-A57 (the first Switch); "max" = Unicorn's model with every extension, for programs built
            for the Switch 2's core (LSE, RCPC, FP16, DotProd, RDM, pointer authentication with the keys disabled).
    """
    if entry is None:
        entry = base
    if stack_top is None:
        stack_top = ((base + len(image) + 15) & ~15) + DEFAULT_STACK
    map_end = (stack_top + PAGE - 1) & ~(PAGE - 1)
    res = Result()

    uc = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
    uc.ctl_set_cpu_model(A.UC_CPU_ARM64_MAX if cpu == "max" else A.UC_CPU_ARM64_A57)   # default: the Switch's core, no LSE, no SVE
    uc.mem_map(base, map_end - base)                  # zero filled, RWX
    uc.mem_write(base, bytes(image))
    # Contract: all registers 0, sp = stack_top, x30 = 0xFFFF_FFF0.
    uc.reg_write(A.UC_ARM64_REG_CPACR_EL1, 3 << 20)   # FPEN: no FP/SIMD traps
    # Unicorn always translates as EL1 (writing PSTATE.EL has no effect on the
    # translator), so the guest runs privileged here: instructions that would
    # trap at EL0 on a Switch are NOT rejected. Everything that is legal at EL0
    # (tpidr_el0, tpidrro_el0 read, nzcv, fpcr, fpsr) behaves the same.
    uc.reg_write(A.UC_ARM64_REG_NZCV, 0)              # Unicorn's reset value has Z set
    uc.reg_write(A.UC_ARM64_REG_FPCR, 0)
    uc.reg_write(A.UC_ARM64_REG_FPSR, 0)
    uc.reg_write(A.UC_ARM64_REG_TPIDR_EL0, 0)
    uc.reg_write(A.UC_ARM64_REG_TPIDRRO_EL0, 0)
    for r in XREGS:
        uc.reg_write(r, 0)
    uc.reg_write(A.UC_ARM64_REG_SP, stack_top)
    uc.reg_write(A.UC_ARM64_REG_X30, RETURN_TO_HOST)

    out = bytearray()
    state = {"tick": 0, "fault": None, "insns": 0}
    blocks = {}

    def fault(msg, pc):
        if state["fault"] is None:
            state["fault"] = (msg, pc)
        uc.emu_stop()

    def on_intr(uc, intno, _):
        pc = uc.reg_read(A.UC_ARM64_REG_PC)
        if intno != EXCP_SWI:
            what = "undefined instruction" if intno == EXCP_UDEF else "exception %d" % intno
            return fault(what, pc)
        insn = int.from_bytes(uc.mem_read(pc - 4, 4), "little")
        if insn & 0xFFE0001F != 0xD4000001:
            return fault("exception %d is not an SVC (insn %08x)" % (intno, insn), pc - 4)
        num = (insn >> 5) & 0xFFFF
        if num == SVC_OUTPUT:
            ptr = uc.reg_read(A.UC_ARM64_REG_X0)
            ln = uc.reg_read(A.UC_ARM64_REG_X1)
            if ptr < base or ptr + ln > map_end:
                return fault("svc 0x27 with unmapped buffer %#x+%#x" % (ptr, ln), pc - 4)
            out.extend(uc.mem_read(ptr, ln))
            uc.reg_write(A.UC_ARM64_REG_X0, 0)        # Horizon result code: success
        elif num == SVC_EXIT:
            res.exit_code = uc.reg_read(A.UC_ARM64_REG_X0) & 0xFFFFFFFF
            res.exited_by = "svc"
            uc.emu_stop()
        elif num == SVC_TICK:
            uc.reg_write(A.UC_ARM64_REG_X0, state["tick"])
            state["tick"] += TICK_STEP
        else:
            fault("unimplemented svc %#x" % num, pc - 4)

    def on_unmapped(uc, access, address, size, value, _):
        kind = {19: "read", 20: "write", 21: "fetch"}.get(access, "access(%d)" % access)
        if not (kind == "fetch" and address == RETURN_TO_HOST):
            fault("unmapped %s of %d bytes at %#x" % (kind, size, address),
                  uc.reg_read(A.UC_ARM64_REG_PC))
        return False

    def on_block(uc, address, size, _):
        if trace is not None:
            trace.write("%08x\n" % address)
        if count:
            key = (address, size)
            blocks[key] = blocks.get(key, 0) + 1

    def on_code(uc, address, size, _):
        state["insns"] += 1

    uc.hook_add(UC_HOOK_INTR, on_intr)
    uc.hook_add(UC_HOOK_MEM_READ_UNMAPPED | UC_HOOK_MEM_WRITE_UNMAPPED |
                UC_HOOK_MEM_FETCH_UNMAPPED, on_unmapped)
    if (count and not exact) or trace is not None:
        uc.hook_add(UC_HOOK_BLOCK, on_block)
    if exact:
        uc.hook_add(UC_HOOK_CODE, on_code)

    err = None
    try:
        uc.emu_start(entry, RETURN_TO_HOST, timeout=int(timeout_s * 1_000_000))
    except UcError as e:
        err = e
    pc = uc.reg_read(A.UC_ARM64_REG_PC)
    res.stdout = bytes(out)

    if state["fault"] is None and res.exit_code is None:
        if pc == RETURN_TO_HOST:
            res.exit_code = uc.reg_read(A.UC_ARM64_REG_X0) & 0xFFFFFFFF
            res.exited_by = "return"
        elif err is not None:
            state["fault"] = ("unicorn error: %s" % err, pc)
        else:
            state["fault"] = ("timeout after %ds" % timeout_s, pc)
    if state["fault"] is not None:
        msg, fpc = state["fault"]
        e = GuestFault("guest fault: %s at pc=%#x\n%s" % (msg, fpc, _context(uc, fpc, base, map_end)))
        e.result = res
        raise e

    if exact:
        res.insn_count = state["insns"]
    elif count:
        res.blocks = blocks
        res.insn_count = sum(size // 4 * n for (_, size), n in blocks.items())
    return res


def mnemonic_histogram(image, blocks, base=BASE):
    """{mnemonic: executed count} from Result.blocks."""
    hist = {}
    for (addr, size), n in blocks.items():
        for off in range(addr - base, addr - base + size, 4):
            word = image[off:off + 4]
            m = None
            for insn in _md.disasm(word, base + off):
                m = insn.mnemonic
            if m is None:
                m = ".word_%08x" % int.from_bytes(word, "little")
            hist[m] = hist.get(m, 0) + n
    return hist


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("guest", help="sidecar .json, or a flat .bin (a .json next to it is used if present)")
    ap.add_argument("--stack-top", type=lambda s: int(s, 0), help="override initial sp")
    ap.add_argument("--trace", action="store_true", help="print the pc of each executed block to stderr")
    ap.add_argument("--count", action="store_true", help="print the number of instructions executed")
    ap.add_argument("--exact", action="store_true", help="with --count: per-instruction hook (slow cross-check)")
    ap.add_argument("--timeout", type=float, default=300, help="seconds (default 300)")
    ap.add_argument("--check", action="store_true", help="compare stdout with the sidecar's expected_stdout")
    args = ap.parse_args()

    path = args.guest
    side = None
    if path.endswith(".json"):
        side = json.load(open(path))
        image_path = os.path.join(os.path.dirname(path), side["image"])
    else:
        image_path = path
        guess = os.path.splitext(path)[0] + ".json"
        if os.path.exists(guess):
            side = json.load(open(guess))
    image = open(image_path, "rb").read()
    base = side["base"] if side else BASE
    entry = side["entry"] if side else base
    stack_top = args.stack_top or (side["stack_top"] if side else None)

    status = 0
    try:
        res = run(image, stack_top=stack_top, base=base, entry=entry, count=args.count,
                  exact=args.exact, trace=sys.stderr if args.trace else None,
                  timeout_s=args.timeout)
    except GuestFault as e:
        res = e.result
        sys.stdout.buffer.write(res.stdout)
        sys.stdout.buffer.flush()
        print("[RED] " + str(e), file=sys.stderr)
        return 2
    sys.stdout.buffer.write(res.stdout)
    sys.stdout.buffer.flush()
    print("exit code: %d (%s)" % (res.exit_code, res.exited_by), file=sys.stderr)
    if args.count:
        print("instructions: %d" % res.insn_count, file=sys.stderr)
    if args.check and side:
        want = open(os.path.join(os.path.dirname(path), side["expected_stdout"]), "rb").read()
        ok = want == res.stdout and side.get("exit_code", res.exit_code) == res.exit_code
        print("check: %s" % ("ok" if ok else "[RED] MISMATCH"), file=sys.stderr)
        status = 0 if ok else 1
    return status


if __name__ == "__main__":
    sys.exit(main())
