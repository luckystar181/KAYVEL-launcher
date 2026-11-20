using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Threading;
using KayvelSetup;

internal static class InstallerTests
{
    private static int assertions;
    private sealed class QuietProgress : IProgress<int> { public void Report(int value) { if (value < 0 || value > 100) throw new Exception("Invalid percentage"); } }
    private sealed class CancelingStream : MemoryStream
    {
        private readonly CancellationTokenSource cancellation;
        public CancelingStream(byte[] bytes, CancellationTokenSource cancellation) : base(bytes) { this.cancellation = cancellation; }
        public override int Read(byte[] buffer, int offset, int count)
        {
            int received = base.Read(buffer, offset, count);
            cancellation.Cancel();
            return received;
        }
    }
    private sealed class CancelingProgress : IProgress<int>
    {
        private readonly CancellationTokenSource cancellation;
        public CancelingProgress(CancellationTokenSource cancellation) { this.cancellation = cancellation; }
        public void Report(int value) { cancellation.Cancel(); }
    }
    private static void Check(bool condition) { assertions++; if (!condition) throw new Exception("Assertion " + assertions + " failed"); }
    private static void Refuses(Action action) { bool failed = false; try { action(); } catch (Exception) { failed = true; } Check(failed); }
    private static Settings Config(string zip)
    {
        using (var file = File.OpenRead(zip))
        using (var sha = SHA256.Create()) return new Settings {
            Version = "v0.2.7-v3S", Url = "https://github.com/luckystar181/KAYVEL-launcher/releases/download/v0.2.7-v3S/KAYVEL-v3S-windows-x64.zip",
            Sha256 = InstallerCore.Hex(sha.ComputeHash(file)), Bytes = file.Length
        };
    }
    private static string Archive(string root, string extra, bool link)
    {
        string zip = Path.Combine(root, Guid.NewGuid() + ".zip");
        using (var stream = new FileStream(zip, FileMode.CreateNew))
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create))
        {
            foreach (string name in new [] { "KAYVEL.exe", "resources/app/package.json", "resources/app/dist/main/main.js" })
                using (var writer = new StreamWriter(archive.CreateEntry(name).Open())) writer.Write("fixture-not-executable");
            if (extra != null)
            {
                var entry = archive.CreateEntry(extra);
                if (link) entry.ExternalAttributes = unchecked((int)0xA1FF0000);
                using (var writer = new StreamWriter(entry.Open())) writer.Write("extra");
            }
        }
        return zip;
    }
    [STAThread]
    private static void Main(string[] args)
    {
        string root = args[0];
        Directory.CreateDirectory(root);
        foreach (string name in new [] { "../escape", "/root", "C:/evil", "mods/CON.jar", "mods/nul.txt", "mods/COM1", "a:b", "folder\\file", "trailing. ", "a//b", "a/./b", "a/../b", "a/" })
            Refuses(() => InstallerCore.SafeEntry(name));
        Check(InstallerCore.SafeEntry("resources/app/node_modules/example/file.js") == "resources/app/node_modules/example/file.js");
        foreach (string url in new [] { "http://github.com/luckystar181/KAYVEL-launcher/releases/download/v/a.zip", "https://example.org/a", "https://github.com:444/luckystar181/KAYVEL-launcher/releases/download/v/a.zip", "https://user@github.com/luckystar181/KAYVEL-launcher/releases/download/v/a.zip", "https://github.com/luckystar181/KAYVEL-launcher/releases/download/v/a.zip#x", "https://github.com/other/repo/releases/download/v/a.zip" })
            Refuses(() => InstallerCore.ValidateUrl(new Uri(url)));
        InstallerCore.ValidateUrl(new Uri("https://release-assets.githubusercontent.com/a?token=fixture"));
        string valid = Archive(root, null, false);
        Settings settings = Config(valid);
        settings.Validate();
        var progress = new QuietProgress();
        using (var stream = new MemoryStream(File.ReadAllBytes(valid)))
        {
            stream.Position = 3;
            string streamed = Path.Combine(root, "streamed");
            InstallerCore.ExtractVerified(stream, settings, streamed, progress, CancellationToken.None);
            Check(stream.CanRead);
            Check(File.ReadAllText(Path.Combine(streamed, "KAYVEL.exe")) == "fixture-not-executable");
            settings.Bytes++;
            string wrongSize = Path.Combine(root, "wrong-size");
            Refuses(() => InstallerCore.ExtractVerified(stream, settings, wrongSize, progress, CancellationToken.None));
            Check(!Directory.Exists(wrongSize));
            settings.Bytes--;
        }
        Refuses(() => InstallerCore.ExtractVerified((Stream)null, settings, Path.Combine(root, "missing-resource"), progress, CancellationToken.None));
        var hashCancel = new CancellationTokenSource();
        string hashCanceledDest = Path.Combine(root, "hash-canceled");
        using (var stream = new CancelingStream(File.ReadAllBytes(valid), hashCancel))
        {
            Refuses(() => InstallerCore.ExtractVerified(stream, settings, hashCanceledDest, progress, hashCancel.Token));
            Check(stream.CanRead);
        }
        Check(!Directory.Exists(hashCanceledDest));
        var extractCancel = new CancellationTokenSource();
        string extractCanceledDest = Path.Combine(root, "extract-canceled");
        Refuses(() => InstallerCore.ExtractVerified(valid, settings, extractCanceledDest, new CancelingProgress(extractCancel), extractCancel.Token));
        Check(File.Exists(Path.Combine(extractCanceledDest, "KAYVEL.exe")));
        Check(!File.Exists(Path.Combine(extractCanceledDest, "resources/app/dist/main/main.js")));
        string dest = Path.Combine(root, "installed");
        InstallerCore.ExtractVerified(valid, settings, dest, progress, CancellationToken.None);
        Check(File.ReadAllText(Path.Combine(dest, "KAYVEL.exe")) == "fixture-not-executable");
        Check(File.Exists(Path.Combine(dest, "resources/app/dist/main/main.js")));
        Refuses(() => InstallerCore.ExtractVerified(valid, settings, dest, progress, CancellationToken.None));
        Check(File.ReadAllText(Path.Combine(dest, "KAYVEL.exe")) == "fixture-not-executable");
        var canceled = new CancellationTokenSource(); canceled.Cancel();
        string canceledDest = Path.Combine(root, "canceled");
        Refuses(() => InstallerCore.ExtractVerified(valid, settings, canceledDest, progress, canceled.Token));
        Check(!Directory.Exists(canceledDest));
        settings.Sha256 = new String('0', 64);
        string invalidDest = Path.Combine(root, "bad-hash");
        Refuses(() => InstallerCore.ExtractVerified(valid, settings, invalidDest, progress, CancellationToken.None));
        Check(!Directory.Exists(invalidDest));
        foreach (string name in new [] { "../escape", "KAYVEL.EXE", "resources/app/package.json", "mods/CON.jar", "folder\\file" })
        {
            string zip = Archive(root, name, false);
            string target = Path.Combine(root, Guid.NewGuid().ToString());
            Refuses(() => InstallerCore.ExtractVerified(zip, Config(zip), target, progress, CancellationToken.None));
            Check(!Directory.Exists(target));
        }
        string linked = Archive(root, "link", true);
        string linkDest = Path.Combine(root, "links");
        Refuses(() => InstallerCore.ExtractVerified(linked, Config(linked), linkDest, progress, CancellationToken.None));
        Check(!Directory.Exists(linkDest));
        settings = Config(valid); settings.Url = settings.Url.Replace("KAYVEL-launcher", "KAYVEL-mods");
        Refuses(settings.Validate);
        string occupied = Path.Combine(root, "occupied"); File.WriteAllText(occupied, "preserve");
        Refuses(() => InstallerCore.CheckDirectoryChain(Path.Combine(occupied, "child")));
        Check(File.ReadAllText(occupied) == "preserve");
        string desktop = Path.Combine(root, "desktop"); Directory.CreateDirectory(desktop);
        File.WriteAllText(Path.Combine(desktop, "KAYVEL v3S.lnk"), "old-shortcut");
        string shortcut = InstallerCore.CreateShortcut(desktop, Path.Combine(dest, "KAYVEL.exe"));
        Check(Path.GetFileName(shortcut) == "KAYVEL v3S (2).lnk");
        Check(new FileInfo(shortcut).Length > 0);
        Check(File.ReadAllText(Path.Combine(desktop, "KAYVEL v3S.lnk")) == "old-shortcut");
        Console.WriteLine("Installer offline tests: " + assertions + " assertions passed. No network or launcher execution.");
    }
}
