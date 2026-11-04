#!/usr/bin/env bash
# Timestamped samples of memory, swap and load on a staging host, for an operator
# to run there during concurrent drives. Needs bash and awk, nothing of devpanel.
# docs/project-infrastructure.md "Measuring a host during concurrent drives".
#
#   staging-host-sampler.sh --label <name> --duration <n>[s|m|h] [--interval <seconds>] [--output <file>]
#   staging-host-sampler.sh --summary <file> [--busy] [--from <utc>] [--to <utc>]
#
# It only reads /proc, /sys/fs/cgroup and systemd's unit list, and appends to its
# own file, one tab-separated line per sample, so an interrupted run keeps its samples.
# A figure this host does not offer is NA, never 0: on a kernel without pressure
# data a *_pct pressure column reads NA, which says nothing about pressure.
set -u
export LC_ALL=C

usage () {
  sed -n '6,7p' "$0" | sed 's/^# *//' >&2
  exit 2
}
die () { echo "staging-host-sampler: $*" >&2; exit 2; }

summarize () {
  local file=$1 busy=$2 from=$3 to=$4
  [ -r "$file" ] || die "cannot read $file"
  awk -F'\t' -v busy="$busy" -v from="$from" -v to="$to" '
    /^#/ { next }
    !cols { cols = NF; for (i = 1; i <= NF; i++) name[i] = $i; for (i = 1; i <= NF; i++) if (name[i] == "drive_units") units = i; next }
    (from != "" && $1 < from) || (to != "" && $1 > to) { next }
    busy && !(units && $units != "NA" && $units > 0) { next }
    { n++; for (i = 3; i <= cols; i++) {
        if ($i == "NA") { absent[i]++; continue }
        count[i]++; sum[i] += $i; if ($i != 0) nonzero[i]++; if (!(i in max) || $i > max[i]) max[i] = $i
    } }
    END {
      print "column\tsamples\tabsent\tnonzero\tmean\tmax"
      for (i = 3; i <= cols; i++)
        if (count[i]) printf "%s\t%d\t%d\t%d\t%.1f\t%s\n", name[i], count[i], absent[i], nonzero[i], sum[i] / count[i], max[i]
        else printf "%s\t0\t%d\t0\tNA\tNA\n", name[i], absent[i]
      if (!n) print "no samples in the chosen period" > "/dev/stderr"
    }' "$file"
}

label='' duration='' interval=5 output='' summary='' busy=0 from='' to=''
while [ $# -gt 0 ]; do
  case $1 in
    --busy) busy=1; shift; continue ;;
    --label|--duration|--interval|--output|--summary|--from|--to) [ $# -ge 2 ] || usage ;;
    *) usage ;;
  esac
  case $1 in
    --label) label=$2 ;;
    --duration) duration=$2 ;;
    --interval) interval=$2 ;;
    --output) output=$2 ;;
    --summary) summary=$2 ;;
    --from) from=$2 ;;
    --to) to=$2 ;;
  esac
  shift 2
done

if [ -n "$summary" ]; then summarize "$summary" "$busy" "$from" "$to"; exit $?; fi

[ -n "$label" ] && [ -n "$duration" ] || usage
case $label in *[!A-Za-z0-9._-]*) die "--label takes letters, digits, dot, underscore and dash" ;; esac
case $interval in ''|*[!0-9]*|0) die "--interval takes whole seconds, at least 1" ;; esac
case $duration in
  *[!0-9smh]*|[smh]*) die "--duration takes <n>, <n>s, <n>m or <n>h" ;;
  *h) seconds=$(( ${duration%h} * 3600 )) ;;
  *m) seconds=$(( ${duration%m} * 60 )) ;;
  *s) seconds=${duration%s} ;;
  *) seconds=$duration ;;
esac
[ "$seconds" -gt 0 ] 2>/dev/null || die "--duration takes <n>, <n>s, <n>m or <n>h"
[ -r /proc/meminfo ] && [ -r /proc/vmstat ] && [ -r /proc/stat ] || die "this needs a Linux /proc"

[ -n "$output" ] || output="host-samples-$label-$(date -u +%Y%m%dT%H%M%SZ).tsv"
[ ! -e "$output" ] || die "$output exists; samples are never appended to an earlier run"

