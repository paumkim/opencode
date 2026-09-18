export interface PlatformInfo {
  platform: string
  arch: string
  zigTarget: string
  libraryFilename: string
}

export function detectPlatform(): PlatformInfo {
  const platform = process.platform
  const arch = process.arch

  let zigTarget: string
  let libraryFilename: string

  if (platform === "darwin") {
    if (arch === "arm64") {
      zigTarget = "aarch64-macos"
    } else if (arch === "x64") {
      zigTarget = "x86_64-macos"
    } else {
      throw new Error(`Unsupported macOS architecture: ${arch}`)
    }
    libraryFilename = "libghostty-vt.dylib"
  } else if (platform === "linux") {
    if (arch === "x64") {
      zigTarget = "x86_64-linux-gnu"
    } else if (arch === "arm64") {
      zigTarget = "aarch64-linux-gnu"
    } else {
      throw new Error(`Unsupported Linux architecture: ${arch}`)
    }
    libraryFilename = "libghostty-vt.so"
  } else if (platform === "win32") {
    if (arch === "x64") {
      zigTarget = "x86_64-windows-gnu"
    } else if (arch === "arm64") {
      zigTarget = "aarch64-windows-gnu"
    } else {
      throw new Error(`Unsupported Windows architecture: ${arch}`)
    }
    libraryFilename = "ghostty-vt.dll"
  } else {
    throw new Error(`Unsupported platform: ${platform}`)
  }

  return {
    platform,
    arch,
    zigTarget,
    libraryFilename,
  }
}

export function getZigDownloadUrl(version: string): string {
  const platform = process.platform
  const arch = process.arch

  let os: string
  if (platform === "darwin") os = "macos"
  else if (platform === "linux") os = "linux"
  else if (platform === "win32") os = "windows"
  else throw new Error(`Unsupported platform: ${platform}`)

  let archName: string
  if (arch === "arm64") archName = "aarch64"
  else if (arch === "x64") archName = "x86_64"
  else throw new Error(`Unsupported architecture: ${arch}`)

  const ext = platform === "win32" ? "zip" : "tar.xz"
  return `https://ziglang.org/download/${version}/zig-${archName}-${os}-${version}.${ext}`
}
