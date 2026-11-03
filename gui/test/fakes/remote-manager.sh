#!/bin/bash
# The fake service manager, installed as `systemd-run` and `systemctl`
# (remote-manager.mjs). In bash because a launcher and its stops call it dozens
# of times per drive and a node start costs about thirty times a bash start.
# Unit files stay JSON: the suites read and rewrite them.
dir=$DEVPANEL_TEST_UNITS
[[ -d $dir ]] || mkdir -p "$dir"
args=("$@")

# JSON text of $1, in REPLY: what the suites' JSON.parse needs of a command line.
quoted () {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\t'/\\t}; s=${s//$'\r'/\\r}
  REPLY="\"$s\""
}
record_invocation () {
  local line a sep=
  quoted "$unit"; line="{\"unit\":$REPLY,\"args\":["
  for a in "${args[@]}"; do quoted "$a"; line+="$sep$REPLY"; sep=,; done
  printf '%s]}\n' "$line" >> "$dir/invocations.jsonl"
}
alive () {
  local s
  { IFS= read -r s < "/proc/$1/stat"; } 2>/dev/null || return 1
  [[ ${s##*) } != Z* ]]
}

if [[ ${0##*/} == systemd-run ]]; then
  unit= cwd= wait= seconds= timer= index=-1 dollar='$'
  for ((i = 0; i < ${#args[@]}; i++)); do
    a=${args[i]}
    case $a in
      --unit=*) [[ -n $unit ]] || unit=${a#--unit=} ;;
      --on-active=*) timer=1 ;;
      --wait) wait=1 ;;
      --property=WorkingDirectory=*) [[ -n $cwd ]] || cwd=${a#--property=WorkingDirectory=} ;;
      --property=RuntimeMaxSec=*) [[ -n $seconds ]] || { seconds=${a#--property=RuntimeMaxSec=}; seconds=${seconds%s}; } ;;
    esac
    if ((index < 0)); then case $a in /usr/bin/bwrap | /usr/bin/unshare | /usr/bin/nsenter | /bin/sh) index=$i ;; esac; fi
  done
  file=$dir/$unit.json

  # A timer is recorded, not run: fireTimer plays its firing.
  if [[ -n $timer ]]; then
    record_invocation
    if [[ -e $dir/fail-arm ]]; then echo 'no manager' >&2; exit 1; fi
    for ((i = 0; i < ${#args[@]}; i++)); do [[ ${args[i]} == -c ]] && { script=${args[i + 1]}; break; }; done
    quoted "${script//"$dollar$dollar"/$dollar}"
    printf '{"timer":true,"script":%s}' "$REPLY" > "$dir/$unit.timer.json"
    exit 0
  fi

  # The confined kinds (0e) run for real where they can: bubblewrap with the
  # ambient capabilities dropped, and the privileged mask inside a user
  # namespace mapped to root (a real root is not available to the suite).
  command=${args[index]}
  rest=()
  environment=()
  for ((i = index + 1; i < ${#args[@]}; i++)); do
    a=${args[i]}
    # systemd's own command-line expansion: $$ is a literal dollar.
    a=${a//"$dollar$dollar"/$dollar}
    [[ $command == /usr/bin/bwrap && -z $wait && $a == --die-with-parent ]] && continue
    rest+=("$a")
  done
  if [[ -e $dir/no-fence && ($command == /usr/bin/bwrap || $command == /usr/bin/unshare) ]]; then
    # A suite about what the engine decides, not the fence, runs where bubblewrap cannot: the
    # run text in plain sh. A join's prelude finds no fence to enter, so it can only join what is down.
    rest=(-c "${rest[-1]}")
    command=/bin/sh
  elif [[ $command == /usr/bin/bwrap ]]; then
    rest=(--ambient-caps -all --inh-caps -all bwrap "${rest[@]}")
    command=setpriv
  elif [[ $command == /usr/bin/unshare ]]; then
    rest=(--user --map-root-user "${rest[@]}")
  fi
  for ((i = 0; i < index; i++)); do [[ ${args[i]} == --setenv=* ]] && environment+=("${args[i]#--setenv=}"); done
  record_invocation

  # setsid does not fork here, so the pid is the unit's and it leads its own group.
  launch () {
    cd "$cwd" || exit 1
    ((${#environment[@]})) && export "${environment[@]}"
    exec setsid "$command" "${rest[@]}"
  }
  # A stop signals the group: it must exist before the unit counts as registered.
  in_own_session () {
    local s n fields
    for ((n = 0; n < 5000; n++)); do
      { IFS= read -r s < "/proc/$1/stat"; } 2>/dev/null || return
      read -ra fields <<< "${s##*) }"
      [[ ${fields[3]} == "$1" ]] && return
    done
  }
  register () { printf '{"pid":%s,"invocationId":"%s-%s"}' "$1" "$1" "${EPOCHREALTIME/./}" > "$file"; }

  if [[ -z $wait ]]; then
    # A service's exit as an event: the unit inherits this lock and the kernel releases
    # it when the unit is down, so `flock <unit>.held` returns then, without polling. Not
    # handed to a unit inside a real fence, which should receive nothing extra.
    (
      if [[ -e $dir/no-fence ]]; then
        exec 8> "$dir/$unit.held"
        flock 8
      fi
      launch
    ) < /dev/null > /dev/null 2>&1 &
    child=$!
    in_own_session "$child"
    register "$child"
    exit 0
  fi

  # Each stream goes through its own reader, so the exit below can wait for the unit's
  # last output and still not wait for a descendant that keeps the stream open.
  exec 3> >(exec cat)
  out=$!
  exec 4> >(exec 3>&-; exec cat >&2)
  err=$!
  launch < /dev/null >&3 2>&4 3>&- 4>&- &
  child=$!
  in_own_session "$child"
  register "$child"
  (
    exec < /dev/null > /dev/null 2>&1 3>&- 4>&-
    trap 'kill "$timer_sleep" 2>/dev/null; exit 0' TERM
    sleep "$seconds" &
    timer_sleep=$!
    wait "$timer_sleep"
    kill -TERM -- "-$child" 2>/dev/null
  ) &
  limit=$!
  wait "$child"
  code=$?
  # Killed by a signal: no exit status of its own, which reads as a failure.
  ((code > 128)) && code=1
  kill "$limit" 2>/dev/null
  printf '{"pid":0}' > "$file"
  exec 3>&- 4>&-
  until=$((${EPOCHREALTIME/./} + 1000000))
  while ((${EPOCHREALTIME/./} < until)); do
    alive "$out" || alive "$err" || break
    sleep 0.002
  done
  kill "$out" "$err" 2>/dev/null
  exit "$code"
fi

unit= prop= stop=
for ((i = 0; i < ${#args[@]}; i++)); do
  a=${args[i]}
  [[ -z $unit && $a == devpanel-check-* ]] && unit=$a
  [[ $a == stop ]] && stop=1
  [[ $a == -p ]] && prop=${args[i + 1]}
done
file=$dir/$unit.json
read_entry () {
  entry= pid=0 invocation= timer=
  local text= shape='^\{"pid":([0-9]+)(,"invocationId":"([^"]*)")?\}$'
  { IFS= read -r text < "$file"; } 2>/dev/null
  [[ $text == '{'*'}' ]] || return 0
  entry=1
  if [[ $text =~ $shape ]]; then pid=${BASH_REMATCH[1]} invocation=${BASH_REMATCH[3]}; fi
  [[ $text == '{"timer":true,'* ]] && timer=1
  return 0
}
read_entry

if [[ -n $stop ]]; then
  [[ $unit == *.timer ]] && rm -f "$file"
  if ((pid)) && alive "$pid"; then
    kill -TERM -- "-$pid" 2>/dev/null
    for ((n = 0; n < 400; n++)); do
      alive "$pid" || break
      sleep 0.005
    done
    alive "$pid" && exit 1
  fi
  exit 0
fi

running=
((pid)) && alive "$pid" && running=1
case $prop in
  LoadState)
    # A manager answers after the request it is already handling: a unit being
    # submitted is not reported missing for the moment a process start takes.
    for ((n = 0; n < 5 && !entry; n++)); do
      sleep 0.005
      read_entry
    done
    [[ -n $entry ]] && echo loaded || echo not-found
    ;;
  ActiveState) [[ -n $running ]] && echo active || echo inactive ;;
  MainPID) [[ -n $running ]] && echo "$pid" || echo 0 ;;
  InvocationID) echo "$invocation" ;;
  SubState) [[ -n $timer ]] && echo waiting || echo ;;
  *) echo ;;
esac
exit 0