# "some" and "full" lifetime stall totals of a pressure file (microseconds).
psi () {
  local totals
  totals=$(awk '{ for (i = 2; i <= NF; i++) if ($i ~ /^total=/) t[$1] = substr($i, 7) }
    END { print (("some" in t) ? t["some"] : "NA"), (("full" in t) ? t["full"] : "NA") }' "$1" 2>/dev/null) || totals=''
  [ -n "$totals" ] && echo "$totals" || echo 'NA NA'
}
# A rate over this interval: (current - previous) * factor / elapsed ms. NA when
# either reading is absent, or the counter went backwards.
rate () {
  [ "$1" != NA ] && [ "$2" != NA ] && [ "$elapsed_ms" -gt 0 ] || { echo NA; return; }
  awk -v c="$1" -v p="$2" -v f="$3" -v e="$elapsed_ms" 'BEGIN { if (c < p) print "NA"; else printf "%.1f\n", (c - p) * f / e }'
}
# A cgroup file holding one number of bytes, in MiB.
cgroup_mib () {
  local bytes
  bytes=$(cat "$1" 2>/dev/null) || bytes=''
  case $bytes in ''|*[!0-9]*) echo NA ;; *) echo $(( bytes / 1048576 )) ;; esac
}
# Running transient units of test drives, as the account the drives log in as
# sees them: a root login's drives are system units, any other's are user units.
drive_units () {
  local scope=() listed
  [ "$(id -u)" = 0 ] || scope=(--user)
  listed=$(systemctl "${scope[@]}" list-units --plain --no-legend --state=running 'devpanel-check-*' 2>/dev/null) || { echo NA; return; }
  if [ -z "$listed" ]; then echo 0; else echo "$listed" | wc -l; fi
}

{
  echo "# label: $label"
  echo "# host: $(hostname 2>/dev/null || echo NA)"
  echo "# kernel: $(uname -r)"
  echo "# virtualization: $(systemd-detect-virt 2>/dev/null || echo NA)"
  echo "# account: $(id -un)"
  echo "# cpus: $(awk '/^processor[[:space:]]*:/ { n++ } END { print n + 0 }' /proc/cpuinfo 2>/dev/null || echo NA)"
  echo "# started: $(date -u +%Y-%m-%dT%H:%M:%SZ), for ${seconds}s, every ${interval}s"
  for f in memory cpu io; do
    read -r s _ < <(psi "/proc/pressure/$f")
    if [ "$s" = NA ]; then echo "# /proc/pressure/$f: absent, its columns read NA"; else echo "# /proc/pressure/$f: present"; fi
  done
  printf 'ts_utc\telapsed_s\tdrive_units\tload1\tload5\tload15\tprocs_running\tprocs_blocked\tmem_total_mib\tmem_available_mib\tswap_total_mib\tswap_used_mib\tswap_cached_mib\tswap_in_pages_s\tswap_out_pages_s\tmajor_faults_s\tcpu_busy_pct\tcpu_iowait_pct\tcpu_steal_pct\tmem_some_pct\tmem_full_pct\tcpu_some_pct\tio_some_pct\tio_full_pct\tcg_mem_mib\tcg_swap_mib\tcg_mem_some_pct\tcg_mem_full_pct\tcg_cpu_some_pct\n'
} > "$output" || die "cannot write $output"
sed -n '/absent/p' "$output" >&2
echo "staging-host-sampler: writing $output for ${seconds}s" >&2

stop=0
trap 'stop=1' INT TERM HUP
started_ms=$(( $(date +%s%N) / 1000000 ))
last_ms=$started_ms
p_in=NA p_out=NA p_maj=NA p_total=NA p_busy=NA p_wait=NA p_steal=NA
p_ms=NA p_mf=NA p_cs=NA p_is=NA p_if=NA p_cgs=NA p_cgf=NA p_cgc=NA
first=1

