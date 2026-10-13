#!/usr/bin/env bash
set -euo pipefail
scaffold_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work_base=/home/vishvananda/work
private_root="$work_base/private/v5scratch"
checkout="$private_root/checkout"
config_path="$work_base/v5scratch.config.json"
state_dir="$work_base/.ralph/v5scratch-gpt-6.1-sol-high"
base_ref=4fc4f61d8897f09293a2ef9202fd49373c602a29
assignment_remote=https://github.com/vishvananda/cppgm-assignments.git
remote_name=vishvananda/cppgm-run-v5scratch

for command_name in git gh node python3 cargo sudo findmnt mountpoint perf bwrap systemd-run; do
  command -v "$command_name" >/dev/null
done
for destination in "$work_base/v5scratch" "$config_path" "$checkout" "$state_dir" "$work_base/v5scratch-control"; do
  if [[ -e "$destination" || -L "$destination" ]]; then
    printf 'Refusing to overwrite existing run path: %s\n' "$destination" >&2
    exit 1
  fi
done
if gh repo view "$remote_name" >/dev/null 2>&1; then
  printf 'Refusing to reuse existing remote: %s\n' "$remote_name" >&2
  exit 1
fi
if [[ -e "$private_root" ]] || sudo -n lvs vg0/cppgm_v5scratch >/dev/null 2>&1; then
  printf 'Refusing to provision or format existing storage.\n' >&2
  exit 1
fi
sudo -n lvcreate -L 100G -n cppgm_v5scratch vg0
sudo -n mkfs.ext4 -m 0 /dev/vg0/cppgm_v5scratch
sudo -n mkdir -p "$private_root"
sudo -n mount -o nosuid,nodev /dev/vg0/cppgm_v5scratch "$private_root"
sudo -n chown "$(id -u):$(id -g)" "$private_root"
sudo -n chmod 0700 "$private_root"
volume_uuid=$(sudo -n blkid -s UUID -o value /dev/vg0/cppgm_v5scratch)
printf 'UUID=%s %s ext4 nosuid,nodev,nofail,x-systemd.device-timeout=30 0 2\n' "$volume_uuid" "$private_root" | sudo -n tee -a /etc/fstab >/dev/null
# No historical solution-bearing commits or other runs are cloned.
git -c "url.$assignment_remote.insteadOf=$assignment_remote" -c credential.https://github.com.helper= -c 'credential.https://github.com.helper=!gh auth git-credential' clone --branch v5 --depth 1 --single-branch "$assignment_remote" "$checkout"
[[ "$(git -C "$checkout" rev-parse HEAD)" == "$base_ref" ]]
git -C "$checkout" switch -c main
git -C "$checkout" remote rename origin upstream
python3 "$scaffold_dir/scaffold.py"
cargo fmt --manifest-path "$checkout/dev/Cargo.toml" --all
perl "$checkout/scripts/ensure_reference_binaries.pl"
node "$scaffold_dir/verify-setup.mjs" "$config_path"
# Publish a snapshot with fresh history; retain the verified shallow source
# metadata as a local setup artifact rather than inheriting assignment history.
mv "$checkout/.git" "$private_root/artifacts/student-source.git"
git -C "$checkout" init --initial-branch=main
git -C "$checkout" remote add upstream "$assignment_remote"
git -C "$checkout" config --local user.name "$(git config --get user.name)"
git -C "$checkout" config --local user.email "$(git config --get user.email)"
git -C "$checkout" add -A
git -C "$checkout" commit -q -m 'Prepare safe Rust student compiler from V5 assignments through PA33'
gh repo create "$remote_name" --private --source "$checkout" --remote origin
git -C "$checkout" remote set-url origin "https://github.com/$remote_name.git"
git -C "$checkout" config --local "url.https://github.com/$remote_name.git.insteadOf" "https://github.com/$remote_name.git"
git -C "$checkout" config --local --add credential.https://github.com.helper ''
git -C "$checkout" config --local --add credential.https://github.com.helper '!gh auth git-credential'
git -C "$checkout" push -u origin main
printf 'Scaffold installed, clean and unstarted. Config: %s\n' "$config_path"
