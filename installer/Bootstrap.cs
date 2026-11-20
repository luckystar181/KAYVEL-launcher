using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
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
            if (Version != "v0.2.10-v3S" || !Regex.IsMatch(Sha256 ?? "", "\\A[a-f0-9]{64}\\z") || Bytes < 1 || Bytes > 1000000000)
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
            using (var file = new FileStream(zipPath, FileMode.Open, FileAccess.Read, FileShare.Read))
                ExtractVerified(file, settings, destination, progress, token);
        }

        public static void ExtractVerified(Stream file, Settings settings, string destination, IProgress<int> progress, CancellationToken token)
        {
            settings.Validate();
            CheckDirectoryChain(Path.GetDirectoryName(destination));
            if (File.Exists(destination) || Directory.Exists(destination)) throw new IOException("Каталог установки уже существует.");
            if (file == null || !file.CanRead || !file.CanSeek || file.Length != settings.Bytes)
                throw new InvalidDataException("Отсутствует встроенный архив или неверен его размер.");
            token.ThrowIfCancellationRequested();
            file.Position = 0;
            using (var hash = SHA256.Create())
            {
                byte[] buffer = new byte[65536];
                int count;
                while ((count = file.Read(buffer, 0, buffer.Length)) != 0)
                {
                    token.ThrowIfCancellationRequested();
                    hash.TransformBlock(buffer, 0, count, null, 0);
                }
                hash.TransformFinalBlock(new byte[0], 0, 0);
                if (Hex(hash.Hash) != settings.Sha256)
                    throw new InvalidDataException("Архив не соответствует закреплённому SHA-256.");
            }
            token.ThrowIfCancellationRequested();
            file.Position = 0;
            using (var archive = new ZipArchive(file, ZipArchiveMode.Read, true))
            {
                if (archive.Entries.Count == 0 || archive.Entries.Count > 50000) throw new InvalidDataException("Некорректное число файлов.");
                var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                long total = 0;
                foreach (var entry in archive.Entries)
                {
                    token.ThrowIfCancellationRequested();
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
                token.ThrowIfCancellationRequested();
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

        private sealed class ShortcutRecord
        {
            public string Path;
            public byte[] Bytes;
            public string Target;
        }

        private static bool SamePath(string left, string right)
        {
            return String.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        }

        private static void CheckPlainFile(string path)
        {
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                throw new IOException("Ожидался обычный файл: " + path);
        }

        private static byte[] ShortcutBytes(string path)
        {
            CheckPlainFile(path);
            using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (input.Length == 0 || input.Length > 1048576) throw new IOException("Необычный размер ярлыка.");
                byte[] bytes = new byte[(int)input.Length];
                int offset = 0;
                while (offset < bytes.Length)
                {
                    int count = input.Read(bytes, offset, bytes.Length - offset);
                    if (count == 0) throw new EndOfStreamException();
                    offset += count;
                }
                return bytes;
            }
        }

        private static bool SameBytes(byte[] left, byte[] right)
        {
            if (left.Length != right.Length) return false;
            for (int i = 0; i < left.Length; i++) if (left[i] != right[i]) return false;
            return true;
        }

        private static string LinkProperty(object shortcut, string name)
        {
            return Convert.ToString(shortcut.GetType().InvokeMember(name, BindingFlags.GetProperty, null, shortcut, null));
        }

        private static void ValidateInstalledLauncher(string launcher, string root)
        {
            string directory = Path.GetDirectoryName(launcher);
            if (!SamePath(Path.GetDirectoryName(directory), root) ||
                !Regex.IsMatch(Path.GetFileName(directory), "\\Av3S-[a-f0-9]{32}\\z") ||
                !SamePath(Path.GetFileName(launcher), "KAYVEL.exe"))
                throw new IOException("Лаунчер находится вне каталога установок KAYVEL.");
            CheckDirectoryChain(directory);
            CheckPlainFile(launcher);
        }

        private static ShortcutRecord ReadOwnedShortcut(object shell, string path, string root)
        {
            object shortcut = null;
            try
            {
                byte[] bytes = ShortcutBytes(path);
                shortcut = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                string target = LinkProperty(shortcut, "TargetPath");
                ValidateInstalledLauncher(target, root);
                if (LinkProperty(shortcut, "Description") != "KAYVEL v3S" ||
                    LinkProperty(shortcut, "Arguments") != "" || LinkProperty(shortcut, "Hotkey") != "" ||
                    LinkProperty(shortcut, "WindowStyle") != "1" ||
                    !SamePath(LinkProperty(shortcut, "WorkingDirectory"), Path.GetDirectoryName(target)) ||
                    !SamePath(LinkProperty(shortcut, "IconLocation"), target + ",0") ||
                    !SameBytes(bytes, ShortcutBytes(path))) return null;
                return new ShortcutRecord { Path = path, Bytes = bytes, Target = target };
            }
            catch (Exception) { return null; }
            finally { if (shortcut != null) Marshal.FinalReleaseComObject(shortcut); }
        }

        private static void CheckUnchanged(ShortcutRecord record)
        {
            if (!SameBytes(record.Bytes, ShortcutBytes(record.Path)))
                throw new IOException("Ярлык изменился во время обновления. Исходные файлы сохранены.");
        }

        public static string CreateShortcut(string desktop, string launcher)
        {
            return CreateShortcut(desktop, launcher, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "KAYVEL"));
        }

        internal static string CreateShortcut(string desktop, string launcher, string installationRoot)
        {
            desktop = Path.GetFullPath(desktop);
            launcher = Path.GetFullPath(launcher);
            string root = Path.GetFullPath(installationRoot);
            CheckDirectoryChain(desktop);
            if (!Directory.Exists(desktop)) throw new IOException("Не найден рабочий стол.");
            ValidateInstalledLauncher(launcher, root);
            string lockPath = Path.Combine(root, ".shortcut-update.lock");
            if (File.Exists(lockPath)) CheckPlainFile(lockPath);
            using (var guard = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            {
                string temporary = Path.Combine(desktop, "KAYVEL-" + Guid.NewGuid().ToString("N") + ".lnk");
                object shell = null;
                object shortcut = null;
                try
                {
                    Type type = Type.GetTypeFromProgID("WScript.Shell", true);
                    shell = Activator.CreateInstance(type);
                    var owned = new List<ShortcutRecord>();
                    var occupied = new HashSet<string>(Directory.GetFileSystemEntries(desktop), StringComparer.OrdinalIgnoreCase);
                    string available = null;
                    for (int i = 0; i < 1000; i++)
                    {
                        string name = i == 0 ? "KAYVEL v3S.lnk" : "KAYVEL v3S (" + (i + 1) + ").lnk";
                        string path = Path.Combine(desktop, name);
                        if (!occupied.Contains(path)) { if (available == null) available = path; continue; }
                        ShortcutRecord record = ReadOwnedShortcut(shell, path, root);
                        if (record != null) owned.Add(record);
                    }
                    string destination = owned.Count == 0 ? available : owned[0].Path;
                    if (destination == null) throw new IOException("Не удалось выбрать имя ярлыка.");
                    bool replace = owned.Count > 0 && !SamePath(owned[0].Target, launcher);
                    if (owned.Count == 1 && !replace) return destination;

                    shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { temporary });
                    Type linkType = shortcut.GetType();
                    linkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { launcher });
                    linkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { Path.GetDirectoryName(launcher) });
                    linkType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "KAYVEL v3S" });
                    linkType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { launcher + ",0" });
                    linkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
                    Marshal.FinalReleaseComObject(shortcut); shortcut = null;
                    CheckPlainFile(temporary);

                    string backup = null;
                    if (owned.Count > 0)
                    {
                        string backups = Path.Combine(root, ".shortcut-backups");
                        CheckDirectoryChain(backups);
                        Directory.CreateDirectory(backups);
                        CheckDirectoryChain(backups);
                        backup = Path.Combine(backups, Guid.NewGuid().ToString("N"));
                        Directory.CreateDirectory(backup);
                        CheckDirectoryChain(backup);
                        foreach (ShortcutRecord record in owned)
                        {
                            CheckUnchanged(record);
                            using (var output = new FileStream(Path.Combine(backup, Path.GetFileName(record.Path)), FileMode.CreateNew, FileAccess.Write, FileShare.None))
                            {
                                output.Write(record.Bytes, 0, record.Bytes.Length);
                                output.Flush(true);
                            }
                        }
                    }
                    if (owned.Count == 0) File.Move(temporary, destination);
                    else if (replace)
                    {
                        CheckUnchanged(owned[0]);
                        File.Replace(temporary, destination, Path.Combine(backup, "replaced.lnk"));
                    }
                    for (int i = 1; i < owned.Count; i++)
                    {
                        CheckUnchanged(owned[i]);
                        File.Move(owned[i].Path, Path.Combine(backup, Path.GetFileName(owned[i].Path) + ".removed"));
                    }
                    return destination;
                }
                finally
                {
                    if (shortcut != null) Marshal.FinalReleaseComObject(shortcut);
                    if (shell != null) Marshal.FinalReleaseComObject(shell);
                    if (File.Exists(temporary))
                    {
                        try { CheckPlainFile(temporary); File.Delete(temporary); }
                        catch (IOException) { } catch (UnauthorizedAccessException) { }
                    }
                }
            }
        }
    }

    internal sealed class BrandPanel : Panel
    {
        public BrandPanel() { DoubleBuffered = true; }
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            using (var background = new LinearGradientBrush(ClientRectangle, Color.FromArgb(57, 28, 43), Color.FromArgb(24, 18, 26), 65f))
                e.Graphics.FillRectangle(background, ClientRectangle);
            float scale = Width / 248f;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            PointF[] diamond = { new PointF(124 * scale, 116 * scale), new PointF(173 * scale, 165 * scale), new PointF(124 * scale, 214 * scale), new PointF(75 * scale, 165 * scale) };
            using (var fill = new LinearGradientBrush(new PointF(75 * scale, 116 * scale), new PointF(173 * scale, 214 * scale), Color.FromArgb(239, 120, 144), Color.FromArgb(150, 42, 72)))
                e.Graphics.FillPolygon(fill, diamond);
            using (var pen = new Pen(Color.FromArgb(100, 224, 100, 121), 1f))
            {
                e.Graphics.DrawPolygon(pen, new PointF[] { new PointF(124 * scale, 91 * scale), new PointF(198 * scale, 165 * scale), new PointF(124 * scale, 239 * scale), new PointF(50 * scale, 165 * scale) });
                e.Graphics.DrawLine(pen, 28 * scale, Height - 82 * scale, Width - 28 * scale, Height - 82 * scale);
            }
        }
    }

    internal sealed class SetupMeter : Control
    {
        private int value;
        private bool pending;
        public int Value { get { return value; } set { this.value = Math.Max(0, Math.Min(100, value)); AccessibleName = "Прогресс установки: " + this.value + "%"; Invalidate(); } }
        public bool Pending { get { return pending; } set { pending = value; Invalidate(); } }
        public SetupMeter() { DoubleBuffered = true; TabStop = false; }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Color.FromArgb(46, 35, 45));
            int width = pending ? Width / 3 : Width * value / 100;
            if (width > 0)
                using (var fill = new LinearGradientBrush(ClientRectangle, Color.FromArgb(172, 52, 80), Color.FromArgb(239, 120, 144), 0f))
                    e.Graphics.FillRectangle(fill, 0, 0, width, Height);
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly Label heading = new Label();
        private readonly Label stage = new Label();
        private readonly Label percentage = new Label();
        private readonly TextBox status = new TextBox();
        private readonly SetupMeter meter = new SetupMeter();
        private readonly Button action = new Button();
        private readonly Button cancel = new Button();
        private readonly UpdateHandoff handoff;
        private CancellationTokenSource cancellation;
        private bool switching;
        private string launcher;
        private static readonly Color Background = Color.FromArgb(22, 18, 25);
        private static readonly Color Muted = Color.FromArgb(190, 171, 181);
        private static readonly Color Accent = Color.FromArgb(239, 120, 144);

        private static Label Copy(Control parent, string text, int x, int y, int width, int height, float size, Color color, bool bold)
        {
            var label = new Label { Text = text, Left = x, Top = y, Width = width, Height = height, ForeColor = color,
                BackColor = Color.Transparent, Font = new Font("Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular) };
            parent.Controls.Add(label);
            return label;
        }

        private static void StyleButton(Button button, bool primary)
        {
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.BorderColor = primary ? Color.FromArgb(217, 105, 128) : Color.FromArgb(78, 56, 71);
            button.BackColor = primary ? Color.FromArgb(172, 52, 80) : Color.FromArgb(34, 26, 36);
            button.ForeColor = Color.FromArgb(255, 245, 248);
            button.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(193, 65, 95) : Color.FromArgb(56, 37, 51);
            button.FlatAppearance.MouseDownBackColor = Color.FromArgb(125, 40, 65);
            button.Font = new Font("Segoe UI", 10, FontStyle.Bold);
            button.Cursor = Cursors.Hand;
            button.UseVisualStyleBackColor = false;
        }

        public SetupForm() : this(null) { }
        internal SetupForm(UpdateHandoff handoff)
        {
            this.handoff = handoff;
            Text = "KAYVEL — установка v3S";
            Font = new Font("Segoe UI", 9);
            AutoScaleDimensions = new SizeF(96, 96);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(824, 536);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Background;
            ForeColor = Color.FromArgb(247, 237, 242);
            DoubleBuffered = true;
            ShowIcon = false;
            var brand = new BrandPanel { Left = 0, Top = 0, Width = 248, Height = 536 };
            Controls.Add(brand);
            Copy(brand, "K A Y V E L", 28, 34, 200, 28, 13, ForeColor, true);
            Copy(brand, "Твой мир.\nТвои правила.", 28, 282, 205, 86, 18, ForeColor, true);
            Copy(brand, "Начни своё приключение", 28, 381, 205, 25, 10, Muted, false);
            Copy(brand, "v3S   /   WINDOWS x64", 28, 476, 210, 25, 9, Muted, true);
            Copy(this, "KAYVEL  /  УСТАНОВКА", 280, 30, 510, 24, 9, Accent, true);
            heading.SetBounds(280, 67, 512, 47);
            heading.Font = new Font("Segoe UI", 25, FontStyle.Bold);
            heading.Text = "Всё готово к старту";
            Controls.Add(heading);
            Copy(this, "Установите лаунчер — и отправляйтесь в игру.", 282, 123, 510, 27, 10, Muted, false);
            var details = new Panel { Left = 282, Top = 173, Width = 508, Height = 127, BackColor = Color.FromArgb(33, 25, 35) };
            Controls.Add(details);
            Copy(details, "01", 18, 15, 30, 23, 10, Accent, true);
            Copy(details, "Лаунчер и Java уже внутри установщика", 56, 15, 440, 24, 10, ForeColor, false);
            Copy(details, "02", 18, 51, 30, 23, 10, Accent, true);
            Copy(details, "Minecraft и сборка скачаются при первом запуске игры", 56, 51, 440, 24, 9, Muted, false);
            Copy(details, "03", 18, 87, 30, 23, 10, Accent, true);
            Copy(details, "Старые установки, миры и настройки сохранятся", 56, 87, 440, 24, 9, Muted, false);
            stage.SetBounds(282, 326, 440, 25);
            stage.Font = new Font("Segoe UI", 10, FontStyle.Bold);
            stage.Text = "Ожидание установки";
            percentage.SetBounds(730, 326, 60, 25);
            percentage.TextAlign = ContentAlignment.TopRight;
            percentage.ForeColor = Muted;
            meter.SetBounds(282, 362, 508, 6);
            meter.AccessibleRole = AccessibleRole.ProgressBar;
            meter.Value = 0;
            status.SetBounds(282, 384, 508, 70);
            status.Multiline = true;
            status.ReadOnly = true;
            status.BorderStyle = BorderStyle.None;
            status.ScrollBars = ScrollBars.None;
            status.TextChanged += delegate {
                Size required = TextRenderer.MeasureText(status.Text, status.Font, new Size(status.Width, Int32.MaxValue), TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl);
                status.ScrollBars = required.Height > status.Height ? ScrollBars.Vertical : ScrollBars.None;
            };
            status.BackColor = Background;
            status.ForeColor = Muted;
            status.TabStop = true;
            status.AccessibleName = "Состояние установки";
            status.Text = handoff == null ? "Без прав администратора. Ярлык KAYVEL будет создан или обновлён на рабочем столе." : "После успешной установки старый лаунчер закроется и откроется новая версия.";
            action.SetBounds(282, 477, 314, 40);
            action.Text = "Установить KAYVEL";
            action.TabIndex = 0;
            cancel.SetBounds(610, 477, 180, 40);
            cancel.Text = "Закрыть";
            cancel.TabIndex = 1;
            StyleButton(action, true);
            StyleButton(cancel, false);
            Controls.AddRange(new Control[] { stage, percentage, meter, status, action, cancel });
            AcceptButton = action;
            CancelButton = cancel;
            action.Click += async delegate { await Install(); };
            cancel.Click += delegate {
                if (switching) return;
                if (cancellation != null) { cancellation.Cancel(); cancel.Enabled = false; stage.Text = "Останавливаем установку…"; }
                else Close();
            };
            FormClosing += delegate(object sender, FormClosingEventArgs e) {
                if (switching) { e.Cancel = true; return; }
                if (cancellation != null) { e.Cancel = true; cancellation.Cancel(); }
            };
        }

        private void ShowStage(string title, string detail, int value)
        {
            stage.Text = title;
            status.Text = detail;
            meter.Value = value;
            percentage.Text = meter.Pending ? "" : value + "%";
        }

        private async Task Install()
        {
            if (launcher != null)
            {
                try { OpenLauncher(); Close(); }
                catch (Exception) { status.Text = "Не удалось открыть лаунчер. Используйте ярлык на рабочем столе или папку установки:\r\n" + Path.GetDirectoryName(launcher); }
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
                heading.Text = "Устанавливаем KAYVEL";
                meter.Pending = true;
                ShowStage("01 / 03 · Проверка архива", "Проверяем закреплённый SHA-256 встроенного архива. Загрузка из сети не нужна.", 0);
                var progress = new Progress<int>(value => {
                    if (launcher != null || cancellation == null) return;
                    meter.Pending = false;
                    ShowStage("02 / 03 · Лаунчер и Java", "Распаковываем файлы в отдельную папку. Прежняя установка не изменяется.", value * 95 / 100);
                });
                string staging = Path.Combine(workspace, "app");
                await Task.Run(() => {
                    using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("launcher-payload.zip"))
                        InstallerCore.ExtractVerified(payload, settings, staging, progress, cancellation.Token);
                });
                cancellation.Token.ThrowIfCancellationRequested();
                InstallerCore.CheckDirectoryChain(parent);
                InstallerCore.CheckDirectoryChain(staging);
                string installed = Path.Combine(parent, "v3S-" + id);
                cancellation.Token.ThrowIfCancellationRequested();
                switching = true;
                cancel.Enabled = false;
                Directory.Move(staging, installed);
                launcher = Path.Combine(installed, "KAYVEL.exe");
                meter.Pending = false;
                ShowStage("03 / 03 · Ярлык на рабочем столе", "Обновляем ярлык KAYVEL. Посторонние ярлыки не изменяются.", 97);
                string completion;
                try
                {
                    InstallerCore.CreateShortcut(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), launcher);
                    completion = "Ярлык KAYVEL на рабочем столе готов. Прежние установки и игровые данные сохранены.";
                }
                catch (Exception)
                {
                    completion = "Лаунчер установлен, но ярлыки не удалось обновить полностью. Старые файлы сохранены. Папка:\r\n" + installed;
                }
                // Only this run's empty staging folder is disposable; old installations are never removed.
                try { Directory.Delete(workspace); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                heading.Text = "Добро пожаловать";
                ShowStage("Установка завершена", completion, 100);
                action.Text = "Открыть KAYVEL";
                action.Enabled = true;
                if (handoff != null)
                {
                    switching = true;
                    action.Enabled = false;
                    cancel.Enabled = false;
                    ShowStage("Переход на новую версию", "Ждём завершения старого лаунчера. Игра автоматически не запускается.", 100);
                    try
                    {
                        await handoff.Complete();
                        OpenLauncher();
                        switching = false;
                        CloseAfterInstall();
                    }
                    catch (Exception)
                    {
                        switching = false;
                        ShowStage("Лаунчер установлен", "Автоматический переход не завершён. Закройте старый лаунчер вручную, затем нажмите «Открыть KAYVEL».\r\n" + completion, 100);
                        action.Enabled = true;
                    }
                }
            }
            catch (Exception error)
            {
                meter.Pending = false;
                heading.Text = cancellation.IsCancellationRequested ? "Установка отменена" : "Не удалось установить";
                ShowStage(cancellation.IsCancellationRequested ? "Отменено" : "Установка остановлена", error.Message +
                    (workspace == null ? "" : "\r\nЧастичные файлы оставлены: " + workspace), meter.Value);
            }
            finally
            {
                switching = false;
                cancellation.Dispose(); cancellation = null;
                cancel.Text = "Закрыть"; cancel.Enabled = true;
            }
        }

        private void OpenLauncher()
        {
            Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(launcher) });
        }

        private void CloseAfterInstall()
        {
            BeginInvoke(new Action(Close));
        }
    }

    internal sealed class UpdateHandoff : IDisposable
    {
        private readonly Process parent;
        private readonly Stream input;
        private readonly Stream output;
        internal UpdateHandoff(Process parent, Stream input, Stream output)
        {
            this.parent = parent; this.input = input; this.output = output;
            // Capture a process handle now: a later PID lookup could refer to a different process.
            IntPtr handle = parent.Handle;
        }

        internal static UpdateHandoff FromArguments(string[] args)
        {
            if (args.Length == 0) return null;
            int pid;
            if (args.Length != 2 || args[0] != "--kayvel-update" || !args[1].StartsWith("--parent-pid=", StringComparison.Ordinal) ||
                !Int32.TryParse(args[1].Substring(13), out pid) || pid <= 0 || pid == Process.GetCurrentProcess().Id)
                throw new IOException("Неизвестные параметры установщика.");
            return new UpdateHandoff(Process.GetProcessById(pid), Console.OpenStandardInput(), Console.OpenStandardOutput());
        }

        internal static string ReadMessage(Stream stream)
        {
            var bytes = new List<byte>();
            for (int i = 0; i < 64; i++)
            {
                int value = stream.ReadByte();
                if (value == -1) throw new EndOfStreamException("Связь с лаунчером закрыта.");
                if (value == 10) return System.Text.Encoding.ASCII.GetString(bytes.ToArray());
                if (value < 32 || value > 126) throw new IOException("Некорректный ответ лаунчера.");
                bytes.Add((byte)value);
            }
            throw new IOException("Слишком длинный ответ лаунчера.");
        }

        internal Task Complete(int timeoutMilliseconds = 15000)
        {
            return Task.Run(() => {
                byte[] message = System.Text.Encoding.ASCII.GetBytes("KAYVEL_SETUP_READY_V1\n");
                output.Write(message, 0, message.Length);
                output.Flush();
                var response = Task.Run(() => ReadMessage(input));
                if (!response.Wait(timeoutMilliseconds)) { input.Dispose(); throw new IOException("Лаунчер не подтвердил переход."); }
                if (response.Result != "KAYVEL_SETUP_QUIT_V1") throw new IOException("Переход не подтверждён.");
                if (!parent.WaitForExit(timeoutMilliseconds)) throw new IOException("Старый лаунчер ещё работает.");
            });
        }

        public void Dispose()
        {
            input.Dispose(); output.Dispose(); parent.Dispose();
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                using (var handoff = UpdateHandoff.FromArguments(args))
                    Application.Run(new SetupForm(handoff));
            }
            catch (Exception)
            {
                MessageBox.Show("Не удалось связаться с запустившим установщик лаунчером. Закройте старый лаунчер и откройте установщик вручную без параметров.", "KAYVEL", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
    }
}
