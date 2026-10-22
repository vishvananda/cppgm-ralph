#!/usr/bin/env python3
"""Prepare PA34/35 files for a reviewed boundary installation; never edit a run."""
import argparse
import hashlib
import json
import re
from pathlib import Path
import shlex
import shutil

HERE = Path(__file__).resolve().parent
SHIPPED = ["scripts/reference_bootstrap.py", "pa34/README.md", "pa35/README.md", "pa35/Makefile", "scripts/rust_course.json"]


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
    variant = json.loads((course / "scripts/rust_course.json").read_text())
    if variant.get("course") != "rust-reference" or variant.get("branch") != "rust-course":
        raise ValueError("course must come from the long-lived rust-course branch/export")
    out.mkdir(parents=True)
    name = config["name"]
    # Copy only templates still selected below PA34, not obsolete stage sidecars.
    earlier_templates = {phase[key] for phase in config["phases"] for key in ("promptTemplate", "goalTemplate")}
    for template in earlier_templates:
        path = config_path.parent / f"{name}.{template}.md"
        if path.exists():
            shutil.copyfile(path, out / path.name)
    staged = out / "candidate"
    files = SHIPPED + [p.relative_to(course).as_posix() for p in (course / "pa35/scripts").glob("*") if p.is_file()]
    for relative in files:
        target = staged / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(course / relative, target)
    # Replace conflicting policy in place; never append an override document.
    for relative in ("AGENTS.md", "spec.md", "CLONE_CONTRACT.md", "README.md", "RUST_STUDENT.md", "docs/rust-clone-plan.md"):
        if not (root / relative).exists():
            continue
        text = (root / relative).read_text()
        if relative == "AGENTS.md":
            text = text.replace("through PA1–PA33.", "through PA1–PA35.")
            text = text.replace("Do not read or copy completed compiler sources or solution\nrepositories, locally or online.",
                "Through PA33, do not read completed compiler sources or solution repositories.\nAt PA34, inspect the pinned C++ reference only as a compilation workload; do\nnot copy its implementation into Rust.")
            text = text.replace("The run stops after the PA33 audit. PA34/PA35 remain handout material and have\nno exit criteria in this run.",
                "PA34 and PA35 follow their Rust course handouts. The run ends after the PA35 audit.")
            text = text.replace("`make inception` is the final\ncross-implementation PA34 proof, not a Rust self-compiler.",
                "PA34's final proof uses the reference-bootstrap runner in its handout.")
            text = re.sub(r"PA35 is not an active conversion stage\..*",
                "PA1–PA34 preserve the port's exact code generation and full PA34 equality.\nPA35 allows valid optimizations under ordinary course correctness/ABI/quality\ncontracts. Follow the current handout's single acceptance procedure.\n", text, flags=re.S)
        elif relative == "spec.md":
            text = text.replace("through V5 PA1–PA33.", "through V5 PA1–PA35.")
            text = text.replace("choices, define acceptance. PA34 and PA35 are deferred.",
                "choices, define acceptance. PA34 compiles the pinned C++ reference workload;\nPA35 optimizes Rust throughput and its generated C++ code under those handouts.")
            text = text.replace("PA35's self-build measurements are outside this run.",
                "PA35 measures Rust throughput and generated code using the frozen C++ bundle.")
            text = text.replace("The run stops after the successful PA33 audit. Neither\ninception nor PA35's self-build gates are exit criteria for this run.",
                "PA34 requires its full reference bootstrap; PA35 requires all 17 gates,\nfinal bootstrap and Rust quality. The run ends after the successful PA35 audit.")
        elif relative == "CLONE_CONTRACT.md":
            text = text.split("## PA34: cross-implementation bootstrap", 1)[0]
            text += ("## PA34 and PA35\n\nPA34 follows pa34/README.md's exact-port bootstrap proof.\n"
                     "PA35 follows pa35/README.md's optimization acceptance. Exact byte and work-\n"
                     "counter parity in this contract applies through PA34; PA35 permits valid\n"
                     "optimization differences while preserving course language, ABI, IR, output\n"
                     "and quality requirements. The completed port proof remains recorded.\n")
        elif relative == "README.md":
            if profile == "student":
                text = (course / "docs/student-export-root/README.md").read_text() if (course / "docs/student-export-root/README.md").exists() else (course / "README.md").read_text()
                text = text.replace("# cppgm assignments", "# C++11 compiler implemented in Rust", 1)
            else:
                text = text.replace("PA35 is reference material, not an optimization objective for this port.",
                    "PA35 optimizes throughput and generated code under its Rust handout; valid\noptimization differences are permitted after the completed PA34 port proof.")
        elif relative == "RUST_STUDENT.md":
            text = text.replace("The run stops after the successful PA33 audit (`stopAfterStage: pa33`).\nPA34/PA35 are deferred; their original handouts remain available. No inception\nproof or PA35 self-build/performance gate is claimed by this run.",
                "The run continues through PA35. PA34's Rust handout defines the reference\nbootstrap; PA35's defines compiler throughput and generated-code acceptance.")
            text = text.replace("The Rust adaptation and PA33 endpoint override the student starter's C++ build\nand PA34/35 instructions; all PA1–PA33 student language/test contracts remain.",
                "The Rust course handouts define PA34/35 directly; PA1–PA33 keep their course contracts.")
        elif relative == "docs/rust-clone-plan.md":
            start = text.find("## Making PA34 prove byte identity")
            end = text.find("The conversion is complete only when:", start)
            if start >= 0 and end >= 0:
                text = text[:start] + ("## PA34 bootstrap and PA35 optimization\n\n"
                    "Follow pa34/README.md for the complete strict port proof and\n"
                    "pa35/README.md for the subsequent optimization acceptance. The configured\n"
                    "runner owns clean generations, inventories, fixed paths and rebuilt suites.\n"
                    "Measure Rust throughput separately from generated C++ code, with unchanged\n"
                    "frozen sources and the handout's cached measurement protocol.\n\n") + text[end:]
            text = text.replace("no new code-generation optimization objective", "PA35 optimization acceptance follows its Rust handout")
        write(staged / relative, text)
    for relative in ("TESTING_AND_REFERENCES.md", "PROJECT_LAYOUT.md"):
        source = course / "docs/student-export-root" / relative
        if not source.exists():
            source = course / relative
        if source.exists():
            shutil.copyfile(source, staged / relative)
    # Student sources never need to see the alternative port acceptance.
    if profile == "port":
        handout = staged / "pa34/README.md"
        text = handout.read_text().replace("Rust compiler reference bootstrap", "Rust port reference bootstrap", 1)
        a = text.index("A need not equal B")
        b = text.index("```sh", a)
        text = text[:a] + ("Build F=B(S) and require F==A==C==D for every object and all nine tools.\n"
            "A and D must pass PA1–PA33 and PA8/PA32/PA33 debug suites using their\n"
            "own helper tools. This is the port's mandatory PA34 acceptance proof.\n\n") + text[b:]
        text = text.replace("--out obj/reference-bootstrap", "--out obj/reference-bootstrap --profile port")
        text = text.replace("It is a compilation workload,\nnot an implementation to delegate to or copy into your compiler. Before PA34,\nan independent student implementation continues to use only the handouts,\nfixtures and supplied reference binaries. At PA34 you may inspect S and reduce\ninputs that expose compilation errors; fix those errors in your own compiler.",
            "Use the reference sources to diagnose port mismatches; production phases\nremain implemented in Rust. Reduce compilation failures and fix their Rust owners.")
        handout.write_text(text)
        optimization = staged / "pa35/README.md"
        optimization.write_text(optimization.read_text().replace(
            "Never copy reference compiler logic into Rust or delegate a production phase.",
            "Consult the reference sources as needed; production phases remain Rust."))
    reference = ("REFERENCE_BUNDLE := " + str(bundle.resolve()) + "\n"
                 "COMPILER := " + str(root / "obj/rust/release/cppgm") + "\n"
                 "LOWIR2NATIVE := " + str(root / "obj/rust/release/lowir2native") + "\n"
                 "REFERENCE_OUT := " + str(root / "obj/reference-bootstrap") + "\n")
    write(staged / "pa35/reference.mk", reference)
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
    prior = boot + f" course --course-root . --tools-dir {q(str(tools))} --out obj/reference-course"
    if profile == "student":
        # Keep the independent student's established comparison rules. The
        # rebuilt C++ generations still run their own strict bootstrap suites.
        prior = "make test-report-through-pa33" + "".join(
            f" && make -C pa{n} test-debuginfo CPPGM_SKIP_DEV_REBUILD=1"
            for n in (8, 32, 33))
    check("referencePrior", prior,
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
                if profile == "port":
                    template = template.replace(
                        "The reference source is a workload, not an implementation to copy or delegate to.",
                        "Consult the pinned C++ sources to fix the Rust port; production phases remain Rust.")
                    template = template.replace("measurement campaigns or copying the reference implementation.",
                                                "measurement campaigns or delegating production phases.")
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
    write(out / "activation.json", json.dumps({"workdir": str(root), "profile": profile, "course_branch": "rust-course",
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
