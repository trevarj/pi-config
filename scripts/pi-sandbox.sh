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
cache_dir="$HOME/.cache/pi-sandbox"
gradle_home="$cache_dir/gradle"
# Shared with the host, unlike the Gradle home above: cargo registry downloads
# are large enough that a sandbox-local copy is worth avoiding.
cargo_home="$HOME/.cargo"
install -d -m 700 "$agent_dir" "$lens_dir" "$gradle_home" "$cargo_home"

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

git_access_fail() {
  printf 'Pi Git access requires current-user SSH/GPG agents and configured signing key.\n' >&2
  exit 1
}

uid=$(id -u)
runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$uid}
ssh_agent=${SSH_AUTH_SOCK:-}
gpg_home=$(gpgconf --list-dirs homedir)
gpg_agent=$(gpgconf --list-dirs agent-socket)
signing_key=$(git config --global --includes user.signingkey)
signing_keygrip=$(
  gpg --batch --with-colons --with-keygrip --list-secret-keys "$signing_key" |
    awk -F: '$1 == "grp" { print $10; exit }'
)
case "$runtime_dir" in "/run/user/$uid") ;; *) git_access_fail ;; esac
case "$ssh_agent" in "/run/user/$uid/"*) ;; *) git_access_fail ;; esac
case "$gpg_agent" in "/run/user/$uid/"*) ;; *) git_access_fail ;; esac
case "$gpg_home" in "$HOME/.gnupg") ;; *) git_access_fail ;; esac
[ "${#signing_keygrip}" = 40 ] || git_access_fail
case "$signing_keygrip" in *[!0-9A-F]*) git_access_fail ;; esac
for socket in "$ssh_agent" "$gpg_agent"; do
  [ -S "$socket" ] && [ ! -L "$socket" ] && [ "$(stat -c %u "$socket")" = "$uid" ] ||
    git_access_fail
done
for path in \
  "$gpg_home/pubring.kbx" \
  "$gpg_home/trustdb.gpg" \
  "$gpg_home/private-keys-v1.d/$signing_keygrip.key" \
  "$HOME/.ssh/config" \
  "$HOME/.ssh/known_hosts" \
  "$HOME/.config/gh/hosts.yml"; do
  [ -f "$path" ] && [ ! -L "$path" ] && [ "$(stat -c %u "$path")" = "$uid" ] ||
    git_access_fail
done
[ -d "$HOME/.config/git" ] && [ ! -L "$HOME/.config/git" ] &&
  [ "$(stat -c %u "$HOME/.config/git")" = "$uid" ] || git_access_fail

git_runtime="$runtime_dir/pi-sandbox-runtime"
sandbox_runtime="/run/user/$uid"
sandbox_gnupg=/tmp/pi-gnupg
sandbox_gpg_agent=$(GNUPGHOME="$sandbox_gnupg" gpgconf --list-dirs agent-socket)
sandbox_ssh_agent="$sandbox_runtime/ssh-agent"
install -d -m700 \
  "$git_runtime/$(dirname "${sandbox_gpg_agent#"$sandbox_runtime/"}")"

properties=(
  --property=AmbientCapabilities=
  --property=CapabilityBoundingSet=
  --property="BindPaths=$workspace"
  --property="BindPaths=$agent_dir"
  --property="BindPaths=$lens_dir"
  --property="BindPaths=$cache_dir"
  --property="BindPaths=$cargo_home"
  --property="BindPaths=$git_runtime:$sandbox_runtime"
  --property="BindReadOnlyPaths=-$HOME/.agents"
  --property="BindReadOnlyPaths=$HOME/.config/git"
  --property="BindReadOnlyPaths=$HOME/.config/gh/hosts.yml"
  --property="BindReadOnlyPaths=-$HOME/.gitconfig"
  --property="BindReadOnlyPaths=$HOME/.ssh/config"
  --property="BindReadOnlyPaths=$HOME/.ssh/known_hosts"
  --property="BindReadOnlyPaths=$gpg_home/pubring.kbx:/run/pi-git/pubring.kbx"
  --property="BindReadOnlyPaths=$gpg_home/trustdb.gpg:/run/pi-git/trustdb.gpg"
  --property="BindReadOnlyPaths=$gpg_home/private-keys-v1.d/$signing_keygrip.key:/run/pi-git/signing.key"
  --property="BindReadOnlyPaths=$gpg_agent:$sandbox_gpg_agent"
  --property="BindReadOnlyPaths=$ssh_agent:$sandbox_ssh_agent"
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
  "GIT_SSH_COMMAND=ssh -F $HOME/.ssh/config"
  "GNUPGHOME=$sandbox_gnupg"
  "GRADLE_USER_HOME=$gradle_home"
  "HOME=$HOME"
  "LANG=${LANG:-en_US.UTF-8}"
  "LC_ALL=${LC_ALL:-en_US.UTF-8}"
  "LOGNAME=$(id -un)"
  "OLLAMA_HOST=127.0.0.1:11434"
  "PATH=$PATH"
  "PI_GIT_SIGNING_KEY=$signing_key"
  "PI_SANDBOXED=1"
  "PI_SANDBOX_HOST_PID=$PPID"
  "PI_SUBAGENT_PI_BINARY=@pi@"
  "SHELL=${SHELL:-/run/current-system/sw/bin/bash}"
  "SSH_AUTH_SOCK=$sandbox_ssh_agent"
  "TERM=${TERM:-xterm-256color}"
  "TZ=UTC"
  "USER=$(id -un)"
  "XDG_CACHE_HOME=$cache_dir"
  "XDG_RUNTIME_DIR=$sandbox_runtime"
  "XDG_STATE_HOME=/tmp/pi-state"
)
if [ -n "${COLORTERM:-}" ]; then
  environment+=("COLORTERM=$COLORTERM")
fi

# Shell variables in sandbox bootstrap expand after systemd starts it.
# shellcheck disable=SC2016
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
  -- @env@ -i "${environment[@]}" @bash@ -c '
    set -eu
    install -d -m700 "$GNUPGHOME" "$GNUPGHOME/private-keys-v1.d"
    install -m600 /run/pi-git/pubring.kbx "$GNUPGHOME/pubring.kbx"
    install -m600 /run/pi-git/trustdb.gpg "$GNUPGHOME/trustdb.gpg"
    install -m600 /run/pi-git/signing.key \
      "$GNUPGHOME/private-keys-v1.d/'"$signing_keygrip"'.key"
    exec "$@"
  ' pi-sandbox-init "$program" "$@"
