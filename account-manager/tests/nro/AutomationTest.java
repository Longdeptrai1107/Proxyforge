package nro;
import java.util.HashMap;
import main.GameCanvas;

public class AutomationTest {
    static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    public static void main(String[] args) {
        boolean manual = args.length > 0 && args[0].equals("manual");
        GameCanvas.serverScreen = new ServerListScreen();
        if (!manual) {
            check("session-test".equals(AccountAutomation.bindSession("session-test", "Account@Example.invalid", "MiXeD Việt 123", 2)), "Session acknowledgement failed");
            try {
                AccountAutomation.bindSession("other", "other-user", "other-password", 0);
                throw new AssertionError("Session account could be replaced");
            } catch (IllegalStateException expected) { }
        }
        AccountAutomation.tick();
        check(manual || Rms.values.get("server").equals("2"), "Server not seeded before splash");
        if (!manual) {
            check(AccountAutomation.isSessionApplied(), "Account not applied before connection");
            check("MiXeD Việt 123".equals(Rms.values.get("pass")), "Password must reach RMS before connection");
            check("Account@Example.invalid".equals(GameCanvas.loginScr.tfUser.value), "Username must reach fields before connection");
            check("MiXeD Việt 123".equals(GameCanvas.loginScr.tfPass.value), "Password must reach fields before connection");
            check(ServerListScreen.ipSelect == 2 && ServerListScreen.connects == 0, "Server must be applied before connection");
        }
        GameCanvas.currentScreen = GameCanvas.serverScreen;
        ServerListScreen.nameServer = new String[] {"1", "2", "3"};
        AccountAutomation.tick();
        if (manual) {
            check(ServerListScreen.connects == 0 && ServerListScreen.logins == 0, "Manual launch changed");
            System.out.println("PASS: manual game unaffected"); return;
        }
        check(ServerListScreen.ipSelect == 2 && ServerListScreen.connects == 1, "Server selection failed");
        AccountAutomation.tick();
        check(ServerListScreen.downloads == 0 && ServerListScreen.logins == 0, "Submitted before connection");
        Session_ME.instance.connected = true; ServerListScreen.testConnect = 2;
        ServerListScreen.downloadPrompt = true;
        AccountAutomation.tick(); AccountAutomation.tick();
        check(ServerListScreen.downloads == 1 && ServerListScreen.logins == 0, "Download not triggered once");
        ServerListScreen.loadScreen = true;
        AccountAutomation.tick();
        check(ServerListScreen.logins == 0, "Login before handshake");
        Service.ready = true; GameCanvas.currentDialog = new Object();
        AccountAutomation.tick();
        check(ServerListScreen.logins == 0, "Dialog was overridden");
        GameCanvas.currentDialog = null;
        AccountAutomation.tick(); AccountAutomation.tick();
        check(ServerListScreen.logins == 1, "Login must happen once");
        check("Account@Example.invalid".equals(GameCanvas.loginScr.tfUser.value), "Username changed");
        check("MiXeD Việt 123".equals(GameCanvas.loginScr.tfPass.value), "Password case/Unicode changed");
        check("MiXeD Việt 123".equals(Rms.values.get("pass")), "Login credentials not supplied to existing game flow");
        System.out.println("PASS: server selection, connection isolation, download, handshake/dialog gating, exact credentials, single login");
    }
}
class Session_ME {
    static Session_ME instance = new Session_ME();
    static int closes;
    boolean connected;
    static Session_ME gI() { return instance; }
    static Session_ME gI2() { return instance; }
    boolean isConnected() { return connected; }
    void close() { closes++; connected = false; }
}
class Service {
    static boolean ready;
    static Service instance = new Service();
    static Service gI() { return instance; }
    boolean isMainClientInfoAcknowledged() { return ready; }
    void resetClientInfoAndPendingLogin() { ready = false; }
}
class Rms {
    static String RMS_acc = "acc", RMS_pass = "pass", RMS_check = "check";
    static HashMap<String, String> values = new HashMap<>();
    static void saveRMSString(String key, String value) { values.put(key, value); }
    static void saveRMSInt(String key, int value) { values.put(key, Integer.toString(value)); }
}
