//! Build-owned equivalent of `gen_builtin_host_config.pl`'s empty-input probes.
use std::process::{Command, Output, Stdio};

fn words(text: &str) -> Result<Vec<String>, &'static str> {
    let (mut out, mut word) = (Vec::new(), String::new());
    let (mut quote, mut escape, mut started) = (None, false, false);
    for ch in text.chars() {
        if escape {
            word.push(ch);
            escape = false;
        } else if ch == '\\' && quote != Some('\'') {
            escape = true;
            started = true;
        } else if quote == Some(ch) {
            quote = None;
        } else if quote.is_none() && matches!(ch, '\'' | '"') {
            quote = Some(ch);
            started = true;
        } else if quote.is_none() && ch.is_whitespace() {
            if started {
                out.push(std::mem::take(&mut word));
                started = false;
            }
        } else {
            word.push(ch);
            started = true;
        }
    }
    if escape || quote.is_some() {
        return Err("unterminated host configuration word");
    }
    if started {
        out.push(word);
    }
    Ok(out)
}

fn probe(base: &[String], args: &[&str]) -> Option<Output> {
    let (program, flags) = base.split_first()?;
    Command::new(program)
        .args(flags)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()
}

fn successful(output: Option<Output>, fallback: &[u8]) -> Vec<u8> {
    output
        .filter(|o| o.status.success())
        .map_or_else(|| fallback.to_vec(), |o| o.stdout)
}

fn includes(output: Option<Output>) -> Vec<u8> {
    let Some(mut output) = output else {
        return Vec::new();
    };
    output.stdout.extend(output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    let (mut paths, mut collecting) = (Vec::new(), false);
    for line in text.lines() {
        if line.contains("#include <...> search starts here:") {
            collecting = true;
        } else if collecting {
            if line.contains("End of search list.") {
                break;
            }
            let path = line.trim();
            if !path.is_empty() && !path.contains("(framework directory)") && !paths.contains(&path)
            {
                paths.push(path);
            }
        }
    }
    paths.join("\n").into_bytes()
}

pub fn capture() -> Result<(), Box<dyn std::error::Error>> {
    for name in ["CPPGM_BUILD_HOST_CXX", "CPPGM_STDLIB_FLAGS"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=build_support/host_configuration.rs");
    let host = std::env::var("CPPGM_BUILD_HOST_CXX")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "c++".into());
    let flags = std::env::var("CPPGM_STDLIB_FLAGS").unwrap_or_default();
    let mut base = words(&host)?;
    base.extend(words(&flags)?);
    // Explicit absolute host commands are Cargo file dependencies as well.
    if let Some(program) = base
        .first()
        .filter(|s| std::path::Path::new(s).is_absolute())
    {
        println!("cargo:rerun-if-changed={program}");
    }
    let macros = successful(
        probe(&base, &["-std=gnu++11", "-dM", "-E", "-x", "c++", "-"]),
        b"",
    );
    let strict = successful(
        probe(&base, &["-std=c++11", "-dM", "-E", "-x", "c++", "-"]),
        &macros,
    );
    let paths = includes(probe(&base, &["-E", "-x", "c++", "-", "-v"]));
    let target = successful(
        probe(&base, &["-dumpmachine"]),
        b"x86_64-unknown-linux-gnu\n",
    );
    let version = successful(probe(&base, &["-dumpversion"]), b"11\n");
    let search = successful(probe(&base, &["-print-search-dirs"]), b"");
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").ok_or("missing Cargo OUT_DIR")?);
    for (name, bytes) in [
        ("macros", macros),
        ("strict", strict),
        ("includes", paths),
        ("target", target),
        ("version", version),
        ("search", search),
        ("command", host.into_bytes()),
        ("flags", flags.into_bytes()),
    ] {
        std::fs::write(out.join(format!("cppgm-host-{name}")), bytes)?;
    }
    Ok(())
}
