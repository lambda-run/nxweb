// nxweb a64 translator entry point (AssemblyScript). See README.md.
export { setOpt, setOptAddr, addRange, removeRange, rangeCount, setEntry, isEntry } from "./emit";
export { init, entryBuf, metaBuf, sideBuf, outPtr, translate, buildCore, probe, staticEnd, staticBase, addrBits } from "./unit";
