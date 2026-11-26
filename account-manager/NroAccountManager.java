import java.awt.*;
import java.awt.event.*;
import java.io.*;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.List;
import java.util.concurrent.*;
import javax.swing.*;
import javax.swing.table.AbstractTableModel;
import qltk.net.ProxyConfig;

/** Standalone manager: the distributed artifact is QLTK.jar only. */
public final class NroAccountManager extends JFrame {
    static final String[] SERVERS = {"Vũ trụ 1", "Vũ trụ 2", "Vũ trụ 3", "Vũ trụ 4", "Vũ trụ 5",
        "Vũ trụ 6", "Vũ trụ 7", "Vũ trụ 8", "Vũ trụ 9", "Vũ trụ 10", "Vũ trụ 11", "Võ đài liên vũ trụ", "Universe 1", "Naga"};
    static final ExecutorService WORKERS = Executors.newCachedThreadPool(r -> { Thread t = new Thread(r, "NRO-worker"); t.setDaemon(true); return t; });
    static FileChannel lockChannel;
    static FileLock appLock;
    final Path data, runtime, bundle;
    final List<Account> accounts;
    final Map<String, Process> running = new HashMap<>();
    final Set<String> starting = new HashSet<>();
    final JTextField username = new JTextField(), note = new JTextField();
    final JPasswordField password = new JPasswordField();
    final JComboBox<String> server = new JComboBox<>(SERVERS);
    final JComboBox<String> proxyType = new JComboBox<>(new String[] {"DIRECT", "SOCKS5", "HTTP"});
    final JTextField proxyHost = new JTextField(), proxyPort = new JTextField(), proxyUser = new JTextField();
    final JPasswordField proxyPassword = new JPasswordField();
    final JComboBox<String> memory = new JComboBox<>(new String[] {"Nhẹ (96 MB)", "Cân bằng (128 MB)", "Dự phòng (256 MB)"});
    final JLabel status = new JLabel("Bấm một dòng để mở game 240 × 320 trong cửa sổ riêng.");
    final AccountsModel model = new AccountsModel();
    final JTable table = new JTable(model);
    boolean saving;
    String emulatorMode;
    final List<String> sessionEvents = new ArrayList<>();
    final List<String> testOutput = new CopyOnWriteArrayList<>();

