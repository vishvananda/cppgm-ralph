#!/usr/bin/env python3
"""Prepare PA34/35 files for a reviewed boundary installation; never edit a run."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import shutil

HERE = Path(__file__).resolve().parent
SHIPPED = ["scripts/reference_bootstrap.py", "pa34/README.md", "pa35/README.md", "pa35/Makefile"]


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def prepare(config_path, course, bundle, out, profile):
    config = json.loads(config_path.read_text())
    root = Path(config["workdir"])
    if out.exists() or out.resolve() == root.resolve() or out.resolve().is_relative_to(root.resolve()):
        raise ValueError("output must be a new staging directory outside the run")
    if not (bundle / "reference-bundle.json").is_file():
        raise ValueError("create the pinned reference bundle first")
    for name in SHIPPED:
        if not (course / name).is_file():
            raise ValueError(f"updated course input missing: {name}")
    out.mkdir(parents=True)
    name = config["name"]
    for path in config_path.parent.glob(name + ".*.md"):
        shutil.copyfile(path, out / path.name)
    staged = out / "candidate"
    files = SHIPPED + [p.relative_to(course).as_posix() for p in (course / "pa35/scripts").glob("*") if p.is_file()]
    for relative in files:
        target = staged / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(course / relative, target)
    contract = (HERE / "REFERENCE_STAGES.md").read_text().replace("@PROFILE@", profile)
    write(staged / "REFERENCE_STAGES.md", contract)
    addendum = "\n\n## PA34/PA35 reference track\n\n" + (
        "After the completed PA33 audit, REFERENCE_STAGES.md overrides the earlier\n"
        "PA33/PA34 stop, PA34/35 exclusions and reference-source restrictions for\n"
        "these two stages only. PA1–PA33 keep their original implementation contract.\n"
        "PA34 uses the " + profile + " bootstrap profile. PA35 uses ordinary course\n"
        "correctness/ABI/quality rules and permits valid optimization differences;\n"
        "clone-only bytes and work-counter equality are no longer its objective.\n")
    for relative in ("AGENTS.md", "spec.md", "CLONE_CONTRACT.md"):
        if (root / relative).exists():
            write(staged / relative, (root / relative).read_text() + addendum)
    # Stage both copies of the port's protected manifest for a later owner install.
    manifest_path = root / "scripts/clone/manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        for path in staged.rglob("*"):
            if path.is_file():
                manifest["protected"][path.relative_to(staged).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        encoded = json.dumps(manifest, indent=2) + "\n"
        write(staged / "scripts/clone/manifest.json", encoded)
        write(out / "control/manifest.json", encoded)
    checks = config["checks"]
    # Preserve the existing PA1–PA33 checks and their dependencies verbatim.
    for definition in checks.values():
        definition["excludeStages"] = list(dict.fromkeys(definition.get("excludeStages", []) + ["pa34", "pa35"]))
    q = shlex.quote
    tools = root / "obj/rust/release"
    compiler, backend = tools / "cppgm", tools / "lowir2native"
    store = root / "obj/reference-bootstrap"
    boot = "python3 scripts/reference_bootstrap.py"
    reference = f" --bundle {q(str(bundle.resolve()))} --compiler {q(str(compiler))} --out {q(str(store))} --profile {profile}"
    perf = (f" REFERENCE_BUNDLE={q(str(bundle.resolve()))} COMPILER={q(str(compiler))}"
            f" LOWIR2NATIVE={q(str(backend))} REFERENCE_OUT={q(str(store))}")
    def check(key, command, stages=("pa34", "pa35"), **extra):
        checks[key] = dict(command=command, required=True, onlyStages=list(stages))
        checks[key].update(extra)
    check("referenceBuild", "make build")
    check("referenceQuality", checks["rustQuality"]["command"], dependsOn=["referenceBuild"])
    if "fileAudit" in checks:
        check("referenceFileAudit", checks["fileAudit"]["command"], dependsOn=["referenceBuild"])
    if profile == "port":
        original = checks["preflight"]["command"].replace("{{testStage}}", "pa33")
        check("referenceIntegrity", original, dependsOn=["referenceBuild"])
        # Preserve the exact port's through-PA33 proof while completing PA34.
        check("referencePortPrior", checks["priorThroughTests"]["command"].replace("{{testStage}}", "pa34"),
              stages=("pa34",), dependsOn=["referenceIntegrity"])
    check("referencePrior", boot + f" course --course-root . --tools-dir {q(str(tools))} --out obj/reference-course",
          stages=("pa35",) if profile == "port" else ("pa34", "pa35"),
          kind="generic", targetStage="pa33", dependsOn=["referenceBuild"])
    required = ["referenceBuild", "referenceQuality"]
    required += [k for k in ("referenceFileAudit", "referenceIntegrity") if k in checks]
    required34 = required + (["referencePortPrior"] if profile == "port" else ["referencePrior"])
    required35 = required + ["referencePrior"]
    check("referenceObjects", boot + " progress" + reference, stages=("pa34",),
          kind="test", primary=True, required=False, dependsOn=["referenceBuild"])
    check("referenceObjectProgress", "ralph:current-stage-progress referenceObjects {{testStage}}",
          stages=("pa34",), dependsOn=required34)
    check("referenceObjectPreserved", "ralph:current-stage-progress referenceObjects {{testStage}} mode=preserve",
          stages=("pa34",), dependsOn=required34)
    check("referenceProof", boot + " final" + reference, stages=("pa34",),
          kind="generic", primary=True, dependsOn=required34)
    check("referenceSmoke", "make -C pa35 test-smoke" + perf, stages=("pa35",), dependsOn=["referenceBuild"])
    check("referencePerf", "make -C pa35 test-progress" + perf, stages=("pa35",),
          kind="test", primary=True, required=False, dependsOn=["referenceBuild"])
    check("referencePerfProgress", "ralph:current-stage-progress referencePerf {{testStage}}",
          stages=("pa35",), dependsOn=required35 + ["referenceSmoke"])
    check("referencePerfPreserved", "ralph:current-stage-progress referencePerf {{testStage}} mode=preserve",
          stages=("pa35",), dependsOn=required35 + ["referenceSmoke"])
    # After optimization the independent student proof permits valid new codegen.
    check("referenceFinalBootstrap", boot + " final" + reference.replace("--profile port", "--profile student"),
          stages=("pa35",), kind="generic", dependsOn=required35)
    check("referenceFinal", "make -C pa35 test" + perf, stages=("pa35",),
          kind="test", primary=True, dependsOn=required35 + ["referenceFinalBootstrap"])
    for phase in config["phases"]:
        phase["checks"] += list(dict.fromkeys(required34 + required35))
        phase["promptTemplates"] = dict(phase.get("promptTemplates", {}))
        phase["goalTemplates"] = dict(phase.get("goalTemplates", {}))
        for stage in ("pa34", "pa35"):
            key = f"reference-{stage}-{phase['name']}"
            phase["promptTemplates"][stage] = key
            phase["goalTemplates"][stage] = key + "-goal"
            for suffix in ("", "-goal"):
                template = (HERE / f"{stage}-{phase['name']}{suffix}.md").read_text()
                write(out / f"{name}.{key}{suffix}.md", template.replace("@PROFILE@", profile))
        if phase["name"] == "audit":
            phase["checks"] += ["referenceProof", "referenceFinalBootstrap", "referenceFinal"]
        else:
            preserve = phase["name"] == "checkpointAudit"
            phase["checks"] += ["referenceObjects", "referenceObjectPreserved" if preserve else "referenceObjectProgress",
                                "referenceSmoke", "referencePerf", "referencePerfPreserved" if preserve else "referencePerfProgress"]
    config["extraStages"] = list(dict.fromkeys(config.get("extraStages", []) + ["pa34", "pa35"]))
    config["stopAfterStage"] = "pa35"
    write(out / f"{name}.config.json", json.dumps(config, indent=2) + "\n")
    write(out / "activation.json", json.dumps({"workdir": str(root), "profile": profile,
          "bundle": str(bundle.resolve()), "files": sorted(p.relative_to(staged).as_posix() for p in staged.rglob("*") if p.is_file()),
          "note": "Prepared only. Install candidate and optional control files at a paused PA33 boundary; then select the staged config."}, indent=2) + "\n")
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--course", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--profile", choices=("student", "port"), required=True)
    args = parser.parse_args()
    prepare(args.config, args.course, args.bundle, args.out, args.profile)
    print(f"Prepared reviewable stage files in {args.out}; active run unchanged")


if __name__ == "__main__":
    main()
