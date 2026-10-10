$ErrorActionPreference = 'Stop'

# Own the launcher before it starts any child. Even a detached grandchild stays
# in this anonymous job; terminating the launcher closes the last job handle.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TestHostJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    static IntPtr job;
    public static int Run(string command, string arguments) {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
        if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
        // Keep the non-inheritable handle open until this launcher exits. Closing
        // it here would terminate the launcher itself before returning its status.
        Console.OutputEncoding = new UTF8Encoding(false);
        // The launcher owns these events until exit, including late pipe callbacks.
        var outputClosed = new ManualResetEvent(false);
        var errorClosed = new ManualResetEvent(false);
        using (var process = new Process()) {
            process.StartInfo = new ProcessStartInfo(command, arguments) {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            process.OutputDataReceived += (sender, data) => { if (data.Data == null) outputClosed.Set(); else Console.Out.WriteLine(data.Data); };
            process.ErrorDataReceived += (sender, data) => { if (data.Data == null) errorClosed.Set(); else Console.Error.WriteLine(data.Data); };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            // The timed overload waits for the root only, not an orphan holding a
            // redirected pipe open. Drain normal output, then exit and close the job.
            process.WaitForExit(Int32.MaxValue);
            outputClosed.WaitOne(1000);
            errorClosed.WaitOne(1000);
            return process.ExitCode;
        }
    }
}
'@

$launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:NEXUS_TEST_HOST_LAUNCH)) | ConvertFrom-Json
[Environment]::SetEnvironmentVariable('NEXUS_TEST_HOST_LAUNCH', $null)
exit [TestHostJob]::Run($launch.command, $launch.arguments)
