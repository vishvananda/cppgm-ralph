#!/usr/bin/env bash
set -euo pipefail
scaffold_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work_base=/home/vishvananda/work
private_root="$work_base/private/v5opus"
checkout="$private_root/checkout"
config_path="$work_base/v5opus.config.json"
state_dir="$work_base/.ralph/v5opus-gpt-6.1-sol-high"
base_ref=22e677f46ffa27a8e003c0b53331c9188d151071
assignment_remote=https://github.com/vishvananda/cppgm-assignments.git
remote_name=vishvananda/cppgm-run-v5opus

for command_name in git gh node claude sudo findmnt mountpoint perf valgrind bwrap systemd-run; do
  command -v "$command_name" >/dev/null
done
for destination in "$work_base/v5opus" "$config_path" "$checkout" "$state_dir"; do
  if [[ -e "$destination" || -L "$destination" ]]; then
    printf 'Refusing to overwrite existing run path: %s\n' "$destination" >&2
    exit 1
  fi
done
gh auth status
if gh repo view "$remote_name" >/dev/null 2>&1; then
  printf 'Refusing to reuse existing remote: %s\n' "$remote_name" >&2
  exit 1
fi

# Format only a volume created by this invocation. Never format an existing LV.
if ! mountpoint -q "$private_root"; then
  if [[ -e "$private_root" ]]; then
    printf 'Provision a dedicated filesystem first; path already exists: %s\n' "$private_root" >&2
    exit 1
  fi
  if sudo -n lvs vg0/cppgm_v5opus >/dev/null 2>&1; then
    printf 'Existing LV is not mounted; refusing to format it.\n' >&2
    exit 1
  fi
  sudo -n lvcreate -L 100G -n cppgm_v5opus vg0
  sudo -n mkfs.ext4 -m 0 /dev/vg0/cppgm_v5opus
  sudo -n mkdir -p "$private_root"
  sudo -n mount -o nosuid,nodev /dev/vg0/cppgm_v5opus "$private_root"
  sudo -n chown "$(id -u):$(id -g)" "$private_root"
  sudo -n chmod 0700 "$private_root"
  volume_uuid=$(sudo -n blkid -s UUID -o value /dev/vg0/cppgm_v5opus)
  printf 'UUID=%s %s ext4 nosuid,nodev,nofail,x-systemd.device-timeout=30 0 2\n' "$volume_uuid" "$private_root" | sudo -n tee -a /etc/fstab >/dev/null
fi

node --input-type=module - "$scaffold_dir" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = process.argv[2];
const { preparePrivateWriteDirectory } = await import(pathToFileURL(path.resolve(dir, '../../session-isolation.js')));
const c = JSON.parse(fs.readFileSync(path.join(dir, 'v5opus.config.json'), 'utf8'));
preparePrivateWriteDirectory({ isolation: c.sessionIsolation,
  workdir: path.join(c.sessionIsolation.privateWriteDir, 'checkout'),
  stateDir: path.join(c.stateBaseDir, `${c.name}-${c.model}-${c.reasoningEffort}`) });
JS

git clone --no-checkout "$assignment_remote" "$checkout"
git -C "$checkout" checkout -B main "$base_ref"
git -C "$checkout" remote rename origin upstream
git -C "$checkout" config remote.upstream.fetch '+refs/heads/*:refs/remotes/upstream/*'
cp "$scaffold_dir/spec.md" "$checkout/spec.md"
git -C "$checkout" add spec.md
git -C "$checkout" commit -m 'Configure V5 Opus semantic reuse architecture and scoped validation'
ln -s "$checkout" "$work_base/v5opus"
cp "$scaffold_dir"/v5opus.* "$work_base/"
node "$scaffold_dir/verify-setup.mjs" "$config_path"
gh repo create "$remote_name" --private --source "$checkout" --remote origin
git -C "$checkout" remote set-url origin "https://github.com/$remote_name.git"
git -C "$checkout" config --local "url.https://github.com/$remote_name.git.insteadOf" "https://github.com/$remote_name.git"
git -C "$checkout" config --local --add credential.https://github.com.helper ''
git -C "$checkout" config --local --add credential.https://github.com.helper '!gh auth git-credential'
git -C "$checkout" push -u origin main
printf 'Scaffold installed, clean and unstarted. Launch from cppgm-ralph with:\nRALPH_CONFIG=%s npm run ralph\n' "$config_path"
