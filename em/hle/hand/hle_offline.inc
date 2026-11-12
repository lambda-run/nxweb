// Hand-written thunks of nxnative's hle_offline.c: what tools/gen_hle.py does not generate.
//   nn::prepo::PlayReport::Send (SDK 22) returns an AsyncContext through the pointer in x8: null, the SDK's default
//   context (its completion event is signalled, GetResult answers 0). x0 stays. Left unanswered (0, x8 not written) the
//   game used whatever was in that stack slot as a context and aborted (2026-11-12, thread PlayReporter).
#define NXT_HAVE_h_prepo_Send 1
void nxt_hle_offline_h_prepo_Send(uint64_t *ctx) { if (ctx[8]) *(uint64_t *)(uintptr_t)ctx[8] = 0; }
