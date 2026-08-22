# shellcheck shell=bash

workspace="$HOME/Workspace"
cwd=$(realpath -e -- "$PWD")
case "$cwd/" in
"$workspace/"*) ;;
*)
  printf 'pi sandbox only starts inside %s\n' "$workspace" >&2
  exit 1
  ;;
esac

agent_dir="$HOME/.pi/agent"
lens_dir="$HOME/.pi-lens"
install -d -m 700 "$agent_dir" "$lens_dir"

telegram_config="$agent_dir/telegram.json"
if [ -e "$telegram_config" ]; then
  if [ ! -f "$telegram_config" ] || [ -L "$telegram_config" ] ||
    [ "$(stat -c %u "$telegram_config")" != "$(id -u)" ] ||
    [ "$(stat -c %a "$telegram_config")" != "600" ]; then
    printf 'Telegram config must be a current-user-owned 0600 regular file.\n' >&2
    exit 1
  fi
  if ! jq -e '
    def has_token: ((.botToken? // "") | type == "string" and length > 0);
    def has_owner: ((.allowedUserId? | type) == "number");
    ((has_token | not) or has_owner)
    and ([.profiles? // {} | .[]] | all(.[]; ((has_token | not) or has_owner)))
  ' "$telegram_config" >/dev/null; then
    printf 'Telegram profiles with a bot token require a numeric allowedUserId.\n' >&2
    exit 1
  fi
fi

program=@pi@
if [ "${1:-}" = "--sandbox-check" ]; then
  program=@check@
  shift
fi

properties=(
  --property=AmbientCapabilities=
  --property=CapabilityBoundingSet=
  --property="BindPaths=$workspace"
  --property="BindPaths=$agent_dir"
  --property="BindPaths=$lens_dir"
  --property="BindReadOnlyPaths=-$HOME/.agents"
  --property="BindReadOnlyPaths=-$HOME/.gitconfig"
  --property="BindReadOnlyPaths=-$HOME/.tmux.conf"
  --property="BindReadOnlyPaths=-$HOME/.config/fuzzel"
  --property="BindReadOnlyPaths=-$HOME/.config/hypr"
  --property="BindReadOnlyPaths=-$HOME/.config/kitty"
  --property="BindReadOnlyPaths=-$HOME/.config/mpv"
  --property="BindReadOnlyPaths=-$HOME/.config/niri"
  --property="BindReadOnlyPaths=-$HOME/.config/pi/web-search.json"
  --property="BindReadOnlyPaths=-$HOME/.config/rmpc"
  --property="BindReadOnlyPaths=-$HOME/.config/topbar"
  --property="BindReadOnlyPaths=-$HOME/.config/yt-dlp"
  --property=BindReadOnlyPaths=/run/current-system
  --property="BindReadOnlyPaths=-/run/opengl-driver"
  --property="BindReadOnlyPaths=-/run/opengl-driver-32"
  --property=BindReadOnlyPaths=/run/systemd/resolve
  --property=KeyringMode=private
  --property=LockPersonality=yes
  --property=NoNewPrivileges=yes
  --property=PrivateDevices=yes
  --property=PrivateIPC=yes
  --property=PrivatePIDs=yes
  --property=PrivateTmp=yes
  --property=ProtectClock=yes
  --property=ProtectControlGroups=yes
  --property=ProtectHome=tmpfs
  --property=ProtectHostname=yes
  --property=ProtectKernelLogs=yes
  --property=ProtectKernelModules=yes
  --property=ProtectKernelTunables=yes
  --property=ProtectProc=ptraceable
  --property=ProtectSystem=strict
  --property=RemoveIPC=yes
  --property="RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK"
  --property=RestrictNamespaces=yes
  --property=RestrictRealtime=yes
  --property=RestrictSUIDSGID=yes
  --property=SystemCallArchitectures=native
  --property=TemporaryFileSystem=/run
  --property=UMask=0077
)

environment=(
  "HOME=$HOME"
  "LANG=${LANG:-en_US.UTF-8}"
  "LC_ALL=${LC_ALL:-en_US.UTF-8}"
  "LOGNAME=$(id -un)"
  "OLLAMA_HOST=127.0.0.1:11434"
  "PATH=$PATH"
  "PI_SANDBOXED=1"
  "PI_SANDBOX_HOST_PID=$PPID"
  "PI_SUBAGENT_PI_BINARY=@pi@"
  "SHELL=${SHELL:-/run/current-system/sw/bin/bash}"
  "TERM=${TERM:-xterm-256color}"
  "USER=$(id -un)"
  "XDG_CACHE_HOME=/tmp/pi-cache"
  "XDG_STATE_HOME=/tmp/pi-state"
)
if [ -n "${COLORTERM:-}" ]; then
  environment+=("COLORTERM=$COLORTERM")
fi

exec systemd-run \
  --user \
  --collect \
  --description='Sandboxed Pi coding agent' \
  --pty \
  --quiet \
  --service-type=exec \
  --unit="pi-sandbox-$$" \
  --wait \
  --working-directory="$cwd" \
  "${properties[@]}" \
  -- @env@ -i "${environment[@]}" "$program" "$@"
