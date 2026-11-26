import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import qltk.net.ProxyConfig;
import qltk.net.ProxyConnector;

/** Real TCP proxy peers; all upstream connections stay on loopback. */
public final class ProxyIntegrationTest {
    static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }

    static final class Peer implements AutoCloseable {
        final String type;
        final boolean auth, reject;
        final int fixedTarget;
        final ServerSocket listener;
        final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
        final List<String> destinations = new CopyOnWriteArrayList<>();
        final List<Throwable> failures = new CopyOnWriteArrayList<>();
        volatile boolean authenticated;
        Peer(String type, boolean auth, boolean reject, int fixedTarget) throws IOException {
            this.type = type; this.auth = auth; this.reject = reject; this.fixedTarget = fixedTarget;
            listener = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
            Thread acceptor = new Thread(() -> {
                while (!listener.isClosed()) {
                    try {
                        Socket client = listener.accept(); sockets.add(client);
                        Thread worker = new Thread(() -> handle(client), "proxy-test-client"); worker.setDaemon(true); worker.start();
                    } catch (IOException e) { if (!listener.isClosed()) failures.add(e); }
                }
            }, "proxy-test-listener"); acceptor.setDaemon(true); acceptor.start();
        }
        int port() { return listener.getLocalPort(); }
        ProxyConfig config() { return new ProxyConfig(type, "127.0.0.1", port(), auth ? "proxy-user" : "", auth ? "Proxy Việt 123" : ""); }
        void handle(Socket client) {
            try (client) {
                client.setSoTimeout(15000);
                DataInputStream input = new DataInputStream(client.getInputStream());
                DataOutputStream output = new DataOutputStream(client.getOutputStream());
                String host; int port;
                if (type.equals("SOCKS5")) {
                    check(input.readUnsignedByte() == 5, "SOCKS version");
                    byte[] methods = input.readNBytes(input.readUnsignedByte());
                    check(methods.length == 1 && methods[0] == (auth ? 2 : 0), "SOCKS methods");
                    output.write(new byte[] {5, (byte)(auth ? 2 : 0)}); output.flush();
                    if (auth) {
                        check(input.readUnsignedByte() == 1, "RFC 1929 version");
                        String user = new String(input.readNBytes(input.readUnsignedByte()), StandardCharsets.UTF_8);
                        String pass = new String(input.readNBytes(input.readUnsignedByte()), StandardCharsets.UTF_8);
                        authenticated = user.equals("proxy-user") && pass.equals("Proxy Việt 123");
                        output.write(new byte[] {1, (byte)(authenticated && !reject ? 0 : 1)}); output.flush();
                        if (!authenticated || reject) return;
                    }
                    check(input.readUnsignedByte() == 5 && input.readUnsignedByte() == 1 && input.readUnsignedByte() == 0, "SOCKS CONNECT");
                    check(input.readUnsignedByte() == 3, "SOCKS must send hostname for proxy DNS");
                    host = new String(input.readNBytes(input.readUnsignedByte()), StandardCharsets.US_ASCII);
                    port = input.readUnsignedShort(); destinations.add(host + ":" + port);
                    if (reject) { output.write(new byte[] {5, 5, 0, 1, 0, 0, 0, 0, 0, 0}); output.flush(); return; }
                } else {
                    String first = readLine(input); check(first.startsWith("CONNECT ") && first.endsWith(" HTTP/1.1"), "HTTP CONNECT request");
                    String authority = first.split(" ")[1]; int colon = authority.lastIndexOf(':');
                    host = authority.substring(0, colon); port = Integer.parseInt(authority.substring(colon + 1));
                    String authorization = "";
                    for (String line; !(line = readLine(input)).isEmpty();) if (line.startsWith("Proxy-Authorization: Basic ")) authorization = line.substring(27);
                    authenticated = !auth || new String(Base64.getDecoder().decode(authorization), StandardCharsets.UTF_8).equals("proxy-user:Proxy Việt 123");
                    destinations.add(host + ":" + port);
                    if (!authenticated || reject) {
                        output.write("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); output.flush(); return;
                    }
                }
                // The DNS test uses a name that cannot resolve locally; only the peer maps it.
                check(host.equals("127.0.0.1") || (fixedTarget != 0 && host.equals("game.remote.invalid")), "Non-loopback test destination");
                try (Socket upstream = new Socket("127.0.0.1", fixedTarget == 0 ? port : fixedTarget)) {
                    sockets.add(upstream);
                    if (type.equals("SOCKS5")) output.write(new byte[] {5, 0, 0, 1, 127, 0, 0, 1, 0, 0});
                    else output.write("HTTP/1.1 200 Connection established\r\nX-Proxy: local-test\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                    output.flush(); client.setSoTimeout(0);
                    Thread returning = new Thread(() -> {
                        try { upstream.getInputStream().transferTo(client.getOutputStream()); client.shutdownOutput(); }
                        catch (IOException ignored) { }
                    }, "proxy-test-return"); returning.setDaemon(true); returning.start();
                    try { input.transferTo(upstream.getOutputStream()); upstream.shutdownOutput(); returning.join(1000); }
                    catch (IOException ignored) { }
                    finally { sockets.remove(upstream); }
                }
            } catch (Throwable e) { if (!listener.isClosed()) failures.add(e); }
            finally { sockets.remove(client); }
        }
        public void close() throws IOException {
            listener.close(); for (Socket socket : sockets) try { socket.close(); } catch (IOException ignored) { }
        }
    }
    static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int value; (value = input.read()) != -1;) {
            if (value == '\n') return bytes.toString(StandardCharsets.US_ASCII).replace("\r", "");
            bytes.write(value); if (bytes.size() > 16384) throw new IOException("Oversized header");
        }
        throw new EOFException();
    }
    static void transport(String type, boolean auth) throws Exception {
        try (ServerSocket target = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
             Peer proxy = new Peer(type, auth, false, target.getLocalPort())) {
            CompletableFuture<Void> echoed = CompletableFuture.runAsync(() -> {
                try (Socket accepted = target.accept()) {
                    accepted.getOutputStream().write(91); accepted.getOutputStream().flush();
                    check(accepted.getInputStream().read() == 73, "Tunnel payload changed");
                } catch (IOException e) { throw new CompletionException(e); }
            });
            javax.microedition.io.SocketConnection connection = (javax.microedition.io.SocketConnection)new ProxyConnector(proxy.config()).open(
                "socket://game.remote.invalid:" + target.getLocalPort());
            try {
                check(connection.openInputStream().read() == 91, "Proxy swallowed first game byte");
                connection.openOutputStream().write(73); connection.openOutputStream().flush();
                check(connection.getAddress().equals("game.remote.invalid") && connection.getPort() == target.getLocalPort(), "MIDP destination changed");
            } finally { connection.close(); }
            echoed.get(5, TimeUnit.SECONDS);
            check(proxy.destinations.contains("game.remote.invalid:" + target.getLocalPort()), "Remote DNS destination lost");
            check(!auth || proxy.authenticated, "Proxy credentials not authenticated");
            check(proxy.failures.isEmpty(), "Proxy peer failed: " + proxy.failures);
            System.out.println("PROXY PASS: " + type + (auth ? " authenticated" : " anonymous") + "; remote DNS, exact first byte and MIDP socket");
        }
    }
    static void rejects(String type, boolean auth) throws Exception {
        try (ServerSocket target = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
             Peer proxy = new Peer(type, auth, true, 0)) {
            target.setSoTimeout(250);
            try { proxy.config().connect("127.0.0.1", target.getLocalPort()); throw new AssertionError("Rejected proxy succeeded"); }
            catch (IOException expected) { }
            try (Socket unexpected = target.accept()) { throw new AssertionError("Proxy failure fell back to a direct connection"); }
            catch (SocketTimeoutException expected) { }
            check(proxy.failures.isEmpty(), "Rejecting proxy failed: " + proxy.failures);
            System.out.println("PROXY PASS: " + type + (auth ? " authentication rejection" : " CONNECT rejection") + "; no direct fallback");
        }
    }
    public static void main(String[] args) throws Exception {
        for (String type : new String[] {"SOCKS5", "HTTP"}) for (boolean auth : new boolean[] {false, true}) {
            transport(type, auth); rejects(type, auth);
        }
        // Real Add-account UI -> encrypted storage -> separate JVM -> proxy -> local game peer.
        for (String type : new String[] {"SOCKS5", "HTTP"}) for (boolean auth : new boolean[] {false, true}) {
            try (Peer proxy = new Peer(type, auth, false, 0)) {
                GameFlowTestServer.runUiScenario(type.equals("SOCKS5"), type, proxy.port(), auth);
                check(!proxy.destinations.isEmpty() && (!auth || proxy.authenticated) && proxy.failures.isEmpty(), "Game bypassed proxy: " + proxy.failures);
            }
        }
        System.out.println("PASS: all proxy transport, rejection, UI persistence and real game login scenarios");
        System.exit(0);
    }
}
