using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace KayvelSetup
{
    public sealed class Settings
    {
        public string Version { get; set; }
        public string Url { get; set; }
        public string Sha256 { get; set; }
        public long Bytes { get; set; }

        public void Validate()
        {
            if (Version != "v0.2.2-v3S" || !Regex.IsMatch(Sha256 ?? "", "\\A[a-f0-9]{64}\\z") || Bytes < 1 || Bytes > 1000000000)
                throw new InvalidDataException("Некорректные параметры установщика.");
            Uri uri = new Uri(Url, UriKind.Absolute);
            InstallerCore.ValidateUrl(uri);
            if (uri.Host != "github.com" || uri.AbsolutePath != "/luckystar181/KAYVEL-launcher/releases/download/" + Version + "/KAYVEL-v3S-windows-x64.zip" || uri.Query != "")
                throw new InvalidDataException("Неизвестный выпуск лаунчера.");
        }
    }

    public static class InstallerCore
    {
        public static void ValidateUrl(Uri uri)
        {
            if (uri.Scheme != "https" || uri.Port != 443 || uri.UserInfo != "" || uri.Fragment != "" ||
                (uri.Host != "github.com" && uri.Host != "release-assets.githubusercontent.com"))
                throw new InvalidDataException("Недопустимый адрес загрузки.");
            if (uri.Host == "github.com" && !uri.AbsolutePath.StartsWith("/luckystar181/KAYVEL-launcher/releases/download/", StringComparison.Ordinal))
                throw new InvalidDataException("Недопустимый путь GitHub.");
        }

        public static void CheckDirectoryChain(string path)
        {
            string current = Path.GetFullPath(path);
            while (!String.IsNullOrEmpty(current))
            {
                if (Directory.Exists(current) || File.Exists(current))
                {
                    FileAttributes attr = File.GetAttributes(current);
                    if ((attr & FileAttributes.ReparsePoint) != 0 || (attr & FileAttributes.Directory) == 0)
                        throw new IOException("Каталог занят файлом или ссылкой: " + current);
                }
                string parent = Path.GetDirectoryName(current);
                if (parent == current) break;
                current = parent;
            }
        }

        public static async Task Download(Settings settings, string destination, IProgress<int> progress, CancellationToken token)
        {
            settings.Validate();
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            Uri uri = new Uri(settings.Url);
            var visited = new HashSet<string>(StringComparer.Ordinal);
            using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                deadline.CancelAfter(TimeSpan.FromMinutes(15));
                for (int hop = 0; hop <= 5; hop++)
                {
                    deadline.Token.ThrowIfCancellationRequested();
                    ValidateUrl(uri);
                    if (!visited.Add(uri.AbsoluteUri)) throw new IOException("Цикл перенаправлений.");
                    var request = (HttpWebRequest)WebRequest.Create(uri);
                    request.AllowAutoRedirect = false;
                    request.AutomaticDecompression = DecompressionMethods.None;
                    request.Credentials = null;
                    request.UseDefaultCredentials = false;
                    request.UserAgent = "KAYVEL-Setup/0.2.2";
                    request.Headers[HttpRequestHeader.AcceptEncoding] = "identity";
                    using (deadline.Token.Register(request.Abort))
                    using (var response = (HttpWebResponse)await request.GetResponseAsync())
                    {
                        int code = (int)response.StatusCode;
                        if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308)
                        {
                            if (hop == 5 || String.IsNullOrEmpty(response.Headers[HttpResponseHeader.Location]))
                                throw new IOException("Слишком много перенаправлений или отсутствует адрес.");
                            uri = new Uri(uri, response.Headers[HttpResponseHeader.Location]);
                            continue;
                        }
                        if (code != 200 || (response.ContentLength != -1 && response.ContentLength != settings.Bytes) ||
                            (!String.IsNullOrEmpty(response.ContentEncoding) && response.ContentEncoding != "identity"))
                            throw new IOException("Сервер вернул неожиданный ответ (HTTP " + code + ").");
                        using (Stream input = response.GetResponseStream())
                        using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
                        using (var hash = SHA256.Create())
                        {
                            byte[] buffer = new byte[65536];
                            long total = 0;
                            int count;
                            while ((count = await input.ReadAsync(buffer, 0, buffer.Length, deadline.Token)) != 0)
                            {
                                total += count;
                                if (total > settings.Bytes) throw new InvalidDataException("Превышен размер загрузки.");
                                hash.TransformBlock(buffer, 0, count, null, 0);
                                await output.WriteAsync(buffer, 0, count, deadline.Token);
                                progress.Report((int)(total * 100 / settings.Bytes));
                            }
                            hash.TransformFinalBlock(new byte[0], 0, 0);
                            if (total != settings.Bytes || Hex(hash.Hash) != settings.Sha256)
                                throw new InvalidDataException("Проверка SHA-256 не пройдена. Установка остановлена.");
                        }
                        return;
                    }
                }
            }
            throw new IOException("Загрузка не завершена.");
        }

        public static string Hex(byte[] bytes)
        {
            return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
        }

        public static string SafeEntry(string name)
        {
            if (String.IsNullOrEmpty(name) || name.Length > 220 || name.Contains("\\") || name.StartsWith("/") || name.EndsWith("/"))
                throw new InvalidDataException("Некорректный путь ZIP.");
            foreach (string part in name.Split('/'))
            {
                if (part == "" || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") ||
                    part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                    Regex.IsMatch(part, "\\A(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)", RegexOptions.IgnoreCase))
                    throw new InvalidDataException("Небезопасный путь ZIP: " + name);
            }
            return name;
        }

        public static void ExtractVerified(string zipPath, Settings settings, string destination, IProgress<int> progress, CancellationToken token)
        {
            settings.Validate();
            CheckDirectoryChain(Path.GetDirectoryName(destination));
            if (File.Exists(destination) || Directory.Exists(destination)) throw new IOException("Каталог установки уже существует.");
            using (var file = new FileStream(zipPath, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                using (var hash = SHA256.Create())
                    if (file.Length != settings.Bytes || Hex(hash.ComputeHash(file)) != settings.Sha256)
                        throw new InvalidDataException("Архив не соответствует закреплённому SHA-256.");
                token.ThrowIfCancellationRequested();
                file.Position = 0;
                using (var archive = new ZipArchive(file, ZipArchiveMode.Read))
                {
                    if (archive.Entries.Count == 0 || archive.Entries.Count > 50000) throw new InvalidDataException("Некорректное число файлов.");
                    var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    long total = 0;
                    foreach (var entry in archive.Entries)
                    {
                        bool directory = entry.FullName.EndsWith("/", StringComparison.Ordinal);
                        string name = SafeEntry(directory ? entry.FullName.Substring(0, entry.FullName.Length - 1) : entry.FullName);
                        int kind = (entry.ExternalAttributes >> 16) & 0xF000;
                        if ((entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) != 0 ||
                            (kind != 0 && kind != (directory ? 0x4000 : 0x8000)) || !paths.Add(name))
                            throw new InvalidDataException("Ссылка, специальный файл или дубликат в ZIP.");
                        total = checked(total + entry.Length);
                        if (entry.Length < 0 || entry.Length > 1000000000 || total > 2000000000 || (directory && entry.Length != 0))
                            throw new InvalidDataException("Превышен распакованный размер ZIP.");
                    }
                    if (!paths.Contains("KAYVEL.exe") || !paths.Contains("resources/app/package.json") || !paths.Contains("resources/app/dist/main/main.js"))
                        throw new InvalidDataException("В архиве нет лаунчера.");
                    Directory.CreateDirectory(destination);
                    string root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
                    long written = 0;
                    foreach (var entry in archive.Entries)
                    {
                        token.ThrowIfCancellationRequested();
                        bool directory = entry.FullName.EndsWith("/", StringComparison.Ordinal);
                        string relative = directory ? entry.FullName.TrimEnd('/') : entry.FullName;
                        string outputPath = Path.GetFullPath(Path.Combine(destination, relative.Replace('/', Path.DirectorySeparatorChar)));
                        if (!outputPath.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Выход за каталог установки.");
                        CheckDirectoryChain(Path.GetDirectoryName(outputPath));
                        if (directory) { CheckDirectoryChain(outputPath); Directory.CreateDirectory(outputPath); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(outputPath));
                        CheckDirectoryChain(Path.GetDirectoryName(outputPath));
                        using (Stream input = entry.Open())
                        using (var output = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        {
                            byte[] buffer = new byte[65536];
                            int count;
                            long length = 0;
                            while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
                            {
                                token.ThrowIfCancellationRequested();
                                length += count;
                                if (length > entry.Length) throw new InvalidDataException("Некорректный размер файла ZIP.");
                                output.Write(buffer, 0, count);
                                written += count;
                                progress.Report(total == 0 ? 0 : (int)(written * 100 / total));
                            }
                            if (length != entry.Length) throw new InvalidDataException("Неполный файл ZIP.");
                        }
                    }
                }
            }
        }

        public static string CreateShortcut(string desktop, string launcher)
        {
            CheckDirectoryChain(desktop);
            if (!Directory.Exists(desktop) || !File.Exists(launcher)) throw new IOException("Не найден рабочий стол или лаунчер.");
            string temporary = Path.Combine(desktop, "KAYVEL-" + Guid.NewGuid().ToString("N") + ".lnk");
            object shell = null;
            object shortcut = null;
            try
            {
                Type type = Type.GetTypeFromProgID("WScript.Shell", true);
                shell = Activator.CreateInstance(type);
                shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { temporary });
                Type linkType = shortcut.GetType();
                linkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { launcher });
                linkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { Path.GetDirectoryName(launcher) });
                linkType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "KAYVEL v3S" });
                linkType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { launcher + ",0" });
                linkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
                for (int i = 0; i < 1000; i++)
                {
                    string name = i == 0 ? "KAYVEL v3S.lnk" : "KAYVEL v3S (" + (i + 1) + ").lnk";
                    string path = Path.Combine(desktop, name);
                    if (File.Exists(path) || Directory.Exists(path)) continue;
                    File.Move(temporary, path);
                    return path;
                }
                throw new IOException("Не удалось выбрать имя ярлыка.");
            }
            finally
            {
                if (shortcut != null) Marshal.FinalReleaseComObject(shortcut);
                if (shell != null) Marshal.FinalReleaseComObject(shell);
            }
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly Label status = new Label { Left = 24, Top = 60, Width = 480, Height = 80, Text = "Скачает лаунчер с GitHub и создаст ярлык на рабочем столе.\nMinecraft и сборка загружаются при первом нажатии «Скачать и играть».\nСтарые установки и миры не изменяются." };
        private readonly ProgressBar meter = new ProgressBar { Left = 24, Top = 150, Width = 470, Height = 24 };
        private readonly Button action = new Button { Left = 24, Top = 198, Width = 220, Height = 36, Text = "Установить KAYVEL v3S" };
        private readonly Button cancel = new Button { Left = 354, Top = 198, Width = 140, Height = 36, Text = "Закрыть" };
        private CancellationTokenSource cancellation;
        private string launcher;

        public SetupForm()
        {
            Text = "KAYVEL — установка v3S";
            ClientSize = new Size(520, 258);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9);
            Controls.Add(new Label { Left = 24, Top = 20, Width = 470, Height = 30, Text = "KAYVEL v3S · Windows x64", Font = new Font("Segoe UI", 16, FontStyle.Bold) });
            Controls.Add(status); Controls.Add(meter); Controls.Add(action); Controls.Add(cancel);
            action.Click += async delegate { await Install(); };
            cancel.Click += delegate { if (cancellation != null) { cancellation.Cancel(); cancel.Enabled = false; } else Close(); };
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (cancellation != null) { e.Cancel = true; cancellation.Cancel(); } };
        }

        private async Task Install()
        {
            if (launcher != null)
            {
                try { Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(launcher) }); Close(); }
                catch (Exception) { status.Text = "Не удалось открыть лаунчер. Используйте ярлык на рабочем столе."; }
                return;
            }
            action.Enabled = false;
            cancel.Text = "Отменить";
            cancellation = new CancellationTokenSource();
            string workspace = null;
            try
            {
                if (!Environment.Is64BitOperatingSystem) throw new IOException("Нужна 64-разрядная Windows 10/11.");
                Settings settings;
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("installer-settings.json"))
                using (var reader = new StreamReader(stream)) settings = new JavaScriptSerializer().Deserialize<Settings>(reader.ReadToEnd());
                settings.Validate();
                string parent = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "KAYVEL");
                InstallerCore.CheckDirectoryChain(parent);
                Directory.CreateDirectory(parent);
                InstallerCore.CheckDirectoryChain(parent);
                if (new DriveInfo(Path.GetPathRoot(parent)).AvailableFreeSpace < 2000000000) throw new IOException("Нужно не менее 2 ГБ свободного места для лаунчера.");
                string id = Guid.NewGuid().ToString("N");
                workspace = Path.Combine(parent, ".setup-" + id);
                Directory.CreateDirectory(workspace);
                InstallerCore.CheckDirectoryChain(workspace);
                string zip = Path.Combine(workspace, "launcher.zip");
                status.Text = "Загрузка лаунчера с GitHub…";
                await InstallerCore.Download(settings, zip, new Progress<int>(value => meter.Value = value), cancellation.Token);
                cancellation.Token.ThrowIfCancellationRequested();
                status.Text = "Проверка SHA-256 и распаковка…";
                meter.Value = 0;
                var progress = new Progress<int>(value => meter.Value = value);
                string staging = Path.Combine(workspace, "app");
                await Task.Run(() => InstallerCore.ExtractVerified(zip, settings, staging, progress, cancellation.Token));
                cancellation.Token.ThrowIfCancellationRequested();
                InstallerCore.CheckDirectoryChain(parent);
                InstallerCore.CheckDirectoryChain(staging);
                string installed = Path.Combine(parent, "v3S-" + id);
                Directory.Move(staging, installed);
                launcher = Path.Combine(installed, "KAYVEL.exe");
                try
                {
                    InstallerCore.CreateShortcut(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), launcher);
                    status.Text = "Установлено. Ярлык KAYVEL v3S создан на рабочем столе.";
                }
                catch (Exception)
                {
                    status.Text = "Лаунчер установлен, но ярлык создать не удалось.\nПапка: " + installed;
                }
                // Only this run's download is disposable; user data and old installations are never removed.
                try { File.Delete(zip); Directory.Delete(workspace); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                meter.Value = 100;
                action.Text = "Открыть KAYVEL";
                action.Enabled = true;
            }
            catch (Exception error)
            {
                status.Text = (cancellation.IsCancellationRequested ? "Установка отменена." : "Установка остановлена: " + (error is WebException ? "Не удалось скачать файлы с GitHub." : error.Message)) +
                    (workspace == null ? "" : "\nЧастичные файлы оставлены: " + workspace);
            }
            finally
            {
                cancellation.Dispose(); cancellation = null;
                cancel.Text = "Закрыть"; cancel.Enabled = true;
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }
    }
}
