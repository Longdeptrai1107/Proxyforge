package qltk.net;

import java.io.IOException;
import java.net.URI;
import javax.microedition.io.Connection;
import org.microemu.microedition.io.ConnectorAdapter;

/** MicroEmulator GCF socket adapter; game code keeps the standard MIDP socket API. */
public final class ProxyConnector extends ConnectorAdapter {
    private final ProxyConfig proxy;
    public ProxyConnector(ProxyConfig proxy) { this.proxy = proxy; }

    public Connection open(String name, int mode, boolean timeouts) throws IOException {
        if (!org.microemu.cldc.http.Connection.isAllowNetworkConnection()) throw new IOException("No network");
        try {
            URI uri = new URI(name);
            if (!"socket".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || (uri.getPath() != null && !uri.getPath().isEmpty())) throw new IOException("Invalid game socket URL");
            String host = uri.getHost();
            if (host.startsWith("[")) host = host.substring(1, host.length() - 1);
            final String destination = host; final int port = uri.getPort();
            return new org.microemu.cldc.socket.SocketConnection(proxy.connect(host, port)) {
                public String getAddress() throws IOException { return destination; }
                public int getPort() throws IOException { return port; }
            };
        } catch (java.net.URISyntaxException | IllegalArgumentException e) { throw new IOException("Invalid game socket URL", e); }
        catch (IOException e) {
            if (!proxy.type.equals("DIRECT")) System.out.println("[ACCOUNT] PROXY_FAILED");
            throw e;
        }
    }
}
