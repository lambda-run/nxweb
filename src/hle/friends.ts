// nn::friends: port of nxnative dm/host/hle_friends.c. Everything that reaches the friends service is cut (bodies
// compiled from the C text); the two notification events are host-owned SystemEvents that never fire.
import { seBind } from "./sysevent";
const EV_NOTIFY: usize = memory.data(256, 16);
const EV_INVITE: usize = memory.data(256, 16);
export function h_fr_NqGetEv(a: usize): u64 { seBind(EV_NOTIFY, 0); return <u64>EV_NOTIFY; }
export function h_fr_InvEv(a: usize): u64 { seBind(EV_INVITE, 0); return <u64>EV_INVITE; }
