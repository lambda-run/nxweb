// nxem shim for <TargetConditionals.h>: the platform is neither macOS nor iOS. Code that asks `#if TARGET_OS_IPHONE`
// takes its other (Mac) branch and code that asks `#if TARGET_OS_OSX` takes its non-Mac branch; whether that branch
// is right for the browser has to be decided per site when the file is ported (tools/hle_inventory.py lists them).
#pragma once
#define TARGET_OS_MAC 0
#define TARGET_OS_OSX 0
#define TARGET_OS_IPHONE 0
#define TARGET_OS_IOS 0
#define TARGET_OS_SIMULATOR 0
#define NXEM_TARGET_SHIM 1
