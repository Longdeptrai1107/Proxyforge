package qltk.net;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Locale;

/** One immutable proxy configuration per emulator process. */
public final class ProxyConfig {
    public static final ProxyConfig DIRECT = new ProxyConfig("DIRECT", "", 0, "", "");
    public final String type, host, username;
    public final int port;
    private final String password;
    private static final int TIMEOUT = 12000;

    public ProxyConfig(String type, String host, int port, String username, String password) {
        this.type = type.toUpperCase(Locale.ROOT);
        this.host = host.trim(); this.port = port; this.username = username; this.password = password;
        if (!this.type.equals("DIRECT") && !this.type.equals("SOCKS5") && !this.type.equals("HTTP"))
            throw new IllegalArgumentException("Loại proxy không hợp lệ.");
        if (!this.type.equals("DIRECT") && (this.host.isEmpty() || port < 1 || port > 65535
            || this.host.chars().anyMatch(c -> Character.isWhitespace(c) || Character.isISOControl(c))
            || this.host.contains("/") || this.host.contains("@")))
            throw new IllegalArgumentException("Nhập host proxy và cổng từ 1 đến 65535.");
        if (username.indexOf('\r') >= 0 || username.indexOf('\n') >= 0 || username.indexOf(':') >= 0
            || password.indexOf('\r') >= 0 || password.indexOf('\n') >= 0)
            throw new IllegalArgumentException("Thông tin xác thực proxy không hợp lệ.");
        if (this.type.equals("SOCKS5") && (username.getBytes(StandardCharsets.UTF_8).length > 255
            || password.getBytes(StandardCharsets.UTF_8).length > 255))
            throw new IllegalArgumentException("Tài khoản/mật khẩu SOCKS5 tối đa 255 byte UTF-8.");
    }

    public Socket connect(String destination, int destinationPort) throws IOException {
        if (destination == null || destination.isBlank() || destinationPort < 1 || destinationPort > 65535
            || destination.chars().anyMatch(c -> Character.isWhitespace(c) || Character.isISOControl(c))
            || destination.contains("/") || destination.contains("@")) throw new IOException("Địa chỉ game không hợp lệ.");
        Socket socket = new Socket(Proxy.NO_PROXY);
        try {
            // Connect to the proxy only. A failed tunnel never falls back to a direct connection.
            socket.connect(new InetSocketAddress(type.equals("DIRECT") ? destination : host,
                type.equals("DIRECT") ? destinationPort : port), TIMEOUT);
            socket.setSoTimeout(TIMEOUT); socket.setTcpNoDelay(true); socket.setKeepAlive(true);
            if (type.equals("SOCKS5")) socks(socket, destination, destinationPort);
            else if (type.equals("HTTP")) http(socket, destination, destinationPort);
            socket.setSoTimeout(0); // The game protocol may legitimately stay idle.
            return socket;
        } catch (IOException | RuntimeException e) {
            try { socket.close(); } catch (IOException ignored) { }
            if (!type.equals("DIRECT")) throw new IOException("Không kết nối được proxy " + type + ": " + safeReason(e), e);
            throw e;
        }
    }

    private static String safeReason(Exception e) {
        if (e instanceof SocketTimeoutException) return "hết thời gian chờ";
        if (e instanceof ConnectException) return "proxy từ chối kết nối";
        if (e instanceof UnknownHostException) return "không tìm thấy host proxy";
        return "bắt tay thất bại; kiểm tra loại proxy, tài khoản và cổng đích";
    }

    private void socks(Socket socket, String destination, int destinationPort) throws IOException {
        DataInputStream input = new DataInputStream(socket.getInputStream());
        DataOutputStream output = new DataOutputStream(socket.getOutputStream());
        // When credentials are supplied, require RFC 1929 authentication.
        output.write(new byte[] {5, 1, (byte)(username.isEmpty() ? 0 : 2)}); output.flush();
        if (input.readUnsignedByte() != 5) throw new IOException("SOCKS version");
        int method = input.readUnsignedByte();
        if (method != (username.isEmpty() ? 0 : 2)) throw new IOException("SOCKS authentication method");
        if (method == 2) {
            byte[] user = username.getBytes(StandardCharsets.UTF_8), pass = password.getBytes(StandardCharsets.UTF_8);
            output.writeByte(1); output.writeByte(user.length); output.write(user);
            output.writeByte(pass.length); output.write(pass); output.flush();
            if (input.readUnsignedByte() != 1 || input.readUnsignedByte() != 0) throw new IOException("SOCKS authentication rejected");
        }
        output.write(new byte[] {5, 1, 0});
        if (destination.contains(":")) {
            byte[] address = InetAddress.getByName(destination).getAddress();
            if (address.length != 16) throw new IOException("IPv6 address");
            output.writeByte(4); output.write(address);
        } else {
            // Domain names (including numeric IPv4) are resolved by the proxy.
            byte[] address = IDN.toASCII(destination).getBytes(StandardCharsets.US_ASCII);
            if (address.length == 0 || address.length > 255) throw new IOException("SOCKS destination length");
            output.writeByte(3); output.writeByte(address.length); output.write(address);
        }
        output.writeShort(destinationPort); output.flush();
        if (input.readUnsignedByte() != 5 || input.readUnsignedByte() != 0 || input.readUnsignedByte() != 0)
            throw new IOException("SOCKS CONNECT rejected");
        int addressType = input.readUnsignedByte();
        int length = switch (addressType) { case 1 -> 4; case 4 -> 16; case 3 -> input.readUnsignedByte(); default -> throw new IOException("SOCKS address type"); };
        byte[] reply = new byte[length + 2]; input.readFully(reply);
    }

    private void http(Socket socket, String destination, int destinationPort) throws IOException {
        String authority = (destination.contains(":") ? "[" + destination + "]" : IDN.toASCII(destination)) + ":" + destinationPort;
        String request = "CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n";
        if (!username.isEmpty()) request += "Proxy-Authorization: Basic " + Base64.getEncoder().encodeToString(
            (username + ":" + password).getBytes(StandardCharsets.UTF_8)) + "\r\n";
        socket.getOutputStream().write((request + "\r\n").getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().flush();
        // Read precisely through CRLFCRLF: do not buffer away the first game packet.
        ByteArrayOutputStream header = new ByteArrayOutputStream(); int matched = 0;
        byte[] end = {'\r', '\n', '\r', '\n'};
        while (matched < end.length) {
            int value = socket.getInputStream().read();
            if (value < 0) throw new EOFException("HTTP proxy closed");
            header.write(value);
            if (header.size() > 16384) throw new IOException("HTTP proxy header too large");
            matched = value == end[matched] ? matched + 1 : value == '\r' ? 1 : 0;
        }
        String status = header.toString(StandardCharsets.ISO_8859_1).split("\r\n", 2)[0];
        if (!status.matches("HTTP/1\\.[01] 2[0-9]{2}(?: .*|)")) throw new IOException("HTTP CONNECT rejected");
    }

    public void writeTo(Writer output) throws IOException {
        for (String field : new String[] {type, host, Integer.toString(port), username, password})
            output.write(Base64.getEncoder().encodeToString(field.getBytes(StandardCharsets.UTF_8)) + "\n");
    }
    public static ProxyConfig readFrom(BufferedReader input) throws IOException {
        String[] fields = new String[5];
        for (int i = 0; i < fields.length; i++) {
            String value = input.readLine(); if (value == null) throw new EOFException("Missing proxy configuration");
            fields[i] = new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
        }
        return new ProxyConfig(fields[0], fields[1], Integer.parseInt(fields[2]), fields[3], fields[4]);
    }
}
