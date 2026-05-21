#!/usr/bin/env perl
use strict;
use warnings;

use Cwd qw(abs_path getcwd);
use File::Find qw(find);
use File::Spec;
use Getopt::Long qw(GetOptions);

my %opt = (
    root => '.',
    paths => [],
    stage => '',
    max_source_lines => 1500,
    max_header_lines => 1200,
    max_internal_header_lines => 900,
    max_function_lines => 120,
    warn_nesting => 6,
    max_nesting => 8,
    duplicate_window => 28,
    duplicate_min_chars => 240,
    warnings_fail => 0,
    follow_includes => 1,
    include_stage_tools => 0,
    help => 0,
);

GetOptions(
    'root=s' => \$opt{root},
    'path=s@' => $opt{paths},
    'paths=s@' => $opt{paths},
    'stage=s' => \$opt{stage},
    'max-source-lines=i' => \$opt{max_source_lines},
    'max-header-lines=i' => \$opt{max_header_lines},
    'max-internal-header-lines=i' => \$opt{max_internal_header_lines},
    'max-function-lines=i' => \$opt{max_function_lines},
    'warn-nesting=i' => \$opt{warn_nesting},
    'max-nesting=i' => \$opt{max_nesting},
    'duplicate-window=i' => \$opt{duplicate_window},
    'duplicate-min-chars=i' => \$opt{duplicate_min_chars},
    'warnings-fail!' => \$opt{warnings_fail},
    'follow-includes!' => \$opt{follow_includes},
    'include-stage-tools!' => \$opt{include_stage_tools},
    'help|h' => \$opt{help},
) or die "Invalid arguments\n";

if ($opt{help}) {
    print_usage();
    exit 0;
}

my $root = abs_path($opt{root}) // die "Cannot resolve root $opt{root}\n";
my @paths = expand_path_options(@{$opt{paths}});
@paths = ('dev') if !@paths;
if ($opt{include_stage_tools}) {
    push @paths, discover_stage_tool_paths($root, $opt{stage});
}

my @files;
for my $input (@paths) {
    my $target = File::Spec->rel2abs($input, $root);
    collect_source_files($target, \@files);
}
my %included_by;
discover_included_files($root, \@files, \%included_by) if $opt{follow_includes};
my %seen_file;
@files = grep { !$seen_file{$_}++ } sort @files;

my @fatal;
my @warning;
my %source_by_file;
my %line_count_by_file;
my %stem_groups;

for my $file (@files) {
    my $rel = relative_path($file, $root);
    next if is_exempt_file($rel);
    my $text = read_text($file);
    $source_by_file{$rel} = $text;
    my $line_count = count_lines($text);
    $line_count_by_file{$rel} = $line_count;
    push @{$stem_groups{division_stem($rel)}}, $rel;

    check_file_size($rel, $line_count, \@fatal);
    check_file_name($rel, $line_count, \@fatal, \@warning);
    check_includes($rel, $text, \%included_by, \@fatal, \@warning);
    check_shortcut_smells($rel, $text, \@fatal, \@warning);
    check_functions($rel, $text, \@fatal, \@warning);
    check_header_body_weight($rel, $text, \@fatal, \@warning);
}

check_stem_groups(\%stem_groups, \@warning);
check_duplicate_blocks(\%source_by_file, \@warning);

my $stage_text = $opt{stage} ? " for $opt{stage}" : '';
if (!@fatal && !@warning) {
    print "File audit passed$stage_text: " . scalar(@files) . " files checked.\n";
    exit 0;
}

if (@fatal) {
    print "File audit failed$stage_text: " . scalar(@fatal) . " fatal issue(s)";
    print @warning ? " and " . scalar(@warning) . " warning(s)" : "";
    print ".\n";
    print_findings("fatal", \@fatal);
    print_findings("warning", \@warning) if @warning;
    exit 1;
}

print "File audit passed$stage_text with " . scalar(@warning) . " warning(s).\n";
print_findings("warning", \@warning);
exit($opt{warnings_fail} ? 1 : 0);

sub print_usage {
    print <<'USAGE';
Usage:
  perl scripts/cppgm_file_audit.pl [--stage paN] [--paths dev] [--include-stage-tools] [--no-follow-includes]

Audits C/C++ implementation shape for CPPGM runs. The check is deliberately
heuristic: high-confidence cheating and mechanical split patterns are fatal,
while lower-confidence structure smells are warnings.
USAGE
}

