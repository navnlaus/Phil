# Loaded by phil's terminal panel instead of ~/.bashrc (bash --rcfile).
# Runs the user's normal config, then tells phil the working directory after
# every command using OSC 7, the escape sequence terminals use for this.
[ -f ~/.bashrc ] && . ~/.bashrc

# phil types "cd" commands with a leading space; keep them out of history.
case ":$HISTCONTROL:" in
  *:ignorespace:* | *:ignoreboth:*) ;;
  *) HISTCONTROL="${HISTCONTROL:+$HISTCONTROL:}ignorespace" ;;
esac

__phil_report_cwd() {
  local status=$? LC_ALL=C path=$PWD url="" c i
  for ((i = 0; i < ${#path}; i++)); do
    c=${path:i:1}
    case $c in
      [a-zA-Z0-9/._~-]) url+=$c ;;
      *) printf -v c '%%%02X' "'$c"; url+=$c ;;
    esac
  done
  printf '\e]7;file://%s%s\e\\' "${HOSTNAME:-localhost}" "$url"
  return $status
}
PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND$'\n'}__phil_report_cwd"
