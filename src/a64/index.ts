// nxweb a64 translator entry point (AssemblyScript). See README.md.
export { setOpt, setOptAddr, addRange, removeRange, rangeCount, setEntry, isEntry, setIntrinsic } from "./emit";
export { init, entryBuf, metaBuf, sideBuf, outPtr, translate, buildCore, probe, staticEnd, staticBase, addrBits, profAddr } from "./unit";
export { scanBuf, scanBufSize, scanReset, scanWords, scanKinds, scanKind, scanCount, scanFirstCount, scanFirst, scanTotal, scanImplemented, scanDropped, scanIsInstruction, scanName, scanNameLen, scanLiterals, scanLiteralWords } from "./scan";
