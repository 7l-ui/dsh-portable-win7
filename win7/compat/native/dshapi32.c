/* Application-local compatibility for the pinned Win7 Node 20.19.2 x64 build.
 * All other ADVAPI32 exports used by that binary are forwarded in dshapi32.def.
 * See README.zh-CN.md for the TraceLogging source evidence and scope.
 */
#ifndef WINVER
#define WINVER 0x0601
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* REGHANDLE is ULONGLONG; EVENT_INFO_CLASS is a 32-bit enum. Keeping the
 * implementation name distinct avoids the SDK's dllimport declaration.
 * The DEF file exports it as EventSetInformation using the x64 Windows ABI.
 */
ULONG WINAPI DshEventSetInformation(
    ULONGLONG registration_handle,
    ULONG information_class,
    void *event_information,
    ULONG information_length) {
  (void)registration_handle;
  (void)information_class;
  (void)event_information;
  (void)information_length;
  /* Match the SDK's supported no-EventSetInformation TraceLogging path.
   * Do not claim success for a request that has not been implemented.
   * No system API is called, and the caller's LastError is preserved.
   */
  return ERROR_NOT_SUPPORTED;
}
