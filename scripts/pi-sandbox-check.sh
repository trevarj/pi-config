# shellcheck shell=bash

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[ "${PI_SANDBOXED:-}" = 1 ] || fail 'PI_SANDBOXED marker is missing'
case "${XDG_CACHE_HOME:-}:${XDG_STATE_HOME:-}" in
/tmp/*:/tmp/*) ;;
*) fail 'sandbox-local cache or state path is missing' ;;
esac
mkdir -p "$XDG_CACHE_HOME" "$XDG_STATE_HOME" || fail 'sandbox-local cache or state is not writable'

[ -d "$HOME/Workspace" ] && [ -r "$HOME/Workspace" ] && [ -w "$HOME/Workspace" ] ||
  fail 'Workspace is not available read/write'
workspace_probe=$(mktemp "$HOME/Workspace/.pi-sandbox-check.XXXXXX") ||
  fail 'Workspace write probe failed'
rm -f -- "$workspace_probe"
[ -d "$HOME/.pi/agent" ] && [ -r "$HOME/.pi/agent" ] && [ -w "$HOME/.pi/agent" ] ||
  fail 'Pi agent state is not available read/write'
[ -d "$HOME/.pi-lens" ] && [ -r "$HOME/.pi-lens" ] && [ -w "$HOME/.pi-lens" ] ||
  fail 'Pi Lens state is not available read/write'
[ -r "$HOME/.config/pi/web-search.json" ] || fail 'reviewed Pi web config is unavailable'
[ -r "$HOME/.config/git/config" ] || fail 'Git config is unavailable'
[ -r "$HOME/.ssh/config" ] || fail 'SSH config is unavailable'
[ -r "$HOME/.ssh/known_hosts" ] || fail 'SSH known_hosts is unavailable'
ssh -F "$HOME/.ssh/config" -G github.com >/dev/null 2>&1 || fail 'SSH configuration is unusable'
[ -S "${SSH_AUTH_SOCK:-}" ] || fail 'SSH agent is unavailable'
ssh-add -L >/dev/null 2>&1 || fail 'SSH agent has no usable identities'
[ -n "${PI_GIT_SIGNING_KEY:-}" ] || fail 'Git signing key is unspecified'
[ -S "$(gpgconf --list-dirs agent-socket)" ] || fail 'GPG agent is unavailable'
gpg --batch --list-secret-keys "$PI_GIT_SIGNING_KEY" >/dev/null 2>&1 ||
  fail 'Git signing key is unavailable'
git_probe=$(mktemp -d)
trap 'rm -rf -- "$git_probe"' EXIT
git -C "$git_probe" init --quiet
git -C "$git_probe" commit --quiet --allow-empty -m 'Pi sandbox signing probe' ||
  fail 'signed Git commit failed'
git -C "$git_probe" verify-commit HEAD >/dev/null 2>&1 || fail 'Git commit signature verification failed'
rm -rf -- "$git_probe"
trap - EXIT
[ -r /nix/store ] || fail 'Nix store is not readable'
[ -S /nix/var/nix/daemon-socket/socket ] || fail 'Nix daemon socket is unavailable'
nix store info --store daemon >/dev/null 2>&1 || fail 'Nix daemon is unreachable'
[ -x "${PI_SUBAGENT_PI_BINARY:-}" ] || fail 'nested Pi executable is unavailable'
"$PI_SUBAGENT_PI_BINARY" --version >/dev/null || fail 'nested Pi executable cannot start'

for path in \
  "$HOME/.ssh/id_ed25519" \
  "$HOME/.ssh/id_rsa" \
  "$HOME/.ssh/aur" \
  "$HOME/.ssh/wgkey" \
  "$HOME/.gnupg" \
  "$HOME/.claude" \
  "$HOME/.codex" \
  "$HOME/.config/BraveSoftware" \
  "$HOME/.config/gh" \
  "$HOME/.config/nym-vpn" \
  "$HOME/.local/share/keyrings" \
  "/run/user/$(id -u)/bus" \
  /run/dbus/system_bus_socket \
  /run/libvirt/libvirt-sock \
  /run/nym-vpn.sock; do
  [ ! -e "$path" ] && [ ! -L "$path" ] || fail "sensitive path is visible: $path"
done

[ ! -d /dev/input ] || fail '/dev/input is visible'
if [ -z "${PI_SANDBOX_HOST_PID:-}" ] || [ -e "/proc/$PI_SANDBOX_HOST_PID" ]; then
  fail 'unrelated host process is visible'
fi

for name in \
  ANTHROPIC_API_KEY \
  AWS_ACCESS_KEY_ID \
  AWS_SECRET_ACCESS_KEY \
  GH_TOKEN \
  GITHUB_TOKEN \
  OPENAI_API_KEY \
  PI_SANDBOX_TEST_SECRET; do
  if printenv "$name" >/dev/null; then
    fail "sensitive environment variable is visible: $name"
  fi
done

printf 'Pi sandbox boundaries pass. Workspace, Pi state, and signing/push agents available; raw host credentials, D-Bus, input devices, and secret environment variables hidden.\n'
