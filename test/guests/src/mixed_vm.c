// A small register-based bytecode interpreter running several programs
// (primes, collatz, bubble sort, fibonacci mod m, a checksum). The dispatch
// loop is a dense switch; handlers mix arithmetic, memory and branches.
#include "rt.h"

#define NOINLINE __attribute__((noinline))

enum {
    OP_HALT, OP_LI, OP_MOV, OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MOD, OP_AND, OP_OR, OP_XOR, OP_SHL, OP_SHR,
    OP_ADDI, OP_LOAD, OP_STORE, OP_LOADB, OP_STOREB, OP_JMP, OP_JEQ, OP_JNE, OP_JLT, OP_JGE, OP_CALL, OP_RET,
    OP_PUSH, OP_POP, OP_OUT, OP_NOT, OP_NEG, OP_SAR, OP_JLTU,
};

struct insn { uint8_t op, a, b, c; int32_t imm; };

struct vm {
    int64_t reg[16];
    int64_t mem[2048];
    int64_t stack[256];
    int sp;
    uint64_t steps, out_hash;
    int outs;
};

#define I(op, a, b, c, imm) {op, a, b, c, imm}

static NOINLINE int run(struct vm *vm, const struct insn *code, int ncode, uint64_t max_steps)
{
    int pc = 0;
    int64_t *r = vm->reg;
    while (vm->steps < max_steps) {
        if (pc < 0 || pc >= ncode) return -2;
        const struct insn *i = &code[pc++];
        vm->steps++;
        switch (i->op) {
        case OP_HALT: return 0;
        case OP_LI: r[i->a] = i->imm; break;
        case OP_MOV: r[i->a] = r[i->b]; break;
        case OP_ADD: r[i->a] = (int64_t)((uint64_t)r[i->b] + (uint64_t)r[i->c]); break;
        case OP_SUB: r[i->a] = (int64_t)((uint64_t)r[i->b] - (uint64_t)r[i->c]); break;
        case OP_MUL: r[i->a] = (int64_t)((uint64_t)r[i->b] * (uint64_t)r[i->c]); break;
        case OP_DIV: r[i->a] = r[i->c] ? r[i->b] / r[i->c] : 0; break;
        case OP_MOD: r[i->a] = r[i->c] ? r[i->b] % r[i->c] : 0; break;
        case OP_AND: r[i->a] = r[i->b] & r[i->c]; break;
        case OP_OR: r[i->a] = r[i->b] | r[i->c]; break;
        case OP_XOR: r[i->a] = r[i->b] ^ r[i->c]; break;
        case OP_SHL: r[i->a] = (int64_t)((uint64_t)r[i->b] << (r[i->c] & 63)); break;
        case OP_SHR: r[i->a] = (int64_t)((uint64_t)r[i->b] >> (r[i->c] & 63)); break;
        case OP_SAR: r[i->a] = r[i->b] >> (r[i->c] & 63); break;
        case OP_ADDI: r[i->a] = (int64_t)((uint64_t)r[i->b] + (uint64_t)(int64_t)i->imm); break;
        case OP_NOT: r[i->a] = ~r[i->b]; break;
        case OP_NEG: r[i->a] = (int64_t)(0 - (uint64_t)r[i->b]); break;
        case OP_LOAD: r[i->a] = vm->mem[(uint64_t)(r[i->b] + i->imm) & 2047]; break;
        case OP_STORE: vm->mem[(uint64_t)(r[i->b] + i->imm) & 2047] = r[i->a]; break;
        case OP_LOADB: r[i->a] = ((uint8_t *)vm->mem)[(uint64_t)(r[i->b] + i->imm) & 16383]; break;
        case OP_STOREB: ((uint8_t *)vm->mem)[(uint64_t)(r[i->b] + i->imm) & 16383] = (uint8_t)r[i->a]; break;
        case OP_JMP: pc = i->imm; break;
        case OP_JEQ: if (r[i->a] == r[i->b]) pc = i->imm; break;
        case OP_JNE: if (r[i->a] != r[i->b]) pc = i->imm; break;
        case OP_JLT: if (r[i->a] < r[i->b]) pc = i->imm; break;
        case OP_JGE: if (r[i->a] >= r[i->b]) pc = i->imm; break;
        case OP_JLTU: if ((uint64_t)r[i->a] < (uint64_t)r[i->b]) pc = i->imm; break;
        case OP_CALL:
            if (vm->sp >= 255) return -3;
            vm->stack[vm->sp++] = pc;
            pc = i->imm;
            break;
        case OP_RET:
            if (vm->sp <= 0) return -4;
            pc = (int)vm->stack[--vm->sp];
            break;
        case OP_PUSH:
            if (vm->sp >= 255) return -3;
            vm->stack[vm->sp++] = r[i->a];
            break;
        case OP_POP:
            if (vm->sp <= 0) return -4;
            r[i->a] = vm->stack[--vm->sp];
            break;
        case OP_OUT:
            vm->out_hash = mix64(vm->out_hash, (uint64_t)r[i->a]);
            if (vm->outs < 6) printf("  out %ld\n", r[i->a]);
            vm->outs++;
            break;
        default: return -1;
        }
    }
    return 1;
}

