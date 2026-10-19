# Loaded by phil's terminal panel instead of ~/.bashrc (bash --rcfile).
# Runs the user's normal config, then tells phil the working directory after
# every command using OSC 7, the escape sequence terminals use for this.
[ -f ~/.bashrc ] && . ~/.bashrc

# phil --incognito: keep your existing history available (up arrow, Ctrl+R),
# but write nothing from this session. /dev/null rather than unsetting
# HISTFILE also covers bashrc setups that run `history -a` at every prompt.
if [[ -n $PHIL_INCOGNITO ]]; then
  history -r
  HISTFILE=/dev/null
fi

__phil_report_cwd() {
  local LC_ALL=C path=$PWD url="" c i
  for ((i = 0; i < ${#path}; i++)); do
    c=${path:i:1}
    case $c in
      [a-zA-Z0-9/._~-]) url+=$c ;;
      *) printf -v c '%%%02X' "'$c"; url+=$c ;;
    esac
  done
  printf '\e]7;file://%s%s\e\\' "${HOSTNAME:-localhost}" "$url"
}

# Silent cd: when you change folder in the file view while this shell sits at
# an empty prompt, phil writes "<unix time>\0<path>\0" to $PHIL_CD_FILE and
# sends an empty Enter. The cd happens here, before the new prompt is drawn,
# so no command is typed or added to history. Stale requests are ignored.
__phil_follow() {
  local stamp dir
  { IFS= read -r -d '' stamp && IFS= read -r -d '' dir; } < "$PHIL_CD_FILE"
  command rm -f -- "$PHIL_CD_FILE"
  if [[ -n $dir ]] && (( ${EPOCHREALTIME%%[.,]*} - ${stamp:-0} <= 2 )); then
    builtin cd -- "$dir" 2>/dev/null
  fi
}

__phil_prompt() {
  local status=$?
  # A terminal phil put in the background to run something (phil --background, a
  # script marked so): that, once, before the first prompt: on the screen, only
  # its output. When it ends, so does the terminal (PHIL_RUN_THEN=exit; a script
  # that only goes somewhere: its prompt, there).
  if [[ -n ${PHIL_RUN-} ]]; then
    local run=$PHIL_RUN then=${PHIL_RUN_THEN-}
    unset PHIL_RUN PHIL_RUN_THEN
    eval "$run"
    status=$?
    [[ $then == exit ]] && exit "$status"
  fi
  [[ -n $PHIL_CD_FILE && -e $PHIL_CD_FILE ]] && __phil_follow
  __phil_report_cwd
  return $status
}
# First in line: prompt hooks like starship's render the prompt text right
# away, so the cd has to happen before them. $? is passed through for them.
PROMPT_COMMAND="__phil_prompt${PROMPT_COMMAND:+$'\n'$PROMPT_COMMAND}"

# ssh with nothing else, in a folder on a network mount (NFS, sshfs): to that
# machine, in the same folder there. The remote shell runs these prompt hooks
# too (sent along in the command, in a temporary rc file that removes
# itself), so it reports its folder to phil and takes phil's silent cds, which
# phil leaves over this session's own connection (the control socket). A
# network icon goes in front of its prompt. Anything else is plain ssh.
ssh() {
  (( $# )) && { command ssh "$@"; return; }
  local source type target
  # The innermost mount is the last line (an automount's autofs comes first).
  read -r source type target < <(findmnt -rn -o SOURCE,FSTYPE,TARGET -T "$PWD" 2>/dev/null | tail -n 1)
  if [[ -z $PHIL_TERMINAL || ! $type =~ ^(nfs4?|fuse\.sshfs|sshfs)$ || $source != [^/:]*:* ]]; then
    command ssh
    return
  fi
  printf -v target '%b' "$target" # findmnt -r writes spaces as \x20
  local host=${source%%:*} root=${source#*:}
  local rel=${PWD#"$target"} dir
  if [[ -n $root ]]; then dir=${root%/}$rel; else dir=${rel#/}; fi
  local rc
  rc=$(__phil_remote_rc | base64 -w0)
  local q=${dir//\'/\'\\\'\'}
  command ssh -t -o ControlMaster=yes -o ControlPersist=no \
    -o ControlPath="${XDG_RUNTIME_DIR:-/tmp}/phil-ssh-$PHIL_TERMINAL" "$host" \
    "f=\$(mktemp) && printf %s '$rc' | base64 -d > \"\$f\" && { cd -- '${q:-.}' 2>/dev/null; exec env __PHIL_RC=\"\$f\" bash --rcfile \"\$f\" -i; }"
}

# The rc file the remote shell starts with (see ssh above).
__phil_remote_rc() {
  declare -f __phil_report_cwd __phil_follow __phil_prompt
  printf 'PHIL_CD_FILE=%q\n' "/tmp/phil-cd-$PHIL_TERMINAL"
  cat <<'RC'
[ -f ~/.bashrc ] && . ~/.bashrc
rm -f -- "$__PHIL_RC"; unset __PHIL_RC
# Last, after prompt hooks that set PS1 themselves: the network icon.
__phil_icon() { local status=$?; [[ $PS1 == "󰈀 "* ]] || PS1="󰈀 $PS1"; return $status; }
PROMPT_COMMAND="__phil_prompt${PROMPT_COMMAND:+$'\n'$PROMPT_COMMAND}"$'\n'"__phil_icon"
RC
}
