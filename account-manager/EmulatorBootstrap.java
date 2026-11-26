import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.awt.Frame;
import javax.swing.SwingUtilities;
import org.microemu.app.Main;
import qltk.net.ProxyConfig;
import qltk.net.ProxyConnector;

/** Credentials arrive over stdin, never on the process command line. */
public final class EmulatorBootstrap {
    public static void main(String[] args) {
        try { run(args); }
        catch (Throwable e) { e.printStackTrace(); System.exit(1); }
    }
    private static void run(String[] args) throws Exception {
        boolean smoke = args.length > 2 && "--smoke".equals(args[2]);
        boolean sessionSmoke = args.length > 2 && "--session-smoke".equals(args[2]);
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String user = smoke ? "Smoke test" : decode(input.readLine());
        String password = smoke ? "" : decode(input.readLine());
        int server = smoke ? 0 : Integer.parseInt(input.readLine());
        String sessionId = smoke ? "" : input.readLine();
        if (!smoke && sessionId == null) sessionId = java.util.UUID.randomUUID().toString();
        if (server < 0 || server > 13) throw new IllegalArgumentException("Invalid server");
        ProxyConfig proxyConfig = smoke ? ProxyConfig.DIRECT : ProxyConfig.readFrom(input);
        // The socket-specific adapter survives Common's registration of the default GCF.
        org.microemu.microedition.ImplFactory.registerGCF("socket", new ProxyConnector(proxyConfig));
        // Each account gets its own MicroEmulator config; RMS is deliberately in memory.
        System.setProperty("user.home", args[1]);
        Main.main(new String[] {"--resizableDevice", "240", "320", "--rms", "memory",
            "--appclasspath", new File(args[0], "dist/DragonBoy252-source-rebuilt.jar").getAbsolutePath(),
            "--propertiesjad", new File(args[0], "dist/DragonBoy252-source-rebuilt.jad").getAbsolutePath(),
            "main.GameMidlet"});
        // Find the running game, then cross MicroEmulator's MIDlet classloader boundary.
        java.lang.reflect.Field commonField = Main.class.getDeclaredField("common");
        commonField.setAccessible(true);
        Class<?> automation = null;
        for (Frame frame : Frame.getFrames()) if (frame instanceof Main) {
            org.microemu.app.Common common = (org.microemu.app.Common)commonField.get(frame);
            javax.microedition.midlet.MIDlet midlet = common.getLauncher().getCurrentMIDlet();
            if (midlet == null || !"main.GameMidlet".equals(midlet.getClass().getName()))
                throw new IllegalStateException("The rebuilt NRO MIDlet is not running");
            automation = midlet.getClass().getClassLoader().loadClass("nro.AccountAutomation");
            installRenderPolicy(frame, midlet.getClass().getClassLoader());
            if (args.length > 2 && args[2].startsWith("--flow-test=")) {
                String[] testSettings = args[2].substring("--flow-test=".length()).split(",");
                int localPort = Integer.parseInt(testSettings[0]);
                if (localPort < 1024 || localPort > 65535) throw new IllegalArgumentException("Invalid local test port");
                StringBuilder list = new StringBuilder();
                for (String name : NroAccountManager.SERVERS) list.append(name).append(":127.0.0.1:").append(localPort).append(":0:0:0,");
                midlet.getClass().getClassLoader().loadClass("nro.ServerListScreen").getField("linkDefault").set(null, list.append("0,0").toString());
                if (testSettings.length > 1 && "cached".equals(testSettings[1])) {
                    Class<?> rms = midlet.getClass().getClassLoader().loadClass("nro.Rms");
                    rms.getMethod("saveRMSString", String.class, String.class).invoke(null, rms.getField("RMS_ResVersion").get(null), "9876");
                }
            }
            if (sessionSmoke) {
                // Block sockets only; let the real splash, server-list and canvas run normally.
                Class<?> sessionClass = midlet.getClass().getClassLoader().loadClass("nro.Session_ME");
                java.lang.reflect.Field throttle = sessionClass.getDeclaredField("nextConnectAllowedAt");
                throttle.setAccessible(true);
                for (String getter : new String[] {"gI", "gI2"})
                    throttle.setLong(sessionClass.getMethod(getter).invoke(null), Long.MAX_VALUE);
            }
            if (!smoke) {
                Object acknowledgement = automation.getMethod("bindSession", String.class, String.class, String.class, int.class)
                    .invoke(null, sessionId, user, password, server);
                if (!sessionId.equals(acknowledgement)) throw new IllegalStateException("Game session acknowledgement differs");
                System.out.println("[ACCOUNT] SESSION_BOUND");
            }
        }
        if (automation == null) throw new IllegalStateException("MicroEmulator game session not found");
        if (sessionSmoke) {
            final Class<?> boundAutomation = automation;
            final String boundId = sessionId;
            new javax.swing.Timer(6500, event -> {
            try {
            // Verify the actual game JAR received exactly this process's stdin account.
            String[] names = {"sessionId", "user", "password", "server"};
            Object[] expected = {boundId, user, password, server};
            for (int i = 0; i < names.length; i++) {
                java.lang.reflect.Field field = boundAutomation.getDeclaredField(names[i]);
                field.setAccessible(true);
                if (!expected[i].equals(field.get(null))) throw new IllegalStateException("Session bridge mismatch: " + names[i]);
            }
            try {
                boundAutomation.getMethod("bindSession", String.class, String.class, String.class, int.class)
                    .invoke(null, "other-session", "other-user", "other-password", 0);
                throw new IllegalStateException("Game accepted a replacement account for an existing session");
            } catch (java.lang.reflect.InvocationTargetException e) {
                if (!(e.getCause() instanceof IllegalStateException)) throw e;
            }
            // Exercise the real LoginScr and its real button command; intercept only the
            // command listener so this test never sends test credentials to a server.
            ClassLoader gameLoader = boundAutomation.getClassLoader();
            Class<?> servers = gameLoader.loadClass("nro.ServerListScreen");
            Class<?> canvasClass = gameLoader.loadClass("main.GameCanvas");
            Class<?> rms = gameLoader.loadClass("nro.Rms");
            Class<?> loginClass = gameLoader.loadClass("nro.LoginScr");
            Object login = canvasClass.getField("loginScr").get(null);
            if (!Boolean.TRUE.equals(boundAutomation.getMethod("isSessionApplied").invoke(null)) || login == null)
                throw new IllegalStateException("Normal game startup never applied the session account");
            Object userField = loginClass.getField("tfUser").get(login);
            Object passField = loginClass.getField("tfPass").get(login);
            if (!user.equals(userField.getClass().getMethod("getText").invoke(userField))
                || !password.equals(passField.getClass().getMethod("getText").invoke(passField))
                || !user.equals(rms.getMethod("loadRMSString", String.class).invoke(null, rms.getField("RMS_acc").get(null)))
                || !password.equals(rms.getMethod("loadRMSString", String.class).invoke(null, rms.getField("RMS_pass").get(null)))
                || !Integer.valueOf(server).equals(servers.getField("ipSelect").get(null))
                || !Integer.valueOf(server).equals(rms.getMethod("loadRMSInt", String.class).invoke(null, servers.getField("RMS_svselect").get(null))))
                throw new IllegalStateException("Normal startup did not retain account fields/RMS/server");
            java.lang.reflect.Field addresses = servers.getDeclaredField("address"), ports = servers.getDeclaredField("port");
            addresses.setAccessible(true); ports.setAccessible(true);
            Class<?> midletClass = gameLoader.loadClass("main.GameMidlet");
            if (!((String[])addresses.get(null))[server].equals(midletClass.getField("IP").get(null))
                || ((short[])ports.get(null))[server] != midletClass.getField("PORT").getInt(null))
                throw new IllegalStateException("Selected account server was not applied to real IP/PORT");
            if (canvasClass.getField("currentScreen").get(null) != canvasClass.getField("serverScreen").get(null))
                throw new IllegalStateException("Normal splash did not reach server screen");
            Object recreated = loginClass.getConstructor().newInstance();
            Object recreatedUser = loginClass.getField("tfUser").get(recreated), recreatedPass = loginClass.getField("tfPass").get(recreated);
            if (!user.equals(recreatedUser.getClass().getMethod("getText").invoke(recreatedUser))
                || !password.equals(recreatedPass.getClass().getMethod("getText").invoke(recreatedPass)))
                throw new IllegalStateException("Recreating LoginScr cleared session credentials");
            java.lang.reflect.Field buttonField = loginClass.getDeclaredField("cmdLogin");
            buttonField.setAccessible(true);
            Object button = buttonField.get(login);
            boolean[] clicked = {false};
            Class<?> listenerClass = gameLoader.loadClass("nro.IActionListener");
            Object listener = java.lang.reflect.Proxy.newProxyInstance(gameLoader, new Class<?>[] {listenerClass},
                (proxy, method, values) -> {
                    if (method.getName().equals("perform")) {
                        if (!Integer.valueOf(888393).equals(values[0])) throw new AssertionError("Wrong login button action");
                        clicked[0] = true;
                    }
                    return null;
                });
            button.getClass().getField("actionListener").set(button, listener);
            loginClass.getMethod("loginFromAccountSession", String.class, String.class).invoke(login, user, password);
            if (!clicked[0] || !user.equals(userField.getClass().getMethod("getText").invoke(userField))
                || !password.equals(passField.getClass().getMethod("getText").invoke(passField))
                || !password.equals(rms.getMethod("loadRMSString", String.class).invoke(null, rms.getField("RMS_pass").get(null))))
                throw new IllegalStateException("Actual game login button or credentials mismatch");
            System.out.println("SESSION PASS: normal splash retained exact account in fields/RMS, selected server/IP/PORT without network; session " + boundId + "; LoginScr recreation retained credentials; real login button invoked (network intercepted)");
            System.exit(0);
            } catch (Throwable e) { e.printStackTrace(); System.exit(1); }
            }).start();
            return;
        }
        SwingUtilities.invokeLater(() -> {
            for (Frame frame : Frame.getFrames()) if (frame instanceof Main)
                frame.setTitle("NRO | " + user + " | Server " + (server + 1));
        });
        if (smoke) {
            new javax.swing.Timer(4000, event -> {
                try {
                    java.lang.reflect.Field field = Main.class.getDeclaredField("common");
                    field.setAccessible(true);
                    for (Frame frame : Frame.getFrames()) if (frame instanceof Main) {
                        org.microemu.app.Common common = (org.microemu.app.Common)field.get(frame);
                        javax.microedition.midlet.MIDlet midlet = common.getLauncher().getCurrentMIDlet();
                        org.microemu.device.DeviceDisplay display = common.getDevice().getDeviceDisplay();
                        Object canvas = midlet.getClass().getClassLoader().loadClass("main.GameCanvas").getField("instance").get(null);
                        int canvasWidth = (Integer)canvas.getClass().getMethod("getWidth").invoke(canvas);
                        int canvasHeight = (Integer)canvas.getClass().getMethod("getHeight").invoke(canvas);
                        System.out.println("SMOKE observed: canvas=" + canvasWidth + "x" + canvasHeight);
                        if (midlet == null || !midlet.getClass().getName().equals("main.GameMidlet")
                            || display.getFullWidth() != 240 || display.getFullHeight() != 320
                            || canvasWidth != 240 || canvasHeight != 320
                            || !((org.microemu.device.impl.DeviceDisplayImpl)display).isResizable())
                            throw new IllegalStateException("Wrong MIDlet or display dimensions");
                        System.out.println("SMOKE PASS: built GameMidlet running; resizable display 240x320; no credentials submitted");
                        System.exit(0);
                    }
                    throw new IllegalStateException("MicroEmulator frame not found");
                } catch (Exception e) { e.printStackTrace(); System.exit(1); }
            }).start();
        }
    }
    private static String decode(String value) {
        if (value == null) throw new IllegalArgumentException("Missing account data");
        return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
    }
    static void installRenderPolicy(Frame frame, ClassLoader loader) throws Exception {
        java.lang.reflect.Field enabled = loader.loadClass("nro.MotherCanvas").getField("renderEnabled");
        java.lang.reflect.Field interval = loader.loadClass("nro.MotherCanvas").getField("repaintIntervalMillis");
        Runnable apply = () -> {
            try {
                enabled.setBoolean(null, (frame.getExtendedState() & Frame.ICONIFIED) == 0);
                interval.setInt(null, frame.isActive() ? 27 : 200);
            } catch (IllegalAccessException e) { throw new IllegalStateException(e); }
        };
        frame.addWindowStateListener(e -> apply.run());
        frame.addWindowFocusListener(new java.awt.event.WindowAdapter() {
            public void windowGainedFocus(java.awt.event.WindowEvent e) { apply.run(); }
            public void windowLostFocus(java.awt.event.WindowEvent e) { apply.run(); }
        });
        SwingUtilities.invokeLater(apply);
    }
}