// r1 = limit; outputs each prime below it (sieve in mem[]).
static const struct insn prog_sieve[] = {
    I(OP_LI, 1, 0, 0, 1500),        // 0
    I(OP_LI, 2, 0, 0, 2),           // 1  i = 2
    I(OP_JGE, 2, 1, 0, 15),         // 2  while i < limit
    I(OP_LOAD, 3, 2, 0, 0),         // 3
    I(OP_LI, 0, 0, 0, 0),           // 4
    I(OP_JNE, 3, 0, 0, 13),         // 5  composite -> next
    I(OP_OUT, 2, 0, 0, 0),          // 6
    I(OP_MUL, 4, 2, 2, 0),          // 7  j = i*i
    I(OP_LI, 5, 0, 0, 1),           // 8
    I(OP_JGE, 4, 1, 0, 13),         // 9  while j < limit
    I(OP_STORE, 5, 4, 0, 0),        // 10
    I(OP_ADD, 4, 4, 2, 0),          // 11
    I(OP_JMP, 0, 0, 0, 9),          // 12
    I(OP_ADDI, 2, 2, 0, 1),         // 13
    I(OP_JMP, 0, 0, 0, 2),          // 14
    I(OP_HALT, 0, 0, 0, 0),         // 15
};

// Collatz: longest chain for starts 1..r1; outputs (start, length) records.
static const struct insn prog_collatz[] = {
    I(OP_LI, 1, 0, 0, 200),         // 0  limit
    I(OP_LI, 2, 0, 0, 1),           // 1  n
    I(OP_LI, 8, 0, 0, 0),           // 2  best
    I(OP_LI, 10, 0, 0, 1),          // 3  const 1
    I(OP_LI, 11, 0, 0, 3),          // 4  const 3
    I(OP_JLT, 1, 2, 0, 22),         // 5  if limit < n: done
    I(OP_MOV, 3, 2, 0, 0),          // 6  x = n
    I(OP_LI, 4, 0, 0, 0),           // 7  len = 0
    I(OP_JEQ, 3, 10, 0, 17),        // 8  while x != 1
    I(OP_AND, 5, 3, 10, 0),         // 9
    I(OP_JEQ, 5, 10, 0, 13),        // 10 odd?
    I(OP_SHR, 3, 3, 10, 0),         // 11 x >>= 1
    I(OP_JMP, 0, 0, 0, 15),         // 12
    I(OP_MUL, 3, 3, 11, 0),         // 13 x = 3x + 1
    I(OP_ADDI, 3, 3, 0, 1),         // 14
    I(OP_ADDI, 4, 4, 0, 1),         // 15 len++
    I(OP_JMP, 0, 0, 0, 8),          // 16
    I(OP_JGE, 8, 4, 0, 20),         // 17 if best >= len skip
    I(OP_MOV, 8, 4, 0, 0),          // 18
    I(OP_OUT, 2, 0, 0, 0),          // 19 new record holder
    I(OP_ADDI, 2, 2, 0, 1),         // 20
    I(OP_JMP, 0, 0, 0, 5),          // 21
    I(OP_OUT, 8, 0, 0, 0),          // 22
    I(OP_HALT, 0, 0, 0, 0),         // 23
};

