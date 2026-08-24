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
                string? attachStr = Arg(argv, "--attach");
                if (attachStr != null) {
                    if (!int.TryParse(attachStr, out int pid) || pid <= 0) {
                        Console.Error.WriteLine($"AcmeInject: bad --attach pid '{attachStr}'");
                        return 4;
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

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

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