sub expand_path_options {
    my @raw = @_;
    my @out;
    for my $value (@raw) {
        push @out, grep { length $_ } map {
            s/^\s+//;
            s/\s+$//;
            $_;
        } split /,/, $value;
    }
    return @out;
}

sub discover_stage_tool_paths {
    my ($root, $stage) = @_;
    die "--include-stage-tools requires --stage paN\n" if !$stage;
    die "--stage must look like paN when --include-stage-tools is used\n"
        if $stage !~ /\Apa\d+\z/;

    my $makefile = File::Spec->catfile($root, $stage, 'Makefile');
    return () if !-f $makefile;

    my %vars;
    my @assignments;
    open my $fh, '<', $makefile or die "Cannot read $makefile: $!\n";
    while (my $line = <$fh>) {
        chomp $line;
        $line = strip_make_comment($line);
        next if $line !~ /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|\?=|=)\s*(.*?)\s*\z/;
        my ($name, $value) = ($1, $2);
        $vars{$name} = $value;
        push @assignments, [$name, $value];
    }
    close $fh;

    my %tools;
    if (defined $vars{TARGET}) {
        add_stage_tool_names(\%tools, resolve_make_value($vars{TARGET}, \%vars));
    }

    for my $assignment (@assignments) {
        my ($name, $value) = @$assignment;
        my $resolved = resolve_make_value($value, \%vars);
        while ($resolved =~ m{(?:^|[\s"'])\.\./dev/([A-Za-z0-9_+.-]+)(?=$|[\s"'])}g) {
            my $tool = $1;
            next if $tool =~ /-ref\z/;
            add_stage_tool_names(\%tools, $tool);
        }
    }

    my @paths;
    for my $tool (sort keys %tools) {
        next if $tool !~ /\A[A-Za-z0-9_+.-]+\z/;
        my $rel = "dev/$tool.cpp";
        push @paths, $rel if -f File::Spec->catfile($root, $rel);
    }
    return @paths;
}

sub strip_make_comment {
    my ($line) = @_;
    $line =~ s/(?<!\\)#.*\z//;
    return $line;
}

sub resolve_make_value {
    my ($value, $vars) = @_;
    for (1 .. 8) {
        my $changed = 0;
        $value =~ s/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/
            $changed = 1;
            exists $vars->{$1} ? $vars->{$1} : "";
        /gex;
        last if !$changed;
    }
    return $value;
}

sub add_stage_tool_names {
    my ($tools, $text) = @_;
    for my $tool (split /\s+/, $text) {
        next if $tool eq '';
        next if $tool =~ /\$/;
        next if $tool =~ /-ref\z/;
        $tools->{$tool} = 1 if $tool =~ /\A[A-Za-z0-9_+.-]+\z/;
    }
}

sub collect_source_files {
    my ($target, $files) = @_;
    return if !-e $target;
    if (-f $target) {
        push @$files, $target if is_source_file($target);
        return;
    }
    return if !-d $target;

    find({
        wanted => sub {
            my $name = $_;
            if (-d $File::Find::name && skip_dir($name)) {
                $File::Find::prune = 1;
                return;
            }
            push @$files, $File::Find::name if -f $File::Find::name && is_source_file($File::Find::name);
        },
        no_chdir => 1,
    }, $target);
}

sub discover_included_files {
    my ($root, $files, $included_by) = @_;
    my %seen = map { abs_path($_) => 1 } grep { defined abs_path($_) } @$files;

    for (my $index = 0; $index < @$files; ++$index) {
        my $including_file = $files->[$index];
        my $including_abs = abs_path($including_file) // next;
        my $including_rel = relative_path($including_abs, $root);
        my $text = read_text($including_abs);
        my $including_dir = file_dir($including_abs);

        for my $include (find_include_records($text)) {
            next if $include->{delimiter} ne '"';
            my $target_abs = abs_path(File::Spec->rel2abs($include->{target}, $including_dir));
            next if !$target_abs || !-f $target_abs;
            my $target_rel = relative_path($target_abs, $root);
            push @{$included_by->{$target_rel}}, {
                from => $including_rel,
                line => $include->{line},
                after_code => $include->{after_code},
                target => $include->{target},
            };
            if (!$seen{$target_abs}) {
                $seen{$target_abs} = 1;
                push @$files, $target_abs;
            }
        }
    }
}

sub skip_dir {
    my ($name) = @_;
    return $name =~ /^(?:\.git|obj|build|dist|node_modules)$/;
}

sub is_source_file {
    my ($path) = @_;
    return $path =~ /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/;
}

sub is_exempt_file {
    my ($rel) = @_;
    return $rel =~ m{^dev/src/test_runner\.cpp$} ||
        $rel =~ m{^dev/src/tool_help_text\.h$};
}

sub is_top_level_dev_tool {
    my ($rel) = @_;
    return $rel =~ m{^dev/[^/]+\.(?:c|cc|cpp|cxx)$};
}

sub read_text {
    my ($file) = @_;
    open my $fh, '<', $file or die "Cannot read $file: $!\n";
    local $/;
    return <$fh>;
}

sub file_dir {
    my ($file) = @_;
    my ($volume, $directory) = File::Spec->splitpath($file);
    return File::Spec->catpath($volume, $directory, '');
}

sub relative_path {
    my ($file, $base) = @_;
    return File::Spec->abs2rel($file, $base);
}

sub count_lines {
    my ($text) = @_;
    return 0 if $text eq '';
    my $count = ($text =~ tr/\n/\n/);
    return $text =~ /\n\z/ ? $count : $count + 1;
}

sub add_finding {
    my ($out, $category, $path, $line, $message) = @_;
    push @$out, {
        category => $category,
        path => $path,
        line => $line,
        message => $message,
    };
}

sub check_file_size {
    my ($rel, $line_count, $fatal) = @_;
    my $limit = $opt{max_source_lines};
    if ($rel =~ /\.(?:h|hh|hpp|hxx)$/) {
        $limit = $opt{max_header_lines};
    }
    if ($rel =~ /(?:^|\/)[^\/]*internal[^\/]*\.(?:h|hh|hpp|hxx)$/) {
        $limit = $opt{max_internal_header_lines};
    }
    if ($line_count > $limit) {
        add_finding($fatal, 'size', $rel, 1, "$line_count lines exceeds limit $limit");
    }
}

sub check_file_name {
    my ($rel, $line_count, $fatal, $warning) = @_;
    my ($base) = $rel =~ /([^\/]+)$/;
    if ($base =~ /(?:^|[_-])(?:part|chunk|split|piece)[_-]?\d+(?:[_-]|\.)/i ||
        $base =~ /(?:^|[_-])\d{1,2}\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i) {
        add_finding($fatal, 'bad-division', $rel, 1,
            "filename looks like a mechanical split rather than a cohesive module");
    }
    if ($base =~ /(?:^|[_-])(?:misc|helpers?|utils?|common|junk|scratch|tmp|hack|workaround)(?:[_-]|\.)/i &&
        $line_count > 250) {
        add_finding($warning, 'bad-division', $rel, 1,
            "large catch-all helper file; consider a responsibility-named module");
    }
}

sub check_includes {
    my ($rel, $text, $included_by, $fatal, $warning) = @_;
    my @include_sites = @{$included_by->{$rel} // []};
    my @inline_sites = grep { $_->{after_code} } @include_sites;
    if (@inline_sites) {
        my $first = $inline_sites[0];
        add_finding($fatal, 'bad-division', $rel, 1,
            "included as an implementation fragment from $first->{from}:$first->{line}; refactor the owned code into self-contained modules under the file/function limits instead of splitting implementation with inline includes");
    }
    if (!@inline_sites && @include_sites && !has_header_preamble($text) && contains_function_definition($text)) {
        my $first = $include_sites[0];
        add_finding($fatal, 'bad-division', $rel, 1,
            "included file contains implementation bodies but is not a guarded header; refactor ownership into cohesive modules rather than sharing implementation by include");
    }

    for my $include (find_include_records($text)) {
        if ($include->{after_code}) {
            add_finding($fatal, 'bad-division', $rel, $include->{line},
                "inline include appears after code; remove the include-as-code-split pattern and refactor the affected responsibilities into self-contained modules under the audit limits");
        }
        if ($include->{delimiter} eq '"' && $include->{target} =~ /\.(?:c|cc|cpp|cxx)$/) {
            add_finding($fatal, 'bad-division', $rel, $include->{line},
                "source file includes another source file");
        }
    }
}

sub find_include_records {
    my ($text) = @_;
    my @lines = split /\n/, $text;
    my @code_lines = split /\n/, mask_comments($text);
    my @records;
    my $saw_real_code = 0;

    for my $i (0 .. $#lines) {
        my $line = $lines[$i];
        if ($line =~ /^\s*#\s*include\s+([<"])([^>"]+)[>"]/) {
            push @records, {
                line => $i + 1,
                delimiter => $1,
                target => $2,
                after_code => $saw_real_code,
            };
            next;
        }
        if (line_is_real_code($code_lines[$i] // '')) {
            $saw_real_code = 1;
        }
    }

    return @records;
}

sub has_header_preamble {
    my ($text) = @_;
    return $text =~ /^\s*#\s*pragma\s+once\b/m ||
        ($text =~ /^\s*#\s*ifndef\s+\w+/m && $text =~ /^\s*#\s*define\s+\w+/m);
}

sub contains_function_definition {
    my ($text) = @_;
    my @defs = find_function_definitions($text);
    return scalar(@defs) > 0;
}

sub find_function_definitions {
    my ($text) = @_;
    my @lines = split /\n/, mask_comments_and_strings($text);
    my @signature;
    my @definitions;
    my $in_function = 0;
    my $function_start = 0;
    my $function_name = '';
    my $brace_depth = 0;

    for my $i (0 .. $#lines) {
        my $line = $lines[$i];
        if (!$in_function) {
            push @signature, $line if $line =~ /\S/;
            shift @signature while @signature > 8;
            my $open_pos = index($line, '{');
            next if $open_pos < 0;
            my $prefix = join(' ', @signature);
            $prefix =~ s/\{.*\z//;
            my $name = function_name_from_signature($prefix);
            next if !$name;

            $in_function = 1;
            $function_start = $i + 1;
            $function_name = $name;
            $brace_depth = count_char(substr($line, $open_pos), '{') -
                count_char(substr($line, $open_pos), '}');
            if ($brace_depth <= 0) {
                push @definitions, { name => $function_name, line => $function_start };
                $in_function = 0;
                @signature = ();
            }
            next;
        }

        $brace_depth += count_char($line, '{') - count_char($line, '}');
        if ($brace_depth <= 0) {
            push @definitions, { name => $function_name, line => $function_start };
            $in_function = 0;
            @signature = ();
        }
    }

    return @definitions;
}

sub line_is_real_code {
    my ($line) = @_;
    $line =~ s/^\s+|\s+$//g;
    return 0 if $line eq '';
    return 0 if $line =~ /^#/;
    return 0 if $line =~ /^using\s+namespace\s+[A-Za-z_][A-Za-z0-9_:]*\s*;\s*$/;
    return 0 if $line =~ /^using\s+[A-Za-z_][A-Za-z0-9_:]*\s*;\s*$/;
    return 0 if $line =~ /^(?:public|protected|private)\s*:\s*$/;
    return 1;
}

sub check_shortcut_smells {
    my ($rel, $text, $fatal, $warning) = @_;
    my @lines = split /\n/, $text;
    my @code_lines = split /\n/, mask_comments_and_strings($text);
    my @uncommented_lines = split /\n/, mask_comments($text);
    for my $i (0 .. $#lines) {
        my $line = $lines[$i];
        my $code_line = $code_lines[$i] // '';
        my $uncommented_line = $uncommented_lines[$i] // '';
        next if $line =~ m{^\s*(?://|\*)};
        if ($line =~ /cppgm\.tests|course\/pa\d+|pa\d+\/tests|\/tests\/[^"']+\.t\b|\b\d{3}-[A-Za-z0-9_.-]+\.t\b/) {
            add_finding($fatal, 'shortcut-risk', $rel, $i + 1,
                "source references test-suite paths or concrete test names; fix by implementing the general assignment semantics and using tests only through the test runner, not by branching on fixture names or reading fixture files");
        }
        if (my $api = process_execution_api_from_line($code_line)) {
            add_finding($fatal, 'shortcut-risk', $rel, $i + 1,
                "compiler implementation calls process API '$api'; fix by moving the behavior into in-process compiler/runtime code or a normal linked library, not by shelling out, spawning helpers, or execing another tool");
        }
        if (my $marker = emitted_script_marker_from_line($uncommented_line)) {
            add_finding($fatal, 'shortcut-risk', $rel, $i + 1,
                "compiler appears to emit or embed script/interpreter trampoline '$marker'; fix by generating the assignment-required artifact directly and moving shared behavior into cohesive compiled modules instead of writing a script that dispatches to an interpreter or helper program");
        }
        if ($uncommented_line =~ /\b(?:import|from)\s+(?:ctypes|mmap|subprocess|os|sys)\b/) {
            add_finding($fatal, 'shortcut-risk', $rel, $i + 1,
                "compiler embeds a dynamic-language runtime/import block; fix by representing the semantics in typed compiler data and generated target code, not by packaging a Python/JS/shell runtime inside compiler output");
        }
        if ($code_line =~ /\bgetenv\s*\(/) {
            add_finding($fatal, 'shortcut-risk', $rel, $i + 1,
                "compiler implementation depends on environment variables; fix by passing required configuration through explicit compiler options or normal source/program inputs, not hidden process environment state");
        }
        if ($line =~ /\bEXIT_NOT_IMPLEMENTED\b/ && !is_top_level_dev_tool($rel)) {
            add_finding($fatal, 'shortcut-risk', $rel, $i + 1,
                "implementation still exposes EXIT_NOT_IMPLEMENTED; fix by completing the owning implementation path or returning a real diagnostic for invalid user input, not by leaving assignment functionality stubbed");
        }
        if ($line =~ /\b(?:hack|cheat|test[-_ ]specific|hardcod(?:e|ed)|workaround)\b/i) {
            add_finding($warning, 'shortcut-risk', $rel, $i + 1,
                "comment or identifier suggests a shortcut; review the code and either replace it with a general semantic implementation or rename it only after the shortcut has actually been removed");
        }
        if ($code_line =~ /\b(?:ifstream|fopen|open)\s*\([^;\n]*(?:expected|golden|reference|cppgm\.tests|\/tests\/)/) {
            add_finding($fatal, 'shortcut-risk', $rel, $i + 1,
                "implementation appears to read expected/reference test data; fix by computing the result from source semantics and remove all runtime dependency on expected, golden, reference, or test fixture files");
        }
    }

    for my $i (0 .. $#lines) {
        my $line = $lines[$i];
        if ($line =~ /R?"(?:\\.|[^"\\]){500,}"/) {
            add_finding($warning, 'shortcut-risk', $rel, $i + 1,
                "very large string literal; if it is executable/runtime logic, split it into typed compiler code or generated target code, and if it is fixture data, remove it entirely");
        }
    }
}

sub process_execution_api_from_line {
    my ($line) = @_;
    my $api_re = qr/(?:std::)?system|popen|fork|vfork|execl|execle|execlp|execv|execve|execvp|execvpe|posix_spawn|posix_spawnp/;
    return $1 if $line =~ /(?:^|[^A-Za-z0-9_:])($api_re)\s*\(/;
    return undef;
}

sub emitted_script_marker_from_line {
    my ($line) = @_;
    return '#!' if $line =~ /#!/;
    return '/usr/bin/env' if $line =~ m{/usr/bin/env};
    return 'python interpreter' if $line =~ m{/(?:usr/)?bin/python3?\b} || $line =~ /["'`]\s*python3?\b/;
    return 'shell interpreter' if $line =~ m{/(?:usr/)?bin/(?:ba)?sh\b} || $line =~ /["'`]\s*(?:bash|sh)\b/;
    return 'node interpreter' if $line =~ m{/(?:usr/)?bin/node\b} || $line =~ /["'`]\s*node\b/;
    return 'perl interpreter' if $line =~ m{/(?:usr/)?bin/perl\b} || $line =~ /["'`]\s*perl\b/;
    return 'exec trampoline' if $line =~ /(?:^|["'`])\s*exec\s+(?:["'`\\\/\$]|[A-Za-z_.-])/;
    return undef;
}

sub check_functions {
    my ($rel, $text, $fatal, $warning) = @_;
    my @lines = split /\n/, mask_comments_and_strings($text);
    my @raw_lines = split /\n/, $text;
    my @signature;
    my $in_function = 0;
    my $function_start = 0;
    my $function_name = '';
    my $brace_depth = 0;
    my $max_relative_depth = 0;

    for my $i (0 .. $#lines) {
        my $line = $lines[$i];
        if (!$in_function) {
            push @signature, $line if $line =~ /\S/;
            shift @signature while @signature > 8;
            my $open_pos = index($line, '{');
            next if $open_pos < 0;
            my $prefix = join(' ', @signature);
            $prefix =~ s/\{.*\z//;
            my $name = function_name_from_signature($prefix);
            next if !$name;

            $in_function = 1;
            $function_start = $i + 1;
            $function_name = $name;
            $brace_depth = count_char(substr($line, $open_pos), '{') -
                count_char(substr($line, $open_pos), '}');
            $max_relative_depth = $brace_depth;
            if ($brace_depth <= 0) {
                report_function_shape($rel, $function_name, $function_start, $i + 1,
                    $max_relative_depth, $fatal, $warning);
                $in_function = 0;
                @signature = ();
            }
            next;
        }

        $brace_depth += count_char($line, '{') - count_char($line, '}');
        $max_relative_depth = $brace_depth if $brace_depth > $max_relative_depth;
        if ($brace_depth <= 0) {
            report_function_shape($rel, $function_name, $function_start, $i + 1,
                $max_relative_depth, $fatal, $warning);
            $in_function = 0;
            @signature = ();
        }
    }
}

sub function_name_from_signature {
    my ($signature) = @_;
    $signature =~ s/\s+/ /g;
    $signature =~ s/^\s+|\s+$//g;
    return undef if $signature !~ /\)/;
    return undef if $signature =~ /;/;
    return undef if $signature =~ /\b(?:if|for|while|switch|catch|sizeof|alignof)\s*\(/;
    return undef if $signature =~ /\b(?:class|struct|enum|namespace|union)\b/;
    return undef if $signature =~ /^\s*(?:else|do)\b/;
    return undef if $signature =~ /=\s*$/;
    return undef if $signature =~ /\[\s*\]\s*\(/;

    if ($signature =~ /([A-Za-z_~][A-Za-z0-9_:~]*)\s*\([^;{}]*\)\s*(?:const|noexcept|override|final|\s|->|[A-Za-z0-9_:<>,*&])*\z/) {
        return $1;
    }
    return undef;
}

sub report_function_shape {
    my ($rel, $name, $start, $end, $max_depth, $fatal, $warning) = @_;
    my $length = $end - $start + 1;
    if ($length > $opt{max_function_lines}) {
        add_finding($fatal, 'function-size', $rel, $start,
            "$name is $length lines; limit is $opt{max_function_lines}");
    }
    my $nesting = $max_depth - 1;
    if ($nesting > $opt{max_nesting}) {
        add_finding($fatal, 'complexity', $rel, $start,
            "$name nesting depth is $nesting; limit is $opt{max_nesting}");
    } elsif ($nesting > $opt{warn_nesting}) {
        add_finding($warning, 'complexity', $rel, $start,
            "$name nesting depth is $nesting; consider simplifying control flow");
    }
}

sub check_header_body_weight {
    my ($rel, $text, $fatal, $warning) = @_;
    return if $rel !~ /\.(?:h|hh|hpp|hxx)$/;
    my @lines = split /\n/, mask_comments_and_strings($text);
    my $body_lines = 0;
    for my $line (@lines) {
        $body_lines++ if $line =~ /[{};]/ && $line !~ /^\s*(?:class|struct|enum|namespace|typedef|using|#)/;
    }
    if ($body_lines > 180) {
        add_finding($warning, 'bad-division', $rel, 1,
            "header contains substantial implementation body; prefer .cpp ownership");
    }
}

sub check_stem_groups {
    my ($groups, $warning) = @_;
    for my $stem (sort keys %$groups) {
        my @group = @{$groups->{$stem}};
        next if @group < 7;
        add_finding($warning, 'bad-division', $group[0], 1,
            "many files share stem '$stem': " . join(', ', @group) .
            "; verify this is cohesive layering rather than scattering one module");
    }
}

sub check_duplicate_blocks {
    my ($source_by_file, $warning) = @_;
    my %seen;
    for my $rel (sort keys %$source_by_file) {
        my @logical = normalized_logical_lines($source_by_file->{$rel});
        next if @logical < $opt{duplicate_window};
        for (my $i = 0; $i + $opt{duplicate_window} <= @logical; ++$i) {
            my @slice = @logical[$i .. $i + $opt{duplicate_window} - 1];
            my $key = join("\n", map { $_->{text} } @slice);
            next if length($key) < $opt{duplicate_min_chars};
            if (my $first = $seen{$key}) {
                next if $first->{path} eq $rel && abs($first->{line} - $slice[0]{line}) < $opt{duplicate_window};
                add_finding($warning, 'duplication', $rel, $slice[0]{line},
                    "large duplicate block also appears at $first->{path}:$first->{line}");
                last;
            }
            $seen{$key} = { path => $rel, line => $slice[0]{line} };
        }
    }
}

sub normalized_logical_lines {
    my ($text) = @_;
    my @lines = split /\n/, mask_comments_and_strings($text);
    my @out;
    for my $i (0 .. $#lines) {
        my $line = $lines[$i];
        $line =~ s/\s+//g;
        next if length($line) < 8;
        next if $line =~ /^[{};]+$/;
        next if $line =~ /^(?:break|continue|return|else);?$/;
        push @out, { text => $line, line => $i + 1 };
    }
    return @out;
}

sub division_stem {
    my ($rel) = @_;
    my ($base) = $rel =~ /([^\/]+)$/;
    $base =~ s/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|def|defs|inc|ipp|inl)\z//;
    $base =~ s/(?:[_-](?:part|chunk|split|piece)?\d+)\z//i;
    $base =~ s/(?:[_-](?:impl|internal|core|model|parser|emit|expr|decl|stmt|ops|primary|function|types|class|lifecycle|convert|aggregate|validate|frontend|backend|helpers?|utils?))\z//i;
    return $base;
}

sub mask_comments {
    my ($text) = @_;
    return mask_text($text, 1, 0);
}

sub mask_comments_and_strings {
    my ($text) = @_;
    return mask_text($text, 1, 1);
}

sub mask_text {
    my ($text, $mask_comments, $mask_strings) = @_;
    my @chars = split //, $text;
    my $out = '';
    my $state = 'normal';
    for (my $i = 0; $i < @chars; ++$i) {
        my $ch = $chars[$i];
        my $next = $i + 1 < @chars ? $chars[$i + 1] : '';
        if ($state eq 'line_comment') {
            if ($ch eq "\n") {
                $state = 'normal';
                $out .= "\n";
            } else {
                $out .= ' ';
            }
            next;
        }
        if ($state eq 'block_comment') {
            if ($ch eq '*' && $next eq '/') {
                $out .= '  ';
                ++$i;
                $state = 'normal';
            } else {
                $out .= $ch eq "\n" ? "\n" : ' ';
            }
            next;
        }
        if ($state eq 'string') {
            if ($ch eq '\\') {
                $out .= ' ';
                if ($i + 1 < @chars) {
                    $out .= $chars[$i + 1] eq "\n" ? "\n" : ' ';
                    ++$i;
                }
                next;
            }
            $state = 'normal' if $ch eq '"';
            $out .= $ch eq "\n" ? "\n" : ' ';
            next;
        }
        if ($state eq 'char') {
            if ($ch eq '\\') {
                $out .= ' ';
                if ($i + 1 < @chars) {
                    $out .= $chars[$i + 1] eq "\n" ? "\n" : ' ';
                    ++$i;
                }
                next;
            }
            $state = 'normal' if $ch eq "'";
            $out .= $ch eq "\n" ? "\n" : ' ';
            next;
        }

        if ($mask_comments && $ch eq '/' && $next eq '/') {
            $out .= '  ';
            ++$i;
            $state = 'line_comment';
            next;
        }
        if ($mask_comments && $ch eq '/' && $next eq '*') {
            $out .= '  ';
            ++$i;
            $state = 'block_comment';
            next;
        }
        if ($mask_strings && $ch eq '"') {
            $out .= ' ';
            $state = 'string';
            next;
        }
        if ($mask_strings && $ch eq "'") {
            $out .= ' ';
            $state = 'char';
            next;
        }
        $out .= $ch;
    }
    return $out;
}

sub count_char {
    my ($text, $char) = @_;
    return () = $text =~ /\Q$char\E/g;
}

sub print_findings {
    my ($label, $findings) = @_;
    for my $finding (@$findings) {
        my $location = $finding->{path};
        $location .= ":$finding->{line}" if $finding->{line};
        print "  [$label][$finding->{category}] $location: $finding->{message}\n";
    }
}
