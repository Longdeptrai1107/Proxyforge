package nro;

import javax.microedition.io.Connector;
import javax.microedition.io.SocketConnection;

public final class SocketConnectionHandle {
   SocketConnection connection;

   public SocketConnectionHandle(String text, int value) throws java.io.IOException {
      if (mSystem.isLocalServer() && (!"127.0.0.1".equals(text) || value != 14445)) {
         throw new java.io.IOException("Local mode only permits 127.0.0.1:14445");
      }
      this.connection = (SocketConnection)Connector.open("socket://" + text + ":" + value);
   }

   public final void close() throws java.io.IOException {
      if (this.connection != null) {
         this.connection.close();
      }
   }
}
