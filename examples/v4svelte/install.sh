#!/usr/bin/env bash
set -euo pipefail
scaffold_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
work_base=/home/vishvananda/work
private_root="$work_base/private/v4svelte"
checkout="$private_root/checkout"
config_path="$work_base/v4svelte.config.json"
state_dir="$work_base/.ralph/v4svelte-gpt-6.1-sol-high"
source_checkout="$work_base/v4sol61"
base_ref=5a4e8c0e4103e9a629d42d0ed13226d056f4a4b9
preparation_ref=433cb2cbde465843d79cdc1490597a83fda214ab
remote_name=vishvananda/cppgm-run-v4svelte

# This is a boundary-stop request, not termination of the active provider turn.
touch "$work_base/.ralph/v4sol61-gpt-6.1-sol-high/stop-after-turn"
for command_name in git gh node sudo findmnt mountpoint; do
  command -v "$command_name" >/dev/null
done
for destination in "$work_base/v4svelte" "$config_path" "$checkout" "$state_dir"; do
  if [[ -e "$destination" || -L "$destination" ]]; then
    printf 'Refusing to overwrite existing run path: %s\n' "$destination" >&2
    exit 1
  fi
done
git -C "$source_checkout" cat-file -e "$preparation_ref^{commit}"
gh auth status
if gh repo view "$remote_name" >/dev/null 2>&1; then
  printf 'Refusing to reuse existing remote: %s\n' "$remote_name" >&2
  exit 1
fi

# Match the dedicated 100 GiB LVM/ext4 storage used by the native scaffold.
# Format only a volume just created by this invocation; never format an existing LV.
if ! mountpoint -q "$private_root"; then
  if [[ -e "$private_root" ]]; then
    printf 'Provision a dedicated filesystem first; path already exists: %s\n' "$private_root" >&2
    exit 1
  fi
  if sudo lvs vg0/cppgm_v4svelte >/dev/null 2>&1; then
    printf 'Existing LV is not mounted; refusing to format it.\n' >&2
    exit 1
  fi
  sudo lvcreate -L 100G -n cppgm_v4svelte vg0
  sudo mkfs.ext4 -m 0 /dev/vg0/cppgm_v4svelte
  sudo mkdir -p "$private_root"
  sudo mount -o nosuid,nodev /dev/vg0/cppgm_v4svelte "$private_root"
  sudo chown "$(id -u):$(id -g)" "$private_root"
  sudo chmod 0700 "$private_root"
  volume_uuid=$(sudo blkid -s UUID -o value /dev/vg0/cppgm_v4svelte)
  printf 'UUID=%s %s ext4 nosuid,nodev,nofail,x-systemd.device-timeout=30 0 2\n' "$volume_uuid" "$private_root" | sudo tee -a /etc/fstab >/dev/null
fi

# Validate the capacity/isolation guard before putting any checkout on the volume.
node --input-type=module - "$scaffold_dir" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = process.argv[2];
const { preparePrivateWriteDirectory } = await import(pathToFileURL(path.resolve(dir, '../../session-isolation.js')));
const c = JSON.parse(fs.readFileSync(path.join(dir, 'v4svelte.config.json'), 'utf8'));
preparePrivateWriteDirectory({ isolation: c.sessionIsolation, workdir: path.join(c.sessionIsolation.privateWriteDir, 'checkout'),
  stateDir: path.join(c.stateBaseDir, `${c.name}-${c.model}-${c.reasoningEffort}`) });
JS

git init -q -b main "$checkout"
git -C "$checkout" fetch -q --no-tags "$source_checkout" "$preparation_ref"
git -C "$checkout" reset --hard "$base_ref"
git -C "$checkout" restore --source="$preparation_ref" -- scripts/cppgm_file_audit.pl student.tests/backend-quality student.tests/pa27/emission-growth student.tests/pa32/accessor-growth
cp "$scaffold_dir/spec.md" "$checkout/spec.md"
git -C "$checkout" add spec.md scripts/cppgm_file_audit.pl student.tests
git -C "$checkout" commit -m 'Add compiler specification, file audit and quality controls on v4.4'
git -C "$checkout" remote add upstream git@github.com:vishvananda/cppgm-assignments.git
ln -s "$checkout" "$work_base/v4svelte"
cp "$scaffold_dir"/v4svelte.* "$work_base/"
node "$scaffold_dir/verify-setup.mjs" "$config_path"
gh repo create "$remote_name" --private --source "$checkout" --remote origin
git -C "$checkout" remote set-url origin "https://github.com/$remote_name.git"
git -C "$checkout" config --local "url.https://github.com/$remote_name.git.insteadOf" "https://github.com/$remote_name.git"
git -C "$checkout" config --local --add credential.https://github.com.helper ''
git -C "$checkout" config --local --add credential.https://github.com.helper '!gh auth git-credential'
git -C "$checkout" push -u origin main
printf 'Scaffold installed, clean and unstarted. Launch from cppgm-ralph with:\nRALPH_CONFIG=%s npm run ralph\n' "$config_path"
