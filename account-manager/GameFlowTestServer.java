import java.awt.*;
import java.awt.event.InputEvent;
import java.awt.event.MouseEvent;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;
import java.util.List;
import java.util.concurrent.*;
import javax.swing.*;

/** Local protocol peer for testing real UI -> MIDlet -> socket login. No public server is used. */
public final class GameFlowTestServer implements AutoCloseable {
    final ServerSocket listener;
    final boolean requiresDownload;
    final CompletableFuture<String[]> login = new CompletableFuture<>();
    volatile boolean downloadRequested, resourceDelivered;
    volatile Socket active;
    final List<Integer> commands = new CopyOnWriteArrayList<>();
    GameFlowTestServer(boolean requiresDownload) throws IOException {
        this.requiresDownload = requiresDownload;
        ServerSocket socket = null;
        for (int attempt = 0; attempt < 100 && socket == null; attempt++) {
            try { socket = new ServerSocket(ThreadLocalRandom.current().nextInt(20000, 30000), 8, InetAddress.getByName("127.0.0.1")); }
            catch (BindException busy) { }
        }
        if (socket == null) throw new IOException("No free local test port in Java ME short range");
        listener = socket;
        Thread thread = new Thread(this::serve, "NRO-local-protocol-test"); thread.setDaemon(true); thread.start();
    }
    interface Payload { void write(DataOutputStream output) throws IOException; }
    static byte[] payload(Payload writer) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); writer.write(new DataOutputStream(bytes)); return bytes.toByteArray();
    }
    static void send(DataOutputStream output, int command, byte[] bytes) throws IOException {
        output.writeByte(command);
        if (command == -74) {
            output.writeByte((bytes.length & 255) - 128);
            output.writeByte(((bytes.length >> 8) & 255) - 128);
            output.writeByte(((bytes.length >> 16) & 255) - 128);
        } else output.writeShort(bytes.length);
        output.write(bytes); output.flush();
    }
    void serve() {
        try {
            active = listener.accept(); active.setSoTimeout(25000);
            DataInputStream input = new DataInputStream(active.getInputStream());
            DataOutputStream output = new DataOutputStream(active.getOutputStream());
            while (!active.isClosed()) {
                int command = input.readByte(); int size = input.readUnsignedShort();
                byte[] bytes = input.readNBytes(size); if (bytes.length != size) throw new EOFException();
                commands.add(command);
                DataInputStream packet = new DataInputStream(new ByteArrayInputStream(bytes));
                if (command == -27) {
                    // One zero key keeps the real XOR transport enabled with transparent bytes.
                    send(output, -27, payload(p -> { p.writeByte(1); p.writeByte(0); p.writeUTF(""); p.writeInt(0); p.writeByte(0); }));
                } else if (command == -29 && size > 0) {
                    int sub = packet.readByte();
                    if (sub == 2) {
                        send(output, -74, payload(p -> { p.writeByte(0); p.writeInt(9876); }));
                    } else if (sub == 0) {
                        packet.readUTF(); // Original game login code.
                        String user = packet.readUTF(), password = packet.readUTF(), version = packet.readUTF();
                        if (requiresDownload && (!downloadRequested || !resourceDelivered)) throw new AssertionError("Login before resource download completed");
                        if (!requiresDownload && downloadRequested) throw new AssertionError("Unnecessary download for ready data");
                        login.complete(new String[] {user, password, version});
                    }
                } else if (command == -74 && size > 0) {
                    int action = packet.readByte();
                    if (action == 1) {
                        downloadRequested = true;
                        send(output, -74, payload(p -> { p.writeByte(1); p.writeShort(1); }));
                    } else if (action == 2) {
                        send(output, -74, payload(p -> { p.writeByte(2); p.writeUTF("/manager-flow.bin"); p.writeInt(3); p.write(new byte[] {1, 2, 3}); }));
                        resourceDelivered = true;
                        send(output, -74, payload(p -> { p.writeByte(3); p.writeInt(9876); }));
                    }
                }
            }
        } catch (Throwable e) { if (!listener.isClosed()) login.completeExceptionally(e); }
    }
    public void close() throws IOException { listener.close(); if (active != null) active.close(); }
    static void runUiTest() throws Exception {
        runUiScenario(true);
        runUiScenario(false);
    }
    static void clickButton(Container container, String text) {
        for (Component component : container.getComponents()) {
            if (component instanceof JButton button && button.getText().equals(text)) { button.doClick(); return; }
            if (component instanceof Container child) {
                try { clickButton(child, text); return; } catch (IllegalArgumentException notHere) { }
            }
        }
        throw new IllegalArgumentException("Button missing: " + text);
    }
    static void runUiScenario(boolean requiresDownload) throws Exception {
        runUiScenario(requiresDownload, "DIRECT", 0, false);
    }
    static void runUiScenario(boolean requiresDownload, String proxyType, int proxyPort, boolean authenticated) throws Exception {
        Path data = NroAccountManager.dataDirectory().resolve("tests").resolve("ui-flow-" + UUID.randomUUID()); Files.createDirectories(data);
        Path runtime = NroAccountManager.prepareRuntime(data), bundle = NroAccountManager.bundlePath();
        NroAccountManager[] form = new NroAccountManager[1];
        try (GameFlowTestServer peer = new GameFlowTestServer(requiresDownload)) {
            SwingUtilities.invokeAndWait(() -> {
                try {
                    form[0] = new NroAccountManager(data, runtime, bundle);
                    form[0].emulatorMode = "--flow-test=" + peer.listener.getLocalPort() + (requiresDownload ? "" : ",cached");
                    form[0].setVisible(true); form[0].toFront();
                    form[0].username.setText("ui-flow@example.invalid"); form[0].password.setText("MiXeD Việt 123");
                    form[0].server.setSelectedIndex(8); form[0].note.setText("Real UI socket flow");
                    form[0].proxyType.setSelectedItem(proxyType);
                    form[0].proxyHost.setText(proxyType.equals("DIRECT") ? "" : "127.0.0.1");
                    form[0].proxyPort.setText(Integer.toString(proxyPort));
                    form[0].proxyUser.setText(authenticated ? "proxy-user" : "");
                    form[0].proxyPassword.setText(authenticated ? "Proxy Việt 123" : "");
                    form[0].memory.setSelectedIndex(0); // Exercise the smallest supported heap too.
                    clickButton(form[0].getContentPane(), "Thêm tài khoản");
                } catch (Exception e) { throw new RuntimeException(e); }
            });
            CompletableFuture<Point> target = new CompletableFuture<>();
            SwingUtilities.invokeLater(() -> {
                javax.swing.Timer poll = new javax.swing.Timer(100, null);
                poll.addActionListener(e -> {
                    if (form[0].saving) return;
                    poll.stop();
                    if (form[0].accounts.size() != 1) { target.completeExceptionally(new AssertionError("UI add account failed")); return; }
                    Rectangle cell = form[0].table.getCellRect(0, 0, true); Point point = form[0].table.getLocationOnScreen();
                    target.complete(new Point(point.x + cell.x + cell.width / 2, point.y + cell.y + cell.height / 2));
                }); poll.start();
            });
            target.get(20, TimeUnit.SECONDS);
            SwingUtilities.invokeAndWait(() -> {
                Rectangle cell = form[0].table.getCellRect(0, 0, true);
                int x = cell.x + cell.width / 2, y = cell.y + cell.height / 2;
                long now = System.currentTimeMillis();
                for (int type : new int[] {MouseEvent.MOUSE_PRESSED, MouseEvent.MOUSE_RELEASED, MouseEvent.MOUSE_CLICKED})
                    form[0].table.dispatchEvent(new MouseEvent(form[0].table, type, now, type == MouseEvent.MOUSE_PRESSED ? InputEvent.BUTTON1_DOWN_MASK : 0, x, y, 1, false, MouseEvent.BUTTON1));
            });
            String[] received;
            try { received = peer.login.get(35, TimeUnit.SECONDS); }
            catch (Exception e) {
                CompletableFuture<String> detail = new CompletableFuture<>();
                SwingUtilities.invokeLater(() -> detail.complete("events=" + form[0].sessionEvents + "; state=" + form[0].status.getText() + "; commands=" + peer.commands));
                throw new AssertionError("Actual table-click -> socket flow failed: " + detail.get(5, TimeUnit.SECONDS) + "\n" + String.join("\n", form[0].testOutput), e);
            }
            NroAccountManager.require(received[0].equals("ui-flow@example.invalid") && received[1].equals("MiXeD Việt 123") && received[2].equals("2.5.2"), "Credentials changed on the actual socket");
            CompletableFuture<Void> checked = new CompletableFuture<>();
            SwingUtilities.invokeLater(() -> {
                try {
                    NroAccountManager.require(form[0].table.getSelectedRow() == 0, "Status updates cleared selected account");
                    NroAccountManager.require(form[0].sessionEvents.contains("ACCOUNT_APPLIED")
                        && form[0].sessionEvents.contains("DOWNLOADING") == requiresDownload, "Game did not follow expected data readiness path");
                    checked.complete(null);
                } catch (Throwable e) { checked.completeExceptionally(e); }
             }); checked.get(5, TimeUnit.SECONDS);
            NroAccountManager.Account stored = NroAccountManager.load(data.resolve("accounts-java.xml")).get(0);
            NroAccountManager.require(stored.proxyType.equals(proxyType) && stored.heapMb == 96, "Proxy/memory settings lost after saving");
            if (authenticated) NroAccountManager.require(NroAccountManager.dpapi(stored.proxySecret, false).equals("Proxy Việt 123")
                && !Files.readString(data.resolve("accounts-java.xml")).contains("Proxy Việt 123"), "Proxy password persistence/DPAPI failed");
            System.out.println("FLOW PASS: " + (requiresDownload ? "required data downloaded automatically -> Play account -> exact login packet" : "data already ready -> Play account -> exact login packet without download")
                + "; " + proxyType + "; 96 MB heap; actual Add button + table mouse events, DPAPI, real MicroEmulator/socket, selected row retained");
        } finally {
            if (form[0] != null) SwingUtilities.invokeAndWait(() -> {
                for (Process p : form[0].running.values()) p.destroyForcibly(); form[0].dispose();
            });
        }
    }
}
