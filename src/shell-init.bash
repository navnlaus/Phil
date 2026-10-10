# Loaded by phil's terminal panel instead of ~/.bashrc (bash --rcfile).
# Runs the user's normal config, then tells phil the working directory after
# every command using OSC 7, the escape sequence terminals use for this.
[ -f ~/.bashrc ] && . ~/.bashrc

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
  [[ -n $PHIL_CD_FILE && -e $PHIL_CD_FILE ]] && __phil_follow
  __phil_report_cwd
  return $status
}
# First in line: prompt hooks like starship's render the prompt text right
# away, so the cd has to happen before them. $? is passed through for them.
PROMPT_COMMAND="__phil_prompt${PROMPT_COMMAND:+$'\n'$PROMPT_COMMAND}"