// Fill mem[0..n) with an LCG, bubble sort it, output a checksum; uses a subroutine.
static const struct insn prog_sort[] = {
    I(OP_LI, 1, 0, 0, 80),          // 0  n
    I(OP_LI, 2, 0, 0, 0),           // 1  i
    I(OP_LI, 3, 0, 0, 12345),       // 2  seed
    I(OP_LI, 12, 0, 0, 1103515245), // 3
    I(OP_LI, 13, 0, 0, 65535),      // 4
    I(OP_JGE, 2, 1, 0, 12),         // 5
    I(OP_MUL, 3, 3, 12, 0),         // 6
    I(OP_ADDI, 3, 3, 0, 12345),     // 7
    I(OP_AND, 4, 3, 13, 0),         // 8
    I(OP_STORE, 4, 2, 0, 0),        // 9
    I(OP_ADDI, 2, 2, 0, 1),         // 10
    I(OP_JMP, 0, 0, 0, 5),          // 11
    I(OP_CALL, 0, 0, 0, 24),        // 12 sort
    I(OP_LI, 2, 0, 0, 0),           // 13
    I(OP_LI, 6, 0, 0, 0),           // 14 checksum
    I(OP_LI, 14, 0, 0, 31),         // 15
    I(OP_JGE, 2, 1, 0, 22),         // 16
    I(OP_LOAD, 4, 2, 0, 0),         // 17
    I(OP_MUL, 6, 6, 14, 0),         // 18
    I(OP_ADD, 6, 6, 4, 0),          // 19
    I(OP_ADDI, 2, 2, 0, 1),         // 20
    I(OP_JMP, 0, 0, 0, 16),         // 21
    I(OP_OUT, 6, 0, 0, 0),          // 22
    I(OP_HALT, 0, 0, 0, 0),         // 23
    // sort: bubble sort mem[0..r1)
    I(OP_PUSH, 2, 0, 0, 0),         // 24
    I(OP_ADDI, 7, 1, 0, -1),        // 25 end = n-1
    I(OP_LI, 0, 0, 0, 0),           // 26
    I(OP_JGE, 0, 7, 0, 41),         // 27 while 0 < end
    I(OP_LI, 2, 0, 0, 0),           // 28 i = 0
    I(OP_JGE, 2, 7, 0, 39),         // 29
    I(OP_LOAD, 4, 2, 0, 0),         // 30
    I(OP_LOAD, 5, 2, 0, 1),         // 31
    I(OP_JGE, 5, 4, 0, 36),         // 32 in order
    I(OP_STORE, 5, 2, 0, 0),        // 33
    I(OP_STORE, 4, 2, 0, 1),        // 34
    I(OP_NOT, 9, 9, 0, 0),          // 35 (swap marker, unused)
    I(OP_ADDI, 2, 2, 0, 1),         // 36
    I(OP_JMP, 0, 0, 0, 29),         // 37
    I(OP_HALT, 0, 0, 0, 0),         // 38 (never reached)
    I(OP_ADDI, 7, 7, 0, -1),        // 39
    I(OP_JMP, 0, 0, 0, 27),         // 40
    I(OP_POP, 2, 0, 0, 0),          // 41
    I(OP_RET, 0, 0, 0, 0),          // 42
};

