namespace WorldBuilder.Terminal;

/// <summary>
/// Parsed command-line arguments for WorldBuilder.Terminal.
/// Supports quoted paths (e.g. --project "C:\My Projects\demo.wbproj").
/// </summary>
public class CommandLineArgs {
    public string? ProjectPath { get; set; }
    public string? ExportDirectory { get; set; }
    public int? Iteration { get; set; }
    public bool ShowHelp { get; set; }
    public bool ShowVersion { get; set; }

    /// <summary>
    /// When true, reads JSON commands from stdin and writes JSON responses to stdout.
    /// Enables agent ↔ terminal piped communication.
    /// </summary>
    public bool StdinMode { get; set; }

    /// <summary>
    /// Non-fatal warnings collected during argument parsing.
    /// The caller should print these to stderr after parsing.
    /// </summary>
    public List<string> Warnings { get; } = new();

    /// <summary>
    /// True when enough arguments are present to run a full batch export
    /// without entering the interactive REPL.
    /// </summary>
    public bool IsBatchMode => !string.IsNullOrEmpty(ProjectPath) && !string.IsNullOrEmpty(ExportDirectory);

    /// <summary>
    /// Parses raw command-line tokens into a <see cref="CommandLineArgs"/> instance.
    /// Handles quoted strings so that paths with spaces work correctly.
    /// </summary>
    public static CommandLineArgs Parse(string[] args) {
        var result = new CommandLineArgs();

        for (int i = 0; i < args.Length; i++) {
            var arg = args[i];

            switch (arg.ToLowerInvariant()) {
                case "--project":
                case "-p":
                    if (i + 1 < args.Length && !LooksLikeFlag(args[i + 1])) {
                        result.ProjectPath = UnquotePath(args[++i]);
                    } else {
                        result.Warnings.Add("Warning: Missing value for --project/-p. Ignored.");
                    }
                    break;

                case "--export":
                case "-e":
                    if (i + 1 < args.Length && !LooksLikeFlag(args[i + 1])) {
                        result.ExportDirectory = UnquotePath(args[++i]);
                    } else {
                        result.Warnings.Add("Warning: Missing value for --export/-e. Ignored.");
                    }
                    break;

                case "--iteration":
                case "-i":
                    if (i + 1 < args.Length && !LooksLikeFlag(args[i + 1])) {
                        var iterStr = args[++i];
                        if (int.TryParse(iterStr, out var iter)) {
                            result.Iteration = iter;
                        } else {
                            result.Warnings.Add($"Warning: Invalid iteration value '{iterStr}' — expected an integer. Ignored.");
                        }
                    } else {
                        result.Warnings.Add("Warning: Missing value for --iteration/-i. Ignored.");
                    }
                    break;

                case "--stdin":
                    result.StdinMode = true;
                    break;

                case "--help":
                case "-h":
                    result.ShowHelp = true;
                    break;

                case "--version":
                case "-v":
                    result.ShowVersion = true;
                    break;

                default:
                    if (arg.StartsWith('-')) {
                        result.Warnings.Add($"Warning: Unknown flag '{arg}' — ignored. Use --help for usage.");
                    }
                    break;
            }
        }

        return result;
    }

    /// <summary>
    /// Strips surrounding double-quotes from a path if present.
    /// </summary>
    private static string UnquotePath(string value) {
        if (value.Length >= 2 && value[0] == '"' && value[^1] == '"') {
            return value[1..^1];
        }
        return value;
    }

    private static bool LooksLikeFlag(string value) {
        if (string.IsNullOrEmpty(value)) return false;
        if (!value.StartsWith('-')) return false;
        return value.Length == 1 || !char.IsDigit(value[1]);
    }

    public static void PrintUsage() {
        Console.WriteLine();
        Console.WriteLine("WorldBuilder.Terminal — Headless DAT export tool");
        Console.WriteLine();
        Console.WriteLine("USAGE:");
        Console.WriteLine("  WorldBuilder.Terminal [options]");
        Console.WriteLine();
        Console.WriteLine("OPTIONS:");
        Console.WriteLine("  --project, -p <path>      Path to a .wbproj project file");
        Console.WriteLine("  --export,  -e <path>      Directory to export DAT files into");
        Console.WriteLine("  --iteration, -i <number>  Portal iteration number (default: current + 1)");
        Console.WriteLine("  --stdin                   JSON-line stdin/stdout mode (for agents)");
        Console.WriteLine("  --version, -v             Show version information");
        Console.WriteLine("  --help, -h                Show this help message");
        Console.WriteLine();
        Console.WriteLine("MODES:");
        Console.WriteLine("  Batch:       Provide --project AND --export to export and exit.");
        Console.WriteLine("  Interactive: Provide no flags (or only --project) to enter the REPL.");
        Console.WriteLine("  Stdin/JSON:  Use --stdin to pipe JSON commands from an agent process.");
        Console.WriteLine();
        Console.WriteLine("AGENT PROTOCOL (--stdin):");
        Console.WriteLine("  Input:  One JSON object per line on stdin");
        Console.WriteLine("          {\"command\":\"load\",\"path\":\"C:\\\\project.wbproj\"}");
        Console.WriteLine("  Output: One JSON response per line on stdout");
        Console.WriteLine("          {\"success\":true,\"command\":\"load\",\"projectName\":\"My World\"}");
        Console.WriteLine();
        Console.WriteLine("EXAMPLES:");
        Console.WriteLine("  WorldBuilder.Terminal");
        Console.WriteLine("  WorldBuilder.Terminal --project \"C:\\\\Projects\\\\demo.wbproj\"");
        Console.WriteLine("  WorldBuilder.Terminal -p demo.wbproj -e \"C:\\\\Output\" -i 5");
        Console.WriteLine("  echo '{\"command\":\"info\"}' | WorldBuilder.Terminal --stdin -p demo.wbproj");
    }
}
