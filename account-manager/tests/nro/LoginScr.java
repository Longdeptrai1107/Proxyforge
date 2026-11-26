package nro;
public class LoginScr {
    public Field tfUser = new Field(), tfPass = new Field();
    public void loginFromAccountSession(String username, String password) {
        tfUser.setText(username); tfPass.setText(password);
        Rms.saveRMSString(Rms.RMS_acc, username); Rms.saveRMSString(Rms.RMS_pass, password);
        ServerListScreen.logins++;
    }
    public static class Field {
        public String value;
        public void setText(String text) { value = text; }
    }
}
