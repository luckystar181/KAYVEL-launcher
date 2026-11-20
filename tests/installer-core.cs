using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
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
            Version = "v0.2.10-v3S", Url = "https://github.com/luckystar181/KAYVEL-launcher/releases/download/v0.2.10-v3S/KAYVEL-v3S-windows-x64.zip",
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
    private static string Installed(string root)
    {
        string directory = Path.Combine(root, "v3S-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string launcher = Path.Combine(directory, "KAYVEL.exe");
        File.WriteAllText(launcher, "fixture-not-executable");
        return launcher;
    }

    private static string Link(string path, string property, string value)
    {
        object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell", true));
        object shortcut = null;
        try
        {
            shortcut = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
            if (value != null)
            {
                shortcut.GetType().InvokeMember(property, BindingFlags.SetProperty, null, shortcut, new object[] { value });
                shortcut.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            return Convert.ToString(shortcut.GetType().InvokeMember(property, BindingFlags.GetProperty, null, shortcut, null));
        }
        finally
        {
            if (shortcut != null) Marshal.FinalReleaseComObject(shortcut);
            Marshal.FinalReleaseComObject(shell);
        }
    }

    private static void EqualFile(string path, byte[] expected)
    {
        Check(Convert.ToBase64String(File.ReadAllBytes(path)) == Convert.ToBase64String(expected));
    }

    private static T Field<T>(object instance, string name)
    {
        return (T)instance.GetType().GetField(name, BindingFlags.NonPublic | BindingFlags.Instance).GetValue(instance);
    }

    private static void CheckLayout(Control parent)
    {
        foreach (Control control in parent.Controls)
        {
            Check(parent.ClientRectangle.Contains(control.Bounds));
            if (control is Label)
            {
                Size text = TextRenderer.MeasureText(control.Text, control.Font, new Size(control.Width, Int32.MaxValue), TextFormatFlags.WordBreak);
                if (text.Width > control.Width || text.Height > control.Height)
                    throw new Exception("Clipped label: " + control.Text + " required=" + text + " bounds=" + control.Size);
                Check(true);
            }
            CheckLayout(control);
        }
    }

    private static void Preview(string root)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var form = new SetupForm())
        {
            form.ShowInTaskbar = false;
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-32000, -32000);
            form.Show();
            Check(form.BackColor.GetBrightness() < 0.2f);
            Check(form.AcceptButton == Field<Button>(form, "action"));
            Check(form.CancelButton == Field<Button>(form, "cancel"));
            Check(Field<TextBox>(form, "status").ReadOnly);
            foreach (string state in new [] { "ready", "progress", "complete", "error", "cancelled", "handoff" })
            {
                if (state != "ready")
                {
                    Field<Label>(form, "heading").Text = state == "progress" ? "Устанавливаем KAYVEL" : state == "complete" ? "Добро пожаловать" : state == "cancelled" ? "Установка отменена" : state == "handoff" ? "Добро пожаловать" : "Не удалось установить";
                    bool complete = state == "complete" || state == "handoff";
                    Field<Button>(form, "action").Text = complete ? "Открыть KAYVEL" : "Установить KAYVEL";
                    Field<Button>(form, "action").Enabled = state == "complete";
                    Field<Button>(form, "cancel").Text = state == "progress" ? "Отменить" : "Закрыть";
                    Field<Button>(form, "cancel").Enabled = state != "handoff";
                    form.GetType().GetMethod("ShowStage", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(form, new object[] {
                        state == "progress" ? "02 / 03 · Лаунчер и Java" : state == "complete" ? "Установка завершена" : state == "handoff" ? "Переход на новую версию" : state == "cancelled" ? "Отменено" : "Установка остановлена",
                        state == "error" ? "Нет доступа к каталогу. Частичные файлы оставлены:\r\n" + new String('a', 1200) : state == "handoff" ? "Ждём завершения старого лаунчера. Игра автоматически не запускается." : "Старые установки, миры и настройки сохранены.", complete ? 100 : 43 });
                }
                Check(Field<TextBox>(form, "status").ScrollBars == (state == "error" ? ScrollBars.Vertical : ScrollBars.None));
                CheckLayout(form);
                using (var image = new Bitmap(form.Width, form.Height))
                {
                    form.DrawToBitmap(image, new Rectangle(0, 0, image.Width, image.Height));
                    image.Save(Path.Combine(root, "setup-" + state + ".png"));
                }
            }
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try { Run(args); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private static void Run(string[] args)
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
        string installs = Path.Combine(root, "Programs", "KAYVEL"); Directory.CreateDirectory(installs);
        string oldLauncher = Installed(installs), newLauncher = Installed(installs);
        string desktop = Path.Combine(root, "desktop"); Directory.CreateDirectory(desktop);
        string shortcut = InstallerCore.CreateShortcut(desktop, oldLauncher, installs);
        Check(Path.GetFileName(shortcut) == "KAYVEL v3S.lnk");
        Check(Link(shortcut, "TargetPath", null) == oldLauncher);
        byte[] original = File.ReadAllBytes(shortcut);
        string second = Path.Combine(desktop, "KAYVEL v3S (2).lnk");
        string third = Path.Combine(desktop, "KAYVEL v3S (3).lnk");
        File.Copy(shortcut, second); File.Copy(shortcut, third);
        string renamed = Path.Combine(desktop, "My KAYVEL.lnk"); File.Copy(shortcut, renamed);
        Check(InstallerCore.CreateShortcut(desktop, newLauncher, installs) == shortcut);
        Check(Link(shortcut, "TargetPath", null) == newLauncher);
        Check(Link(shortcut, "WorkingDirectory", null) == Path.GetDirectoryName(newLauncher));
        Check(!File.Exists(second) && !File.Exists(third));
        EqualFile(renamed, original);
        Check(File.ReadAllText(oldLauncher) == "fixture-not-executable");
        string backups = Path.Combine(installs, ".shortcut-backups");
        string backup = Directory.GetDirectories(backups)[0];
        foreach (string name in new [] { "KAYVEL v3S.lnk", "KAYVEL v3S (2).lnk", "KAYVEL v3S (3).lnk", "replaced.lnk", "KAYVEL v3S (2).lnk.removed", "KAYVEL v3S (3).lnk.removed" })
            EqualFile(Path.Combine(backup, name), original);
        byte[] current = File.ReadAllBytes(shortcut);
        Check(InstallerCore.CreateShortcut(desktop, newLauncher, installs) == shortcut);
        EqualFile(shortcut, current);
        Check(Directory.GetDirectories(backups).Length == 1);
        using (var held = new FileStream(Path.Combine(installs, ".shortcut-update.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            Refuses(() => InstallerCore.CreateShortcut(desktop, oldLauncher, installs));
        EqualFile(shortcut, current);

        string occupiedDesktop = Path.Combine(root, "occupied-desktop"); Directory.CreateDirectory(occupiedDesktop);
        string foreign = Path.Combine(occupiedDesktop, "KAYVEL v3S.lnk"); File.WriteAllText(foreign, "old-shortcut");
        string other = InstallerCore.CreateShortcut(occupiedDesktop, oldLauncher, installs);
        Check(Path.GetFileName(other) == "KAYVEL v3S (2).lnk");
        Check(InstallerCore.CreateShortcut(occupiedDesktop, newLauncher, installs) == other);
        Check(File.ReadAllText(foreign) == "old-shortcut");
        Check(Directory.GetFiles(occupiedDesktop, "*.lnk").Length == 2);
        foreach (string property in new [] { "Description", "Arguments", "WorkingDirectory", "IconLocation", "TargetPath", "Hotkey" })
        {
            string isolated = Path.Combine(root, "foreign-" + property); Directory.CreateDirectory(isolated);
            string link = InstallerCore.CreateShortcut(isolated, oldLauncher, installs);
            Link(link, property, property == "TargetPath" ? Path.Combine(dest, "KAYVEL.exe") : property == "Hotkey" ? "CTRL+ALT+K" : property == "WorkingDirectory" ? root : property == "IconLocation" ? newLauncher + ",0" : "user-customized");
            byte[] preserve = File.ReadAllBytes(link);
            string fresh = InstallerCore.CreateShortcut(isolated, newLauncher, installs);
            Check(fresh != link);
            EqualFile(link, preserve);
        }
        string directoryDesktop = Path.Combine(root, "directory-desktop"); Directory.CreateDirectory(directoryDesktop);
        Directory.CreateDirectory(Path.Combine(directoryDesktop, "KAYVEL v3S.lnk"));
        Check(Path.GetFileName(InstallerCore.CreateShortcut(directoryDesktop, newLauncher, installs)) == "KAYVEL v3S (2).lnk");
        Refuses(() => InstallerCore.CreateShortcut(desktop, Path.Combine(dest, "KAYVEL.exe"), installs));
        Refuses(() => InstallerCore.CreateShortcut(desktop, Path.Combine(installs, "v3S-" + new String('a', 32), "KAYVEL.exe"), installs));
        Refuses(() => InstallerCore.CreateShortcut(occupied, newLauncher, installs));

        string failureRoot = Path.Combine(root, "backup-failure"); Directory.CreateDirectory(failureRoot);
        string before = Installed(failureRoot), after = Installed(failureRoot);
        string failureDesktop = Path.Combine(root, "failure-desktop"); Directory.CreateDirectory(failureDesktop);
        string preservedLink = InstallerCore.CreateShortcut(failureDesktop, before, failureRoot);
        byte[] preservedBytes = File.ReadAllBytes(preservedLink);
        File.WriteAllText(Path.Combine(failureRoot, ".shortcut-backups"), "occupied-backup");
        Refuses(() => InstallerCore.CreateShortcut(failureDesktop, after, failureRoot));
        EqualFile(preservedLink, preservedBytes);
        Check(Directory.GetFiles(failureDesktop).Length == 1);
        File.Copy(preservedLink, Path.Combine(failureDesktop, "KAYVEL v3S (2).lnk"));
        using (var held = new FileStream(preservedLink, FileMode.Open, FileAccess.Read, FileShare.Read))
            Refuses(() => InstallerCore.CreateShortcut(failureDesktop, after, failureRoot));
        EqualFile(preservedLink, preservedBytes);

        Check(UpdateHandoff.FromArguments(new string[0]) == null);
        foreach (string[] arguments in new [] { new [] { "--unknown" }, new [] { "--kayvel-update", "--parent-pid=0" }, new [] { "--kayvel-update", "--parent-pid=-1" }, new [] { "--kayvel-update", "--parent-pid=bad" } })
            Refuses(() => UpdateHandoff.FromArguments(arguments));
        using (var message = new MemoryStream(Encoding.ASCII.GetBytes("KAYVEL_SETUP_QUIT_V1\n")))
            Check(UpdateHandoff.ReadMessage(message) == "KAYVEL_SETUP_QUIT_V1");
        foreach (string message in new [] { "", "unfinished", new String('x', 65) + "\n", "bad\r\n" })
            using (var stream = new MemoryStream(Encoding.ASCII.GetBytes(message))) Refuses(() => UpdateHandoff.ReadMessage(stream));
        Preview(root);
        Console.WriteLine("Installer offline tests: " + assertions + " assertions passed. No network or launcher execution. Previews: " + root);
    }
}
