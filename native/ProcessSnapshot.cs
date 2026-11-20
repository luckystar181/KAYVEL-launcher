using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

namespace KayvelProcessSnapshot
{
    internal static class Program
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct ProcessEntry
        {
            public uint Size;
            public uint Usage;
            public uint ProcessId;
            public UIntPtr DefaultHeapId;
            public uint ModuleId;
            public uint Threads;
            public uint ParentProcessId;
            public int BasePriority;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string Name;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
        [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        private static int Main(string[] args)
        {
            if (args.Length != 0) return 2;
            try
            {
                IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
                if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
                var records = new List<object>();
                try
                {
                    var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
                    if (!Process32First(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    do
                    {
                        if (records.Count >= 100000) throw new InvalidOperationException("Snapshot too large.");
                        records.Add(new { ProcessId = entry.ProcessId, ParentProcessId = entry.ParentProcessId, Name = entry.Name });
                    } while (Process32Next(snapshot, ref entry));
                    int error = Marshal.GetLastWin32Error();
                    if (error != 18) throw new Win32Exception(error);
                }
                finally { CloseHandle(snapshot); }
                Console.OutputEncoding = new UTF8Encoding(false);
                Console.WriteLine(new JavaScriptSerializer { MaxJsonLength = 4000000 }.Serialize(records));
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Process snapshot failed: " + error.GetType().Name);
                return 1;
            }
        }
    }
}