while :; do
  now_ms=$(( $(date +%s%N) / 1000000 ))
  elapsed_ms=$(( now_ms - last_ms ))
  last_ms=$now_ms
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  read -r load1 load5 load15 _ < /proc/loadavg
  read -r mem_total mem_avail swap_total swap_used swap_cached < <(awk '
    { v[$1] = $2 }
    function mib (k) { return (k in v) ? int(v[k] / 1024) : "NA" }
    END {
      used = ("SwapTotal:" in v && "SwapFree:" in v) ? int((v["SwapTotal:"] - v["SwapFree:"]) / 1024) : "NA"
      print mib("MemTotal:"), mib("MemAvailable:"), mib("SwapTotal:"), used, mib("SwapCached:")
    }' /proc/meminfo)
  read -r c_in c_out c_maj < <(awk '
    { v[$1] = $2 }
    function get (k) { return (k in v) ? v[k] : "NA" }
    END { print get("pswpin"), get("pswpout"), get("pgmajfault") }' /proc/vmstat)
  # Jiffies: user nice system idle iowait irq softirq steal, then the two gauges.
  read -r c_total c_busy c_wait c_steal running blocked < <(awk '
    $1 == "cpu" { total = $2 + $3 + $4 + $5 + $6 + $7 + $8 + $9; busy = $2 + $3 + $4 + $7 + $8; wait = $6; steal = $9 }
    $1 == "procs_running" { running = $2 }
    $1 == "procs_blocked" { blocked = $2 }
    END { print total, busy, wait, steal, running, blocked }' /proc/stat)
  read -r c_ms c_mf < <(psi /proc/pressure/memory)
  read -r c_cs _ < <(psi /proc/pressure/cpu)
  read -r c_is c_if < <(psi /proc/pressure/io)
  read -r c_cgs c_cgf < <(psi /sys/fs/cgroup/memory.pressure)
  read -r c_cgc _ < <(psi /sys/fs/cgroup/cpu.pressure)
  cg_mem=$(cgroup_mib /sys/fs/cgroup/memory.current)
  cg_swap=$(cgroup_mib /sys/fs/cgroup/memory.swap.current)

  # The first sample has no interval behind it: its rates are NA, not 0.
  if [ "$first" = 1 ]; then
    r_in=NA r_out=NA r_maj=NA cpu_busy=NA cpu_wait=NA cpu_steal=NA
    r_ms=NA r_mf=NA r_cs=NA r_is=NA r_if=NA r_cgs=NA r_cgf=NA r_cgc=NA
  else
    r_in=$(rate "$c_in" "$p_in" 1000) r_out=$(rate "$c_out" "$p_out" 1000) r_maj=$(rate "$c_maj" "$p_maj" 1000)
    # A stall total in microseconds over elapsed milliseconds, as a percentage of the interval.
    r_ms=$(rate "$c_ms" "$p_ms" 0.1) r_mf=$(rate "$c_mf" "$p_mf" 0.1) r_cs=$(rate "$c_cs" "$p_cs" 0.1)
    r_is=$(rate "$c_is" "$p_is" 0.1) r_if=$(rate "$c_if" "$p_if" 0.1)
    r_cgs=$(rate "$c_cgs" "$p_cgs" 0.1) r_cgf=$(rate "$c_cgf" "$p_cgf" 0.1) r_cgc=$(rate "$c_cgc" "$p_cgc" 0.1)
    read -r cpu_busy cpu_wait cpu_steal < <(awk -v t=$((c_total - p_total)) -v b=$((c_busy - p_busy)) -v w=$((c_wait - p_wait)) -v s=$((c_steal - p_steal)) \
      'BEGIN { if (t > 0) printf "%.1f %.1f %.1f\n", b * 100 / t, w * 100 / t, s * 100 / t; else print "NA NA NA" }')
  fi

  printf '%s\t%d\t%s' "$ts" $(( (now_ms - started_ms) / 1000 )) "$(drive_units)" >> "$output"
  printf '\t%s' "$load1" "$load5" "$load15" "$running" "$blocked" "$mem_total" "$mem_avail" "$swap_total" "$swap_used" "$swap_cached" \
    "$r_in" "$r_out" "$r_maj" "$cpu_busy" "$cpu_wait" "$cpu_steal" "$r_ms" "$r_mf" "$r_cs" "$r_is" "$r_if" \
    "$cg_mem" "$cg_swap" "$r_cgs" "$r_cgf" "$r_cgc" >> "$output"
  printf '\n' >> "$output"

  first=0
  p_in=$c_in p_out=$c_out p_maj=$c_maj p_total=$c_total p_busy=$c_busy p_wait=$c_wait p_steal=$c_steal
  p_ms=$c_ms p_mf=$c_mf p_cs=$c_cs p_is=$c_is p_if=$c_if p_cgs=$c_cgs p_cgf=$c_cgf p_cgc=$c_cgc

  [ "$stop" = 0 ] && [ $(( (now_ms - started_ms) / 1000 )) -lt "$seconds" ] || break
  sleep "$interval" & wait $! 2>/dev/null
  [ "$stop" = 0 ] || break
done
echo "# ended: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$output"
echo "staging-host-sampler: done, $output" >&2
