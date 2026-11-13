// The status of the running game, once a second: the frame rate, where a frame's time goes, each thread's split, the
// owner's report. It runs where the runtime's main thread is: on the page (?owner=page) or in em_worker.js, which gives
// it stand-ins for the page's elements and sends what it wrote to the page. (Moved out of em.html as it was.)
function nxStartStatus($, say, rtLabel) {
  var last = 0, lastT = performance.now(), lastO = null;
  setInterval(function () {
    var o = globalThis.NXOWNER; if (!o) return;
    var now = performance.now(), n = o.presents, threads = 0;
    try { threads = window.Module.nxLiveThreads ? window.Module.nxLiveThreads() : 0; } catch (e) {}
    var last0 = last, dN = n - last, dT = now - lastT, fps = dN * 1000 / dT; last = n; lastT = now;
    // where a frame's time goes, per frame over the last second: the owner thread's part (nxweb's recorder answering NVN
    // calls, of it the replayer's WebGPU work; nn::fs) and the rest, which is guest code and waiting
    // the callers' side of the owner: every guest thread's time from wanting the request slot to having its answer
    // (waiting behind other threads for the slot + the hand-over and the owner's work), summed over threads
    var M0 = window.Module, slot = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    try { if (M0._nx_slot_stats) { if (!window.nxSlotBuf) window.nxSlotBuf = M0._malloc(96); M0._nx_slot_stats(window.nxSlotBuf); slot = Array.from(new Float64Array(M0.HEAPU8.buffer, window.nxSlotBuf, 11)); } } catch (e) {}
    // every 10 s: where the owner thread's time went (owner/owner.ts report), into the log and window.nxem.owner
    if (o.report && (!window.nxOwnerAt || now - window.nxOwnerAt >= 10000)) { window.nxOwnerAt = now; try { var rep = o.report(true); window.nxem.owner = rep; if (rep.wallMs > 5000) { var line = "[owner] time, last " + (rep.wallMs / 1000).toFixed(0) + " s: " + JSON.stringify(rep); say(line); console.log(line); } } catch (e) { say("[RED] owner report: " + e.message); console.log("[RED] owner report: " + (e && e.stack || e)); } }
    var tsplit = "", coresBusy = -1;
    try { if (M0._nx_thread_split) { if (!window.nxSplitBuf) window.nxSplitBuf = M0._malloc(2400); coresBusy = M0._nx_thread_split(window.nxSplitBuf, 2400, n - last0, 0);
        var u8s = M0.HEAPU8, e0 = window.nxSplitBuf, e1 = e0; while (u8s[e1] && e1 < e0 + 2399) e1++; tsplit = new TextDecoder().decode(u8s.slice(e0, e1)); } } catch (e) {}
    window.nxem.threadsRunning = +coresBusy.toFixed(2); window.nxem.threadSplit = tsplit;
    var gd = [0, 0, 0, 0, 0];
    try { if (M0._nx_gfx_stats) { if (!window.nxGfxBuf) window.nxGfxBuf = M0._malloc(40); M0._nx_gfx_stats(window.nxGfxBuf); gd = Array.from(new Float64Array(M0.HEAPU8.buffer, window.nxGfxBuf, 5)); } } catch (e) {}
    var g = o.gfx, cur = { gd: gd, gl: o.glStats ? [o.glStats.served, o.glStats.execMs, o.glStats.heldMs || 0] : [0, 0, 0], nvnNs: o.hostNs, gpuMs: g ? g.times.execMs : 0, fsNs: o.stats.fsNs, calls: o.hostCalls + o.stats.fsCalls, slot: slot }, split = "";
    if (lastO && dN > 0) { var f = dN, ms = dT / f, nvn = (cur.nvnNs - lastO.nvnNs) / 1e6 / f, gpu = (cur.gpuMs - lastO.gpuMs) / f, fs = (cur.fsNs - lastO.fsNs) / 1e6 / f;
      var sq = (cur.slot[1] - lastO.slot[1]) / 1e6 / f, ss = (cur.slot[2] - lastO.slot[2]) / 1e6 / f, depth = cur.slot.slice(3).map(function (v, i) { return v - lastO.slot[3 + i]; }), dn = depth.reduce(function (a, b) { return a + b; }, 0) || 1;
      window.nxem.frame = { ms: +ms.toFixed(1), ownerNvnMs: +nvn.toFixed(1), gpuReplayMs: +gpu.toFixed(1), ownerFsMs: +fs.toFixed(1), otherMs: +(ms - nvn - fs).toFixed(1), ownerCalls: Math.round((cur.calls - lastO.calls) / f),
        callersWaitForSlotMs: +sq.toFixed(1), callersRequestToAnswerMs: +ss.toFixed(1), callersOverOwnerMs: +(sq + ss - nvn - fs).toFixed(1), slotDepthPct: depth.map(function (v) { return Math.round(100 * v / dn); }) };
 var dcalls = (cur.gd[0] - lastO.gd[0]) / f, dms = (cur.gd[1] - lastO.gd[1]) / 1e6 / f, fl = (cur.gl[0] - lastO.gl[0]) / f, flms = (cur.gl[1] - lastO.gl[1]) / f;
      window.nxem.frame.directNvnCalls = Math.round(dcalls); window.nxem.frame.directNvnMs = +dms.toFixed(1); window.nxem.frame.directLockSleeps = cur.gd[2] - lastO.gd[2]; window.nxem.frame.lockFreeNvnCalls = Math.round((cur.gd[4] - lastO.gd[4]) / f); window.nxem.frame.directLockWaitMs = +((cur.gd[3] - lastO.gd[3]) / 1e6 / f).toFixed(1); window.nxem.frame.flushesToOwner = +fl.toFixed(1); window.nxem.frame.flushMs = +flms.toFixed(1); window.nxem.frame.ownerHeldRecorderLockMs = +((cur.gl[2] - lastO.gl[2]) / f).toFixed(1); window.nxem.ring = o.ringStats;
      window.nxem.frame.presentInterval = g ? g.stats.presentInterval || 0 : 0; window.nxem.frame.acquireParked = g ? g.stats.acquireParked : 0; window.nxem.frame.acquireLate = g ? g.stats.acquireLate : 0;
 var fsrc = window.NXFRAMESRC || { raf: 0, timer: 0 }; window.nxem.frame.frameWaitsEndedByRaf = fsrc.raf; window.nxem.frame.frameWaitsEndedBy50msTimer = fsrc.timer;
      split = " · present interval " + window.nxem.frame.presentInterval + " (display-frame waits ended by rAF " + fsrc.raf + ", by the 50 ms timer " + fsrc.timer + ")" + " · NVN on its thread " + Math.round(dcalls) + " calls under the lock + " + window.nxem.frame.lockFreeNvnCalls + " without, " + dms.toFixed(1) + " ms (lock wait " + window.nxem.frame.directLockWaitMs + "), " + fl.toFixed(1) + " flushes to the owner " + flms.toFixed(1) + " ms, the owner itself held the recorder's lock " + window.nxem.frame.ownerHeldRecorderLockMs + " ms · frame " + ms.toFixed(0) + " ms = owner NVN " + nvn.toFixed(0) + " (GPU replay " + gpu.toFixed(0) + ") + fs " + fs.toFixed(0) + " + guest/wait " + (ms - nvn - fs).toFixed(0) + " · " + window.nxem.frame.ownerCalls + " owner calls/frame · callers: slot wait " + sq.toFixed(0) + " + request→answer " + ss.toFixed(0) + " ms (thread-sum); depth 0/1/2/3/4+/8+/16+/32+ % " + window.nxem.frame.slotDepthPct.join("/"); }
    lastO = cur;
    window.nxem.presents = n; window.nxem.threads = threads; window.nxem.fps = fps; window.nxem.label = rtLabel(threads);
    if (n > 0 && !window.nxem.reason && window.nxem.state !== "aborted" && window.nxem.state !== "exited") { window.nxem.state = "running"; $("stage").textContent = "running"; }
    $("rt").textContent = rtLabel(threads);
    $("fps").textContent = fps.toFixed(1) + " fps · frame " + n + " · " + rtLabel(threads) + split + (o.frameWorkLine ? o.frameWorkLine() : "") + (o.flushCauseLine ? o.flushCauseLine() : "") + (o.shaderWait && o.shaderWait.waits ? " · shader waits " + o.shaderWait.waits + " (" + Math.round(o.shaderWait.ms) + " ms, longest " + Math.round(o.shaderWait.maxMs) + ", not waited for (at the translator) " + o.shaderWait.notWaited + ", ran out " + o.shaderWait.timeouts + ", waiting now " + o.shaderWait.waiting + ")" : "") + (coresBusy >= 0 ? " · guest threads running at once " + coresBusy.toFixed(2) + " · per frame ms: " + tsplit : "");
  }, 1000);
}
