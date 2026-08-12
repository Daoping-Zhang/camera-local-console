# Hikvision SDK Layout

Put HCNetSDK runtime files in the platform directory that matches the host.

```text
vendor/hikvision/
  win-x64/
    HCNetSDK.dll
    HCCore.dll
    libssl-3-x64.dll
    libcrypto-3-x64.dll
    HCNetSDKCom/
  linux-x64/
    libhcnetsdk.so
    libHCCore.so
    libssl.so.3
    libcrypto.so.3
    HCNetSDKCom/
  linux-arm64/
    libhcnetsdk.so
    libHCCore.so
    libssl.so.3
    libcrypto.so.3
    HCNetSDKCom/
```

The collector resolves SDK files in this order:

- `HIK_SDK_DIR`, when explicitly set.
- `vendor/hikvision/win-x64` on Windows.
- `vendor/hikvision/linux-arm64` on ARM64 Linux.
- `vendor/hikvision/linux-x64` on x64 Linux.
- Legacy unpacked SDK folders in the workspace.
- `/opt/hikvision-sdk` on Linux.

Do not commit SDK binaries unless the project license explicitly allows it. Packaging scripts should copy SDK files from these directories into release artifacts or mount them into Docker containers.
