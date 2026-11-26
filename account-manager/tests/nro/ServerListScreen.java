package nro;
public class ServerListScreen {
    public static String[] nameServer;
    public static String RMS_svselect = "server";
    public static int ipSelect, testConnect, connects, downloads, logins;
    public static boolean loadScreen, downloadPrompt;
    public static void doUpdateServer() { nameServer = new String[] {"1", "2", "3"}; }
    public void applyAccountServer(int index) { SetIpSelect(index, true); }
    public static void SetIpSelect(int server, boolean save) { ipSelect = server; }
    public static void ConnectIP() { connects++; }
    public boolean downloadForAccount() {
        if (!downloadPrompt) return false;
        downloadPrompt = false; downloads++; return true;
    }
    public void perform(int action, Object ignored) {
        if (action != 3) throw new AssertionError("Wrong game login action");
        logins++;
    }
}
