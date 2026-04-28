using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using WorldBuilder.Terminal;
using WorldBuilder.Shared.Lib.Extensions;
using WorldBuilder.Shared.Services;

// ──────────────────────────────────────────────────────
//  WorldBuilder.Terminal — Entry Point
// ──────────────────────────────────────────────────────
//  Batch mode:  WorldBuilder.Terminal --project X --export Y [--iteration N]
//  Interactive: WorldBuilder.Terminal [--project X]
//  Agent mode:  WorldBuilder.Terminal --stdin [--project X]
// ──────────────────────────────────────────────────────

var cliArgs = CommandLineArgs.Parse(args);

// Surface any argument-parsing warnings (e.g. unknown flags, bad iteration)
foreach (var warning in cliArgs.Warnings) {
    Console.Error.WriteLine(warning);
}

if (cliArgs.ShowHelp) {
    CommandLineArgs.PrintUsage();
    return 0;
}

if (cliArgs.ShowVersion) {
    var version = typeof(CommandLineArgs).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
    Console.WriteLine($"WorldBuilder.Terminal v{version}");
    return 0;
}

// ── Batch mode ──────────────────────────────────────
if (cliArgs.IsBatchMode && !cliArgs.StdinMode) {
    // Batch export only needs logging + project manager, so avoid constructing
    // the full WorldBuilder service graph for faster startup.
    var batchServices = new ServiceCollection();
    batchServices.AddLogging(c => {
        c.AddConsole();
        c.SetMinimumLevel(LogLevel.Information);
    });
    using var batchProvider = batchServices.BuildServiceProvider();
    var batchLoggerFactory = batchProvider.GetRequiredService<ILoggerFactory>();
    using var batchProjectManager = new HeadlessProjectManager(batchLoggerFactory);

    try {
        Console.WriteLine($"[Batch] Loading project: {cliArgs.ProjectPath}");
        batchProjectManager.LoadProject(cliArgs.ProjectPath!);

        Console.WriteLine($"[Batch] Exporting to: {cliArgs.ExportDirectory}");
        var success = batchProjectManager.ExportDats(cliArgs.ExportDirectory!, cliArgs.Iteration);

        return success ? 0 : 1;
    } catch (Exception ex) {
        Console.Error.WriteLine($"[Batch] Fatal error: {ex.Message}");
        return 1;
    }
}

// Set up the full WorldBuilder services for interactive/stdin modes.
// In stdin mode, suppress console logging to keep stdout clean for JSON.
var services = new ServiceCollection();
services.AddLogging(c => {
    if (!cliArgs.StdinMode) {
        c.AddConsole();
    }
    c.SetMinimumLevel(cliArgs.StdinMode ? LogLevel.Warning : LogLevel.Information);
});
services.AddWorldBuilder();  // Register ITerrainService, IObjectPlacementService, etc.
using var provider = services.BuildServiceProvider();

var loggerFactory = provider.GetRequiredService<ILoggerFactory>();
var terrainService = provider.GetRequiredService<ITerrainService>();
var objectPlacementService = provider.GetRequiredService<IObjectPlacementService>();
var dungeonService = provider.GetRequiredService<IDungeonService>();
var ontologyService = provider.GetRequiredService<IOntologyService>();
var stampService = provider.GetRequiredService<IStampService>();
using var projectManager = new HeadlessProjectManager(loggerFactory);

// ── Stdin/JSON mode (agent protocol) ────────────────
if (cliArgs.StdinMode) {
    // When stdout is redirected (e.g. by Process.Start in a test harness),
    // the default Console.Out uses block buffering.  Switch to auto-flush
    // so that every Console.WriteLine is immediately visible to the reader.
    var stdoutWriter = new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true };
    Console.SetOut(stdoutWriter);

    // Pre-load project if specified
    if (!string.IsNullOrEmpty(cliArgs.ProjectPath)) {
        try {
            projectManager.LoadProject(cliArgs.ProjectPath);
        } catch (Exception ex) {
            // In stdin mode, report errors as JSON
            var errorJson = System.Text.Json.JsonSerializer.Serialize(new {
                success = false,
                command = "startup",
                error = $"Could not pre-load project: {ex.Message}"
            });
            Console.WriteLine(errorJson);
        }
    }

    var processor = new JsonCommandProcessor(projectManager, terrainService, objectPlacementService, dungeonService, ontologyService, stampService,
        cliArgs.TransactDiffRetention, cliArgs.TransactDiffMemCapMb);
    processor.RunStdinLoop();
    return 0;
}

// ── Interactive mode ────────────────────────────────
// If --project was provided but not --export, pre-load the project
if (!string.IsNullOrEmpty(cliArgs.ProjectPath)) {
    try {
        Console.WriteLine($"Pre-loading project: {cliArgs.ProjectPath}");
        projectManager.LoadProject(cliArgs.ProjectPath);
    } catch (Exception ex) {
        Console.Error.WriteLine($"Warning: Could not pre-load project: {ex.Message}");
    }
}

var repl = new TerminalRepl(projectManager, terrainService, objectPlacementService, dungeonService, ontologyService, stampService,
    cliArgs.TransactDiffRetention, cliArgs.TransactDiffMemCapMb);
repl.Run();

return 0;
