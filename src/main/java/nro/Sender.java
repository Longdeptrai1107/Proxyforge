package nro;

import java.io.IOException;
import java.util.Vector;

final class Sender implements Runnable {
   private final Vector sendingMessage;
   private final long generation;
   private Session_ME session;

   public Sender(Session_ME sessionValue, long generationValue) {
      this.session = sessionValue;
      this.sendingMessage = new Vector();
      this.generation = generationValue;
   }

   public final void AddMessage(Message sendingMessageValue) {
      synchronized (this.sendingMessage) {
         this.sendingMessage.addElement(sendingMessageValue);
         this.sendingMessage.notifyAll();
      }
   }

   public final void wakeUp() {
      synchronized (this.sendingMessage) { this.sendingMessage.notifyAll(); }
   }

   public final void clear() {
      synchronized (this.sendingMessage) {
         this.sendingMessage.removeAllElements();
         this.sendingMessage.notifyAll();
      }
   }

   public final void run() {
      while (this.generation == this.session.getConnectionGeneration() && this.session.connected) {
         try {
            Message message;
            synchronized (this.sendingMessage) {
               while (this.generation == this.session.getConnectionGeneration() && this.session.connected
                   && (!this.session.getKeyComplete || this.sendingMessage.size() == 0)) {
                  this.sendingMessage.wait();
               }
               if (this.generation != this.session.getConnectionGeneration() || !this.session.connected) return;
               message = (Message)this.sendingMessage.elementAt(0);
               this.sendingMessage.removeElementAt(0);
            }
            Session_ME.sendForGeneration(this.session, message, this.generation);
         } catch (InterruptedException interrupted) {
            return;
         } catch (IOException iOException) {
            Session_ME.failConnection(this.session, this.generation, "socket send failed: " + iOException.toString());
            return;
         } catch (RuntimeException runtimeException) {
            runtimeException.printStackTrace();
         }
      }
   }

}
