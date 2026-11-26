package nro;

import main.GameCanvas;

/** Optional desktop launcher integration; ordinary game launches are unaffected. */
public final class AccountAutomation {
   private static boolean initialized;
   private static volatile boolean applied;
   private static volatile boolean bound;
   private static String sessionId;
   private static boolean selected;
   private static boolean submitted;
   private static String user;
   private static String password;
   private static int server;
   private static long started;

   public static boolean hasSession() { return bound; }

   public static boolean isSessionApplied() { return applied; }

   public static int preferredServerIndex(int fallback) { return bound ? server : fallback; }

   /** Invoked on this game's actual MIDlet classloader by EmulatorBootstrap. */
   public static synchronized String bindSession(String id, String username, String secret, int serverIndex) {
      if (bound) throw new IllegalStateException("An account is already bound to this game session");
      if (id == null || id.length() == 0 || username == null || username.length() == 0
          || secret == null || secret.length() == 0 || serverIndex < 0 || serverIndex > 13)
         throw new IllegalArgumentException("Invalid game session account");
      sessionId = id;
      user = username;
      password = secret;
      server = serverIndex;
      bound = true;
      return sessionId;
   }

   public static void tick() {
      if (!bound) return;
      if (!initialized) {
         initialized = true;
         Rms.saveRMSInt(Rms.RMS_check, 1);
         Rms.saveRMSString(Rms.RMS_acc, user);
         Rms.saveRMSString(Rms.RMS_pass, password);
         Rms.saveRMSInt(ServerListScreen.RMS_svselect, server);
         if (GameCanvas.loginScr == null) GameCanvas.loginScr = new LoginScr();
         GameCanvas.loginScr.tfUser.setText(user);
         GameCanvas.loginScr.tfPass.setText(password);
         if (ServerListScreen.nameServer == null) ServerListScreen.doUpdateServer();
         GameCanvas.serverScreen.applyAccountServer(server);
         applied = true;
         System.out.println("[ACCOUNT] ACCOUNT_APPLIED");
         started = System.currentTimeMillis();
      }
      if (submitted) return;
      if (System.currentTimeMillis() - started > 180000L) {
         submitted = true;
         System.out.println("[ACCOUNT] TIMEOUT");
         return;
      }
      if ((GameCanvas.currentScreen != GameCanvas.serverScreen && GameCanvas.currentScreen != GameCanvas.loginScr) || GameCanvas.serverScreen == null
          || ServerListScreen.nameServer == null) return;
      if (!selected) {
         if (server < 0 || server >= ServerListScreen.nameServer.length) {
            submitted = true;
            password = null;
            System.out.println("[ACCOUNT] INVALID_SERVER");
            return;
         }
         selected = true;
         if (ServerListScreen.ipSelect != server) {
            Session_ME.gI().close();
            Session_ME.gI2().close();
            Service.gI().resetClientInfoAndPendingLogin();
            ServerListScreen.testConnect = -1;
         }
         ServerListScreen.SetIpSelect(server, true);
         ServerListScreen.ConnectIP();
         System.out.println("[ACCOUNT] CONNECTING");
         return;
      }
      if (ServerListScreen.testConnect != 2 || !Session_ME.gI().isConnected()) return;
      if (GameCanvas.serverScreen.downloadForAccount()) {
         System.out.println("[ACCOUNT] DOWNLOADING");
         return;
      }
      if (!ServerListScreen.loadScreen
          || !Service.gI().isMainClientInfoAcknowledged() || GameCanvas.currentDialog != null) return;
      if (GameCanvas.loginScr == null) GameCanvas.loginScr = new LoginScr();
      submitted = true;
      GameCanvas.serverScreen.perform(3, null);
      password = null;
      System.out.println("[ACCOUNT] LOGIN_SUBMITTED");
   }
}
