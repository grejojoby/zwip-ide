// Read-only macOS process counters. This diagnostic executable is not shipped in the IDE.
#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\') printf("\\%c", *p);
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static uint64_t nanoseconds(uint64_t ticks, mach_timebase_info_data_t timebase) {
  __uint128_t value = (__uint128_t)ticks * timebase.numer / timebase.denom;
  return (uint64_t)(value > UINT64_MAX ? UINT64_MAX : value);
}
static uint64_t cpu_clock(void) {
  struct timespec value = {0};
  clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &value);
  return (uint64_t)value.tv_sec * 1000000000 + value.tv_nsec;
}
int main(int argc, char **argv) {
  mach_timebase_info_data_t timebase = {0};
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) return 1;
  if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
    struct rusage_info_v4 before = {0}, after = {0};
    if (proc_pid_rusage(getpid(), RUSAGE_INFO_V4, (rusage_info_t *)&before) != 0) return 1;
    uint64_t start = cpu_clock();
    while (cpu_clock() - start < 100000000) { }
    uint64_t expected = cpu_clock() - start;
    if (proc_pid_rusage(getpid(), RUSAGE_INFO_V4, (rusage_info_t *)&after) != 0) return 1;
    uint64_t measured = nanoseconds(after.ri_user_time - before.ri_user_time, timebase) + nanoseconds(after.ri_system_time - before.ri_system_time, timebase);
    double ratio = (double)measured / expected;
    printf("{\"timebaseNumer\":%u,\"timebaseDenom\":%u,\"cpuClockNs\":%" PRIu64 ",\"measuredCpuNs\":%" PRIu64 ",\"ratio\":%.6f}\n", timebase.numer, timebase.denom, expected, measured, ratio);
    return ratio > 0.95 && ratio < 1.05 ? 0 : 1;
  }
  typedef pid_t (*responsibility_fn)(pid_t);
  // Optional private diagnostic SPI, also used by Chromium. Missing/failed SPI
  // is reported; parent-PID ancestry remains available and ownership is never guessed.
  responsibility_fn responsible = (responsibility_fn)dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
  int size = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
  if (size <= 0) { fprintf(stderr, "Cannot enumerate processes: %s\n", strerror(errno)); return 1; }
  size += 4096 * (int)sizeof(pid_t);
  pid_t *pids = calloc(1, (size_t)size);
  if (!pids) return 1;
  int bytes = proc_listpids(PROC_UID_ONLY, getuid(), pids, size);
  if (bytes <= 0) { free(pids); fprintf(stderr, "Cannot enumerate processes: %s\n", strerror(errno)); return 1; }
  printf("{\"timebase\":{\"numer\":%u,\"denom\":%u},\"responsibilityApi\":%s,\"enumerationTruncated\":%s,\"processes\":[", timebase.numer, timebase.denom, responsible ? "true" : "false", bytes >= size ? "true" : "false");
  int first = 1, inaccessible = 0;
  for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) {
    if (pids[i] <= 0 || pids[i] == getpid()) continue;
    struct proc_bsdinfo info = {0};
    if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) { inaccessible++; continue; }
    if (info.pbi_uid != getuid()) continue;
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int path_ok = proc_pidpath(pids[i], path, sizeof(path));
    struct rusage_info_v4 usage = {0};
    int usage_error = proc_pid_rusage(pids[i], RUSAGE_INFO_V4, (rusage_info_t *)&usage) == 0 ? 0 : errno;
    pid_t owner = responsible ? responsible(pids[i]) : -1;
    if (!first) putchar(',');
    first = 0;
    printf("{\"pid\":%d,\"ppid\":%u,\"startTime\":\"%" PRIu64 ".%06" PRIu64 "\",\"name\":", pids[i], info.pbi_ppid, info.pbi_start_tvsec, info.pbi_start_tvusec);
    json_string(info.pbi_name[0] ? info.pbi_name : info.pbi_comm);
    printf(",\"executable\":"); json_string(path_ok > 0 ? path : "");
    printf(",\"responsiblePid\":%d,\"measurementError\":%d", owner, usage_error);
    if (!usage_error) {
      // rusage CPU counters use Mach absolute ticks, not nanoseconds (notably
      // 125/3 ns per tick on this Apple Silicon host). Use a wide intermediate.
      printf(",\"rssBytes\":%" PRIu64 ",\"physicalFootprintBytes\":%" PRIu64 ",\"cpuUserNs\":\"%" PRIu64 "\",\"cpuSystemNs\":\"%" PRIu64 "\"", usage.ri_resident_size, usage.ri_phys_footprint, nanoseconds(usage.ri_user_time, timebase), nanoseconds(usage.ri_system_time, timebase));
    }
    putchar('}');
  }
  printf("],\"inaccessibleOrExitedProcesses\":%d}\n", inaccessible);
  free(pids);
  return 0;
}
