// nxem shim for <mach/mach.h>: hle_thread.c uses Mach for diagnostics only (CPU time, suspending a thread to read
// its registers, reading memory that may be unmapped). A wasm thread cannot be suspended or inspected from
// another one, so those calls fail and the diagnostics print less; reading memory cannot fault inside the
// linear memory, so vm_read_overwrite is a bounds-checked copy.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <pthread.h>
#include "nx_port.h"
typedef uint32_t mach_port_t;
typedef uintptr_t vm_address_t;
typedef size_t vm_size_t;
typedef unsigned mach_msg_type_number_t;
typedef int kern_return_t;
typedef mach_port_t *thread_act_array_t;
typedef void *thread_info_t;
typedef void *thread_state_t;
enum { KERN_SUCCESS = 0, KERN_FAILURE = 5 };
typedef struct { struct { int seconds, microseconds; } user_time, system_time; int run_state; } thread_basic_info_data_t;
typedef struct { uint64_t __x[29], __fp, __lr, __sp, __pc; uint32_t __cpsr; } arm_thread_state64_t;
#define THREAD_BASIC_INFO 3
#define THREAD_BASIC_INFO_COUNT 10
#define ARM_THREAD_STATE64 6
#define ARM_THREAD_STATE64_COUNT 68
#define __darwin_arm_thread_state64_get_pc(s) ((s).__pc)
#define __darwin_arm_thread_state64_get_fp(s) ((s).__fp)
#define __darwin_arm_thread_state64_get_lr(s) ((s).__lr)
#define __darwin_arm_thread_state64_get_sp(s) ((s).__sp)
#define vm_page_size ((vm_size_t)65536)
static inline mach_port_t mach_task_self(void) { return 1; }
static inline mach_port_t mach_thread_self(void) { return 0; }
static inline mach_port_t pthread_mach_thread_np(pthread_t t) { (void)t; return 0; }   // 0 = "no port": every mport path is skipped
static inline kern_return_t thread_info(mach_port_t t, int f, thread_info_t o, mach_msg_type_number_t *c) { (void)t; (void)f; (void)o; (void)c; return KERN_FAILURE; }
static inline kern_return_t thread_suspend(mach_port_t t) { (void)t; return KERN_FAILURE; }
static inline kern_return_t thread_resume(mach_port_t t) { (void)t; return KERN_FAILURE; }
static inline kern_return_t thread_get_state(mach_port_t t, int f, thread_state_t o, mach_msg_type_number_t *c) { (void)t; (void)f; (void)o; (void)c; return KERN_FAILURE; }
static inline kern_return_t task_threads(mach_port_t t, thread_act_array_t *a, mach_msg_type_number_t *n) { (void)t; (void)a; (void)n; return KERN_FAILURE; }
static inline kern_return_t mach_port_deallocate(mach_port_t t, mach_port_t p) { (void)t; (void)p; return 0; }
static inline kern_return_t vm_deallocate(mach_port_t t, vm_address_t a, vm_size_t n) { (void)t; (void)a; (void)n; return 0; }
kern_return_t nx_vm_read(uint64_t addr, size_t n, void *dst, vm_size_t *got);
#define vm_read_overwrite(task, addr, n, dst, got) nx_vm_read((uint64_t)(addr), (n), (void *)(dst), (got))
