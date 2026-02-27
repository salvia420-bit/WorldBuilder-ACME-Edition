using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using WorldBuilder.Lib;
using WorldBuilder.Lib.Extensions;
using WorldBuilder.Lib.Settings;
using WorldBuilder.Shared.Models;

namespace WorldBuilder.Terminal;

class Program {
    static async Task Main(string[] args) {
        Console.WriteLine("ACME WorldBuilder Headless Terminal");
        Console.WriteLine("-----------------------------------");

        var services = new ServiceCollection();
        services.AddCommonServices();
        services.AddLogging(builder => builder.AddConsole());
        var serviceProvider = services.BuildServiceProvider();

        var projectManager = serviceProvider.GetRequiredService<ProjectManager>();

        if (args.Length > 0) {
            await HandleArgs(args, projectManager);
            return;
        }

        bool running = true;
        while (running) {
            Console.Write("> ");
            var input = Console.ReadLine();
            if (string.IsNullOrWhiteSpace(input)) continue;

            var parts = SplitArguments(input);
            if (parts.Length == 0) continue;
            var command = parts[0].ToLower();

            try {
                switch (command) {
                    case "load":
                        if (parts.Length < 2) {
                            Console.WriteLine("Usage: load <project_path>");
                        } else {
                            var path = parts[1];
                            if (!File.Exists(path)) {
                                Console.WriteLine($"Error: File not found: {path}");
                                break;
                            }
                            Console.WriteLine($"Loading project: {path}...");
                            await projectManager.LoadProjectAsync(path);
                            Console.WriteLine($"Project loaded: {projectManager.CurrentProject?.Name}");
                        }
                        break;
                    case "export":
                        if (projectManager.CurrentProject == null) {
                            Console.WriteLine("No project loaded. Use 'load <path>' first.");
                        } else if (parts.Length < 3) {
                            Console.WriteLine("Usage: export <output_directory> <iteration>");
                        } else {
                            var outDir = parts[1];
                            if (int.TryParse(parts[2], out var iteration)) {
                                Console.WriteLine($"Exporting to {outDir} (iteration {iteration})...");
                                // Export can be slow, run it in task
                                var success = await Task.Run(() => projectManager.CurrentProject.ExportDats(outDir, iteration));
                                if (success) {
                                    Console.WriteLine("Export complete.");
                                } else {
                                    Console.WriteLine("Export failed.");
                                }
                            } else {
                                Console.WriteLine("Invalid iteration number.");
                            }
                        }
                        break;
                    case "info":
                        if (projectManager.CurrentProject == null) {
                            Console.WriteLine("No project loaded.");
                        } else {
                            var p = projectManager.CurrentProject;
                            Console.WriteLine($"Project Name: {p.Name}");
                            Console.WriteLine($"File Path:    {p.FilePath}");
                            Console.WriteLine($"Base DATs:    {p.BaseDatDirectory}");
                            Console.WriteLine($"Database:     {p.DatabasePath}");
                        }
                        break;
                    case "exit":
                    case "quit":
                        running = false;
                        break;
                    case "help":
                    case "?":
                        PrintHelp();
                        break;
                    default:
                        Console.WriteLine($"Unknown command: {command}. Type 'help' for commands.");
                        break;
                }
            } catch (Exception ex) {
                Console.WriteLine($"Error: {ex.Message}");
                if (ex.InnerException != null) {
                    Console.WriteLine($"Inner Error: {ex.InnerException.Message}");
                }
            }
        }
    }

    private static string[] SplitArguments(string input) {
        return Regex.Matches(input, @"[\""].+?[\""]|[^ ]+")
            .Select(m => m.Value.Trim('\"'))
            .ToArray();
    }

    private static void PrintHelp() {
        Console.WriteLine("Available commands:");
        Console.WriteLine("  load <path>              - Load a .wbproj project");
        Console.WriteLine("  export <dir> <iteration> - Export DATs to directory");
        Console.WriteLine("  info                     - Show current project info");
        Console.WriteLine("  help                     - Show this help");
        Console.WriteLine("  exit                     - Exit the terminal");
    }

    private static async Task HandleArgs(string[] args, ProjectManager projectManager) {
        // Basic argument parsing for automation
        // Example: --project "path" --export "outdir" --iteration 1
        string? projectPath = null;
        string? exportDir = null;
        int iteration = 0;

        for (int i = 0; i < args.Length; i++) {
            if (args[i] == "--project" && i + 1 < args.Length) projectPath = args[++i];
            else if (args[i] == "--export" && i + 1 < args.Length) exportDir = args[++i];
            else if (args[i] == "--iteration" && i + 1 < args.Length) int.TryParse(args[++i], out iteration);
        }

        if (projectPath != null) {
            await projectManager.LoadProjectAsync(projectPath);
            if (projectManager.CurrentProject != null) {
                Console.WriteLine($"Loaded project: {projectManager.CurrentProject.Name}");
                if (exportDir != null) {
                    Console.WriteLine($"Exporting to {exportDir}...");
                    var success = projectManager.CurrentProject.ExportDats(exportDir, iteration);
                    if (success) {
                        Console.WriteLine("Export complete.");
                    } else {
                        Console.WriteLine("Export failed.");
                    }
                }
            } else {
                Console.WriteLine("Failed to load project.");
            }
        } else {
            Console.WriteLine("No project specified. Use --project <path>");
        }
    }
}