    static final class Account {
        String id = UUID.randomUUID().toString(), user, secret, note, state = "Sẵn sàng";
        String proxyType = "DIRECT", proxyHost = "", proxyUser = "", proxySecret = "";
        int server, proxyPort, heapMb = 128;
        String proxyLabel() { return proxyType.equals("DIRECT") ? "Trực tiếp" : proxyType + " " + proxyHost + ":" + proxyPort; }
    }
    NroAccountManager(Path data, Path runtime, Path bundle) throws Exception {
        super("NRO — Quản lý tài khoản (QLTK.jar)");
        this.data = data; this.runtime = runtime; this.bundle = bundle;
        accounts = loadAccounts(data);
        setDefaultCloseOperation(WindowConstants.DISPOSE_ON_CLOSE);
        setMinimumSize(new Dimension(1000, 540)); setSize(1180, 680); setLocationRelativeTo(null);
        JPanel content = new JPanel(new BorderLayout(0, 16)); content.setBorder(BorderFactory.createEmptyBorder(22, 22, 18, 22));
        setContentPane(content);
        JPanel top = new JPanel(new BorderLayout(0, 18));
        JLabel title = new JLabel("QUẢN LÝ TÀI KHOẢN NRO"); title.setFont(title.getFont().deriveFont(Font.BOLD, 24));
        top.add(title, BorderLayout.NORTH);
        JPanel fields = new JPanel(new GridLayout(1, 4, 14, 0));
        String[] names = {"Tài khoản", "Mật khẩu", "Máy chủ", "Ghi chú"};
        JComponent[] inputs = {username, password, server, note};
        for (int i = 0; i < inputs.length; i++) {
            JPanel field = new JPanel(new BorderLayout(0, 6)); field.add(new JLabel(names[i]), BorderLayout.NORTH);
            inputs[i].setPreferredSize(new Dimension(160, 32)); field.add(inputs[i]); fields.add(field);
        }
        JPanel editors = new JPanel(new GridLayout(2, 1, 0, 12)); editors.add(fields);
        JPanel networkFields = new JPanel(new GridLayout(1, 6, 10, 0));
        String[] networkNames = {"Kết nối", "Host proxy", "Cổng proxy", "Tài khoản proxy", "Mật khẩu proxy", "RAM tối đa / game"};
        JComponent[] networkInputs = {proxyType, proxyHost, proxyPort, proxyUser, proxyPassword, memory};
        memory.setSelectedIndex(1);
        proxyPassword.setToolTipText("Để trống khi sửa để giữ mật khẩu proxy đã lưu. Chọn DIRECT để bỏ proxy.");
        proxyHost.setToolTipText("Ví dụ: 127.0.0.1 hoặc proxy.example.com, không thêm http://");
        for (int i = 0; i < networkInputs.length; i++) {
            JPanel field = new JPanel(new BorderLayout(0, 6)); field.add(new JLabel(networkNames[i]), BorderLayout.NORTH);
            networkInputs[i].setPreferredSize(new Dimension(140, 32)); field.add(networkInputs[i]); networkFields.add(field);
        }
        proxyType.addActionListener(e -> updateProxyEditor()); updateProxyEditor();
        editors.add(networkFields); top.add(editors);
        JPanel buttons = new JPanel(new FlowLayout(FlowLayout.LEFT, 8, 0));
        button(buttons, "Thêm tài khoản", () -> saveEditor(false));
        button(buttons, "Lưu thay đổi", () -> saveEditor(true));
        button(buttons, "Chạy đã chọn", this::launchSelected);
        button(buttons, "Dừng đã chọn", this::stopSelected);
        button(buttons, "Xóa", this::deleteSelected);
        top.add(buttons, BorderLayout.SOUTH); content.add(top, BorderLayout.NORTH);
        table.setRowHeight(35); table.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        table.setFillsViewportHeight(true); table.setShowVerticalLines(false);
        table.getTableHeader().setReorderingAllowed(false);
        table.getSelectionModel().addListSelectionListener(e -> { if (!e.getValueIsAdjusting()) fillEditor(); });
        table.addMouseListener(new MouseAdapter() {
            public void mouseClicked(MouseEvent e) { if (SwingUtilities.isLeftMouseButton(e) && table.rowAtPoint(e.getPoint()) >= 0) launchSelected(); }
        });
        table.getInputMap().put(KeyStroke.getKeyStroke(KeyEvent.VK_ENTER, 0), "launch-account");
        table.getActionMap().put("launch-account", new AbstractAction() { public void actionPerformed(ActionEvent e) { launchSelected(); } });
        content.add(new JScrollPane(table)); content.add(status, BorderLayout.SOUTH);
    }
    void button(JPanel parent, String text, Runnable action) {
        JButton button = new JButton(text); button.setPreferredSize(new Dimension(text.length() > 12 ? 150 : 135, 34));
        button.addActionListener(e -> { try { action.run(); } catch (Exception ex) { error(ex); } }); parent.add(button);
    }
    void error(Throwable ex) { JOptionPane.showMessageDialog(this, ex.getMessage(), "NRO", JOptionPane.ERROR_MESSAGE); }
    void updateProxyEditor() {
        boolean enabled = !"DIRECT".equals(proxyType.getSelectedItem());
        for (JComponent field : new JComponent[] {proxyHost, proxyPort, proxyUser, proxyPassword}) field.setEnabled(enabled);
    }
    Account selected() { int row = table.getSelectedRow(); return row < 0 ? null : accounts.get(row); }
    void fillEditor() {
        Account a = selected(); if (a == null) return;
        username.setText(a.user); password.setText(""); server.setSelectedIndex(a.server); note.setText(a.note);
        proxyType.setSelectedItem(a.proxyType); proxyHost.setText(a.proxyHost); proxyPort.setText(a.proxyPort == 0 ? "" : Integer.toString(a.proxyPort));
        proxyUser.setText(a.proxyUser); proxyPassword.setText(""); memory.setSelectedIndex(a.heapMb == 96 ? 0 : a.heapMb == 256 ? 2 : 1);
    }
    void state(Account a, String text) {
        a.state = text;
        int row = accounts.indexOf(a);
        if (row >= 0) model.fireTableRowsUpdated(row, row);
        status.setText(a.user + ": " + text);
    }
    void saveEditor(boolean editing) {
        if (saving) return;
        Account old = editing ? selected() : null;
        if (editing && old == null) return;
        if (old != null && (running.containsKey(old.id) || starting.contains(old.id))) throw new IllegalStateException("Dừng tài khoản trước khi sửa.");
        String type = (String)proxyType.getSelectedItem();
        int port = 0;
        if (!type.equals("DIRECT")) {
            try { port = Integer.parseInt(proxyPort.getText().trim()); }
            catch (NumberFormatException e) { throw new IllegalArgumentException("Cổng proxy phải là số từ 1 đến 65535."); }
        }
        ProxyConfig proxy = new ProxyConfig(type, type.equals("DIRECT") ? "" : proxyHost.getText(), port,
            type.equals("DIRECT") ? "" : proxyUser.getText().trim(), "");
        String user = username.getText().trim(); char[] chars = password.getPassword();
        if (user.isEmpty() || (!editing && chars.length == 0)) { Arrays.fill(chars, '\0'); throw new IllegalArgumentException("Nhập tài khoản và mật khẩu."); }
        int serverIndex = server.getSelectedIndex();
        for (Account a : accounts) if (a != old && a.user.equalsIgnoreCase(user) && a.server == serverIndex) {
            Arrays.fill(chars, '\0'); throw new IllegalArgumentException("Tài khoản đã có trên máy chủ này.");
        }
        Account a = new Account(); if (old != null) a.id = old.id;
        a.user = user; a.server = serverIndex; a.note = note.getText();
        a.proxyType = proxy.type; a.proxyHost = proxy.host; a.proxyPort = proxy.port; a.proxyUser = proxy.username;
        a.heapMb = new int[] {96, 128, 256}[memory.getSelectedIndex()];
        char[] proxyChars = proxyPassword.getPassword();
        saving = true; status.setText("Đang lưu tài khoản...");
        new SwingWorker<List<Account>, Void>() {
            protected List<Account> doInBackground() throws Exception {
                try {
                    a.secret = chars.length == 0 ? old.secret : dpapi(new String(chars), true);
                    String proxyPass = new String(proxyChars);
                    new ProxyConfig(a.proxyType, a.proxyHost, a.proxyPort, a.proxyUser, proxyPass);
                    a.proxySecret = a.proxyType.equals("DIRECT") || a.proxyUser.isEmpty() ? ""
                        : proxyChars.length == 0 && old != null ? old.proxySecret : dpapi(proxyPass, true);
                } finally { Arrays.fill(chars, '\0'); Arrays.fill(proxyChars, '\0'); }
                List<Account> updated = new ArrayList<>(accounts);
                if (old == null) updated.add(a); else updated.set(updated.indexOf(old), a);
                save(data.resolve("accounts-java.xml"), updated); return updated;
            }
            protected void done() {
                saving = false;
                try { accounts.clear(); accounts.addAll(get()); model.fireTableDataChanged(); password.setText(""); proxyPassword.setText(""); status.setText("Đã lưu " + a.user + ". Bấm dòng trong bảng để chạy."); }
                catch (Exception ex) { status.setText("Không lưu được tài khoản"); error(cause(ex)); }
            }
        }.execute();
    }
    void deleteSelected() {
        if (saving) return;
        Account a = selected(); if (a == null) return;
        if (running.containsKey(a.id) || starting.contains(a.id)) throw new IllegalStateException("Dừng tài khoản trước khi xóa.");
        if (JOptionPane.showConfirmDialog(this, "Xóa " + a.user + " khỏi danh sách?", "NRO", JOptionPane.YES_NO_OPTION) != JOptionPane.YES_OPTION) return;
        try {
            List<Account> updated = new ArrayList<>(accounts); updated.remove(a); save(data.resolve("accounts-java.xml"), updated);
            accounts.clear(); accounts.addAll(updated); model.fireTableDataChanged();
        } catch (Exception ex) { error(ex); }
    }
    void launchSelected() {
        Account a = selected(); if (a == null || starting.contains(a.id)) return;
        if (running.containsKey(a.id)) { status.setText(a.user + ": đã mở cửa sổ game"); return; }
        starting.add(a.id); state(a, "Đang mở...");
        WORKERS.execute(() -> {
            Process process = null;
            try {
                String secret = dpapi(a.secret, false);
                ProxyConfig proxy = new ProxyConfig(a.proxyType, a.proxyHost, a.proxyPort, a.proxyUser,
                    a.proxySecret.isEmpty() ? "" : dpapi(a.proxySecret, false));
                Path profile = data.resolve("profiles").resolve(a.id); Files.createDirectories(profile);
                process = startEmulator(bundle, runtime, profile, emulatorMode, a.heapMb);
                Process launched = process;
                SwingUtilities.invokeLater(() -> { starting.remove(a.id); running.put(a.id, launched); state(a, "Đang khởi động game"); });
                sendAccount(process, a.user, secret, a.server, UUID.randomUUID().toString(), proxy); secret = null;
                try (BufferedReader output = process.inputReader(StandardCharsets.UTF_8)) {
                    for (String line; (line = output.readLine()) != null;) {
                        if (emulatorMode != null) testOutput.add(line);
                        if (!line.startsWith("[ACCOUNT] ")) continue;
                        String event = line.substring(10);
                        String text = switch (event) {
                            case "SESSION_BOUND" -> "Đã nối tài khoản vào phiên game";
                            case "ACCOUNT_APPLIED" -> "Đã ghi tài khoản, mật khẩu và server vào game";
                            case "CONNECTING" -> "Đang kết nối máy chủ";
                            case "DOWNLOADING" -> "Đang tải dữ liệu";
                            case "LOGIN_SUBMITTED" -> "Đã gửi đăng nhập";
                            case "TIMEOUT" -> "Hết thời gian tự động; kiểm tra game";
                            case "INVALID_SERVER" -> "Máy chủ không có trong game";
                            case "PROXY_FAILED" -> "Lỗi proxy; kiểm tra host, cổng và xác thực";
                            default -> "Đang chạy";
                        };
                        SwingUtilities.invokeLater(() -> { if (emulatorMode != null) sessionEvents.add(event); state(a, text); });
                    }
                }
                int exit = process.waitFor();
                SwingUtilities.invokeLater(() -> { starting.remove(a.id); running.remove(a.id); state(a, exit == 0 ? "Đã đóng game" : "Game thoát lỗi (" + exit + ")"); });
            } catch (Exception ex) {
                if (process != null) process.destroyForcibly();
                SwingUtilities.invokeLater(() -> { starting.remove(a.id); running.remove(a.id); state(a, "Không mở được game"); error(ex); });
            }
        });
    }
    void stopSelected() {
        Account a = selected(); if (a == null) return;
        Process process = running.get(a.id);
        if (process != null) { process.destroy(); state(a, "Đang dừng..."); }
    }
    final class AccountsModel extends AbstractTableModel {
        final String[] names = {"Tài khoản", "Mật khẩu", "Máy chủ", "Proxy", "RAM/game", "Ghi chú", "Trạng thái"};
        public int getColumnCount() { return names.length; }
        public int getRowCount() { return accounts == null ? 0 : accounts.size(); }
        public String getColumnName(int c) { return names[c]; }
        public Object getValueAt(int row, int c) {
            Account a = accounts.get(row);
            return switch (c) { case 0 -> a.user; case 1 -> "••••••••"; case 2 -> SERVERS[a.server]; case 3 -> a.proxyLabel();
                case 4 -> a.heapMb + " MB"; case 5 -> a.note; default -> a.state; };
        }
    }
    static Throwable cause(Exception ex) { return ex.getCause() == null ? ex : ex.getCause(); }
    static String javaExecutable() { return Path.of(System.getProperty("java.home"), "bin", "java.exe").toString(); }
    static Path dataDirectory() {
        String local = System.getenv("LOCALAPPDATA");
        return Path.of(local == null ? System.getProperty("user.home") : local, "NroAccountManager");
    }
    static Path bundlePath() throws Exception { return Path.of(NroAccountManager.class.getProtectionDomain().getCodeSource().getLocation().toURI()); }
    static Process startEmulator(Path bundle, Path runtime, Path profile, String mode) throws IOException {
        return startEmulator(bundle, runtime, profile, mode, 128);
    }
    static Process startEmulator(Path bundle, Path runtime, Path profile, String mode, int heapMb) throws IOException {
        if (heapMb != 96 && heapMb != 128 && heapMb != 256) throw new IllegalArgumentException("RAM/game không hợp lệ.");
        Files.createDirectories(profile);
        List<String> command = new ArrayList<>(List.of(javaExecutable(), "-Xms16m", "-Xmx" + heapMb + "m", "-XX:+UseSerialGC",
            "-XX:ReservedCodeCacheSize=32m", "-XX:+DisableExplicitGC", "-Dfile.encoding=UTF-8", "-cp", bundle.toString(),
            "EmulatorBootstrap", runtime.toString(), profile.toString()));
        if (mode != null) command.add(mode);
        return new ProcessBuilder(command).redirectErrorStream(true).start();
    }
    static void sendAccount(Process process, String user, String secret, int server, String sessionId) throws IOException {
        sendAccount(process, user, secret, server, sessionId, ProxyConfig.DIRECT);
    }
    static void sendAccount(Process process, String user, String secret, int server, String sessionId, ProxyConfig proxy) throws IOException {
        try (Writer input = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)) {
            input.write(Base64.getEncoder().encodeToString(user.getBytes(StandardCharsets.UTF_8)) + "\n");
            input.write(Base64.getEncoder().encodeToString(secret.getBytes(StandardCharsets.UTF_8)) + "\n" + server + "\n" + sessionId + "\n");
            proxy.writeTo(input);
        }
    }
    static String dpapi(String value, boolean protect) throws Exception {
        String operation = protect ? "Protect" : "Unprotect";
        String script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; "
            + "$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); "
            + "$result=[Security.Cryptography.ProtectedData]::" + operation + "($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); "
            + "[Console]::Out.Write([Convert]::ToBase64String($result))";
        Process p = new ProcessBuilder("powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand",
            Base64.getEncoder().encodeToString(script.getBytes(StandardCharsets.UTF_16LE))).redirectError(ProcessBuilder.Redirect.DISCARD).start();
        try {
            String payload = protect ? Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)) : value;
            try (OutputStream input = p.getOutputStream()) { input.write(payload.getBytes(StandardCharsets.US_ASCII)); }
            if (!p.waitFor(20, TimeUnit.SECONDS)) throw new IOException("Windows không phản hồi yêu cầu mã hóa mật khẩu.");
            if (p.exitValue() != 0) throw new IOException("Không giải mã được mật khẩu bằng người dùng Windows hiện tại.");
            String output = new String(p.getInputStream().readAllBytes(), StandardCharsets.US_ASCII).trim();
            return protect ? output : new String(Base64.getDecoder().decode(output), StandardCharsets.UTF_8);
        } finally { if (p.isAlive()) p.destroyForcibly(); }
    }
    static List<Account> load(Path file) throws Exception {
        List<Account> result = new ArrayList<>(); if (!Files.exists(file)) return result;
        Properties p = new Properties(); try (InputStream input = Files.newInputStream(file)) { p.loadFromXML(input); }
        int count = Integer.parseInt(p.getProperty("count")); Set<String> ids = new HashSet<>();
        if (count < 0 || count > 100000) throw new IOException("Danh sách tài khoản bị lỗi.");
        for (int i = 0; i < count; i++) {
            String prefix = "account." + i + ".";
            Account a = new Account(); a.id = p.getProperty(prefix + "id"); a.user = p.getProperty(prefix + "user");
            a.secret = p.getProperty(prefix + "secret"); a.note = p.getProperty(prefix + "note", "");
            a.server = Integer.parseInt(p.getProperty(prefix + "server"));
            a.proxyType = p.getProperty(prefix + "proxy.type", "DIRECT"); a.proxyHost = p.getProperty(prefix + "proxy.host", "");
            a.proxyPort = Integer.parseInt(p.getProperty(prefix + "proxy.port", "0")); a.proxyUser = p.getProperty(prefix + "proxy.user", "");
            a.proxySecret = p.getProperty(prefix + "proxy.secret", ""); a.heapMb = Integer.parseInt(p.getProperty(prefix + "heapMb", "128"));
            new ProxyConfig(a.proxyType, a.proxyHost, a.proxyPort, a.proxyUser, "");
            if (a.heapMb != 96 && a.heapMb != 128 && a.heapMb != 256) throw new IOException("RAM/game trong dữ liệu không hợp lệ.");
            if (a.id == null || !a.id.matches("[a-fA-F0-9-]{36}") || !ids.add(a.id) || a.user == null || a.secret == null || a.server < 0 || a.server >= SERVERS.length)
                throw new IOException("Danh sách tài khoản bị lỗi; hãy khôi phục bản .bak.");
            result.add(a);
        }
        return result;
    }
    static List<Account> loadAccounts(Path data) throws Exception {
        Path file = data.resolve("accounts-java.xml");
        if (Files.exists(file) || !Files.exists(data.resolve("accounts.xml"))) return load(file);
        // Import the previous Windows build once, retaining its DPAPI ciphertext.
        javax.xml.parsers.DocumentBuilderFactory factory = javax.xml.parsers.DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        org.w3c.dom.Document document = factory.newDocumentBuilder().parse(data.resolve("accounts.xml").toFile());
        org.w3c.dom.NodeList entries = document.getElementsByTagName("Account");
        List<Account> imported = new ArrayList<>();
        for (int i = 0; i < entries.getLength(); i++) {
            org.w3c.dom.Element element = (org.w3c.dom.Element)entries.item(i);
            Account a = new Account(); a.user = xmlText(element, "User"); a.secret = xmlText(element, "Secret");
            a.note = xmlText(element, "Note"); a.server = Integer.parseInt(xmlText(element, "Server"));
            if (a.server < 0 || a.server >= SERVERS.length) throw new IOException("Máy chủ trong dữ liệu cũ bị lỗi.");
            imported.add(a);
        }
        save(file, imported); return imported;
    }
    static String xmlText(org.w3c.dom.Element element, String name) throws IOException {
        org.w3c.dom.Node node = element.getElementsByTagName(name).item(0);
        if (node == null) throw new IOException("Dữ liệu tài khoản cũ thiếu " + name);
        return node.getTextContent();
    }
    static void save(Path file, List<Account> accounts) throws Exception {
        Properties p = new Properties(); p.setProperty("count", Integer.toString(accounts.size()));
        for (int i = 0; i < accounts.size(); i++) {
            Account a = accounts.get(i); String prefix = "account." + i + ".";
            p.setProperty(prefix + "id", a.id); p.setProperty(prefix + "user", a.user); p.setProperty(prefix + "secret", a.secret);
            p.setProperty(prefix + "note", a.note); p.setProperty(prefix + "server", Integer.toString(a.server));
            p.setProperty(prefix + "proxy.type", a.proxyType); p.setProperty(prefix + "proxy.host", a.proxyHost);
            p.setProperty(prefix + "proxy.port", Integer.toString(a.proxyPort)); p.setProperty(prefix + "proxy.user", a.proxyUser);
            p.setProperty(prefix + "proxy.secret", a.proxySecret); p.setProperty(prefix + "heapMb", Integer.toString(a.heapMb));
        }
        Files.createDirectories(file.getParent()); Path temp = Files.createTempFile(file.getParent(), "accounts-", ".tmp");
        try {
            try (OutputStream output = Files.newOutputStream(temp)) { p.storeToXML(output, "NRO account manager — Windows DPAPI protected passwords", StandardCharsets.UTF_8); }
            if (Files.exists(file)) Files.copy(file, file.resolveSibling(file.getFileName() + ".bak"), StandardCopyOption.REPLACE_EXISTING);
            try { Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (AtomicMoveNotSupportedException e) { Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING); }
        } finally { Files.deleteIfExists(temp); }
    }
    static Path prepareRuntime(Path data) throws Exception {
        byte[] game;
        try (InputStream input = NroAccountManager.class.getResourceAsStream("/runtime/DragonBoy252-source-rebuilt.jar")) {
            if (input == null) throw new IOException("QLTK.jar thiếu JAR game đã build."); game = input.readAllBytes();
        }
        String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(game));
        Path root = data.resolve("runtime").resolve(hash), dist = root.resolve("dist"); Files.createDirectories(dist);
        // Recreate only packaged runtime files; account data is stored separately.
        Files.write(dist.resolve("DragonBoy252-source-rebuilt.jar"), game);
        try (InputStream input = NroAccountManager.class.getResourceAsStream("/runtime/DragonBoy252-source-rebuilt.jad")) {
            if (input == null) throw new IOException("QLTK.jar thiếu JAD game.");
            Files.copy(input, dist.resolve("DragonBoy252-source-rebuilt.jad"), StandardCopyOption.REPLACE_EXISTING);
        }
        return root;
    }
    public static void main(String[] args) {
        try {
            UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
            if (args.length > 0 && "--flow-test".equals(args[0])) { GameFlowTestServer.runUiTest(); System.exit(0); }
            if (args.length > 0 && "--self-test".equals(args[0])) { selfTest(); System.exit(0); }
            Path data = dataDirectory(); Files.createDirectories(data);
            lockChannel = FileChannel.open(data.resolve("manager-java.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
            appLock = lockChannel.tryLock();
            if (appLock == null) { JOptionPane.showMessageDialog(null, "QLTK.jar đang mở."); return; }
            Path runtime = prepareRuntime(data), bundle = bundlePath();
            SwingUtilities.invokeLater(() -> {
                try { new NroAccountManager(data, runtime, bundle).setVisible(true); }
                catch (Exception e) { JOptionPane.showMessageDialog(null, e.getMessage(), "NRO", JOptionPane.ERROR_MESSAGE); System.exit(1); }
            });
        } catch (Exception e) {
            e.printStackTrace();
            if (args.length > 0) System.exit(1);
            JOptionPane.showMessageDialog(null, e.getMessage(), "NRO", JOptionPane.ERROR_MESSAGE); System.exit(1);
        }
    }
    static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    static void selfTest() throws Exception {
        Path test = dataDirectory().resolve("tests").resolve(UUID.randomUUID().toString()); Files.createDirectories(test);
        String secret = "MiXeD Việt 123";
        Account a = new Account(); a.user = "test@example.invalid"; a.secret = dpapi(secret, true); a.server = 2; a.note = "Ghi chú tiếng Việt";
        Path file = test.resolve("accounts-java.xml"); save(file, List.of(a));
        Account restored = load(file).get(0);
        require(restored.user.equals(a.user) && restored.note.equals(a.note) && restored.server == a.server
            && dpapi(restored.secret, false).equals(secret) && !Files.readString(file).contains(secret), "Account persistence or DPAPI failed");
        save(file, List.of(a)); require(Files.exists(test.resolve("accounts-java.xml.bak")), "Backup missing");
        Path runtime = prepareRuntime(test), bundle = bundlePath();
        SwingUtilities.invokeAndWait(() -> {
            try { NroAccountManager form = new NroAccountManager(test, runtime, bundle); form.setVisible(true); require(form.table.getRowCount() == 1, "UI missing account row"); form.dispose(); }
            catch (Exception ex) { throw new RuntimeException(ex); }
        });
        System.out.println("PASS: single-JAR extraction, DPAPI, Unicode persistence, backup, Swing account table");
        List<Process> probes = new ArrayList<>();
        try {
            for (int i = 0; i < 2; i++) {
                Path profile = test.resolve("probe-" + i); Files.createDirectories(profile);
                Process process = startEmulator(bundle, runtime, profile, "--session-smoke"); probes.add(process);
                sendAccount(process, "Session" + i + "@example.invalid", "MiXeD Việt " + i, i == 0 ? 2 : 8, "session-" + i);
            }
            for (int i = 0; i < probes.size(); i++) {
                Process process = probes.get(i);
                // Drain while the child runs; neither child emits account credentials.
                Future<String> capture = WORKERS.submit(() -> new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
                String output = capture.get(30, TimeUnit.SECONDS);
                require(process.waitFor(5, TimeUnit.SECONDS) && process.exitValue() == 0 && output.contains("SESSION PASS:")
                    && output.contains("session-" + i), "Actual game session test failed:\n" + output);
                System.out.println(output.lines().filter(line -> line.startsWith("SESSION PASS:")).findFirst().orElseThrow());
            }
        } finally { for (Process p : probes) if (p.isAlive()) p.destroyForcibly(); }
        Process smoke = startEmulator(bundle, runtime, test.resolve("display-probe"), "--smoke");
        try {
            Future<String> capture = WORKERS.submit(() -> new String(smoke.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
            String output = capture.get(20, TimeUnit.SECONDS);
            require(smoke.waitFor(5, TimeUnit.SECONDS) && smoke.exitValue() == 0 && output.contains("SMOKE PASS:"), "Emulator display test failed:\n" + output);
            System.out.println(output.lines().filter(line -> line.startsWith("SMOKE PASS:")).findFirst().orElseThrow());
        } finally { if (smoke.isAlive()) smoke.destroyForcibly(); }
    }
}
