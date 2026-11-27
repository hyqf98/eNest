/* Fixed read-only sampler. No task ports, command lines, process names or user data leave it. */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_PID_COUNT 131072
#define MAX_JSON_BYTES (2 * 1024 * 1024)

static pid_t *list_pids(int *count) {
  int estimated = proc_listallpids(NULL, 0);
  if (estimated <= 0 || estimated > MAX_PID_COUNT - 128) return NULL;
  int capacity = estimated + 128;
  for (int attempt = 0; attempt < 4; attempt++) {
    pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
    if (!pids) return NULL;
    int used = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
    if (used <= 0) { free(pids); return NULL; }
    if (used < capacity) { *count = used; return pids; }
    free(pids);
    if (capacity > MAX_PID_COUNT / 2) return NULL;
    capacity *= 2;
  }
  return NULL;
}

static bool identity(pid_t pid, struct proc_bsdinfo *info) {
  memset(info, 0, sizeof(*info));
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, (int)sizeof(*info)) == (int)sizeof(*info)
    && info->pbi_pid == (uint32_t)pid;
}

static uint64_t started_at(const struct proc_bsdinfo *info) {
  return info->pbi_start_tvsec * UINT64_C(1000) + info->pbi_start_tvusec / UINT64_C(1000);
}

static bool same_process(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
  return a->pbi_start_tvsec == b->pbi_start_tvsec && a->pbi_start_tvusec == b->pbi_start_tvusec;
}

int main(void) {
  int count = 0;
  pid_t *pids = list_pids(&count);
  if (!pids) { fputs("Process enumeration unavailable\n", stderr); return 1; }
  char *json = malloc(MAX_JSON_BYTES);
  if (!json) { free(pids); return 1; }
  size_t length = 1;
  int written = 0;
  json[0] = '[';
  for (int index = 0; index < count; index++) {
    pid_t pid = pids[index];
    if (pid <= 0) continue;
    struct proc_bsdinfo before, after;
    bool have_identity = identity(pid, &before);
    struct rusage_info_v4 usage = {0};
    // phys_footprint includes compressed memory. RSS is supplemental, never labelled footprint.
    bool have_memory = have_identity
      && proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) == 0;
    if (have_memory) {
      if (!identity(pid, &after)) have_memory = false;
      else if (!same_process(&before, &after)) { before = after; have_memory = false; }
      else before = after; // Keep the current parent if it changed during collection.
    }
    uint32_t parent = have_identity ? before.pbi_ppid : 0;
    uint64_t start = have_identity ? started_at(&before) : 0;
    char row[256];
    int size;
    if (have_memory) {
      size = snprintf(row, sizeof(row), "%s[%d,%" PRIu32 ",%" PRIu64 ",%" PRIu64 ",%" PRIu64 "]",
        written ? "," : "", pid, parent, start, usage.ri_phys_footprint, usage.ri_resident_size);
    } else {
      size = snprintf(row, sizeof(row), "%s[%d,%" PRIu32 ",%" PRIu64 ",null,null]",
        written ? "," : "", pid, parent, start);
    }
    // Fail the complete snapshot rather than emitting truncated JSON or silently dropping PIDs.
    if (size < 0 || (size_t)size >= sizeof(row) || length + (size_t)size + 2 > MAX_JSON_BYTES) {
      free(json); free(pids); fputs("Process snapshot too large\n", stderr); return 1;
    }
    memcpy(json + length, row, (size_t)size);
    length += (size_t)size;
    written++;
  }
  free(pids);
  if (!written) { free(json); return 1; }
  json[length++] = ']';
  json[length++] = '\n';
  bool ok = fwrite(json, 1, length, stdout) == length;
  free(json);
  return ok ? 0 : 1;
}
