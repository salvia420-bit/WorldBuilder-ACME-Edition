using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AcmeInject {
    /// <summary>
    /// Base-aware Chorizite injector. See AcmeInject.csproj for the why. In one line: it launches
    /// acclient suspended, remote-LoadLibraryW's Chorizite.Injector.dll, reads the injector's REMOTE
    /// base from the load thread's exit code, calls the injector's Bootstrap export at
    /// (remoteBase + BootstrapRVA), then resumes the client. This removes the same-base assumption
    /// that faulted the prebuilt injector under wine.
    /// </summary>
    internal static unsafe class Program {
        // ---- config (overridable; defaults match the proven wine/1070 setup) ----
        // Order of resolution per key: CLI arg -> env -> inject.cfg -> default.
        private const string DefClient = @"D:\ac-dat-test\acclient.exe";
        private const string DefArgs = "-h 100.116.47.66 -p 9000 -a tailnet1 -v tailnet1 -rodat off";
        private const string DefInjector = @"Chorizite.Injector.dll"; // resolved against CWD (the Chorizite dir)
        private static readonly string[] CfgPaths = {
            @"C:\Temp\acdt\inject.cfg",
        };

        private static int Main(string[] argv) {
            try {
                // --list: enumerate running clients and their inject state. Needs no injector, so
                // handle it before any injector resolution. This is the GUI's discovery backbone.
                if (HasFlag(argv, "--list")) {
                    return ListClients();
                }

                var cfg = LoadCfg();
                string client = Arg(argv, "--client") ?? Env("ACMEINJECT_CLIENT") ?? cfg.Get("client") ?? DefClient;
                string args = Arg(argv, "--args") ?? Env("ACMEINJECT_ARGS") ?? cfg.Get("args") ?? DefArgs;
                string injector = Arg(argv, "--injector") ?? Env("ACMEINJECT_INJECTOR") ?? cfg.Get("injector") ?? DefInjector;
                string workdir = Arg(argv, "--workdir") ?? cfg.Get("workdir") ?? Path.GetDirectoryName(client) ?? Environment.CurrentDirectory;

                // The injector path Bootstrap will GetModuleFileNameW itself from — must be the real
                // on-disk file so Bootstrap finds runtimeconfig + NativeClientBootstrapper beside it.
                string injectorFull = Path.GetFullPath(injector);
                if (!File.Exists(injectorFull)) {
                    Console.Error.WriteLine($"AcmeInject: injector not found: {injectorFull}");
                    return 2;
                }

                uint bootstrapRva = ExportRva(injectorFull, "Bootstrap");
                if (bootstrapRva == 0) {
                    Console.Error.WriteLine("AcmeInject: could not resolve Bootstrap export RVA from injector");
                    return 3;
                }
                Console.WriteLine($"Injector:   {injectorFull}");
                Console.WriteLine($"Bootstrap:  RVA 0x{bootstrapRva:X8}");

                // --attach <pid>: inject into an ALREADY-RUNNING client (the multi-box /
                // ThwargLauncher / Decal posture — we don't own the launch). Same LoadLibraryW +
                // base-aware Bootstrap as the spawn path, minus CreateProcess/Resume. The live
                // render loop is NOT suspended, so this exercises the patch-while-running path
                // that spawn-injection avoids — the exact thing under test.
                // --attach-all: attach to every running acclient.exe that isn't already injected.
                if (HasFlag(argv, "--attach-all")) {
                    return AttachAll(injectorFull, bootstrapRva);
                }

                string? attachStr = Arg(argv, "--attach");
                if (attachStr != null) {
                    if (!int.TryParse(attachStr, out int pid) || pid <= 0) {
                        Console.Error.WriteLine($"AcmeInject: bad --attach pid '{attachStr}'");
                        return 4;
                    }
                    // Idempotency guard: injecting Chorizite twice into one client crashes it.
                    // Fail SAFE — if we cannot determine the state (null), refuse rather than risk
                    // a double-inject, unless the caller forces it.
                    bool? loaded = IsChoriziteLoaded(pid);
                    if (loaded == true) {
                        Console.Error.WriteLine($"AcmeInject: pid {pid} already has Chorizite injected — refusing "
                            + "(a second injection would load it twice and crash the client). Use --list to check state.");
                        return 23;
                    }
                    if (loaded == null && !HasFlag(argv, "--force")) {
                        Console.Error.WriteLine($"AcmeInject: could not verify pid {pid}'s injection state "
                            + "(module snapshot failed — the client may be starting, exiting, elevated, or in a "
                            + "different session). Refusing rather than risk a double-inject crash. Re-run once "
                            + "the client has settled, or pass --force to inject anyway.");
                        return 26;
                    }
                    Console.WriteLine($"Attach:     pid {pid} (running client)");
                    return InjectAttach(pid, injectorFull, bootstrapRva);
                }

                Console.WriteLine($"Launching:  {client} {args}");
                Console.WriteLine($"workdir:    {workdir}");
                return Inject(client, args, workdir, injectorFull, bootstrapRva);
            }
            catch (Exception ex) {
                Console.Error.WriteLine("AcmeInject: fatal: " + ex);
                return 1;
            }
        }

        private static int Inject(string client, string args, string workdir, string injectorFull, uint bootstrapRva) {
            string cmdline = "\"" + client + "\" " + args;
            var si = new STARTUPINFO { cb = (uint)Marshal.SizeOf<STARTUPINFO>() };
            if (!CreateProcessW(null, cmdline, IntPtr.Zero, IntPtr.Zero, false,
                                CREATE_SUSPENDED, IntPtr.Zero, workdir, ref si, out PROCESS_INFORMATION pi)) {
                Console.Error.WriteLine($"AcmeInject: CreateProcessW failed, err={Marshal.GetLastWin32Error()}");
                return 10;
            }
            IntPtr hProc = pi.hProcess, hThread = pi.hThread;
            try {
                // Remote LoadLibraryW(injectorFull): its return value (thread exit code) is the
                // injector's HMODULE in the target == its REMOTE load base.
                IntPtr remoteBase = RemoteLoadLibrary(hProc, injectorFull, out int llErr);
                if (remoteBase == IntPtr.Zero) {
                    Console.Error.WriteLine($"AcmeInject: remote LoadLibraryW failed (err={llErr}); injector did not load in target");
                    TerminateProcess(hProc, 0xDEAD);
                    return 11;
                }
                IntPtr remoteBootstrap = (IntPtr)((long)remoteBase + bootstrapRva);
                Console.WriteLine($"Injector remote base: 0x{(long)remoteBase:X8}  -> Bootstrap 0x{(long)remoteBootstrap:X8}");

                // Call Bootstrap(NULL) on a remote thread; it hosts the CLR + loads
                // NativeClientBootstrapper. Wait for it to finish arming.
                IntPtr hBoot = CreateRemoteThread(hProc, IntPtr.Zero, 0, remoteBootstrap, IntPtr.Zero, 0, out _);
                if (hBoot == IntPtr.Zero) {
                    Console.Error.WriteLine($"AcmeInject: CreateRemoteThread(Bootstrap) failed, err={Marshal.GetLastWin32Error()}");
                    TerminateProcess(hProc, 0xDEAD);
                    return 12;
                }
                WaitForSingleObject(hBoot, 60_000);
                GetExitCodeThread(hBoot, out uint bootRc);
                CloseHandle(hBoot);
                Console.WriteLine($"Bootstrap returned {bootRc}");

                ResumeThread(hThread);
                Console.WriteLine("Client resumed.");
                return 0;
            }
            finally {
                CloseHandle(hThread);
                CloseHandle(hProc);
            }
        }

        /// <summary>Attach path: OpenProcess an existing client, remote-LoadLibraryW the injector,
        /// call Bootstrap at its remote base. No suspend/resume — the client keeps running, so
        /// Chorizite arms its hooks against a LIVE render loop.</summary>
        private static int InjectAttach(int pid, string injectorFull, uint bootstrapRva) {
            IntPtr hProc = OpenProcess(PROCESS_ALL_ACCESS, false, (uint)pid);
            if (hProc == IntPtr.Zero) {
                Console.Error.WriteLine($"AcmeInject: OpenProcess({pid}) failed, err={Marshal.GetLastWin32Error()} "
                    + "(is the client running? does its integrity level match ours? AV blocking?)");
                return 20;
            }
            try {
                IntPtr remoteBase = RemoteLoadLibrary(hProc, injectorFull, out int llErr);
                if (remoteBase == IntPtr.Zero) {
                    Console.Error.WriteLine($"AcmeInject: remote LoadLibraryW failed (err={llErr})");
                    return 21;
                }
                IntPtr remoteBootstrap = (IntPtr)((long)remoteBase + bootstrapRva);
                Console.WriteLine($"Injector remote base: 0x{(long)remoteBase:X8}  -> Bootstrap 0x{(long)remoteBootstrap:X8}");
                IntPtr hBoot = CreateRemoteThread(hProc, IntPtr.Zero, 0, remoteBootstrap, IntPtr.Zero, 0, out _);
                if (hBoot == IntPtr.Zero) {
                    Console.Error.WriteLine($"AcmeInject: CreateRemoteThread(Bootstrap) failed, err={Marshal.GetLastWin32Error()}");
                    return 22;
                }
                WaitForSingleObject(hBoot, 60_000);
                GetExitCodeThread(hBoot, out uint bootRc);
                CloseHandle(hBoot);
                Console.WriteLine($"Bootstrap returned {bootRc}");
                Console.WriteLine("Attached (client not resumed — it was already running).");
                return 0;
            }
            finally {
                CloseHandle(hProc);
            }
        }

        // ---- client discovery + idempotency (the GUI backbone) --------------------

        private sealed class ClientInfo {
            public int Pid;
            public string ExePath = "";
            public string WindowTitle = "";
            public bool? Injected;   // true = injected, false = plain, null = state unknown (scan failed)
        }

        /// <summary>`--list`: print every running acclient.exe, one machine-readable TSV line each
        /// plus a human summary. Machine format (GUI parses lines starting with the CLIENT tag):
        ///   CLIENT \t &lt;pid&gt; \t &lt;injected:0|1&gt; \t &lt;exePath&gt; \t &lt;windowTitle&gt;
        /// windowTitle may be empty; exePath/title are tab/CR/LF-stripped (see Clean). Human lines start with '#'.</summary>
        private static int ListClients() {
            var clients = EnumClients();
            if (clients == null) {   // enumeration itself failed — distinct from "no clients"
                Console.Error.WriteLine("AcmeInject: could not enumerate processes (Toolhelp snapshot failed)");
                return 27;
            }
            // Machine field 3: 1 = injected, 0 = plain, ? = state could not be determined.
            foreach (var c in clients)
                Console.WriteLine($"CLIENT\t{c.Pid}\t{InjFlag(c.Injected)}\t{c.ExePath}\t{c.WindowTitle}");
            Console.WriteLine();
            if (clients.Count == 0) {
                Console.WriteLine("# no running acclient.exe found");
            }
            else {
                Console.WriteLine($"# {clients.Count} running client(s):");
                foreach (var c in clients)
                    Console.WriteLine($"#   pid {c.Pid}  {InjLabel(c.Injected)}  {c.ExePath}"
                        + (string.IsNullOrEmpty(c.WindowTitle) ? "" : $"  \"{c.WindowTitle}\""));
            }
            return 0;
        }

        private static string InjFlag(bool? inj) => inj == true ? "1" : inj == false ? "0" : "?";
        private static string InjLabel(bool? inj) => inj == true ? "[injected]" : inj == false ? "[plain]   " : "[unknown] ";

        /// <summary>`--attach-all`: attach to every running acclient.exe not already injected,
        /// skipping injected ones. Returns 24 if there are no clients, 25 if any attach failed.</summary>
        private static int AttachAll(string injectorFull, uint bootstrapRva) {
            var clients = EnumClients();
            if (clients == null) {   // enumeration failed — distinct from "no clients"
                Console.Error.WriteLine("AcmeInject: could not enumerate processes (Toolhelp snapshot failed)");
                return 27;
            }
            if (clients.Count == 0) {
                Console.Error.WriteLine("AcmeInject: no running acclient.exe to attach to");
                return 24;
            }
            int ok = 0, skipped = 0, failed = 0;
            foreach (var c in clients) {
                if (c.Injected == true) {
                    Console.WriteLine($"pid {c.Pid}: already injected — skipping");
                    skipped++;
                    continue;
                }
                if (c.Injected == null) {   // fail safe: never inject a client whose state we couldn't read
                    Console.WriteLine($"pid {c.Pid}: injection state unknown (snapshot failed) — skipping for safety");
                    skipped++;
                    continue;
                }
                Console.WriteLine($"pid {c.Pid}: attaching...");
                int rc = InjectAttach(c.Pid, injectorFull, bootstrapRva);
                if (rc == 0) { ok++; }
                else { failed++; Console.Error.WriteLine($"pid {c.Pid}: attach failed (rc={rc})"); }
            }
            Console.WriteLine($"attach-all: {ok} attached, {skipped} skipped (injected/unknown), {failed} failed");
            return failed > 0 ? 25 : 0;
        }

        /// <summary>Toolhelp snapshot of all acclient.exe processes with their exe path, window
        /// title, and whether Chorizite is already loaded. Never throws. Returns null when the
        /// process snapshot itself failed (enumeration unavailable) — distinct from an empty list
        /// (genuinely no clients); a per-pid module-scan failure yields an entry with Injected=null.</summary>
        private static System.Collections.Generic.List<ClientInfo>? EnumClients() {
            var list = new System.Collections.Generic.List<ClientInfo>();
            IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snap == INVALID_HANDLE_VALUE) return null;
            try {
                var pe = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>() };
                if (Process32First(snap, ref pe)) {
                    do {
                        if (!string.Equals(pe.szExeFile, "acclient.exe", StringComparison.OrdinalIgnoreCase))
                            continue;
                        int pid = (int)pe.th32ProcessID;
                        var (exePath, injected) = ScanModules(pid);
                        list.Add(new ClientInfo {
                            Pid = pid,
                            ExePath = Clean(exePath),
                            Injected = injected,
                            WindowTitle = Clean(GetMainWindowTitle(pid)),
                        });
                    } while (Process32Next(snap, ref pe));
                }
            }
            finally { CloseHandle(snap); }
            return list;
        }

        /// <summary>Strip tab/CR/LF so the machine-readable --list line stays single-field-safe
        /// (tab is a legal filename char; a window title is arbitrary text).</summary>
        private static string Clean(string s) => (s ?? "").Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ').Trim();

        /// <summary>One module snapshot of a pid → (exe path from the first module, is
        /// Chorizite.Injector.dll present?). injected is null (unknown) if the snapshot can't be
        /// taken — callers must fail safe on null, never treat it as "not injected".</summary>
        private static (string exePath, bool? injected) ScanModules(int pid) {
            // Retry the snapshot on ERROR_BAD_LENGTH: Win32 documents this as the transient failure
            // when the target is actively loading DLLs — precisely the attach race we care about.
            IntPtr snap = INVALID_HANDLE_VALUE;
            for (int attempt = 0; attempt < 6; attempt++) {
                snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, (uint)pid);
                if (snap != INVALID_HANDLE_VALUE) break;
                if (Marshal.GetLastWin32Error() != ERROR_BAD_LENGTH) break;   // only the transient is worth a retry
                System.Threading.Thread.Sleep(25);
            }
            // Snapshot failed → state is UNKNOWN, NOT "not injected". Callers must fail safe: a
            // wrong "false" here would let the guard permit a double-inject and crash the client.
            if (snap == INVALID_HANDLE_VALUE) return ("", null);
            try {
                var me = new MODULEENTRY32 { dwSize = (uint)Marshal.SizeOf<MODULEENTRY32>() };
                if (!Module32First(snap, ref me)) return ("", null);   // couldn't read modules → unknown
                string exePath = "";
                bool injected = false;
                bool first = true;
                do {
                    if (first) { exePath = me.szExePath; first = false; }   // first module == the process exe
                    if (string.Equals(me.szModule, "Chorizite.Injector.dll", StringComparison.OrdinalIgnoreCase))
                        injected = true;
                } while (Module32Next(snap, ref me));
                return (exePath, injected);
            }
            finally { CloseHandle(snap); }
        }

        /// <summary>Idempotency check: is Chorizite already injected into this pid?
        /// true = yes, false = no, null = could NOT be determined (callers fail safe).</summary>
        private static bool? IsChoriziteLoaded(int pid) => ScanModules(pid).injected;

        /// <summary>First visible titled top-level window owned by the pid ("" if none).</summary>
        private static string GetMainWindowTitle(int pid) {
            string title = "";
            EnumWindows((hWnd, _) => {
                GetWindowThreadProcessId(hWnd, out uint wpid);
                if (wpid == (uint)pid && IsWindowVisible(hWnd)) {
                    int len = GetWindowTextLength(hWnd);
                    if (len > 0) {
                        var sb = new StringBuilder(len + 1);
                        GetWindowText(hWnd, sb, sb.Capacity);
                        var t = sb.ToString().Replace('\t', ' ').Trim();
                        if (t.Length > 0) { title = t; return false; }   // stop enumerating
                    }
                }
                return true;
            }, IntPtr.Zero);
            return title;
        }

        /// <summary>Remote LoadLibraryW(path); returns the loaded module's remote base (exit code),
        /// or IntPtr.Zero on failure.</summary>
        private static IntPtr RemoteLoadLibrary(IntPtr hProc, string path, out int err) {
            err = 0;
            byte[] wpath = Encoding.Unicode.GetBytes(path + "\0");
            IntPtr remoteBuf = VirtualAllocEx(hProc, IntPtr.Zero, (uint)wpath.Length,
                                              MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            if (remoteBuf == IntPtr.Zero) { err = Marshal.GetLastWin32Error(); return IntPtr.Zero; }
            try {
                fixed (byte* p = wpath) {
                    if (!WriteProcessMemory(hProc, remoteBuf, (IntPtr)p, (uint)wpath.Length, out _)) {
                        err = Marshal.GetLastWin32Error(); return IntPtr.Zero;
                    }
                }
                // kernel32!LoadLibraryW is at the same base in every process on this machine, so the
                // LOCAL address is valid as the remote thread start.
                IntPtr k32 = GetModuleHandleW("kernel32.dll");
                IntPtr loadLibraryW = GetProcAddress(k32, "LoadLibraryW");
                if (loadLibraryW == IntPtr.Zero) { err = Marshal.GetLastWin32Error(); return IntPtr.Zero; }

                IntPtr hThread = CreateRemoteThread(hProc, IntPtr.Zero, 0, loadLibraryW, remoteBuf, 0, out _);
                if (hThread == IntPtr.Zero) { err = Marshal.GetLastWin32Error(); return IntPtr.Zero; }
                // MUST require WAIT_OBJECT_0: a timeout (WAIT_TIMEOUT) leaves the load thread
                // running, and GetExitCodeThread then returns STILL_ACTIVE (259) — a nonzero value
                // the caller would treat as the injector's remote base and inject into garbage,
                // while the finally below frees the path buffer out from under the live thread.
                // Under wine/cold-disk/AV the DLL's DllMain can genuinely exceed 30 s, so fail
                // loud rather than trust 259.
                uint wait = WaitForSingleObject(hThread, 30_000);
                if (wait != WAIT_OBJECT_0) {
                    err = wait == WAIT_TIMEOUT ? (int)WAIT_TIMEOUT : unchecked((int)0xFFFFFFFF);
                    CloseHandle(hThread);
                    return IntPtr.Zero;
                }
                GetExitCodeThread(hThread, out uint rc);   // low 32 bits of the HMODULE (32-bit target)
                CloseHandle(hThread);
                return (IntPtr)rc;
            }
            finally {
                VirtualFreeEx(hProc, remoteBuf, 0, MEM_RELEASE);
            }
        }

        // ---- PE export-table reader: RVA of a named export ----
        private static uint ExportRva(string dllPath, string exportName) {
            byte[] f = File.ReadAllBytes(dllPath);
            int pe = BitConverter.ToInt32(f, 0x3c);
            if (f[pe] != (byte)'P' || f[pe + 1] != (byte)'E') return 0;
            int opt = pe + 24;
            ushort magic = BitConverter.ToUInt16(f, opt);
            int dirOff = opt + (magic == 0x20b ? 112 : 96);       // DataDirectory[0] = export
            uint expRva = BitConverter.ToUInt32(f, dirOff);
            if (expRva == 0) return 0;
            ushort nsec = BitConverter.ToUInt16(f, pe + 6);
            ushort optSize = BitConverter.ToUInt16(f, pe + 20);
            int secTab = opt + optSize;
            uint Rva2Off(uint rva) {
                for (int i = 0; i < nsec; i++) {
                    int b = secTab + i * 40;
                    uint va = BitConverter.ToUInt32(f, b + 12);
                    uint vsz = BitConverter.ToUInt32(f, b + 8);
                    uint rsz = BitConverter.ToUInt32(f, b + 16);
                    uint rptr = BitConverter.ToUInt32(f, b + 20);
                    uint span = Math.Max(vsz, rsz);
                    if (rva >= va && rva < va + span) return rptr + (rva - va);
                }
                return 0;
            }
            uint eo = Rva2Off(expRva);
            uint nNames = BitConverter.ToUInt32(f, (int)eo + 24);
            uint addrRva = BitConverter.ToUInt32(f, (int)eo + 28);
            uint nameRva = BitConverter.ToUInt32(f, (int)eo + 32);
            uint ordRva = BitConverter.ToUInt32(f, (int)eo + 36);
            uint ao = Rva2Off(addrRva), no = Rva2Off(nameRva), oo = Rva2Off(ordRva);
            for (uint i = 0; i < nNames; i++) {
                uint nmRva = BitConverter.ToUInt32(f, (int)(no + i * 4));
                int s = (int)Rva2Off(nmRva);
                int e = s; while (f[e] != 0) e++;
                string nm = Encoding.ASCII.GetString(f, s, e - s);
                if (nm == exportName) {
                    ushort ordIdx = BitConverter.ToUInt16(f, (int)(oo + i * 2));
                    return BitConverter.ToUInt32(f, (int)(ao + ordIdx * 4));
                }
            }
            return 0;
        }

        // ---- tiny cfg (key=value, '#'/';' comments) ----
        private sealed class Cfg {
            private readonly System.Collections.Generic.Dictionary<string, string> _m = new(StringComparer.OrdinalIgnoreCase);
            public void Put(string k, string v) => _m[k] = v;
            public string? Get(string k) => _m.TryGetValue(k, out var v) ? v : null;
        }
        private static Cfg LoadCfg() {
            var c = new Cfg();
            foreach (var path in CfgPaths) {
                try {
                    if (!File.Exists(path)) continue;
                    foreach (var line in File.ReadAllLines(path)) {
                        var s = line.Trim();
                        if (s.Length == 0 || s[0] == '#' || s[0] == ';') continue;
                        int eq = s.IndexOf('=');
                        if (eq <= 0) continue;
                        c.Put(s[..eq].Trim(), s[(eq + 1)..].Trim());
                    }
                    break;
                }
                catch { /* ignore */ }
            }
            return c;
        }
        private static string? Arg(string[] argv, string name) {
            for (int i = 0; i < argv.Length - 1; i++) if (argv[i] == name) return argv[i + 1];
            return null;
        }
        private static bool HasFlag(string[] argv, string name) {
            foreach (var a in argv) if (a == name) return true;
            return false;
        }
        private static string? Env(string name) {
            var v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? null : v;
        }

        // ---- interop ----
        private const uint CREATE_SUSPENDED = 0x4;
        private const uint MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, MEM_RELEASE = 0x8000;
        private const uint WAIT_OBJECT_0 = 0x0, WAIT_TIMEOUT = 0x102;
        private const uint PAGE_READWRITE = 0x4;
        private const uint PROCESS_ALL_ACCESS = 0x1F0FFF;
        private const uint TH32CS_SNAPPROCESS = 0x2, TH32CS_SNAPMODULE = 0x8, TH32CS_SNAPMODULE32 = 0x10;
        private const int ERROR_BAD_LENGTH = 299;
        private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

        // ---- Toolhelp (process/module enumeration) ----
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32 {
            public uint dwSize, cntUsage, th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID, cntThreads, th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct MODULEENTRY32 {
            public uint dwSize, th32ModuleID, th32ProcessID, GlblcntUsage, ProccntUsage;
            public IntPtr modBaseAddr;
            public uint modBaseSize;
            public IntPtr hModule;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szModule;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExePath;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW", SetLastError = true)]
        private static extern bool Process32First(IntPtr snap, ref PROCESSENTRY32 pe);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW", SetLastError = true)]
        private static extern bool Process32Next(IntPtr snap, ref PROCESSENTRY32 pe);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Module32FirstW", SetLastError = true)]
        private static extern bool Module32First(IntPtr snap, ref MODULEENTRY32 me);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Module32NextW", SetLastError = true)]
        private static extern bool Module32Next(IntPtr snap, ref MODULEENTRY32 me);

        // ---- window title (best-effort labelling) ----
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO {
            public uint cb; public string? lpReserved, lpDesktop, lpTitle;
            public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcessW(string? app, string cmdline, IntPtr pa, IntPtr ta,
            bool inherit, uint flags, IntPtr env, string? cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr VirtualAllocEx(IntPtr h, IntPtr addr, uint size, uint type, uint protect);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool VirtualFreeEx(IntPtr h, IntPtr addr, uint size, uint type);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool WriteProcessMemory(IntPtr h, IntPtr addr, IntPtr buf, uint size, out IntPtr written);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateRemoteThread(IntPtr h, IntPtr sa, uint stack, IntPtr start, IntPtr param, uint flags, out uint tid);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeThread(IntPtr h, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr h, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr GetModuleHandleW(string name);
        [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
        private static extern IntPtr GetProcAddress(IntPtr mod, string name);
    }
}