// Recursive fibonacci through the VM call stack.
static const struct insn prog_fib[] = {
    I(OP_LI, 1, 0, 0, 15),          // 0  n
    I(OP_LI, 10, 0, 0, 2),          // 1
    I(OP_CALL, 0, 0, 0, 5),         // 2
    I(OP_OUT, 2, 0, 0, 0),          // 3
    I(OP_HALT, 0, 0, 0, 0),         // 4
    // fib(r1) -> r2
    I(OP_JGE, 1, 10, 0, 8),         // 5
    I(OP_MOV, 2, 1, 0, 0),          // 6
    I(OP_RET, 0, 0, 0, 0),          // 7
    I(OP_PUSH, 1, 0, 0, 0),         // 8
    I(OP_ADDI, 1, 1, 0, -1),        // 9
    I(OP_CALL, 0, 0, 0, 5),         // 10
    I(OP_POP, 1, 0, 0, 0),          // 11
    I(OP_PUSH, 2, 0, 0, 0),         // 12
    I(OP_ADDI, 1, 1, 0, -2),        // 13
    I(OP_CALL, 0, 0, 0, 5),         // 14
    I(OP_POP, 3, 0, 0, 0),          // 15
    I(OP_ADD, 2, 2, 3, 0),          // 16
    I(OP_RET, 0, 0, 0, 0),          // 17
};

// Byte-wise mixing over memory with shifts, signed ops and unsigned compares.
static const struct insn prog_bytes[] = {
    I(OP_LI, 1, 0, 0, 2000),        // 0  n bytes
    I(OP_LI, 2, 0, 0, 0),           // 1  i
    I(OP_LI, 3, 0, 0, -77),         // 2  state
    I(OP_LI, 10, 0, 0, 5),          // 3
    I(OP_LI, 11, 0, 0, 59),         // 4
    I(OP_LI, 12, 0, 0, 251),        // 5
    I(OP_JLTU, 2, 1, 0, 8),         // 6
    I(OP_JMP, 0, 0, 0, 22),         // 7
    I(OP_SHL, 4, 3, 10, 0),         // 8
    I(OP_SAR, 5, 3, 11, 0),         // 9
    I(OP_XOR, 3, 4, 5, 0),          // 10
    I(OP_NEG, 6, 2, 0, 0),          // 11
    I(OP_ADD, 3, 3, 6, 0),          // 12
    I(OP_STOREB, 3, 2, 0, 0),       // 13
    I(OP_LOADB, 7, 2, 0, -1),       // 14 previous byte (wraps at i=0)
    I(OP_MOD, 8, 3, 12, 0),         // 15 signed modulo
    I(OP_ADD, 7, 7, 8, 0),          // 16
    I(OP_DIV, 8, 3, 12, 0),         // 17
    I(OP_OR, 3, 3, 7, 0),           // 18
    I(OP_SUB, 3, 3, 8, 0),          // 19
    I(OP_ADDI, 2, 2, 0, 1),         // 20
    I(OP_JMP, 0, 0, 0, 6),          // 21
    I(OP_OUT, 3, 0, 0, 0),          // 22
    I(OP_LOAD, 4, 0, 0, 100),       // 23 r0 is 0 here
    I(OP_OUT, 4, 0, 0, 0),          // 24
    I(OP_HALT, 0, 0, 0, 0),         // 25
};

static struct vm vm;
static void execute(const char *name, const struct insn *code, int n)
{
    memset(&vm, 0, sizeof vm);
    printf("%s:\n", name);
    int rc = run(&vm, code, n, 3000000);
    uint64_t mh = 0;
    for (int i = 0; i < 2048; i++) mh = mix64(mh, (uint64_t)vm.mem[i]);
    printf("  rc=%d steps=%lu outs=%d out_hash=%016lx mem_hash=%016lx r3=%ld\n", rc, vm.steps, vm.outs, vm.out_hash,
           mh, vm.reg[3]);
}

int main(void)
{
    execute("sieve", prog_sieve, (int)(sizeof prog_sieve / sizeof prog_sieve[0]));
    execute("collatz", prog_collatz, (int)(sizeof prog_collatz / sizeof prog_collatz[0]));
    execute("sort", prog_sort, (int)(sizeof prog_sort / sizeof prog_sort[0]));
    execute("fib", prog_fib, (int)(sizeof prog_fib / sizeof prog_fib[0]));
    execute("bytes", prog_bytes, (int)(sizeof prog_bytes / sizeof prog_bytes[0]));
    return 0;
}
