using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace ProxyForge.WinForms
{
    internal sealed class MainForm : Form
    {
        private const int BackgroundColor = 0x101211;
        private const int SurfaceColor = 0x181B19;
        private const int BorderColor = 0x30372F;
        private const int TextColor = 0xEAF0E6;
        private const int MutedColor = 0x97A48F;
        private const int LimeColor = 0xCCF566;
        private readonly string root = FindProjectRoot();
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
        private readonly HttpClient http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(20) };
        private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        private readonly DataGridView grid = new DataGridView();
        private readonly ComboBox protocolFilter = new ComboBox();
        private readonly ComboBox countryFilter = new ComboBox();
        private readonly ComboBox statusFilter = new ComboBox();
        private readonly ComboBox checkMode = new ComboBox();
        private readonly ComboBox concurrency = new ComboBox();
        private readonly ComboBox timeout = new ComboBox();
        private readonly ComboBox protocolImport = new ComboBox();
        private readonly ComboBox pageSize = new ComboBox();
        private readonly TextBox search = new TextBox();
        private readonly ProgressBar progress = new ProgressBar();
        private readonly Label connectionLabel = new Label();
        private readonly Label statusLabel = new Label();
        private readonly Label countsLabel = new Label();
        private readonly Label jobLabel = new Label();
        private readonly Label etaLabel = new Label();
        private readonly Label pageLabel = new Label();
        private readonly Label autoLabel = new Label();
        private readonly Button collectButton = new Button();
        private readonly Button checkButton = new Button();
        private readonly Button stopButton = new Button();
        private readonly List<Button> jobButtons = new List<Button>();
        private Process pythonProcess;
        private string token;
        private int port;
        private bool polling;
        private bool closing;
        private int page = 1;
        private readonly Dictionary<string, object> sourceCache = new Dictionary<string, object>();
        private sealed class CountryChoice
        {
            public string Code;
            public string Label;
            public override string ToString() { return Label; }
        }

        private static string FindProjectRoot()
        {
            DirectoryInfo directory = new DirectoryInfo(Path.GetDirectoryName(typeof(MainForm).Assembly.Location));
            while (directory != null)
            {
                if (File.Exists(Path.Combine(directory.FullName, "proxyforge", "web.py"))) return directory.FullName;
                directory = directory.Parent;
            }
            return AppDomain.CurrentDomain.BaseDirectory;
        }

        public MainForm()
        {
            Text = "Proxy Forge — Desktop";
            Name = "ProxyForgeMainForm";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1050, 690);
            Size = new Size(1440, 900);
            BackColor = Hex(BackgroundColor);
            ForeColor = Hex(TextColor);
            Font = new Font("Segoe UI", 9F);
            FormBorderStyle = FormBorderStyle.Sizable;
            BuildInterface();
            Shown += async delegate { await StartEngineAsync(); };
            FormClosing += OnClosing;
        }

        private static Color Hex(int color) { return Color.FromArgb(255, (color >> 16) & 255, (color >> 8) & 255, color & 255); }

        private static Label TextLabel(string value, int size, Color color, bool bold)
        {
            return new Label { Text = value, AutoSize = true, ForeColor = color,
                Font = new Font("Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular) };
        }

        private static Label At(Label label, int x, int y)
        {
            label.Location = new Point(x, y);
            return label;
        }

        private static void ConfigureButton(Button button, bool primary, int width)
        {
            button.AutoSize = false;
            button.Size = new Size(width, 37);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.BorderColor = primary ? Hex(LimeColor) : Hex(BorderColor);
            button.BackColor = primary ? Hex(LimeColor) : Color.FromArgb(37, 42, 36);
            button.ForeColor = primary ? Color.FromArgb(25, 35, 14) : Hex(TextColor);
            button.Font = new Font("Segoe UI Semibold", 9F);
            button.Cursor = Cursors.Hand;
        }

        private static void StyleCombo(ComboBox box, int width)
        {
            box.DropDownStyle = ComboBoxStyle.DropDownList;
            box.Width = width;
            box.BackColor = Color.FromArgb(22, 27, 20);
            box.ForeColor = Hex(TextColor);
            box.FlatStyle = FlatStyle.Flat;
            box.IntegralHeight = false;
            box.DropDownHeight = 280;
            box.Font = new Font("Segoe UI", 8.5F);
        }

        private void BuildInterface()
        {
            var outer = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = Hex(BackgroundColor) };
            outer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 220));
            outer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Controls.Add(outer);

            var sidebar = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(20, 23, 21), Padding = new Padding(18) };
            sidebar.Controls.Add(At(TextLabel("◆  proxyforge.", 19, Hex(LimeColor), true), 20, 23));
            sidebar.Controls.Add(At(TextLabel("LOCAL WORKSPACE", 8, Hex(MutedColor), true), 22, 84));
            sidebar.Controls.Add(At(TextLabel("Python engine  ·  50 websites", 9, Hex(TextColor), false), 22, 107));
            sidebar.Controls.Add(At(TextLabel("────────────────────────", 10, Hex(BorderColor), false), 20, 137));
            sidebar.Controls.Add(At(TextLabel("COLLECTION", 8, Hex(MutedColor), true), 22, 164));
            sidebar.Controls.Add(At(TextLabel("Async I/O · 1 CPU friendly\nHTTPS/TLS verified · 4 protocols\nUp to 100,000 proxies", 9, Hex(TextColor), false), 22, 190));
            sidebar.Controls.Add(At(TextLabel("────────────────────────", 10, Hex(BorderColor), false), 20, 267));
            sidebar.Controls.Add(At(TextLabel("YOUR DATA", 8, Hex(MutedColor), true), 22, 296));
            sidebar.Controls.Add(At(TextLabel("Saved locally on this PC.\nPublic proxies can log traffic;\ndon't send passwords.", 9, Hex(MutedColor), false), 22, 321));
            var sourcesButton = new Button { Text = "Sources · manage", Location = new Point(20, 413), Size = new Size(165, 34), Anchor = AnchorStyles.Left | AnchorStyles.Top };
            ConfigureButton(sourcesButton, false, 165); sourcesButton.Click += async delegate { await ManageSourcesAsync(); }; sidebar.Controls.Add(sourcesButton);
            var geoCredit = new LinkLabel { Text = "IP Geolocation by DB-IP", AutoSize = true, Location = new Point(20, 470), LinkColor = Hex(MutedColor), ActiveLinkColor = Hex(LimeColor) };
            geoCredit.LinkClicked += delegate { Process.Start(new ProcessStartInfo("https://db-ip.com") { UseShellExecute = true }); };
            sidebar.Controls.Add(geoCredit);
            var asnCredit = new LinkLabel { Text = "ASN by IPtoASN", AutoSize = true, Location = new Point(20, 495), LinkColor = Hex(MutedColor), ActiveLinkColor = Hex(LimeColor) };
            asnCredit.LinkClicked += delegate { Process.Start(new ProcessStartInfo("https://iptoasn.com") { UseShellExecute = true }); };
            sidebar.Controls.Add(asnCredit);
            outer.Controls.Add(sidebar, 0, 0);

            var main = new Panel { Dock = DockStyle.Fill, Padding = new Padding(27, 17, 27, 15), BackColor = Hex(BackgroundColor), AutoScroll = true };
            outer.Controls.Add(main, 1, 0);
            main.Controls.Add(At(TextLabel("WORKSPACE     /     DESKTOP COMMAND CENTER", 8, Hex(MutedColor), true), 30, 21));
            connectionLabel.Text = "●  Starting Python engine…"; connectionLabel.AutoSize = true; connectionLabel.ForeColor = Hex(MutedColor); connectionLabel.Anchor = AnchorStyles.Top | AnchorStyles.Right; connectionLabel.Location = new Point(850, 18); main.Controls.Add(connectionLabel);
            main.Controls.Add(At(TextLabel("Every proxy. One place.", 26, Hex(TextColor), true), 28, 55));
            main.Controls.Add(At(TextLabel("Collect wide. Verify for real. Keep useful results.", 10, Hex(MutedColor), false), 31, 100));

            var stats = new TableLayoutPanel { Location = new Point(28, 139), Size = new Size(1100, 103), Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right, ColumnCount = 4, RowCount = 1, BackColor = Hex(BackgroundColor) };
            for (int i = 0; i < 4; i++) { stats.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25)); var cardPanel = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 11, 0), BackColor = Hex(SurfaceColor), Padding = new Padding(14) }; stats.Controls.Add(cardPanel, i, 0); }
            string[] titles = { "TOTAL PROXIES", "HTTPS ALIVE", "PUBLIC FEEDS", "AVG. LATENCY" };
            for (int i = 0; i < stats.Controls.Count; i++)
            {
                Panel card = stats.Controls[i] as Panel;
                card.Controls.Add(At(TextLabel(titles[i], 8, Hex(MutedColor), true), 14, 13));
                Label value = TextLabel(i == 0 ? "0" : "—", 23, i == 1 ? Hex(LimeColor) : Hex(TextColor), true);
                value.Name = "stat" + i;
                value.Location = new Point(14, 38);
                card.Controls.Add(value);
            }
            main.Controls.Add(stats);

            var panel = new Panel { Location = new Point(28, 258), Size = new Size(1100, 160), Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right, BackColor = Hex(SurfaceColor), Padding = new Padding(17) };
            main.Controls.Add(panel);
            panel.Controls.Add(At(TextLabel("COLLECT & VERIFY", 10, Hex(TextColor), true), 17, 13));
            autoLabel.Text = "Backend starts automatically · Every 60 seconds · HTTPS live only"; autoLabel.AutoSize = true; autoLabel.ForeColor = Hex(MutedColor); autoLabel.Location = new Point(17, 39); panel.Controls.Add(autoLabel);
            collectButton.Text = "Resume auto"; collectButton.Visible = false; ConfigureButton(collectButton, true, 170); collectButton.Location = new Point(17, 77); collectButton.Click += async delegate { await CollectAsync(); }; panel.Controls.Add(collectButton); jobButtons.Add(collectButton);
            checkButton.Text = "Collect + check now"; ConfigureButton(checkButton, false, 150); checkButton.Location = new Point(197, 77); checkButton.Click += async delegate { await CheckAsync(); }; panel.Controls.Add(checkButton); jobButtons.Add(checkButton);
            stopButton.Text = "■  Stop"; ConfigureButton(stopButton, false, 90); stopButton.ForeColor = Color.FromArgb(242, 162, 147); stopButton.Location = new Point(357, 77); stopButton.Enabled = false; stopButton.Click += async delegate { try { await PostAsync("/api/stop", new Dictionary<string, object>()); await PollAsync(); } catch (Exception ex) { ShowError(ex); } }; panel.Controls.Add(stopButton);
            StyleCombo(checkMode, 194); checkMode.Items.Add("HTTPS real · verify TLS"); checkMode.SelectedIndex = 0; checkMode.Enabled = false; checkMode.Location = new Point(466, 82); panel.Controls.Add(checkMode);
            StyleCombo(concurrency, 155); concurrency.Items.AddRange(new object[] { "256", "1,024", "2,048", "5,000", "10,000 · concurrent" }); concurrency.SelectedIndex = 4; concurrency.Location = new Point(670, 82); panel.Controls.Add(concurrency);
            StyleCombo(timeout, 128); timeout.Items.Add("3 seconds · total"); timeout.SelectedIndex = 0; timeout.Enabled = false; timeout.Location = new Point(835, 82); panel.Controls.Add(timeout);
            progress.Location = new Point(17, 126); progress.Size = new Size(790, 7); progress.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom; progress.Style = ProgressBarStyle.Continuous; progress.Maximum = 100; panel.Controls.Add(progress);
            jobLabel.Text = "Ready — start by collecting sources."; jobLabel.AutoSize = true; jobLabel.ForeColor = Hex(MutedColor); jobLabel.Font = new Font("Segoe UI", 8F); jobLabel.Location = new Point(818, 126); panel.Controls.Add(jobLabel);

            var toolbar = new Panel { Location = new Point(28, 437), Size = new Size(1100, 48), Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right };
            main.Controls.Add(toolbar);
            toolbar.Controls.Add(At(TextLabel("PROXY INVENTORY", 10, Hex(TextColor), true), 2, 11));
            StyleCombo(countryFilter, 150); countryFilter.Location = new Point(240, 6); countryFilter.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            countryFilter.Items.Add(new CountryChoice { Code = "all", Label = "All countries (249)" });
            countryFilter.Items.Add(new CountryChoice { Code = "unknown", Label = "Unknown location" });
            try
            {
                string[] countryCodes = serializer.Deserialize<string[]>(File.ReadAllText(Path.Combine(root, "public", "countries.json")));
                foreach (string code in countryCodes)
                {
                    string label = code;
                    try { label = new RegionInfo(code).DisplayName + " (" + code + ")"; } catch (ArgumentException) { }
                    countryFilter.Items.Add(new CountryChoice { Code = code, Label = label });
                }
            }
            catch (Exception error) { Debug.WriteLine(error); }
            countryFilter.SelectedIndex = 0; countryFilter.SelectedIndexChanged += async delegate { page = 1; await RefreshGridAsync(); }; toolbar.Controls.Add(countryFilter);
            StyleCombo(statusFilter, 150); statusFilter.Items.AddRange(new object[] { "Live proxies only", "HTTPS alive" }); statusFilter.SelectedIndex = 0; statusFilter.Anchor = AnchorStyles.Top | AnchorStyles.Right; statusFilter.Location = new Point(400, 6); statusFilter.SelectedIndexChanged += async delegate { page = 1; await RefreshGridAsync(); }; toolbar.Controls.Add(statusFilter);
            StyleCombo(protocolFilter, 125); protocolFilter.Items.AddRange(new object[] { "All protocols", "HTTP", "HTTPS", "SOCKS4", "SOCKS5" }); protocolFilter.SelectedIndex = 0; protocolFilter.Anchor = AnchorStyles.Top | AnchorStyles.Right; protocolFilter.Location = new Point(560, 6); protocolFilter.SelectedIndexChanged += async delegate { page = 1; await RefreshGridAsync(); }; toolbar.Controls.Add(protocolFilter);
            search.BackColor = Color.FromArgb(22, 27, 20); search.ForeColor = Hex(TextColor); search.BorderStyle = BorderStyle.FixedSingle; search.Size = new Size(158, 25); search.Anchor = AnchorStyles.Top | AnchorStyles.Right; search.Location = new Point(695, 8); search.TextChanged += async delegate { page = 1; await RefreshGridAsync(); }; toolbar.Controls.Add(search);
            var import = new Button { Text = "Import" }; ConfigureButton(import, false, 76); import.Anchor = AnchorStyles.Top | AnchorStyles.Right; import.Location = new Point(865, 3); import.Click += async delegate { await ImportAsync(); }; toolbar.Controls.Add(import);
            var export = new Button { Text = "Export" }; ConfigureButton(export, false, 76); export.Anchor = AnchorStyles.Top | AnchorStyles.Right; export.Location = new Point(947, 3); export.Click += async delegate { await ExportAsync(); }; toolbar.Controls.Add(export);
            grid.Location = new Point(28, 488); grid.Size = new Size(1100, 295); grid.Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right | AnchorStyles.Bottom;
            grid.BackgroundColor = Hex(SurfaceColor); grid.BorderStyle = BorderStyle.None; grid.GridColor = Hex(BorderColor); grid.RowHeadersVisible = false;
            grid.AllowUserToAddRows = false; grid.AllowUserToDeleteRows = false; grid.ReadOnly = true; grid.MultiSelect = false; grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            grid.EnableHeadersVisualStyles = false; grid.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(21, 26, 19); grid.ColumnHeadersDefaultCellStyle.ForeColor = Hex(MutedColor); grid.ColumnHeadersDefaultCellStyle.SelectionBackColor = Color.FromArgb(21, 26, 19); grid.ColumnHeadersDefaultCellStyle.Font = new Font("Segoe UI Semibold", 8F); grid.ColumnHeadersHeight = 34;
            grid.DefaultCellStyle.BackColor = Hex(SurfaceColor); grid.DefaultCellStyle.ForeColor = Hex(TextColor); grid.DefaultCellStyle.SelectionBackColor = Color.FromArgb(48, 62, 37); grid.DefaultCellStyle.SelectionForeColor = Hex(LimeColor); grid.DefaultCellStyle.Font = new Font("Consolas", 9F); grid.RowTemplate.Height = 30;
            grid.Columns.Add("address", "PROXY ADDRESS"); grid.Columns.Add("protocol", "PROTOCOL"); grid.Columns.Add("status", "STATUS"); grid.Columns.Add("latency", "LATENCY"); grid.Columns.Add("exit", "EXIT IP"); grid.Columns.Add("server", "SERVER / ASN"); grid.Columns.Add("location", "LOCATION (APPROX.)"); grid.Columns.Add("sources", "SOURCE");
            grid.Columns[0].Width = 215; grid.Columns[1].Width = 85; grid.Columns[2].Width = 105; grid.Columns[3].Width = 85; grid.Columns[4].Width = 130; grid.Columns[5].Width = 200; grid.Columns[6].Width = 170; grid.Columns[7].AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill; grid.Columns[7].MinimumWidth = 100;
            grid.CellDoubleClick += delegate { if (grid.CurrentRow != null) { try { Clipboard.SetText(Convert.ToString(grid.CurrentRow.Cells[0].Value)); statusLabel.Text = "Copied proxy address."; } catch (Exception ex) { ShowError(ex); } } };
            main.Controls.Add(grid);
            statusLabel.Text = "HTTPS checks verify the tunnel and the destination certificate."; statusLabel.AutoSize = true; statusLabel.ForeColor = Hex(MutedColor); statusLabel.Font = new Font("Segoe UI", 8F); statusLabel.Location = new Point(30, 795); main.Controls.Add(statusLabel);
            etaLabel.Text = "Double-click a row to copy"; etaLabel.AutoSize = true; etaLabel.ForeColor = Hex(MutedColor); etaLabel.Anchor = AnchorStyles.Bottom | AnchorStyles.Right; etaLabel.Location = new Point(870, 795); main.Controls.Add(etaLabel);
            var previous = new Button { Text = "‹", Width = 34, Height = 26 }; ConfigureButton(previous, false, 34); previous.Anchor = AnchorStyles.Bottom | AnchorStyles.Right; previous.Location = new Point(935, 823); previous.Click += async delegate { page = Math.Max(1, page - 1); await RefreshGridAsync(); }; main.Controls.Add(previous);
            pageLabel.Text = "Page 1"; pageLabel.AutoSize = true; pageLabel.ForeColor = Hex(MutedColor); pageLabel.Anchor = AnchorStyles.Bottom | AnchorStyles.Right; pageLabel.Location = new Point(980, 831); main.Controls.Add(pageLabel);
            var next = new Button { Text = "›", Width = 34, Height = 26 }; ConfigureButton(next, false, 34); next.Anchor = AnchorStyles.Bottom | AnchorStyles.Right; next.Location = new Point(1031, 823); next.Click += async delegate { page++; await RefreshGridAsync(); }; main.Controls.Add(next);
            timer.Interval = 1200; timer.Tick += async delegate { await PollAsync(); };
            foreach (var button in jobButtons) button.Enabled = false;
        }

        private static int Numeric(object source, string key, int fallback)
        {
            var map = source as IDictionary<string, object>;
            int value;
            return map != null && map.ContainsKey(key) && Int32.TryParse(Convert.ToString(map[key]), out value) ? value : fallback;
        }

        private static string Str(object source, string key, string fallback)
        {
            var map = source as IDictionary<string, object>;
            return map != null && map.ContainsKey(key) && map[key] != null ? Convert.ToString(map[key]) : fallback;
        }

        private static object Get(object source, string key)
        {
            var map = source as IDictionary<string, object>;
            object value;
            return map != null && map.TryGetValue(key, out value) ? value : null;
        }

        private ProcessStartInfo PythonStart(string executable, string args, bool useLauncher)
        {
            var info = new ProcessStartInfo { FileName = executable, Arguments = args, WorkingDirectory = root,
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true, RedirectStandardError = true };
            info.EnvironmentVariables["PYTHONUTF8"] = "1";
            info.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            info.EnvironmentVariables["PYTHONPATH"] = root;
            info.EnvironmentVariables["PROXYFORGE_DATA"] = Environment.GetEnvironmentVariable("PROXYFORGE_DATA")
                ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ProxyForge");
            info.EnvironmentVariables["PORT"] = port.ToString();
            return info;
        }

        private async Task<int> RunCaptureAsync(string executable, string args, string expected)
        {
            try
            {
                using (var process = Process.Start(PythonStart(executable, args, false)))
                {
                    if (process == null) return -1;
                    var stdout = process.StandardOutput.ReadToEndAsync();
                    var stderr = process.StandardError.ReadToEndAsync();
                    await Task.Run(() => process.WaitForExit());
                    await Task.WhenAll(stdout, stderr);
                    if (!String.IsNullOrEmpty(expected) && process.ExitCode != 0 && !String.IsNullOrEmpty(stderr.Result))
                        Debug.WriteLine(stderr.Result);
                    return process.ExitCode;
                }
            }
            catch (System.ComponentModel.Win32Exception) { return -1; }
        }

        private async Task StartEngineAsync()
        {
            try
            {
                if (!File.Exists(Path.Combine(root, "proxyforge", "web.py"))) throw new FileNotFoundException("Python engine files not found.", root);
                var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
                string localData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ProxyForge");
                string privateVenv = Path.Combine(localData, ".venv", "Scripts", "python.exe");
                string[] candidates = {
                    Path.Combine(root, ".venv", "Scripts", "python.exe"),
                    privateVenv,
                    "python", "py"
                };
                string executable = null; string launcherArgs = "";
                foreach (string candidate in candidates)
                {
                    if (candidate.EndsWith("python.exe", StringComparison.OrdinalIgnoreCase) && !File.Exists(candidate)) continue;
                    string args = candidate.Equals("py", StringComparison.OrdinalIgnoreCase) ? "-3 -c \"import sys,aiohttp; assert sys.version_info >= (3,11)\"" : "-c \"import sys,aiohttp; assert sys.version_info >= (3,11)\"";
                    if (await RunCaptureAsync(candidate, args, "aiohttp") == 0)
                    { executable = candidate; launcherArgs = candidate.Equals("py", StringComparison.OrdinalIgnoreCase) ? "-3 " : ""; break; }
                }
                if (executable == null)
                {
                    string basePython = null;
                    string baseArgs = "";
                    foreach (string candidate in candidates)
                    {
                        if ((candidate.EndsWith("python.exe", StringComparison.OrdinalIgnoreCase) && !File.Exists(candidate)) || candidate == privateVenv) continue;
                        if (candidate.Equals("py", StringComparison.OrdinalIgnoreCase))
                        {
                            if (await RunCaptureAsync(candidate, "-3 -c \"import sys; assert sys.version_info >= (3,11)\"", "python") == 0) { basePython = candidate; baseArgs = "-3 "; break; }
                        }
                        else if (await RunCaptureAsync(candidate, "-c \"import sys; assert sys.version_info >= (3,11)\"", "python") == 0) { basePython = candidate; break; }
                    }
                    if (basePython == null) throw new InvalidOperationException("Python 3.11+ is required. Install Python and try again.");
                    Directory.CreateDirectory(localData);
                    connectionLabel.Text = "●  Creating private Python environment…";
                    var venvProcess = Process.Start(PythonStart(basePython, baseArgs + "-m venv \"" + Path.GetDirectoryName(Path.GetDirectoryName(privateVenv)) + "\"", false));
                    if (venvProcess == null) throw new InvalidOperationException("Could not create a private Python environment.");
                    await Task.Run(() => venvProcess.WaitForExit());
                    if (venvProcess.ExitCode != 0 || !File.Exists(privateVenv)) throw new InvalidOperationException("Python could not create the private environment.");
                    executable = privateVenv;
                    launcherArgs = "";
                    connectionLabel.Text = "●  Installing aiohttp…";
                    var install = Process.Start(PythonStart(executable, launcherArgs + "-m pip install -r requirements.txt", false));
                    if (install == null) throw new InvalidOperationException("Could not install the Python dependency.");
                    await Task.Run(() => install.WaitForExit());
                    if (install.ExitCode != 0) throw new InvalidOperationException("pip install failed. See README.md and run Run-Python.cmd first.");
                    using (var verify = Process.Start(PythonStart(executable, launcherArgs + "-c \"import aiohttp\"", false)))
                    { await Task.Run(() => verify.WaitForExit()); if (verify.ExitCode != 0) throw new InvalidOperationException("aiohttp is not installed in this Python environment."); }
                }
                var info = PythonStart(executable, launcherArgs + "-m proxyforge.web", false);
                pythonProcess = Process.Start(info);
                if (pythonProcess == null) throw new InvalidOperationException("Python engine could not start.");
                pythonProcess.ErrorDataReceived += (sender, args) => { if (!String.IsNullOrWhiteSpace(args.Data)) Debug.WriteLine(args.Data); };
                pythonProcess.BeginErrorReadLine();
                pythonProcess.OutputDataReceived += (sender, args) => { if (!String.IsNullOrWhiteSpace(args.Data)) Debug.WriteLine(args.Data); };
                pythonProcess.BeginOutputReadLine();
                http.BaseAddress = new Uri("http://127.0.0.1:" + port + "/");
                bool connected = false;
                for (int attempt = 0; attempt < 60 && !connected; attempt++)
                {
                    if (pythonProcess.HasExited) throw new InvalidOperationException("Python server stopped unexpectedly.");
                    bool retry = false;
                    try
                    {
                        using (HttpResponseMessage response = await http.GetAsync("api/state"))
                        {
                            if (response.IsSuccessStatusCode)
                            {
                                var state = serializer.DeserializeObject(await response.Content.ReadAsStringAsync()) as IDictionary<string, object>;
                                token = Str(state, "token", ""); connected = !String.IsNullOrEmpty(token);
                            }
                        }
                    }
                    catch (HttpRequestException) { retry = true; }
                    catch (TaskCanceledException) { retry = true; }
                    if (retry) await Task.Delay(200);
                }
                if (!connected) throw new TimeoutException("Python server did not become ready.");
                connectionLabel.Text = "●  Local Python engine connected"; connectionLabel.ForeColor = Hex(LimeColor);
                timer.Start(); await PollAsync();
            }
            catch (Exception error) { connectionLabel.Text = "●  Engine offline"; connectionLabel.ForeColor = Color.Salmon; ShowError(error); }
        }

        private async Task<object> GetJsonAsync(string path)
        {
            using (HttpResponseMessage response = await http.GetAsync(path))
            {
                string body = await response.Content.ReadAsStringAsync();
                if (!response.IsSuccessStatusCode) throw new InvalidOperationException(ErrorBody(body, (int)response.StatusCode));
                return serializer.DeserializeObject(body);
            }
        }

        private async Task<IDictionary<string, object>> GetAsync(string path)
        {
            return await GetJsonAsync(path) as IDictionary<string, object>;
        }

        private static string ErrorBody(string body, int code)
        {
            try { var data = new JavaScriptSerializer().DeserializeObject(body) as IDictionary<string, object>; return data != null && data.ContainsKey("error") ? Convert.ToString(data["error"]) : "HTTP " + code; }
            catch { return "HTTP " + code; }
        }

        private async Task<IDictionary<string, object>> PostAsync(string path, IDictionary<string, object> values)
        {
            if (String.IsNullOrEmpty(token)) throw new InvalidOperationException("Python engine is still starting or offline. Check the connection status and try again.");
            var content = new StringContent(serializer.Serialize(values), Encoding.UTF8, "application/json");
            content.Headers.ContentType.CharSet = "utf-8";
            var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = content };
            request.Headers.Add("X-Proxy-Forge-Token", token);
            using (request)
            using (HttpResponseMessage response = await http.SendAsync(request))
            {
                string body = await response.Content.ReadAsStringAsync();
                if (!response.IsSuccessStatusCode) throw new InvalidOperationException(ErrorBody(body, (int)response.StatusCode));
                return serializer.DeserializeObject(body) as IDictionary<string, object>;
            }
        }

        private async Task PollAsync()
        {
            if (polling || String.IsNullOrEmpty(token) || IsDisposed) return;
            polling = true;
            try
            {
                var state = await GetAsync("api/state");
                connectionLabel.Text = "●  Local Python engine connected"; connectionLabel.ForeColor = Hex(LimeColor);
                var counts = Get(state, "counts") as IDictionary<string, object>;
                var sourceInfo = Get(state, "sources") as IDictionary<string, object>;
                var stat0 = Controls.Find("stat0", true).FirstOrDefault();
                var stat1 = Controls.Find("stat1", true).FirstOrDefault();
                var stat2 = Controls.Find("stat2", true).FirstOrDefault();
                var stat3 = Controls.Find("stat3", true).FirstOrDefault();
                if (counts != null)
                {
                    if (stat0 != null) stat0.Text = Numeric(counts, "total", 0).ToString("N0");
                    if (stat1 != null) stat1.Text = Numeric(counts, "alive", 0).ToString("N0");
                    if (stat3 != null) stat3.Text = Numeric(state, "latencyMs", -1) < 0 ? "—" : Numeric(state, "latencyMs", 0).ToString("N0") + " ms";
                }
                if (stat2 != null && sourceInfo != null) stat2.Text = Numeric(sourceInfo, "total", 0).ToString("N0") + " feeds";
                var job = Get(state, "job") as IDictionary<string, object>;
                var auto = Get(state, "automation");
                bool autoEnabled = Object.Equals(Get(auto, "enabled"), true);
                bool busy = Str(job, "state", "") == "running";
                foreach (var button in jobButtons) button.Enabled = !busy;
                collectButton.Enabled = !busy && !autoEnabled;
                collectButton.Visible = !autoEnabled;
                stopButton.Enabled = busy || autoEnabled;
                concurrency.Enabled = !busy && !autoEnabled;
                if (autoEnabled)
                {
                    int selected = Array.IndexOf(ConcurrencyValues, Numeric(Get(auto, "options"), "concurrency", 10000));
                    if (selected >= 0) concurrency.SelectedIndex = selected;
                }
                double nextRun;
                double.TryParse(Str(auto, "nextRunAtMs", "0"), NumberStyles.Any, CultureInfo.InvariantCulture, out nextRun);
                double now = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
                autoLabel.Text = autoEnabled ? busy ? "Backend auto · Every 60 seconds · Updating HTTPS live proxies…"
                    : "Backend auto · Every 60 seconds · Next round in " + Math.Max(0, Math.Ceiling((nextRun - now) / 1000)).ToString("N0") + "s · " + Numeric(auto, "rounds", 0) + " rounds completed"
                    : "Paused for this session · Backend resumes automatically on restart";
                if (Get(auto, "error") != null) autoLabel.Text += " · " + Str(auto, "error", "");
                if (job != null)
                {
                    int total = Numeric(job, "total", 0); int done = Numeric(job, "completed", 0);
                    progress.Value = total == 0 ? 0 : Math.Min(progress.Maximum, done * progress.Maximum / total);
                    string kind = Str(job, "type", "task");
                    string phase = Str(job, "phase", kind);
                    jobLabel.Text = (phase == "location" && busy ? "Locate / ASN" : phase == "collect" && busy ? "Collect" : phase == "check" && busy ? "Check HTTPS" : kind == "refresh" ? "Refresh" : "Check") + "  " + done.ToString("N0") + " / " + total.ToString("N0");
                    etaLabel.Text = "Elapsed " + (Numeric(job, "elapsedMs", 0) / 1000).ToString("N0") + "s  ·  " + Numeric(job, "rate", 0).ToString("N0") + " proxy/s";
                    statusLabel.Text = kind == "refresh"
                        ? Numeric(job, "added", 0).ToString("N0") + " new candidates · " + Numeric(job, "networkChecked", 0).ToString("N0") + " checked · " + Numeric(job, "liveAdded", 0).ToString("N0") + " new live · " + Numeric(job, "removed", 0).ToString("N0") + " dead removed"
                        : Numeric(job, "networkChecked", 0).ToString("N0") + " measured · " + Numeric(job, "removed", 0).ToString("N0") + " dead removed · " + Str(job, "geoWarning", "Server/location is approximate.");
                }
                if ((DateTime.UtcNow - lastGridRefresh).TotalMilliseconds > 1700 || !busy) await RefreshGridAsync();
            }
            catch (Exception error)
            {
                connectionLabel.Text = "●  Reconnecting…"; connectionLabel.ForeColor = Color.Salmon;
                Debug.WriteLine(error);
            }
            finally { polling = false; }
        }

        private DateTime lastGridRefresh = DateTime.MinValue;
        private async Task RefreshGridAsync()
        {
            if (String.IsNullOrEmpty(token) || polling && (DateTime.UtcNow - lastGridRefresh).TotalMilliseconds < 900) return;
            try
            {
                string[] states = { "all", "alive" };
                string[] protocols = { "all", "http", "https", "socks4", "socks5" };
                string query = "api/proxies?status=" + Uri.EscapeDataString(states[Math.Max(0, statusFilter.SelectedIndex)]) +
                    "&protocol=" + Uri.EscapeDataString(protocols[Math.Max(0, protocolFilter.SelectedIndex)]) +
                    "&country=" + Uri.EscapeDataString(countryFilter.SelectedItem is CountryChoice ? ((CountryChoice)countryFilter.SelectedItem).Code : "all") +
                    "&page=" + page + "&pageSize=50&search=" + Uri.EscapeDataString(search.Text ?? "");
                var result = await GetAsync(query);
                var rows = Get(result, "rows") as object[];
                grid.SuspendLayout(); grid.Rows.Clear();
                if (rows != null)
                {
                    foreach (object item in rows)
                    {
                        var proxy = item as IDictionary<string, object>; if (proxy == null) continue;
                        string host = Str(proxy, "host", ""); int portValue = Numeric(proxy, "port", 0);
                        string address = (host.Contains(":") ? "[" + host + "]" : host) + ":" + portValue;
                        object latency = Get(proxy, "latencyMs");
                        string latencyText = latency == null ? "—" : Convert.ToString(latency) + " ms";
                        var sources = Get(proxy, "sources") as object[];
                        string sourceName = sources == null || sources.Length == 0 ? "manual" : Convert.ToString(sources[0]).Split('-')[0] + (sources.Length > 1 ? " +" + (sources.Length - 1) : "");
                        string country = Str(proxy, "countryCode", ""); string countryName = Str(proxy, "country", country);
                        if (!String.IsNullOrEmpty(country)) { try { countryName = new RegionInfo(country).DisplayName; } catch (ArgumentException) { } }
                        string city = Str(proxy, "city", ""); string server = Str(proxy, "server", "—");
                        if (Get(proxy, "asn") != null) server += " · AS" + Str(proxy, "asn", "");
                        grid.Rows.Add(address, Str(proxy, "protocol", "").ToUpperInvariant(), Str(proxy, "status", ""), latencyText,
                            Str(proxy, "exitIP", "—"), server, countryName + (String.IsNullOrEmpty(city) ? "" : " · " + city), sourceName);
                    }
                }
                int pages = Math.Max(1, Numeric(result, "pages", 1));
                if (page > pages) page = pages;
                pageLabel.Text = "Page " + page + " / " + pages + "  ·  " + Numeric(result, "total", 0).ToString("N0") + " proxies";
                lastGridRefresh = DateTime.UtcNow;
                grid.ResumeLayout();
            }
            catch (Exception error) { statusLabel.Text = "Could not refresh inventory: " + error.Message; Debug.WriteLine(error); }
        }

        private static int[] ConcurrencyValues = { 256, 1024, 2048, 5000, 10000 };
        private int SelectedConcurrency { get { return ConcurrencyValues[Math.Max(0, concurrency.SelectedIndex)]; } }

        private async Task CollectAsync()
        {
            try { await PostAsync("api/auto", new Dictionary<string, object> { { "enabled", true }, { "limit", 100000 }, { "concurrency", SelectedConcurrency } }); statusLabel.Text = "Auto every 60 seconds · 3-second timeout · HTTPS live output only"; await PollAsync(); }
            catch (Exception error) { ShowError(error); }
        }

        private async Task CheckAsync()
        {
            try { await PostAsync("api/refresh", new Dictionary<string, object> { { "limit", 100000 }, { "concurrency", SelectedConcurrency } }); statusLabel.Text = "Collecting fresh sources and checking every candidate · live output only"; await PollAsync(); }
            catch (Exception error) { ShowError(error); }
        }

        private async Task ImportAsync()
        {
            using (var dialog = new OpenFileDialog { Filter = "Proxy lists (*.txt;*.csv;*.json)|*.txt;*.csv;*.json|All files (*.*)|*.*", Multiselect = false })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    if (new FileInfo(dialog.FileName).Length > 8 * 1024 * 1024) throw new InvalidOperationException("Import files must be 8 MB or smaller.");
                    string text = await Task.Run(() => File.ReadAllText(dialog.FileName, Encoding.UTF8));
                    var result = await PostAsync("api/import", new Dictionary<string, object> { { "text", text }, { "protocol", new[] { "http", "https", "socks4", "socks5" }[Math.Max(0, protocolImport.SelectedIndex)] } });
                    statusLabel.Text = Numeric(result, "added", 0).ToString("N0") + " proxies received; checking HTTPS before showing live results.";
                    await RefreshGridAsync();
                }
                catch (Exception error) { ShowError(error); }
            }
        }

        private async Task ExportAsync()
        {
            using (var dialog = new SaveFileDialog { Filter = "TXT (*.txt)|*.txt|CSV (*.csv)|*.csv|JSON (*.json)|*.json", FileName = "proxy-forge-alive.txt", AddExtension = true })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    string extension = Path.GetExtension(dialog.FileName).TrimStart('.').ToLowerInvariant();
                    if (extension != "csv" && extension != "json") extension = "txt";
                    string url = "api/export?format=" + extension + "&status=alive&protocol=all&country=" + Uri.EscapeDataString(countryFilter.SelectedItem is CountryChoice ? ((CountryChoice)countryFilter.SelectedItem).Code : "all");
                    using (HttpResponseMessage response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead))
                    {
                        response.EnsureSuccessStatusCode();
                        using (var input = await response.Content.ReadAsStreamAsync())
                        using (var output = new FileStream(dialog.FileName, FileMode.Create, FileAccess.Write, FileShare.None, 65536, true))
                            await input.CopyToAsync(output);
                    }
                    statusLabel.Text = "Saved HTTPS-verified proxies: " + dialog.FileName;
                }
                catch (Exception error) { ShowError(error); }
            }
        }

        private async Task ManageSourcesAsync()
        {
            try
            {
                var response = await GetJsonAsync("api/sources");
                var sources = response as object[];
                if (sources == null) throw new InvalidOperationException("Source list is unavailable.");
                using (var form = new Form { Text = "Manage public feeds", Size = new Size(780, 630), MinimumSize = new Size(640, 480), StartPosition = FormStartPosition.CenterParent, BackColor = Hex(BackgroundColor), ForeColor = Hex(TextColor), Font = Font })
                {
                    var list = new CheckedListBox { Dock = DockStyle.Fill, BackColor = Hex(SurfaceColor), ForeColor = Hex(TextColor), BorderStyle = BorderStyle.FixedSingle, CheckOnClick = true, IntegralHeight = false, Font = new Font("Segoe UI", 9F) };
                    foreach (object value in sources)
                    {
                        var source = value as IDictionary<string, object>; if (source == null) continue;
                        string name = Str(source, "name", "feed"); string url = Str(source, "url", ""); string status = Str(source, "status", "idle");
                        list.Items.Add(name + "   ·   " + status + "   ·   " + url, Object.Equals(Get(source, "enabled"), true));
                        sourceCache["@" + list.Items.Count] = source;
                    }
                    var footer = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 58, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(8) };
                    var save = new Button { Text = "Save enabled feeds" }; ConfigureButton(save, true, 155);
                    var add = new Button { Text = "Add HTTPS source" }; ConfigureButton(add, false, 145);
                    var all = new Button { Text = "Enable all" }; ConfigureButton(all, false, 95);
                    save.Click += async delegate {
                        try
                        {
                            var ids = new List<string>();
                            for (int i = 0; i < list.Items.Count; i++) if (list.GetItemChecked(i))
                            { var entry = sourceCache["@" + (i + 1)] as IDictionary<string, object>; ids.Add(Str(entry, "id", "")); }
                            await PostAsync("api/sources/toggle", new Dictionary<string, object> { { "ids", ids }, { "enabled", true } });
                            var allSources = (await GetJsonAsync("api/sources")) as object[];
                            var enabled = new HashSet<string>(ids);
                            var disabled = allSources == null ? new List<string>() : allSources.Select(item => Str(item, "id", "")).Where(id => !enabled.Contains(id)).ToList();
                            if (disabled.Count > 0) await PostAsync("api/sources/toggle", new Dictionary<string, object> { { "ids", disabled }, { "enabled", false } });
                            form.DialogResult = DialogResult.OK; form.Close();
                        }
                        catch (Exception error) { ShowError(error); }
                    };
                    all.Click += delegate { for (int i = 0; i < list.Items.Count; i++) list.SetItemChecked(i, true); };
                    add.Click += async delegate {
                        using (var dialog = new AddSourceForm())
                        {
                            if (dialog.ShowDialog(form) != DialogResult.OK) return;
                            try
                            {
                                await PostAsync("api/sources/add", new Dictionary<string, object> { { "name", dialog.SourceName }, { "url", dialog.SourceUrl }, { "protocol", dialog.Protocol } });
                                list.Items.Add(dialog.SourceName + "   ·   idle   ·   " + dialog.SourceUrl, true);
                                var newSources = (await GetJsonAsync("api/sources")) as object[];
                                var newSource = newSources == null ? null : newSources.Cast<object>().Select(item => item as IDictionary<string, object>).FirstOrDefault(item => item != null && Str(item, "url", "") == dialog.SourceUrl);
                                if (newSource != null) sourceCache["@" + list.Items.Count] = newSource;
                            }
                            catch (Exception error) { ShowError(error); }
                        }
                    };
                    footer.Controls.Add(save); footer.Controls.Add(add); footer.Controls.Add(all); form.Controls.Add(list); form.Controls.Add(footer); form.ShowDialog(this);
                    sourceCache.Clear();
                    await PollAsync();
                }
            }
            catch (Exception error) { ShowError(error); }
        }

        private void ShowError(Exception error)
        {
            if (IsDisposed) return;
            MessageBox.Show(this, error.Message, "Proxy Forge", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        private async void OnClosing(object sender, FormClosingEventArgs args)
        {
            if (closing) return;
            args.Cancel = true;
            closing = true;
            timer.Stop();
            try { if (!String.IsNullOrEmpty(token)) await PostAsync("api/stop", new Dictionary<string, object> { { "preserveAuto", true } }); } catch (Exception error) { Debug.WriteLine(error); }
            try { http.Dispose(); } catch { }
            try
            {
                if (pythonProcess != null && !pythonProcess.HasExited)
                {
                    using (var terminate = Process.Start(new ProcessStartInfo("taskkill.exe", "/PID " + pythonProcess.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true }))
                    { if (terminate != null) await Task.Run(() => terminate.WaitForExit()); }
                    pythonProcess.Dispose();
                }
            }
            catch (Exception error) { Debug.WriteLine(error); }
            Close();
        }
    }

    internal sealed class AddSourceForm : Form
    {
        private readonly TextBox nameBox = new TextBox();
        private readonly TextBox urlBox = new TextBox();
        private readonly ComboBox protocolBox = new ComboBox();
        public string SourceName { get { return nameBox.Text.Trim(); } }
        public string SourceUrl { get { return urlBox.Text.Trim(); } }
        public string Protocol { get { return protocolBox.SelectedItem == null ? "http" : Convert.ToString(protocolBox.SelectedItem).ToLowerInvariant(); } }

        public AddSourceForm()
        {
            Text = "Add public HTTPS feed"; Size = new Size(510, 340); MinimumSize = new Size(430, 310); StartPosition = FormStartPosition.CenterParent;
            BackColor = Color.FromArgb(16, 18, 17); ForeColor = Color.FromArgb(234, 240, 230); Font = new Font("Segoe UI", 9F);
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(20), ColumnCount = 1, RowCount = 8 };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 35)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 27)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 35)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 27)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 35)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 45));
            layout.Controls.Add(new Label { Text = "Public source · HTTPS only · no login required", AutoSize = true, ForeColor = Color.FromArgb(160, 178, 143) }, 0, 0);
            nameBox.Dock = DockStyle.Fill; nameBox.BackColor = Color.FromArgb(23, 27, 22); nameBox.ForeColor = Color.White; nameBox.BorderStyle = BorderStyle.FixedSingle;
            layout.Controls.Add(new Label { Text = "Source name", AutoSize = true }, 0, 1); layout.Controls.Add(nameBox, 0, 2);
            urlBox.Dock = DockStyle.Fill; urlBox.BackColor = Color.FromArgb(23, 27, 22); urlBox.ForeColor = Color.White; urlBox.BorderStyle = BorderStyle.FixedSingle;
            layout.Controls.Add(new Label { Text = "Feed URL", AutoSize = true }, 0, 3); layout.Controls.Add(urlBox, 0, 4);
            protocolBox.DropDownStyle = ComboBoxStyle.DropDownList; protocolBox.Items.AddRange(new object[] { "HTTP", "HTTPS", "SOCKS4", "SOCKS5" }); protocolBox.SelectedIndex = 0; protocolBox.Dock = DockStyle.Left; protocolBox.Width = 140; protocolBox.BackColor = Color.FromArgb(23, 27, 22); protocolBox.ForeColor = Color.White;
            layout.Controls.Add(new Label { Text = "Default proxy protocol", AutoSize = true }, 0, 5); layout.Controls.Add(protocolBox, 0, 6);
            var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft };
            var save = new Button { Text = "Add source", DialogResult = DialogResult.OK, Width = 110, Height = 32, BackColor = Color.FromArgb(204, 245, 102), ForeColor = Color.FromArgb(28, 39, 17), FlatStyle = FlatStyle.Flat };
            var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Width = 90, Height = 32, BackColor = Color.FromArgb(36, 41, 35), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
            save.Click += (sender, args) => { Uri parsed; if (!Uri.TryCreate(urlBox.Text, UriKind.Absolute, out parsed) || parsed.Scheme != Uri.UriSchemeHttps) { DialogResult = DialogResult.None; MessageBox.Show(this, "Enter a valid HTTPS feed URL."); } };
            buttons.Controls.Add(save); buttons.Controls.Add(cancel); layout.Controls.Add(buttons, 0, 7); Controls.Add(layout); AcceptButton = save; CancelButton = cancel;
        }
    }
}
